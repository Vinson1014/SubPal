// content/messaging.js
// 消息傳遞模組 - 抽象層，與 content.js 透過 CustomEvent 通訊

// 註冊的消息處理器
const messageHandlers = new Map();

// 調試模式開關 (由 content.js 控制)
let debugMode = false;

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
  // 監聽來自 content.js 的消息事件
  window.addEventListener('messageFromContentScript', (event) => {
    const { message, sender } = event.detail;
    debugLog('收到來自 content.js 的消息', message, sender);

    // 更新 debugMode
    if (message.type === 'SET_DEBUG_MODE') {
      debugMode = message.debugMode;
      debugLog('Debug mode set to:', debugMode);
      return; // 不需進一步處理
    }

    const handler = messageHandlers.get(message.type) || messageHandlers.get('*');
    if (!handler) {
      debugLog('無處理器，類型:', message.type);
      // 無法直接 sendResponse，需要透過 content.js 回應
      window.dispatchEvent(new CustomEvent('responseToContentScript', {
        detail: { messageId: message.messageId, response: { error: `Unhandled message type: ${message.type}` } }
      }));
      return;
    }

    try {
      const result = handler(message, sender);
      if (result instanceof Promise) {
        result
          .then(res => {
            debugLog('異步回應', res);
            window.dispatchEvent(new CustomEvent('responseToContentScript', {
              detail: { messageId: message.messageId, response: res }
            }));
          })
          .catch(err => {
            console.error('異步處理錯誤:', err);
            window.dispatchEvent(new CustomEvent('responseToContentScript', {
              detail: { messageId: message.messageId, response: { error: err.message } }
            }));
          });
      } else {
        debugLog('同步回應', result);
        window.dispatchEvent(new CustomEvent('responseToContentScript', {
          detail: { messageId: message.messageId, response: result }
        }));
      }
    } catch (err) {
      console.error('處理消息時出錯:', err);
      window.dispatchEvent(new CustomEvent('responseToContentScript', {
        detail: { messageId: message.messageId, response: { error: err.message } }
      }));
    }
  });

  // 請求初始 debugMode 狀態
  sendMessage({ type: 'GET_DEBUG_MODE' }).then(res => {
    if (typeof res?.debugMode === 'boolean') {
      debugMode = res.debugMode;
      debugLog('Initial debug mode:', debugMode);
    }
  }).catch(err => console.warn('Failed to get initial debug mode:', err));

  debugLog('Messaging module initialized and listening for events.');
}


/**
 * 發送消息到 background 或 popup (透過 content.js)
 * @param {Object} message - 消息對象
 * @returns {Promise<any>}
 */
export function sendMessage(message) {
  debugLog('發送消息 (透過 content.js)', message);
  return new Promise((resolve, reject) => {
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const listener = (event) => {
      if (event.detail.messageId === messageId) {
        window.removeEventListener('responseFromContentScript', listener);
        debugLog('收到回應 (來自 content.js)', event.detail.response);
        if (event.detail.response?.error) {
          // 模擬 chrome.runtime.lastError
          const error = new Error(event.detail.response.error);
          console.error('sendMessage 失敗:', error);
          reject(error);
        } else {
          resolve(event.detail.response);
        }
      }
    };

    window.addEventListener('responseFromContentScript', listener);

    // 發送事件到 content.js
    window.dispatchEvent(new CustomEvent('messageToContentScript', {
      detail: { messageId, message }
    }));
  });
}

/**
 * 註冊消息處理器
 * @param {string} type - 消息類型，'*' 表示通用處理
 * @param {Function} handler - 處理函數 (message, sender) => result|Promise
 */
export function registerMessageHandler(type, handler) {
  if (!type || typeof handler !== 'function') {
    console.error('registerMessageHandler 參數錯誤', type, handler);
    return;
  }
  messageHandlers.set(type, handler);
  debugLog('註冊處理器', type);
}

/**
 * 高階接口：註冊通用消息回調
 * @param {Function} callback - (message, sender) => result|Promise
 */
export function onMessage(callback) {
  registerMessageHandler('*', callback);
}
