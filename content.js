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

  let messageCounter = 0; // 用於生成唯一訊息 ID 的計數器
  let backgroundPort = null; // 長連接 port
  let configManager = null; // ConfigManager 實例
  let submissionQueueManager = null; // SubmissionQueueManager 實例

  // 隊列消息類型常數
  const QUEUE_MESSAGE_TYPES = [
    'VOTE_ENQUEUE', 'VOTE_GET_HISTORY', 'VOTE_GET_STATUS', 'VOTE_RETRY',
    'TRANSLATION_ENQUEUE', 'TRANSLATION_GET_HISTORY', 'TRANSLATION_RETRY',
    'GET_ALL_PENDING', 'GET_QUEUE_STATS'
  ];

  // 初始化 ConfigManager
  async function initializeConfigManager() {
    try {
      // 先直接從 storage 讀取 debugMode，以便早期的 debugLog 能正常工作
      try {
        const result = await chrome.storage.local.get('debugMode');
        if (result.debugMode !== undefined) {
          debugMode = result.debugMode;
        }
      } catch (e) {
        // 讀取失敗，使用預設值
      }

      debugLog('開始初始化 ConfigManager...');

      // 動態導入 ConfigManager 和 getAllConfigKeys
      const { ConfigManager } = await import(chrome.runtime.getURL('content/system/config/config-manager.js'));
      const { getAllConfigKeys } = await import(chrome.runtime.getURL('content/system/config/config-schema.js'));
      // 創建實例
      configManager = new ConfigManager({ debug: debugMode });

      // 初始化
      await configManager.initialize();

      // 訂閱所有配置變更，統一轉發到 page context
      // 當 Options Page 直接修改 storage 時，ConfigManager 會收到通知
      // 這裡訂閱所有配置的變更，並轉發為 CONFIG_CHANGED 消息
      const allConfigKeys = getAllConfigKeys();
      configManager.subscribe(allConfigKeys, (key, newValue, oldValue) => {
        debugLog('ConfigManager 配置變更:', key, newValue, oldValue);

        // 轉發 CONFIG_CHANGED 消息到 page context
        // 利用原本設計好的 messaging system
        window.dispatchEvent(new CustomEvent('messageFromContentScript', {
          detail: {
            message: {
              type: 'CONFIG_CHANGED',
              key: key,
              newValue: newValue,
              oldValue: oldValue
            }
          }
        }));
      });

      // 從 ConfigManager 讀取初始 debugMode
      debugMode = configManager.get('debugMode') || false;
      debugLog('從 ConfigManager 讀取初始 debugMode:', debugMode);

      // 訂閱 debugMode 變更，保持 content script 的 debugLog 功能同步
      configManager.subscribe('debugMode', (key, newValue, oldValue) => {
        debugMode = newValue;
        debugLog('Content script debugMode 已更新:', oldValue, '->', newValue);
      });

      debugLog('ConfigManager 初始化完成');
      return true;
    } catch (error) {
      console.error('[Content Script] ConfigManager 初始化失敗:', error);
      return false;
    }
  }

  // 初始化 SubmissionQueueManager
  async function initializeQueueManagers() {
    try {
      debugLog('開始初始化 SubmissionQueueManager...');

      // 動態導入 SubmissionQueueManager
      const { SubmissionQueueManager } = await import(chrome.runtime.getURL('content/core/submission-queue-manager.js'));

      // 創建實例
      submissionQueueManager = new SubmissionQueueManager({ debug: debugMode });

      // 初始化
      await submissionQueueManager.initialize();

      debugLog('SubmissionQueueManager 初始化完成');
      return true;
    } catch (error) {
      console.error('[Content Script] SubmissionQueueManager 初始化失敗:', error);
      return false;
    }
  }

  // 注入 page context script (content/index.js)
  function injectPageContextScript() {
    try {
      debugLog('注入 page context script (content/index.js)...');
      const script = document.createElement('script');
      script.type = 'module';
      script.src = chrome.runtime.getURL('content/index.js');
      script.onload = () => debugLog('Page context script (content/index.js) loaded.');
      script.onerror = (err) => console.error('[Content Script] Failed to load page context script (content/index.js):', err);
      (document.head || document.documentElement).appendChild(script);
      debugLog('Page context script injected.');
    } catch (e) {
      console.error('[Content Script] Error injecting page context script:', e);
    }
  }

  // 處理配置相關訊息
  function handleConfigMessage(messageId, message) {
    if (!configManager) {
      debugLog('ConfigManager 尚未初始化，回應錯誤');
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: 'ConfigManager not initialized'
          }
        }
      }));
      return;
    }

    // 處理不同類型的配置訊息
    switch (message.type) {
      case 'CONFIG_GET_ALL':
        handleConfigGetAll(messageId);
        break;

      case 'CONFIG_GET':
        handleConfigGet(messageId, message.key);
        break;

      case 'CONFIG_SET':
        handleConfigSet(messageId, message.key, message.value);
        break;

      case 'CONFIG_SET_MULTIPLE':
        handleConfigSetMultiple(messageId, message.items);
        break;

      default:
        debugLog('未知的配置訊息類型:', message.type);
        window.dispatchEvent(new CustomEvent('responseFromContentScript', {
          detail: {
            messageId: messageId,
            response: {
              success: false,
              error: `Unknown config message type: ${message.type}`
            }
          }
        }));
    }
  }

  // CONFIG_GET_ALL 處理
  async function handleConfigGetAll(messageId) {
    try {
      const config = configManager.getAll();
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true,
            config: config
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_GET_ALL 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // CONFIG_GET 處理
  async function handleConfigGet(messageId, key) {
    try {
      const value = configManager.get(key);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true,
            value: value
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_GET 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // CONFIG_SET 處理
  async function handleConfigSet(messageId, key, value) {
    try {
      const oldValue = configManager.get(key);
      await configManager.set(key, value);

      // 廣播配置變更到 page context
      window.dispatchEvent(new CustomEvent('messageFromContentScript', {
        detail: {
          message: {
            type: 'CONFIG_CHANGED',
            key: key,
            newValue: value,
            oldValue: oldValue
          }
        }
      }));

      // 回應成功
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_SET 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // CONFIG_SET_MULTIPLE 處理
  async function handleConfigSetMultiple(messageId, items) {
    try {
      const oldValues = {};
      for (const key of Object.keys(items)) {
        oldValues[key] = configManager.get(key);
      }

      await configManager.setMultiple(items);

      // 廣播每個配置變更到 page context
      for (const [key, newValue] of Object.entries(items)) {
        window.dispatchEvent(new CustomEvent('messageFromContentScript', {
          detail: {
            message: {
              type: 'CONFIG_CHANGED',
              key: key,
              newValue: newValue,
              oldValue: oldValues[key]
            }
          }
        }));
      }

      // 回應成功
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_SET_MULTIPLE 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // 處理隊列相關訊息
  async function handleQueueMessage(messageId, message) {
    if (!submissionQueueManager) {
      debugLog('SubmissionQueueManager 尚未初始化，回應錯誤');
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            error: 'SubmissionQueueManager not initialized'
          }
        }
      }));
      return;
    }

    const { type, payload } = message;

    try {
      let result;

      switch (type) {
        // 投票消息
        case 'VOTE_ENQUEUE':
          result = await submissionQueueManager.enqueueVote(payload);
          break;

        case 'VOTE_GET_HISTORY':
          result = await submissionQueueManager.getVoteHistory(payload?.limit);
          result = { history: result };
          break;

        case 'VOTE_GET_STATUS':
          result = await submissionQueueManager.getVoteStatus(payload.itemId);
          break;

        case 'VOTE_RETRY':
          result = await submissionQueueManager.retryVote(payload.itemId);
          result = { success: result };
          break;

        // 翻譯消息
        case 'TRANSLATION_ENQUEUE':
          result = await submissionQueueManager.enqueueTranslation(payload);
          break;

        case 'TRANSLATION_GET_HISTORY':
          result = await submissionQueueManager.getTranslationHistory(payload?.limit);
          result = { history: result };
          break;

        case 'TRANSLATION_RETRY':
          result = await submissionQueueManager.retryTranslation(payload.itemId);
          result = { success: result };
          break;

        // 通用消息
        case 'GET_ALL_PENDING':
          result = await submissionQueueManager.getAllPending();
          break;

        case 'GET_QUEUE_STATS':
          result = await submissionQueueManager.getStats();
          break;

        default:
          window.dispatchEvent(new CustomEvent('responseFromContentScript', {
            detail: {
              messageId: messageId,
              response: {
                error: `未知的消息類型: ${type}`
              }
            }
          }));
          return;
      }

      // 回應成功
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: result
        }
      }));
    } catch (error) {
      debugLog('處理隊列消息失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            error: error.message
          }
        }
      }));
    }
  }

  // 建立到 background script 的長連接
  function connectToBackground() {
    backgroundPort = chrome.runtime.connect({ name: "subtitle-assistant-channel" });
    debugLog('Connected to background script.');

    // 監聽來自 background 的消息
    backgroundPort.onMessage.addListener((message) => {
      debugLog('Received from background (port):', message.type, message);

      // 處理廣播消息（沒有 messageId 或特定 messageId）
      if (message.messageId === 'subtitle-style-broadcast' ||
          message.response?.type) {
        // 將廣播消息轉發給 messaging.js 作為內部事件
        window.dispatchEvent(new CustomEvent('messageFromContentScript', {
          detail: {
            message: message.response || message,
            messageId: message.messageId,
            sender: 'background'
          }
        }));
      } else {
        // 將 background 的回應轉發回 page context (messaging.js)
        window.dispatchEvent(new CustomEvent('responseFromContentScript', {
          detail: { messageId: message.messageId, response: message.response }
        }));
      }
    });

    // 監聽連接斷開事件
    backgroundPort.onDisconnect.addListener(() => {
      console.warn('[Content Script] Disconnected from background script. Attempting to reconnect...');
      backgroundPort = null;
      setTimeout(connectToBackground, 1000);
    });
  }

  // 1. 監聽來自 page context (messaging.js) 的消息事件
  window.addEventListener('messageToContentScript', (event) => {
    const { messageId, message } = event.detail;
    debugLog('Received from page:', messageId, message);

    // 檢查是否為配置相關訊息（由 content script 處理，不轉發到 background）
    const configMessages = ['CONFIG_GET_ALL', 'CONFIG_GET', 'CONFIG_SET', 'CONFIG_SET_MULTIPLE'];

    if (configMessages.includes(message.type)) {
      debugLog('處理配置訊息:', message.type);
      handleConfigMessage(messageId, message);
      return;
    }

    // 檢查是否為隊列相關訊息（由 content script 處理，不轉發到 background）
    if (QUEUE_MESSAGE_TYPES.includes(message.type)) {
      debugLog('處理隊列訊息:', message.type);
      handleQueueMessage(messageId, message);
      return;
    }

    // 檢查是否為內部消息（不需要發送到 background）
    const internalMessages = ['SUBTITLE_READY', 'RAW_TTML_INTERCEPTED'];

    if (internalMessages.includes(message.type)) {
      debugLog('處理內部消息:', message.type);

      // 將內部消息分發給 page context 模組
      window.dispatchEvent(new CustomEvent('messageFromContentScript', {
        detail: {
          messageId: messageId,
          message: message
        }
      }));

      // 內部消息不需要回應，直接返回
      return;
    }

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

  // 監聽page script注入請求
  window.addEventListener('subpal-inject-page-script', (event) => {
    debugLog('收到page script注入請求');
    injectNetflixPageScript();
  });

  // 監聽來自page context的page script注入請求
  window.addEventListener('subpal-request-page-script-injection', (event) => {
    debugLog('收到來自page context的page script注入請求:', event.detail);
    injectNetflixPageScript();
  });

  // 注入Netflix page script
  function injectNetflixPageScript() {
    try {
      // 檢查是否已經注入
      if (window.subpalPageScript) {
        debugLog('Netflix page script已存在，跳過注入');
        return;
      }

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('netflix-page-script.js');
      script.onload = () => {
        debugLog('Netflix page script加載成功');
      };
      script.onerror = (error) => {
        console.error('Netflix page script加載失敗:', error);
      };
      
      (document.head || document.documentElement).appendChild(script);
      debugLog('Netflix page script注入完成');
    } catch (error) {
      console.error('注入Netflix page script時出錯:', error);
    }
  }

  // 建立初始連接
  connectToBackground();

  // 初始化所有 Managers
  async function initializeAllManagers() {
    try {
      // 先初始化 ConfigManager
      const configSuccess = await initializeConfigManager();
      if (!configSuccess) {
        console.error('[Content Script] ConfigManager 初始化失敗');
        // 即使失敗也繼續注入腳本，使用預設 debugMode
        injectPageContextScript();
        return;
      }

      // 再初始化 SubmissionQueueManager
      const queueSuccess = await initializeQueueManagers();
      if (!queueSuccess) {
        console.error('[Content Script] SubmissionQueueManager 初始化失敗');
      }

      debugLog('All managers initialized.');

      // ConfigManager 初始化完成後，立即注入 page context script
      injectPageContextScript();

    } catch (error) {
      console.error('[Content Script] Managers 初始化過程中發生錯誤:', error);
      // 發生錯誤時仍嘗試注入腳本
      injectPageContextScript();
    }
  }

  // 執行初始化
  initializeAllManagers();

  debugLog('Message bridge initialized.');
})();
