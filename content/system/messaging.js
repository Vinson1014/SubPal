// content/messaging.js
// 消息傳遞模組 - 抽象層，與 content.js 透過 CustomEvent 通訊

import { PRIVATE_PROTOCOL_VERSION, buildSafeDiagnostic, createDomTransport, createEnvelope, toCompatibilityError } from './capabilities/private-transports.js';

// 註冊的消息處理器
// 修改為支持多個 handler 的結構：type -> Set<handler>
const messageHandlers = new Map();

// 註冊的內部事件處理器，支持多個處理函數
const internalEventHandlers = new Map();

// 調試模式開關 (由 content.js 控制)
let debugMode = false;
let messagingInitializationPromise = null;

// 根據訊息類型定義不同的超時時間
const messageTimeouts = {
  'SUBMIT_TRANSLATION': 20000, // 20秒，API相關操作
  'PROCESS_VOTE': 15000, // 15秒，API相關操作
  'DEFAULT': 10000 // 默認10秒
};

/**
 * 根據消息類型獲取超時時間
 * @param {string} type - 消息類型
 * @returns {number} - 超時時間 (毫秒)
 */
function getTimeoutForMessageType(type) {
  return messageTimeouts[type] || messageTimeouts.DEFAULT;
}

let domTransport = null;
const legacyDomRequestEvent = 'messageToContentScript';
const legacyDomResponseEvent = 'responseFromContentScript';

function getDomTransport() {
  if (!domTransport) {
    domTransport = createDomTransport({
      window,
      makeEvent: (type, detail) => new CustomEvent(type, { detail }),
      requestEvent: legacyDomRequestEvent,
      responseEvent: legacyDomResponseEvent
    });
  }
  return domTransport;
}

function unwrapLegacyResult(result, rejectRawError = true) {
  if (!result.ok) throw toCompatibilityError(result);
  if (rejectRawError && result.value?.error) throw toCompatibilityError({
    ok: false,
    error: { kind: 'domain-rejected', code: 'legacy-response-error', retryable: false }
  });
  return result.value;
}

/**
 * 僅在 debugMode 開啟時輸出日誌
 */
function debugLog(...args) {
  if (debugMode) {
    console.log('[Messaging]', ...args);
  }
}

// 導出初始化函式，由外部調用
export function initMessaging() {
  if (!messagingInitializationPromise) {
    messagingInitializationPromise = initializeMessaging();
  }
  return messagingInitializationPromise;
}

async function initializeMessaging() {
  // 初始化 ConfigBridge 並讀取 debugMode
  try {
    const { configBridge } = await import('./config/config-bridge.js');

    // ConfigBridge 應該已經在 initialization-manager 初始化
    if (!configBridge.isInitialized) {
      await configBridge.initialize();
    }

    // 讀取 debugMode
    debugMode = configBridge.get('debugMode');
    debugLog('初始 debug mode:', debugMode);

    // 訂閱 debugMode 變更
    configBridge.subscribe('debugMode', (newValue) => {
      debugMode = newValue;
      debugLog('Debug mode 已更新:', debugMode);
    });
  } catch (error) {
    console.error('messaging.js 初始化 ConfigBridge 失敗:', error);
    // 不拋出錯誤，讓 messaging 系統繼續運行
  }

  // 監聽來自 content.js 的消息事件 (用於接收 background 的回應或 content.js 的內部消息)
  window.addEventListener('messageFromContentScript', (event) => {
    const { message, sender } = event.detail;
    debugLog('收到來自 content.js 的消息', message, sender);

    // 處理內部事件消息
    const internalEventTypes = ['SUBTITLE_READY', 'VIDEO_ID_CHANGED'];
    if (internalEventTypes.includes(message.type)) {
      debugLog(`收到 ${message.type} 消息，分發給內部事件處理器`);
      dispatchInternalEvent(message);
      return;
    }

    // 處理來自 background 的回應 (通過 content.js 轉發)
    // 這些回應應該有 messageId
    // 處理其他來自 content.js 的內部消息 (如果有的話)
    // 收集所有匹配的 handler：type-specific + wildcard
    const typeHandlers = messageHandlers.get(message.type) || new Set();
    const wildcardHandlers = messageHandlers.get('*') || new Set();
    const allHandlers = new Set([...typeHandlers, ...wildcardHandlers]);

    if (allHandlers.size === 0) {
      debugLog('無處理器，類型:', message.type);
      // 無法直接 sendResponse，需要透過 content.js 回應
      // 這裡應該是內部消息，通常不需要回應
      return;
    }

    // 調用所有匹配的 handler
    for (const handler of allHandlers) {
      try {
        // 內部消息處理通常是同步的，或者通過 dispatchInternalEvent 處理
        // 如果這裡有異步處理，需要考慮如何回應，但目前架構下，
        // 來自 content.js 的消息主要是 background 的回應或單向通知
        handler(message, sender); // 執行處理器
      } catch (err) {
        console.error('處理內部消息時出錯:', err);
      }
    }
  });

  // debugMode 將通過 initMessaging() 初始化



  debugLog('Messaging module initialized and listening for events.');
}

/**
 * 註冊僅在內容腳本層面處理的內部事件處理器，支持多個處理函數
 * @param {string} type - 事件類型
 * @param {Function} handler - 處理函數
 * @returns {Function} 取消訂閱函數
 */
export function registerInternalEventHandler(type, handler) {
  if (!type || typeof handler !== 'function') {
    console.error('registerInternalEventHandler 參數錯誤', type, handler);
    return () => {};
  }

  let handlers = internalEventHandlers.get(type);
  if (!handlers) {
    handlers = [];
    internalEventHandlers.set(type, handlers);
  }

  handlers.push(handler);
  debugLog('註冊內部事件處理器', type, '總數:', handlers.length);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;

    const currentHandlers = internalEventHandlers.get(type);
    if (!currentHandlers) return;

    const index = currentHandlers.indexOf(handler);
    if (index !== -1) {
      currentHandlers.splice(index, 1);
      debugLog('取消註冊內部事件處理器', type, '總數:', currentHandlers.length);
    }

    if (currentHandlers.length === 0) {
      internalEventHandlers.delete(type);
    }
  };
}

/**
 * 發送內部事件，僅在內容腳本層面處理，支持多個處理函數
 * @param {Object} message - 事件訊息
 */
export function dispatchInternalEvent(message) {
  debugLog(`發送內部事件: ${message.type}`, message);
  const handlers = internalEventHandlers.get(message.type);
  if (handlers && handlers.length > 0) {
    handlers.forEach((handler, index) => {
      try {
        handler(message);
        debugLog(`執行處理器 ${index + 1}/${handlers.length} 對於事件: ${message.type}`);
      } catch (err) {
        console.error(`處理內部事件出錯: ${message.type} (處理器 ${index + 1})`, err);
      }
    });
  } else {
    debugLog(`無內部事件處理器，類型: ${message.type}`);
  }
}

/**
 * 註冊一個消息類型，使其在收到時自動作為內部事件分發
 * @param {string} messageType - 要自動轉發的消息類型
 */
export function registerAutoForwardingToInternalEvent(messageType) {
  registerMessageHandler(messageType, (message) => {
    dispatchInternalEvent(message);
    // 如果需要，可以返回一個成功的響應，表示消息已被內部處理
    return { success: true };
  });
  debugLog(`註冊自動轉發到內部事件: ${messageType}`);
}


/**
 * 發送消息到 background 或 popup (透過 content.js)
 * @param {Object} message - 消息對象
 * @returns {Promise<any>}
 */
export function sendMessage(message) {
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const timeoutMs = getTimeoutForMessageType(message.type);
  return getDomTransport().request(createEnvelope({
    requestId: messageId,
    kind: 'background-message',
    payload: message
  }), {
    deadlineMs: timeoutMs,
    wire: { messageId, message }
  }).then((result) => {
    debugLog('DOM 傳輸已結束', buildSafeDiagnostic({
      requestId: messageId, capability: 'messaging', operation: 'background-message', protocolVersion: PRIVATE_PROTOCOL_VERSION,
      result, deadlineMs: timeoutMs
    }));
    return unwrapLegacyResult(result);
  });
}

/**
 * 註冊消息處理器（支持多個 handler）
 * @param {string} type - 消息類型，'*' 表示通用處理
 * @param {Function} handler - 處理函數 (message, sender) => result|Promise
 * @returns {Function} 取消訂閱函數
 */
export function registerMessageHandler(type, handler) {
  if (!type || typeof handler !== 'function') {
    console.error('registerMessageHandler 參數錯誤', type, handler);
    return () => {};
  }

  // 如果該類型還沒有 handler set，創建一個
  if (!messageHandlers.has(type)) {
    messageHandlers.set(type, new Set());
  }

  // 添加 handler 到 set
  messageHandlers.get(type).add(handler);
  debugLog('註冊處理器', type, '當前處理器數量:', messageHandlers.get(type).size);

  // 返回取消訂閱函數
  return () => {
    const handlers = messageHandlers.get(type);
    if (handlers) {
      handlers.delete(handler);
      debugLog('取消註冊處理器', type, '剩餘處理器數量:', handlers.size);
    }
  };
}

/**
 * 高階接口：註冊通用消息回調（支持多個訂閱者）
 * @param {Function} callback - (message, sender) => result|Promise
 * @returns {Function} 取消訂閱函數
 */
export function onMessage(callback) {
  return registerMessageHandler('*', callback);
}

/**
 * 檢查 page script 是否可用
 * @returns {boolean}
 */
export function isPageScriptAvailable() {
  return !!(window.subpalPageScript);
}

/**
 * 等待 page script 可用
 * @param {number} timeout - 超時時間（毫秒）
 * @returns {Promise<boolean>}
 */
export function waitForPageScript(timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (isPageScriptAvailable()) {
      resolve(true);
      return;
    }

    let checkCount = 0;
    const maxChecks = timeout / 500;
    
    const checkInterval = setInterval(() => {
      checkCount++;
      if (isPageScriptAvailable()) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        reject(new Error('Page script 載入超時'));
      }
    }, 500);
  });
}
