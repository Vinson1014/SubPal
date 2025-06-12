// content.js
// 內容腳本 - 作為 background 和 page context (content/index.js) 之間的消息橋樑
// 使用 chrome.runtime.connect 建立長連接以提高穩定性

(function() {
  let debugMode = false; // 控制調試日誌輸出

  function debugLog(...args) {
    if (debugMode) {
      console.log('[Content Script]', ...args);
    }
  }

  // 檢查 chrome.runtime 是否可用
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) {
    console.error('[Content Script] chrome.runtime is not available. Extension messaging will not work.');
    return;
  }
  debugLog('Initializing message bridge with long-lived connection...');

  let initialDebugMode = false; // 預設值
  let messageCounter = 0; // 用於生成唯一訊息 ID 的計數器
  let backgroundPort = null; // 長連接 port

  // 建立到 background script 的長連接
  function connectToBackground() {
    backgroundPort = chrome.runtime.connect({ name: "subtitle-assistant-channel" });
    debugLog('Connected to background script.');

    // 監聽來自 background 的消息
    backgroundPort.onMessage.addListener((message) => {
      debugLog('Received from background (port):', message.type, message);

      // 將 background 的回應轉發回 page context (messaging.js)
      // 使用 CustomEvent 傳遞消息和 messageId
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: { messageId: message.messageId, response: message.response }
      }));

      // 處理特定的 background 請求，例如更新 debug 模式
      if (message.type === 'TOGGLE_DEBUG_MODE') {
        debugMode = message.debugMode; // 更新 debugMode
        // 將 debug 狀態同步給 page context
        debugLog('Syncing debug mode to page context:', debugMode);
        window.dispatchEvent(new CustomEvent('messageFromContentScript', {
          detail: { message: { type: 'SET_DEBUG_MODE', debugMode: debugMode } }
        }));
      }
    });

    // 監聽連接斷開事件
    backgroundPort.onDisconnect.addListener(() => {
      console.warn('[Content Script] Disconnected from background script. Attempting to reconnect...');
      backgroundPort = null;
      // 在一段時間後嘗試重新連接
      setTimeout(connectToBackground, 1000); // 1秒後重試
    });

    // 獲取初始 debugMode 並注入腳本 (通過新連接發送消息)
    // 使用一個臨時的 messageId 來處理這個單次請求的響應
    const initialDebugMessageId = generateUniqueMessageId('GET_DEBUG_MODE_INITIAL');
    // 監聽這個特定 messageId 的響應
    const initialDebugListener = (event) => {
      if (event.detail.messageId === initialDebugMessageId) {
        window.removeEventListener('responseFromContentScript', initialDebugListener);
        const res = event.detail.response;
        if (res && res.success && typeof res.debugMode === 'boolean') {
          initialDebugMode = res.debugMode;
          debugMode = res.debugMode; // 同步初始 debugMode 到 debugMode 變量
          debugLog('Initial debug mode:', initialDebugMode);
        } else {
           console.warn('[Content Script] Failed to get initial settings via port:', res?.error);
        }

        // 將初始 debug 狀態發送給 page context
        window.dispatchEvent(new CustomEvent('messageFromContentScript', {
          detail: { message: { type: 'SET_DEBUG_MODE', debugMode: initialDebugMode } }
        }));

        // 動態插入模組化入口腳本 (content/index.js)
        // 這個腳本將運行在 page context，可以訪問 messaging.js
        try {
          const script = document.createElement('script');
          script.type = 'module';
          script.src = chrome.runtime.getURL('content/index.js');
          script.onload = () => debugLog('Page context script (content/index.js) loaded.');
          script.onerror = (err) => console.error('[Content Script] Failed to load page context script (content/index.js):', err);
          (document.head || document.documentElement).appendChild(script);
          debugLog('Injected page context script.');
        } catch (e) {
          console.error('[Content Script] Error injecting page context script:', e);
        }
      }
    };
    window.addEventListener('responseFromContentScript', initialDebugListener);

    // 通過 port 發送獲取 debug mode 的請求
    backgroundPort.postMessage({ messageId: initialDebugMessageId, message: { type: 'GET_SETTINGS', keys: ['debugMode'] } });
  }

  // 1. 監聽來自 page context (messaging.js) 的消息事件
  window.addEventListener('messageToContentScript', (event) => {
    const { messageId, message } = event.detail;
    debugLog('Received from page:', messageId, message);

    // 生成唯一的訊息 ID，如果未提供
    const uniqueMessageId = messageId || generateUniqueMessageId(message.type);

    if (backgroundPort && backgroundPort.postMessage) {
      debugLog('Forwarding message to background (port):', uniqueMessageId, message.type);
      // 通過 port 發送消息，包含 messageId
      backgroundPort.postMessage({ messageId: uniqueMessageId, message: message });
      // 注意：這裡不再需要設置超時，因為 messaging.js 已經處理了超時
    } else {
      console.error('[Content Script] Background port is not connected. Cannot send message:', uniqueMessageId, message.type);
      // 如果 port 未連接，立即向 page context 發送錯誤響應
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: { messageId: uniqueMessageId, response: { error: 'Background service is unavailable.' } }
      }));
    }
  });

  // 移除舊的 chrome.runtime.onMessage 監聽器，因為我們現在使用 port
  // chrome.runtime.onMessage.addListener(...) // 這部分將被移除

  // 生成唯一訊息 ID 的輔助函數
  function generateUniqueMessageId(messageType) {
    messageCounter++;
    return `content_msg_${Date.now()}_${messageCounter}_${messageType}`;
  }

  // 建立初始連接
  connectToBackground();

  debugLog('Message bridge initialized.');
})();
