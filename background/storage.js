// storage.js - 負責處理與存儲相關的操作

let isDebugModeEnabled = false; // 快取 Debug 模式狀態

/**
 * 初始化存儲模組，設置初始值並更新快取
 */
function initializeStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['debugMode'], (result) => {
      if (result.debugMode === undefined) {
        chrome.storage.local.set({ debugMode: false }, () => {
          if (chrome.runtime.lastError) {
            console.error('[Storage] Error setting initial debugMode:', chrome.runtime.lastError.message);
            reject(chrome.runtime.lastError);
          } else {
            isDebugModeEnabled = false;
            if (isDebugModeEnabled) console.log('[Storage] Debug mode is initially set to false.');
            resolve();
          }
        });
      } else {
        isDebugModeEnabled = result.debugMode;
        if (isDebugModeEnabled) console.log('[Storage] Debug mode is initially enabled.');
        resolve();
      }
    });
  });
}

/**
 * 通用函數，用於從 Chrome 存儲獲取數據
 * @param {string|string[]} keys - 要獲取的鍵或鍵數組
 * @returns {Promise<object>} - 包含獲取數據的 Promise
 */
function getStorageItem(keys) {
  return new Promise((resolve, reject) => {
    // 設置獲取數據的超時
    const timeout = setTimeout(() => {
      reject(new Error(`獲取存儲項 ${keys} 超時`));
    }, 5000); // 5秒超時

    chrome.storage.local.get(keys, (result) => {
      clearTimeout(timeout);
      try {
        if (chrome.runtime.lastError) {
          console.error('[Storage] Error getting storage item:', chrome.runtime.lastError.message);
          reject(chrome.runtime.lastError);
        } else {
          if (isDebugModeEnabled) console.log('[Storage] Retrieved storage item:', result);
          resolve(result);
        }
      } catch (e) {
        console.error('[Storage] Uncaught error in getStorageItem callback:', e);
        reject(e);
      }
    });
  });
}

/**
 * 通用函數，用於向 Chrome 存儲設置數據
 * @param {object} items - 要設置的鍵值對對象
 * @returns {Promise<void>} - 設置完成的 Promise
 */
function setStorageItem(items) {
  return new Promise((resolve, reject) => {
    // 設置設置數據的超時
    const timeout = setTimeout(() => {
      reject(new Error(`設置存儲項 ${JSON.stringify(items)} 超時`));
    }, 5000); // 5秒超時

    chrome.storage.local.set(items, () => {
      clearTimeout(timeout);
      try {
        if (chrome.runtime.lastError) {
          console.error('[Storage] Error setting storage item:', chrome.runtime.lastError.message);
          reject(chrome.runtime.lastError);
        } else {
          if (isDebugModeEnabled) console.log('[Storage] Set storage item:', items);
          resolve();
        }
      } catch (e) {
        console.error('[Storage] Uncaught error in setStorageItem callback:', e);
        reject(e);
      }
    });
  });
}

/**
 * 處理存儲相關的訊息請求 (通過 port)
 * @param {object} request - 訊息請求對象
 * @param {object} sender - 發送者信息
 * @param {function} portSendResponse - 回應函數 (通過 port 發送)
 */
export function handleMessage(request, sender, portSendResponse) {
  if (isDebugModeEnabled) console.log('[Storage] Handling message (port):', request);

  // 移除原有的超時保護和 wrappedSendResponse，由 background.js 的 port 處理

  switch (request.type) {
    case 'GET_SETTINGS':
      const keys = request.keys || ['debugMode', 'isEnabled', 'subtitleStyle'];
      getStorageItem(keys)
        .then(result => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with settings (port):', result);
          portSendResponse({ success: true, ...result });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_SETTINGS (port):', error);
          portSendResponse({ success: false, error: error.message });
        });
      break; // 使用 break 代替 return

    case 'SAVE_SETTINGS':
      if (!request.settings || typeof request.settings !== 'object') {
        console.error('[Storage] SAVE_SETTINGS error (port): Missing settings');
        portSendResponse({ success: false, error: '缺少 settings' });
        break;
      }
      setStorageItem(request.settings)
        .then(() => {
          if (isDebugModeEnabled) console.log('[Storage] Settings saved (port):', request.settings);
          portSendResponse({ success: true });
        })
        .catch(error => {
          console.error('[Storage] SAVE_SETTINGS error (port):', error);
          portSendResponse({ success: false, error: error.message });
        });
      break; // 使用 break 代替 return

    case 'GET_USER_ID':
      getStorageItem(['userID'])
        .then(({ userID }) => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with userID (port):', userID);
          portSendResponse({ success: true, userID });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_USER_ID (port):', error);
          portSendResponse({ success: false, error: error.message });
        });
      break; // 使用 break 代替 return

    case 'SAVE_VIDEO_INFO':
      if (request.data) {
        const videoInfo = {
          currentVideoId: request.data.currentVideoId,
          currentVideoTitle: request.data.currentVideoTitle,
          currentVideoLanguage: request.data.currentVideoLanguage
        };
        setStorageItem(videoInfo)
          .then(() => {
            if (isDebugModeEnabled) console.log('[Storage] Video info saved (port):', videoInfo);
            portSendResponse({ success: true });
          })
          .catch(error => {
            console.error('[Storage] Error saving video info (port):', error);
            portSendResponse({ success: false, error: '保存視頻信息失敗' });
          });
      } else {
        console.error('[Storage] SAVE_VIDEO_INFO error (port): Missing data');
        portSendResponse({ success: false, error: '缺少視頻信息數據' });
      }
      break; // 使用 break 代替 return

    case 'GET_DEBUG_MODE':
      getStorageItem(['debugMode'])
        .then(result => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with debugMode (port):', result.debugMode);
          portSendResponse({ success: true, debugMode: result.debugMode || false });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_DEBUG_MODE (port):', error);
          portSendResponse({ success: false, error: error.message });
        });
      break; // 使用 break 代替 return

    case 'GET_USER_LANGUAGE':
      getStorageItem(['userLanguage'])
        .then(result => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with userLanguage (port):', result.userLanguage);
          portSendResponse({ success: true, languageCode: result.userLanguage });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_USER_LANGUAGE (port):', error);
          portSendResponse({ success: false, error: error.message });
        });
      break; // 使用 break 代替 return

    case 'SAVE_USER_LANGUAGE':
      if (request.languageCode) {
        setStorageItem({ userLanguage: request.languageCode })
          .then(() => {
            if (isDebugModeEnabled) console.log('[Storage] User language saved (port):', request.languageCode);
            portSendResponse({ success: true });
          })
          .catch(error => {
            console.error('[Storage] Error saving user language (port):', error);
            portSendResponse({ success: false, error: '保存用戶語言失敗' });
          });
      } else {
        console.error('[Storage] SAVE_USER_LANGUAGE error (port): Missing languageCode');
        portSendResponse({ success: false, error: '缺少 languageCode' });
      }
      break; // 使用 break 代替 return

    default:
      // 如果模組未處理訊息，則返回錯誤
      console.warn('[Storage] Unhandled message type (port):', request.type);
      portSendResponse({ success: false, error: `Unhandled message type in Storage module (port): ${request.type}` });
      break; // 使用 break 代替 return
  }
}

/**
 * 設置調試模式狀態
 * @param {boolean} debugMode - 調試模式是否啟用
 */
export function setDebugMode(debugMode) {
  isDebugModeEnabled = debugMode;
}

// 初始化存儲模組
initializeStorage()
  .then(() => {
    if (isDebugModeEnabled) console.log('[Storage] Storage module initialized successfully.');
  })
  .catch(error => {
    console.error('[Storage] Error initializing storage module:', error);
  });
