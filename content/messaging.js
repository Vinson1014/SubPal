/**
 * 字幕助手擴充功能 - 消息傳遞模組
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
  
  try {
    // 設置消息監聽器，使用 window.addEventListener 而不是直接使用 chrome API
    console.log('設置消息監聽器...');
    window.addEventListener('message', (event) => {
      // 確保消息來自我們的擴充功能橋接器
      if (event.source !== window || !event.data || !event.data.type || 
          !event.data.from || event.data.from !== 'SUBTITLE_ASSISTANT_BRIDGE') {
        return;
      }
      
      console.log('收到來自橋接器的消息:', event.data.type, event.data);
      
      // 只處理從橋接器轉發的 Chrome 消息
      if (event.data.type === 'CHROME_MESSAGE') {
        console.log('處理從橋接器轉發的 Chrome 消息:', event.data.data);
        handleMessage(event.data.data, event.data.sender, (response) => {
          console.log('發送回應到橋接器:', response);
          // 將回應發送回橋接器
          window.postMessage({
            type: 'RESPONSE',
            from: 'SUBTITLE_ASSISTANT',
            id: event.data.id,
            data: response
          }, '*');
        });
      } else if (event.data.type === 'RESPONSE') {
        console.log('收到來自橋接器的回應:', event.data);
      }
    });
    
    // 通知 background script 內容腳本已加載
    console.log('通知 background script 內容腳本已加載...');
    sendMessage({
      type: 'CONTENT_SCRIPT_LOADED'
    })
    .then(response => {
      console.log('收到 background script 的回應:', response);
    })
    .catch(error => {
      console.error('通知 background script 時出錯:', error);
    });
    
    console.log('消息傳遞模組初始化完成');
  } catch (error) {
    console.error('初始化消息傳遞模組時出錯:', error);
  }
}

/**
 * 處理接收到的消息
 * @param {Object} message - 消息對象
 * @param {Object} sender - 發送者信息
 * @param {Function} sendResponse - 回應函數
 * @returns {boolean} - 是否需要保持連接開啟
 */
function handleMessage(message, sender, sendResponse) {
  console.log('處理接收到的消息:', message.type, message);
  console.log('消息發送者:', sender);
  
  // 檢查消息格式
  if (!message || !message.type) {
    console.error('無效的消息格式:', message);
    sendResponse({ error: '無效的消息格式' });
    return false;
  }
  
  // 檢查是否有對應的消息處理器
  if (messageHandlers.has(message.type)) {
    const handler = messageHandlers.get(message.type);
    console.log(`找到消息類型 "${message.type}" 的處理器`);
    
    try {
      // 調用處理器並獲取結果
      console.log(`調用消息類型 "${message.type}" 的處理器...`);
      const result = handler(message, sender);
      
      // 如果結果是 Promise，則等待其解析後回應
      if (result instanceof Promise) {
        console.log(`消息類型 "${message.type}" 的處理器返回 Promise，等待解析...`);
        
        result.then(response => {
          console.log(`消息類型 "${message.type}" 的 Promise 已解析:`, response);
          sendResponse(response);
        }).catch(error => {
          console.error(`消息類型 "${message.type}" 的 Promise 解析出錯:`, error);
          sendResponse({ error: error.message });
        });
        
        // 返回 true 表示將異步發送回應
        console.log(`返回 true 表示將異步發送回應`);
        return true;
      }
      
      // 否則直接回應
      console.log(`消息類型 "${message.type}" 的處理器返回同步結果:`, result);
      sendResponse(result);
    } catch (error) {
      console.error(`處理消息類型 "${message.type}" 時出錯:`, error);
      sendResponse({ error: error.message });
    }
  } else if (messageHandlers.has('*')) {
    // 嘗試使用通用處理器
    console.log(`未找到消息類型 "${message.type}" 的處理器，嘗試使用通用處理器`);
    const handler = messageHandlers.get('*');
    
    try {
      // 調用通用處理器
      console.log(`調用通用處理器...`);
      const result = handler(message, sender);
      
      // 如果結果是 Promise，則等待其解析後回應
      if (result instanceof Promise) {
        console.log(`通用處理器返回 Promise，等待解析...`);
        
        result.then(response => {
          console.log(`通用處理器的 Promise 已解析:`, response);
          sendResponse(response);
        }).catch(error => {
          console.error(`通用處理器的 Promise 解析出錯:`, error);
          sendResponse({ error: error.message });
        });
        
        // 返回 true 表示將異步發送回應
        console.log(`返回 true 表示將異步發送回應`);
        return true;
      }
      
      // 否則直接回應
      console.log(`通用處理器返回同步結果:`, result);
      sendResponse(result);
    } catch (error) {
      console.error(`通用處理器處理消息時出錯:`, error);
      sendResponse({ error: error.message });
    }
  } else {
    // 如果沒有對應的處理器，則回應未處理
    console.warn(`未找到消息類型 "${message.type}" 的處理器，且沒有通用處理器`);
    sendResponse({ error: `未處理的消息類型: ${message.type}` });
  }
  
  // 返回 false 表示不需要保持連接開啟
  console.log(`返回 false 表示不需要保持連接開啟`);
  return false;
}

/**
 * 發送消息到 background script
 * @param {Object} message - 消息對象
 * @returns {Promise<any>} - 回應 Promise
 */
export function sendMessage(message) {
  console.log('發送消息:', message);
  
  return new Promise((resolve, reject) => {
    try {
      // 生成唯一消息 ID
      const messageId = Date.now() + Math.random().toString(36).substr(2, 9);
      console.log(`生成消息 ID: ${messageId}`);
      
      // 創建消息處理器
      const messageHandler = (event) => {
        // 確保消息來自我們的擴充功能橋接器
        if (event.source !== window || !event.data || !event.data.type || 
            !event.data.from || event.data.from !== 'SUBTITLE_ASSISTANT_BRIDGE') {
          return;
        }
        
        // 檢查是否是對我們發送的消息的回應
        if (event.data.type === 'RESPONSE' && event.data.id === messageId) {
          console.log(`收到消息 ID ${messageId} 的回應:`, event.data.data);
          
          // 移除消息處理器
          window.removeEventListener('message', messageHandler);
          console.log(`移除消息 ID ${messageId} 的處理器`);
          
          // 解析 Promise
          resolve(event.data.data);
        }
      };
      
      // 添加消息處理器
      console.log(`添加消息 ID ${messageId} 的處理器`);
      window.addEventListener('message', messageHandler);
      
      // 通過 postMessage 發送消息到橋接器
      console.log(`發送消息 ID ${messageId} 到橋接器:`, message);
      window.postMessage({
        type: 'SEND_TO_BACKGROUND',
        from: 'SUBTITLE_ASSISTANT',
        id: messageId,
        target: 'BACKGROUND',
        data: message
      }, '*');
      
      // 設置超時
      console.log(`設置消息 ID ${messageId} 的超時處理`);
      setTimeout(() => {
        console.log(`消息 ID ${messageId} 超時`);
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
  console.log(`註冊消息處理器: ${messageType}`);
  
  // 檢查參數
  if (!messageType) {
    console.error('無效的消息類型:', messageType);
    return;
  }
  
  if (!handler || typeof handler !== 'function') {
    console.error(`無效的處理函數，消息類型: ${messageType}`, handler);
    return;
  }
  
  // 檢查是否已存在處理器
  if (messageHandlers.has(messageType)) {
    console.warn(`覆蓋現有的消息處理器: ${messageType}`);
  }
  
  // 創建包裝處理器，添加日誌
  const wrappedHandler = (message, sender) => {
    console.log(`調用消息類型 "${messageType}" 的處理器:`, message);
    
    try {
      // 調用原始處理器
      return handler(message, sender);
    } catch (error) {
      console.error(`消息類型 "${messageType}" 的處理器出錯:`, error);
      throw error;
    }
  };
  
  // 註冊處理器
  messageHandlers.set(messageType, wrappedHandler);
  console.log(`成功註冊消息處理器: ${messageType}`);
}

/**
 * 註冊消息監聽器
 * @param {Function} callback - 回調函數，接收消息對象
 */
export function onMessage(callback) {
  console.log('註冊消息監聽器...');
  
  if (!callback || typeof callback !== 'function') {
    console.error('無效的回調函數:', callback);
    return;
  }
  
  // 創建包裝回調函數，添加日誌
  const wrappedCallback = (message, sender) => {
    console.log('消息監聽器被觸發:', message);
    
    try {
      // 調用原始回調函數
      const result = callback(message, sender);
      
      // 如果結果是 Promise，則添加日誌
      if (result instanceof Promise) {
        return result
          .then(response => {
            console.log('消息監聽器回應:', response);
            return response;
          })
          .catch(error => {
            console.error('消息監聽器出錯:', error);
            throw error;
          });
      }
      
      // 否則直接返回結果
      console.log('消息監聽器同步回應:', result);
      return result;
    } catch (error) {
      console.error('消息監聽器處理時出錯:', error);
      throw error;
    }
  };
  
  // 註冊通用消息處理器
  registerMessageHandler('*', wrappedCallback);
  
  console.log('消息監聽器註冊完成');
}
