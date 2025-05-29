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
 * 處理存儲相關的訊息請求
 * @param {object} request - 訊息請求對象
 * @param {object} sender - 發送者信息
 * @param {function} portSendResponse - 回應函數 (通過 port 發送)
 */
export function handleMessage(request, sender, portSendResponse) {
  if (isDebugModeEnabled) console.log('[Storage] Handling message:', request);

  switch (request.type) {
    case 'GET_SETTINGS':
      const keys = request.keys || ['debugMode', 'isEnabled', 'subtitleStyle'];
      getStorageItem(keys)
        .then(result => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with settings:', result);
          portSendResponse({ success: true, ...result });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_SETTINGS:', error);
          portSendResponse({ success: false, error: error.message });
        });
      break;

    case 'SAVE_SETTINGS':
      if (!request.settings || typeof request.settings !== 'object') {
        console.error('[Storage] SAVE_SETTINGS error: Missing settings');
        portSendResponse({ success: false, error: '缺少 settings' });
        break;
      }
      setStorageItem(request.settings)
        .then(() => {
          if (isDebugModeEnabled) console.log('[Storage] Settings saved:', request.settings);
          portSendResponse({ success: true });
        })
        .catch(error => {
          console.error('[Storage] SAVE_SETTINGS error:', error);
          portSendResponse({ success: false, error: error.message });
        });
      break;

    case 'GET_USER_ID':
      getStorageItem(['userID'])
        .then(({ userID }) => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with userID:', userID);
          portSendResponse({ success: true, userID });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_USER_ID:', error);
          portSendResponse({ success: false, error: error.message });
        });
      break;

    case 'SAVE_VIDEO_INFO':
      if (request.data) {
        const videoInfo = {
          currentVideoId: request.data.currentVideoId,
          currentVideoTitle: request.data.currentVideoTitle,
          currentVideoLanguage: request.data.currentVideoLanguage
        };
        setStorageItem(videoInfo)
          .then(() => {
            if (isDebugModeEnabled) console.log('[Storage] Video info saved:', videoInfo);
            portSendResponse({ success: true });
          })
          .catch(error => {
            console.error('[Storage] Error saving video info:', error);
            portSendResponse({ success: false, error: '保存視頻信息失敗' });
          });
      } else {
        console.error('[Storage] SAVE_VIDEO_INFO error: Missing data');
        portSendResponse({ success: false, error: '缺少視頻信息數據' });
      }
      break;

    case 'GET_DEBUG_MODE':
      getStorageItem(['debugMode'])
        .then(result => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with debugMode:', result.debugMode);
          portSendResponse({ success: true, debugMode: result.debugMode || false });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_DEBUG_MODE:', error);
          portSendResponse({ success: false, error: error.message });
        });
      break;

    case 'GET_USER_LANGUAGE':
      getStorageItem(['userLanguage'])
        .then(result => {
          if (isDebugModeEnabled) console.log('[Storage] Responding with userLanguage:', result.userLanguage);
          portSendResponse({ success: true, languageCode: result.userLanguage });
        })
        .catch(error => {
          console.error('[Storage] Error in GET_USER_LANGUAGE:', error);
          portSendResponse({ success: false, error: error.message });
        });
      break;

    case 'SAVE_USER_LANGUAGE':
      if (request.languageCode) {
        setStorageItem({ userLanguage: request.languageCode })
          .then(() => {
            if (isDebugModeEnabled) console.log('[Storage] User language saved:', request.languageCode);
            portSendResponse({ success: true });
          })
          .catch(error => {
            console.error('[Storage] Error saving user language:', error);
            portSendResponse({ success: false, error: '保存用戶語言失敗' });
          });
      } else {
        console.error('[Storage] SAVE_USER_LANGUAGE error: Missing languageCode');
        portSendResponse({ success: false, error: '缺少 languageCode' });
      }
      break;

    case 'REPORT_REPLACEMENT_EVENTS':
      // 處理替換事件儲存邏輯
      handleStoreReplacementEvents(request, portSendResponse);
      break;

    case 'CLEAR_QUEUE':
      // 處理清除隊列邏輯
      if (request.queueType) {
        clearQueue(request.queueType)
          .then(() => {
            portSendResponse({ success: true });
          })
          .catch(error => {
            portSendResponse({ success: false, error: error.message });
          });
      } else {
        portSendResponse({ success: false, error: '缺少 queueType' });
      }
      break;

    default:
      // 如果模組未處理訊息，則返回錯誤
      console.warn('[Storage] Unhandled message type:', request.type);
      portSendResponse({ success: false, error: `Unhandled message type in Storage module: ${request.type}` });
      break;
  }
}

/**
 * 去重時間窗口（分鐘）
 */
const DEDUP_WINDOW_MINUTES = 15;

/**
 * 過濾重複的替換事件
 * @param {Array} newEvents - 新的事件陣列
 * @param {Array} existingEvents - 現有的事件陣列
 * @returns {Promise<Array>} - 過濾後的事件陣列
 */
async function filterDuplicateEvents(newEvents, existingEvents) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - DEDUP_WINDOW_MINUTES * 60 * 1000);
  
  // 先清理過期的事件（超過1小時的舊事件）
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recentEvents = existingEvents.filter(event => {
    const eventTime = new Date(event.occurredAt);
    return eventTime > oneHourAgo;
  });
  
  if (isDebugModeEnabled && recentEvents.length !== existingEvents.length) {
    console.log(`[Storage] Cleaned ${existingEvents.length - recentEvents.length} old events from dedup cache`);
  }
  
  // 建立去重檢查的索引（僅檢查時間窗口內的事件）
  const recentEventsInWindow = recentEvents.filter(event => {
    const eventTime = new Date(event.occurredAt);
    return eventTime > windowStart;
  });
  
  const dedupIndex = new Set();
  recentEventsInWindow.forEach(event => {
    const key = `${event.translationID}_${event.beneficiaryUserID}`;
    dedupIndex.add(key);
  });
  
  // 過濾新事件中的重複項
  const filteredEvents = [];
  let duplicateCount = 0;
  
  for (const event of newEvents) {
    const key = `${event.translationID}_${event.beneficiaryUserID}`;
    
    if (dedupIndex.has(key)) {
      duplicateCount++;
      if (isDebugModeEnabled) {
        console.log(`[Storage] Filtered duplicate event: ${key} within ${DEDUP_WINDOW_MINUTES} minute window`);
      }
    } else {
      filteredEvents.push(event);
      // 將新事件添加到去重索引中，避免同一批次內的重複
      dedupIndex.add(key);
    }
  }
  
  if (duplicateCount > 0) {
    console.log(`[Storage] Filtered ${duplicateCount} duplicate events out of ${newEvents.length} new events`);
  }
  
  return { filteredEvents, cleanedExistingEvents: recentEvents };
}

/**
 * 處理替換事件儲存的邏輯 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
async function handleStoreReplacementEvents(request, portSendResponse) {
  const { events } = request;
  if (!events || !Array.isArray(events) || events.length === 0) {
    console.error('[Storage] REPORT_REPLACEMENT_EVENTS error (port): Missing or invalid events array');
    portSendResponse({ success: false, error: '缺少或無效的 events 陣列' });
    return;
  }

  if (isDebugModeEnabled) console.log(`[Storage] Processing ${events.length} replacement events for deduplication (port)`);

  try {
    // 獲取現有的替換事件列表
    const { replacementEvents = [] } = await getStorageItem(['replacementEvents']);
    
    // 過濾重複事件並清理舊事件
    const { filteredEvents, cleanedExistingEvents } = await filterDuplicateEvents(events, replacementEvents);
    
    // 將過濾後的新事件添加到清理後的列表中
    const updatedEvents = [...cleanedExistingEvents, ...filteredEvents];
    
    // 限制隊列大小，避免無限增長
    const MAX_EVENTS_SIZE = 1000;
    if (updatedEvents.length > MAX_EVENTS_SIZE) {
      console.warn(`[Storage] Replacement events queue is full, discarding ${updatedEvents.length - MAX_EVENTS_SIZE} oldest events.`);
      updatedEvents.splice(0, updatedEvents.length - MAX_EVENTS_SIZE);
    }
    
    // 儲存更新後的事件列表
    await setStorageItem({ replacementEvents: updatedEvents });
    
    const storedCount = filteredEvents.length;
    const duplicateCount = events.length - storedCount;
    
    if (isDebugModeEnabled) {
      console.log(`[Storage] Successfully processed replacement events: ${storedCount} stored, ${duplicateCount} duplicates filtered. Total events: ${updatedEvents.length} (port)`);
    }
    
    portSendResponse({ 
      success: true, 
      message: `處理完成：${storedCount} 個新事件已儲存，${duplicateCount} 個重複事件已過濾`,
      storedCount,
      duplicateCount,
      totalEvents: updatedEvents.length
    });
  } catch (error) {
    console.error('[Storage] Error storing replacement events (port):', error);
    portSendResponse({ success: false, error: `儲存替換事件失敗: ${error.message}` });
  }
}

/**
 * 清除指定隊列的數據
 * @param {string} queueKey - 要清除的隊列鍵名 (e.g., 'voteQueue', 'translationQueue', 'replacementEvents')
 * @returns {Promise<void>}
 */
export async function clearQueue(queueKey) {
  if (isDebugModeEnabled) console.log(`[Storage] Clearing queue: ${queueKey}`);
  try {
    await setStorageItem({ [queueKey]: [] });
    if (isDebugModeEnabled) console.log(`[Storage] Queue ${queueKey} cleared successfully.`);
  } catch (error) {
    console.error(`[Storage] Error clearing queue ${queueKey}:`, error);
    throw error;
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
