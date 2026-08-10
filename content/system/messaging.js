// content/messaging.js

// 註冊的內部事件處理器，支持多個處理函數
const internalEventHandlers = new Map();
const CONTENT_SCRIPT_BRIDGE_KEYS = new Set(['message', 'messageId']);
const VIDEO_ID_CHANGED_KEYS = new Set(['type', 'oldVideoId', 'newVideoId', 'videoId']);
const SUBTITLE_SOURCE_CHANGED_KEYS = new Set(['type', 'generation']);
const VIDEO_ID_FIELDS = ['oldVideoId', 'newVideoId', 'videoId'];
const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);
const OBJECT_PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype).sort();

// 調試模式開關 (由 content.js 控制)
let debugMode = false;
let messagingInitializationPromise = null;

/**
 * 僅在 debugMode 開啟時輸出日誌
 */
function debugLog(...args) {
  if (debugMode) {
    console.log('[Messaging]', ...args);
  }
}

function hasPlainObjectPrototype(value, allowNullPrototype = false) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return allowNullPrototype;
  if (Object.getPrototypeOf(prototype) !== null) return false;

  const prototypeKeys = Object.getOwnPropertyNames(prototype).sort();
  if (prototypeKeys.length !== OBJECT_PROTOTYPE_KEYS.length || prototypeKeys.some((key, index) => key !== OBJECT_PROTOTYPE_KEYS[index])) {
    return false;
  }
  const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return Boolean(
    constructor && Object.hasOwn(constructor, 'value') && typeof constructor.value === 'function' &&
    Function.prototype.toString.call(constructor.value) === OBJECT_CONSTRUCTOR_SOURCE
  );
}

function parseVideoIdChangedMessage(message) {
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !hasPlainObjectPrototype(message)) {
      return null;
    }
    if (Object.getOwnPropertySymbols(message).length !== 0) return null;

    const keys = Object.getOwnPropertyNames(message);
    if (!keys.includes('type') || keys.some((key) => !VIDEO_ID_CHANGED_KEYS.has(key))) return null;

    const values = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(message, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      values[key] = descriptor.value;
    }
    if (values.type !== 'VIDEO_ID_CHANGED') return null;

    const parsed = { type: 'VIDEO_ID_CHANGED' };
    for (const key of VIDEO_ID_FIELDS) {
      if (!Object.hasOwn(values, key)) continue;
      const value = values[key];
      if (value === null) {
        parsed[key] = null;
      } else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
        parsed[key] = String(value);
      } else {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseSubtitleSourceChangedMessage(message) {
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !hasPlainObjectPrototype(message)) {
      return null;
    }
    if (Object.getOwnPropertySymbols(message).length !== 0) return null;

    const keys = Object.getOwnPropertyNames(message);
    if (keys.length !== 2 || keys.some((key) => !SUBTITLE_SOURCE_CHANGED_KEYS.has(key))) return null;
    const type = Object.getOwnPropertyDescriptor(message, 'type');
    const generation = Object.getOwnPropertyDescriptor(message, 'generation');
    if (!type || !generation || !Object.hasOwn(type, 'value') || !Object.hasOwn(generation, 'value') ||
        type.enumerable !== true || generation.enumerable !== true ||
        type.value !== 'SUBTITLE_SOURCE_CHANGED' ||
        !Number.isInteger(generation.value) || generation.value < 0) {
      return null;
    }
    return { type: 'SUBTITLE_SOURCE_CHANGED', generation: generation.value };
  } catch {
    return null;
  }
}

function parseContentScriptBridgeMessage(event) {
  try {
    const detail = event.detail;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail) || !hasPlainObjectPrototype(detail, true)) return null;
    if (Object.getOwnPropertySymbols(detail).length !== 0) return null;

    const keys = Object.getOwnPropertyNames(detail);
    if (!keys.includes('message') || keys.some((key) => !CONTENT_SCRIPT_BRIDGE_KEYS.has(key))) return null;

    const descriptors = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(detail, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      descriptors[key] = descriptor.value;
    }
    if (Object.hasOwn(descriptors, 'messageId') && typeof descriptors.messageId !== 'string') return null;
    return parseVideoIdChangedMessage(descriptors.message) ||
      parseSubtitleSourceChangedMessage(descriptors.message);
  } catch {
    return null;
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

  window.addEventListener('messageFromContentScript', (event) => {
    const message = parseContentScriptBridgeMessage(event);
    if (!message) return;

    debugLog(`收到 ${message.type} 消息，分發給內部事件處理器`);
    dispatchInternalEvent(message);
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
