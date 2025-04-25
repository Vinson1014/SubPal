// content.js
// 內容腳本 - 作為 background 和 page context (content/index.js) 之間的消息橋樑

(function() {
  // 檢查 chrome.runtime 是否可用
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    console.error('[Content Script] chrome.runtime is not available. Extension messaging will not work.');
    return;
  }
  console.log('[Content Script] Initializing message bridge...');

  let initialDebugMode = false; // 預設值

  // 1. 監聽來自 page context (messaging.js) 的消息事件
  window.addEventListener('messageToContentScript', (event) => {
    const { messageId, message } = event.detail;
    console.log('[Content Script] Received from page:', messageId, message);

    // 將消息轉發到 background script
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Content Script] Error sending message to background:', chrome.runtime.lastError.message, 'Original message:', message);
        // 將錯誤回傳給 page context
        window.dispatchEvent(new CustomEvent('responseFromContentScript', {
          detail: { messageId, response: { error: chrome.runtime.lastError.message } }
        }));
      } else {
        console.log('[Content Script] Received response from background:', response);
        // 將 background 的回應轉發回 page context
        window.dispatchEvent(new CustomEvent('responseFromContentScript', {
          detail: { messageId, response }
        }));
      }
    });
  });

  // 2. 監聽來自 background script 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Content Script] Received from background:', message, sender);

    // 將消息轉發到 page context (messaging.js)
    // 注意：這裡無法直接獲取 page context 的回應，因為 CustomEvent 是單向的
    // 如果 background 需要 page context 的回應，應透過 content script 發起請求
    const detail = { message, sender: { id: sender.id, url: sender.url, tab: sender.tab } }; // 簡化 sender 信息
    window.dispatchEvent(new CustomEvent('messageFromContentScript', { detail }));

    // 處理特定的 background 請求，例如更新 debug 模式
    if (message.type === 'TOGGLE_DEBUG_MODE') {
       initialDebugMode = message.debugMode;
       // 將 debug 狀態同步給 page context
       window.dispatchEvent(new CustomEvent('messageFromContentScript', {
         detail: { message: { type: 'SET_DEBUG_MODE', debugMode: initialDebugMode } }
       }));
    }

    // Content script 通常不需要同步回應 background，除非有特殊需求
    // sendResponse({ received: true });
    return false; // 表示不會異步回應
  });

  // 3. 獲取初始 debugMode 並注入腳本
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS', keys: ['debugMode'] }, (res) => {
    if (chrome.runtime.lastError) {
      console.warn('[Content Script] Failed to get initial settings:', chrome.runtime.lastError.message);
    } else if (res && res.success && typeof res.debugMode === 'boolean') {
      initialDebugMode = res.debugMode;
      console.log('[Content Script] Initial debug mode:', initialDebugMode);
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
      script.onload = () => console.log('[Content Script] Page context script (content/index.js) loaded.');
      script.onerror = (err) => console.error('[Content Script] Failed to load page context script (content/index.js):', err);
      (document.head || document.documentElement).appendChild(script);
      console.log('[Content Script] Injected page context script.');
    } catch (e) {
      console.error('[Content Script] Error injecting page context script:', e);
    }
  });

  console.log('[Content Script] Message bridge initialized.');
})();
