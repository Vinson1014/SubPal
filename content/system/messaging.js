// content/messaging.js
// 消息傳遞模組 - 抽象層，與 content.js 透過 CustomEvent 通訊

// 註冊的消息處理器
// 修改為支持多個 handler 的結構：type -> Set<handler>
const messageHandlers = new Map();

// 註冊的內部事件處理器，支持多個處理函數
const internalEventHandlers = new Map();

// 調試模式開關 (由 content.js 控制)
let debugMode = false;

// 存儲所有活動的監聽器和超時計時器
const activeListeners = new Map(); // messageId => { listener, timeoutId, resolve, reject }

// 根據訊息類型定義不同的超時時間
const messageTimeouts = {
  'CHECK_SUBTITLE': 30000, // 30秒，API相關操作
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

/**
 * 清理指定 messageId 的監聽器和超時計時器
 * @param {string} messageId - 消息 ID
 */
function cleanupListener(messageId) {
  const item = activeListeners.get(messageId);
  if (item) {
    const { listener, timeoutId } = item;
    window.removeEventListener('responseFromContentScript', listener);
    clearTimeout(timeoutId);
    activeListeners.delete(messageId);
    debugLog(`清理監聽器: ${messageId}`);
  }
}

// 添加連接狀態檢查函數
let isConnected = true; // 假設初始連接是正常的
// let reconnectingPromise = null; // 用於處理重連中的 Promise (暫時不需要)

// 添加訊息隊列，處理連接斷開時的請求
const messageQueue = [];
const MAX_QUEUE_SIZE = 50; // 最大隊列大小

/**
 * 處理隊列中的消息
 */
function processMessageQueue() {
  if (!isConnected || messageQueue.length === 0) return;

  debugLog(`處理隊列中消息，數量: ${messageQueue.length}`);

  // 處理隊列中的消息
  // 使用 for...of 循環並在循環內部檢查 isConnected 狀態
  const queueCopy = [...messageQueue]; // 複製隊列，避免在循環中修改
  messageQueue.length = 0; // 清空原隊列

  for (const { message, resolve, reject, timestamp } of queueCopy) {
    if (!isConnected) {
      // 如果在處理過程中連接斷開，將剩餘消息放回隊列頭部
      messageQueue.unshift({ message, resolve, reject, timestamp });
      debugLog(`連接斷開，剩餘 ${messageQueue.length} 個消息放回隊列`);
      break;
    }

    // 檢查消息是否過期 (例如 1 分鐘)
    if (Date.now() - timestamp > 60000) {
      debugLog(`隊列中消息過期: ${message.type}, ${message.messageId}`);
      reject(new Error('Queued message expired'));
      continue;
    }

    // 重新發送消息
    debugLog(`重新發送隊列中消息: ${message.type}, ${message.messageId}`);
    // 這裡需要確保 sendMessage 能夠處理隊列中的 Promise
    // sendMessage 返回 Promise，直接鏈接 resolve/reject
    sendMessage(message).then(resolve).catch(reject);
  }
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
export async function initMessaging() {
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
    const { message, messageId, sender } = event.detail;
    debugLog('收到來自 content.js 的消息', message, sender);

    // 處理特定的內部消息，例如更新 debug 模式或連接狀態
    if (message.type === 'SET_DEBUG_MODE') {
      debugMode = message.debugMode;
      debugLog('Debug mode set to:', debugMode);
      // 不需要進一步處理，這個消息是單向的
      return;
    }

    // 處理內部事件消息
    const internalEventTypes = ['SUBTITLE_READY', 'RAW_TTML_INTERCEPTED', 'SUBTITLE_STYLE_UPDATED'];
    if (internalEventTypes.includes(message.type)) {
      debugLog(`收到 ${message.type} 消息，分發給內部事件處理器`);
      dispatchInternalEvent(message);
      return;
    }

    if (message.type === 'CONNECTION_STATUS_CHANGED') {
      const wasConnected = isConnected;
      isConnected = message.connected;
      debugLog(`連接狀態變更: ${isConnected ? '已連接' : '已斷開'}`);

      if (!isConnected && wasConnected) {
        // 連接斷開時，處理所有待處理的訊息響應
        debugLog(`連接斷開，處理 ${activeListeners.size} 個待處理消息`);
        for (const [messageId, { resolve, reject }] of activeListeners.entries()) {
           // 找到對應的 Promise 的 reject 函數並調用
           const error = new Error('Background connection lost');
           console.error(`消息 ${messageId} 因連接斷開而失敗:`, error);
           cleanupListener(messageId); // 清理監聽器和計時器
           reject(error); // 拒絕 Promise
        }
      } else if (isConnected && !wasConnected) {
         // 連接恢復時，處理隊列中的消息
         processMessageQueue();
      }
      return; // 不需要進一步處理
    }


    // 處理來自 background 的回應 (通過 content.js 轉發)
    // 這些回應應該有 messageId
    if (message.messageId) {
       // 找到對應的監聽器並觸發
       const item = activeListeners.get(message.messageId);
       if (item && item.listener) {
          // 觸發監聽器，listener 會處理響應並清理
          item.listener({ detail: { messageId: message.messageId, response: message.response } });
       } else {
          debugLog('收到無效或已過期消息的回應:', message.messageId, message.type);
       }
       return; // 處理完回應後返回
    }


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

  // 監聽來自 content.js 的回應事件 (舊的 sendMessage 機制可能還在使用，保留兼容性)
   window.addEventListener('responseFromContentScript', (event) => {
      // 這個監聽器主要用於兼容舊的 sendMessage 實現，
      // 新的基於 port 的回應應該直接在 messageFromContentScript 中處理
      // 這裡可以保留，以防萬一，但主要邏輯應移至 messageFromContentScript
      debugLog('收到來自 content.js 的回應事件 (舊機制)', event.detail.messageId, event.detail.response);
      // 找到對應的監聽器並觸發
      const item = activeListeners.get(event.detail.messageId);
      if (item && item.listener) {
         item.listener(event); // 觸發監聽器，listener 會處理響應並清理
      } else {
         debugLog('收到無效或已過期回應事件 (舊機制):', event.detail.messageId);
      }
   });


  // debugMode 將通過 initMessaging() 初始化


  // 請求初始連接狀態 (如果 content.js 提供了這個功能)
  // sendMessage({ type: 'GET_CONNECTION_STATUS' }).then(res => {
  //   if (res?.success && typeof res.connected === 'boolean') {
  //     isConnected = res.connected;
  //     debugLog('Initial connection status:', isConnected);
  //   } else {
  //      console.warn('Failed to get initial connection status:', res?.error);
  //   }
  // }).catch(err => console.warn('Failed to get initial connection status (catch):', err));


  debugLog('Messaging module initialized and listening for events.');
}

/**
 * 註冊僅在內容腳本層面處理的內部事件處理器，支持多個處理函數
 * @param {string} type - 事件類型
 * @param {Function} handler - 處理函數
 */
export function registerInternalEventHandler(type, handler) {
  if (!type || typeof handler !== 'function') {
    console.error('registerInternalEventHandler 參數錯誤', type, handler);
    return;
  }
  let handlers = internalEventHandlers.get(type);
  if (!handlers) {
    handlers = [];
    internalEventHandlers.set(type, handlers);
  }
  handlers.push(handler);
  debugLog('註冊內部事件處理器', type, '總數:', handlers.length);
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
  // 檢查連接狀態，如果斷開且不是重要消息，則直接拒絕
  const isImportantMessage = ['SUBMIT_TRANSLATION', 'PROCESS_VOTE'].includes(message.type);
  if (!isConnected && !isImportantMessage) {
     debugLog(`發送消息失敗: ${message.type}, 連接已斷開`);
     return Promise.reject(new Error('Background connection is not available'));
  }

  // 如果連接斷開且是重要消息，則加入隊列
  if (!isConnected && isImportantMessage) {
     if (messageQueue.length < MAX_QUEUE_SIZE) {
        debugLog(`連接斷開，將消息加入隊列: ${message.type}`);
        return new Promise((resolve, reject) => {
           messageQueue.push({ message, resolve, reject, timestamp: Date.now() });
        });
     } else {
        debugLog(`消息隊列已滿，發送消息失敗: ${message.type}`);
        return Promise.reject(new Error('Message queue is full'));
     }
  }


  debugLog('發送消息 (透過 content.js)', message);
  return new Promise((resolve, reject) => {
    // 生成唯一的訊息 ID
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timeoutMs = getTimeoutForMessageType(message.type); // 根據類型獲取超時時間

    debugLog('生成訊息 ID:', messageId, '類型:', message.type, '超時:', timeoutMs, 'ms');

    // 創建監聽器
    const listener = (event) => {
      // 檢查 messageId 是否匹配
      if (event.detail.messageId === messageId) {
        // 收到回應，清理監聽器和超時計時器
        cleanupListener(messageId);
        debugLog('收到回應 (來自 content.js)', messageId, message.type, event.detail.response);

        // 處理響應
        if (event.detail.response?.error) {
          // 模擬 chrome.runtime.lastError
          const error = new Error(event.detail.response.error);
          console.error('sendMessage 失敗:', messageId, message.type, error);
          reject(error);
        } else {
          resolve(event.detail.response);
        }
      }
    };

    // 添加回應監聽器
    window.addEventListener('responseFromContentScript', listener);
    debugLog('添加回應監聽器:', messageId, message.type);

    // 設置超時處理
    const timeoutId = setTimeout(() => {
      // 超時發生，清理監聽器和超時計時器
      cleanupListener(messageId);
      const error = new Error(`Message response timeout: ${message.type}`);
      console.error('sendMessage 超時:', messageId, message.type, error);
      reject(error);
    }, timeoutMs);
    debugLog('設置超時處理:', messageId, message.type, timeoutMs, 'ms');

    // 保存監聽器和計時器引用
    activeListeners.set(messageId, { listener, timeoutId, resolve, reject }); // 保存 resolve/reject 以便連接斷開時使用

    // 發送事件到 content.js
    window.dispatchEvent(new CustomEvent('messageToContentScript', {
      detail: { messageId, message }
    }));
    debugLog('已發送訊息到 content.js:', messageId, message.type);
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

// === Page Script 通信功能 ===

// 存儲 page script 監聽器
const pageScriptListeners = new Map();

/**
 * 發送消息到 page script
 * @param {Object} message - 消息對象
 * @returns {Promise<any>}
 */
export function sendMessageToPageScript(message) {
  debugLog('發送消息到 page script:', message);
  
  return new Promise((resolve, reject) => {
    // 檢查是否有 page script 可用
    if (!window.subpalPageScript) {
      reject(new Error('Page script 不可用'));
      return;
    }

    // 生成唯一的訊息 ID
    const messageId = `page_msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timeoutMs = getTimeoutForMessageType(message.type);

    debugLog('發送到 page script:', messageId, message.type, timeoutMs, 'ms');

    // 創建監聽器
    const listener = (event) => {
      // 檢查消息來源和 messageId
      if (event.data?.source === 'subpal-page-script' && 
          event.data?.messageId === messageId) {
        // 收到回應，清理監聽器和超時計時器
        cleanupPageScriptListener(messageId);
        debugLog('收到 page script 回應:', messageId, event.data);

        // 處理響應
        if (event.data.error) {
          const error = new Error(event.data.error);
          console.error('page script 消息失敗:', messageId, message.type, error);
          reject(error);
        } else {
          resolve(event.data);
        }
      }
    };

    // 添加監聽器
    window.addEventListener('message', listener);

    // 設置超時處理
    const timeoutId = setTimeout(() => {
      cleanupPageScriptListener(messageId);
      const error = new Error(`Page script message timeout: ${message.type}`);
      console.error('page script 消息超時:', messageId, message.type, error);
      reject(error);
    }, timeoutMs);

    // 保存監聽器和計時器引用
    pageScriptListeners.set(messageId, { listener, timeoutId });

    // 發送消息到 page script
    window.postMessage({
      source: 'subpal-content-script',
      target: 'subpal-page-script',
      messageId: messageId,
      ...message
    }, '*');
    
    debugLog('已發送訊息到 page script:', messageId, message.type);
  });
}

/**
 * 清理 page script 監聽器
 * @param {string} messageId - 消息 ID
 */
function cleanupPageScriptListener(messageId) {
  const item = pageScriptListeners.get(messageId);
  if (item) {
    const { listener, timeoutId } = item;
    window.removeEventListener('message', listener);
    clearTimeout(timeoutId);
    pageScriptListeners.delete(messageId);
    debugLog(`清理 page script 監聽器: ${messageId}`);
  }
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

/**
 * 請求注入 page script
 * @returns {Promise<void>}
 */
export function requestPageScriptInjection() {
  debugLog('請求注入 page script');

  return new Promise((resolve, reject) => {
    // 檢查是否已經存在
    if (isPageScriptAvailable()) {
      debugLog('Page script 已存在');
      resolve();
      return;
    }

    // 觸發注入事件
    const event = new CustomEvent('subpal-inject-page-script', {
      detail: { timestamp: Date.now() }
    });
    window.dispatchEvent(event);

    // 等待注入完成
    waitForPageScript(10000)
      .then(() => {
        debugLog('Page script 注入成功');
        resolve();
      })
      .catch(reject);
  });
}

