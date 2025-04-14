/**
 * Netflix 字幕優化擴充功能 - 消息傳遞模組
 * 
 * 這個模組負責處理與 background script 和 popup 的通信。
 */

// 消息處理回調函數
const messageHandlers = new Map();

/**
 * 初始化消息傳遞模組
 */
export function initMessaging() {
  console.log('初始化消息傳遞模組...');
  
  // 設置消息監聽器，使用 window.addEventListener 而不是直接使用 chrome API
  window.addEventListener('message', (event) => {
    // 確保消息來自我們的擴充功能橋接器
    if (event.source !== window || !event.data || !event.data.type || 
        !event.data.from || event.data.from !== 'NETFLIX_SUBTITLE_OPTIMIZER_BRIDGE') {
      return;
    }
    
    // 只處理從橋接器轉發的 Chrome 消息
    if (event.data.type === 'CHROME_MESSAGE') {
      handleMessage(event.data.data, event.data.sender, (response) => {
        // 將回應發送回橋接器
        window.postMessage({
          type: 'RESPONSE',
          from: 'NETFLIX_SUBTITLE_OPTIMIZER',
          id: event.data.id,
          data: response
        }, '*');
      });
    }
  });
  
  // 通知 background script 內容腳本已加載
  sendMessage({
    type: 'CONTENT_SCRIPT_LOADED'
  });
  
  console.log('消息傳遞模組初始化完成');
}

/**
 * 處理接收到的消息
 * @param {Object} message - 消息對象
 * @param {Object} sender - 發送者信息
 * @param {Function} sendResponse - 回應函數
 * @returns {boolean} - 是否需要保持連接開啟
 */
function handleMessage(message, sender, sendResponse) {
  console.log('收到消息:', message.type);
  
  // 檢查是否有對應的消息處理器
  if (messageHandlers.has(message.type)) {
    const handler = messageHandlers.get(message.type);
    
    try {
      // 調用處理器並獲取結果
      const result = handler(message, sender);
      
      // 如果結果是 Promise，則等待其解析後回應
      if (result instanceof Promise) {
        result.then(sendResponse).catch(error => {
          console.error('處理消息時出錯:', error);
          sendResponse({ error: error.message });
        });
        
        // 返回 true 表示將異步發送回應
        return true;
      }
      
      // 否則直接回應
      sendResponse(result);
    } catch (error) {
      console.error('處理消息時出錯:', error);
      sendResponse({ error: error.message });
    }
  } else {
    // 如果沒有對應的處理器，則回應未處理
    console.log('未處理的消息類型:', message.type);
  }
  
  // 返回 false 表示不需要保持連接開啟
  return false;
}

/**
 * 發送消息到 background script
 * @param {Object} message - 消息對象
 * @returns {Promise<any>} - 回應 Promise
 */
export function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      // 生成唯一消息 ID
      const messageId = Date.now() + Math.random().toString(36).substr(2, 9);
      
      // 創建消息處理器
      const messageHandler = (event) => {
        // 確保消息來自我們的擴充功能橋接器
        if (event.source !== window || !event.data || !event.data.type || 
            !event.data.from || event.data.from !== 'NETFLIX_SUBTITLE_OPTIMIZER_BRIDGE') {
          return;
        }
        
        // 檢查是否是對我們發送的消息的回應
        if (event.data.type === 'RESPONSE' && event.data.id === messageId) {
          // 移除消息處理器
          window.removeEventListener('message', messageHandler);
          
          // 解析 Promise
          resolve(event.data.data);
        }
      };
      
      // 添加消息處理器
      window.addEventListener('message', messageHandler);
      
      // 通過 postMessage 發送消息到橋接器
      window.postMessage({
        type: 'SEND_TO_BACKGROUND',
        from: 'NETFLIX_SUBTITLE_OPTIMIZER',
        id: messageId,
        target: 'BACKGROUND',
        data: message
      }, '*');
      
      // 設置超時
      setTimeout(() => {
        window.removeEventListener('message', messageHandler);
        reject(new Error('發送消息超時'));
      }, 5000);
    } catch (error) {
      console.error('發送消息時出錯:', error);
      reject(error);
    }
  });
}

/**
 * 註冊消息處理器
 * @param {string} messageType - 消息類型
 * @param {Function} handler - 處理函數
 */
export function registerMessageHandler(messageType, handler) {
  messageHandlers.set(messageType, handler);
  console.log(`已註冊消息處理器: ${messageType}`);
}

/**
 * 註冊消息監聽器
 * @param {Function} callback - 回調函數，接收消息對象
 */
export function onMessage(callback) {
  // 註冊通用消息處理器
  registerMessageHandler('*', (message, sender) => {
    return callback(message, sender);
  });
}
