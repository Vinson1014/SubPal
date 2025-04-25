// background.js - 用於跨模組消息與全局狀態管理

let isDebugModeEnabled = false; // 快取 Debug 模式狀態

// 擴充功能安裝/更新事件
chrome.runtime.onInstalled.addListener(() => {
  console.log('字幕助手擴充功能已安裝或更新');
  // 設置初始值並更新快取
  chrome.storage.local.get(['debugMode'], (result) => {
    if (result.debugMode === undefined) {
      chrome.storage.local.set({ debugMode: false });
      isDebugModeEnabled = false;
    } else {
      isDebugModeEnabled = result.debugMode;
    }
    if (isDebugModeEnabled) console.log('[Background] Debug mode is initially enabled.');
  });
});

// 監聽來自 popup 或內容腳本的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (isDebugModeEnabled) console.log('[Background] Received message:', request, 'from:', sender.tab ? `Tab ${sender.tab.id}` : 'Popup/Other');

  if (!request || !request.type) {
    console.error('[Background] Invalid message format:', request); // 錯誤訊息總是顯示
    sendResponse({ success: false, error: '無效的消息格式' });
    return false; // 同步回應
  }

  switch (request.type) {
    // 內容腳本加載完成通知 (來自 content.js)
    case 'CONTENT_SCRIPT_LOADED': // 這個類型似乎沒有被 content.js 使用，但保留以防萬一
      if (isDebugModeEnabled) console.log('[Background] 內容腳本已加載:', sender.tab?.url);
      sendResponse({ success: true });
      return false;  // 同步回應

    // 取得 userID (來自 popup 或 content.js)
    case 'GET_USER_ID':
      chrome.storage.local.get(['userID'], ({ userID }) => {
        if (isDebugModeEnabled) console.log('[Background] Responding with userID:', userID);
        sendResponse({ success: true, userID });
      });
      return true;   // 異步回應

    // 取得設置 (來自 popup 或 content.js)
    case 'GET_SETTINGS':
      const keys = request.keys || ['debugMode', 'isEnabled', 'subtitleStyle']; // 包含常用設置
      chrome.storage.local.get(keys, (result) => {
        if (isDebugModeEnabled) console.log('[Background] Responding with settings:', result);
        sendResponse({ success: true, ...result });
      });
      return true;   // 異步回應

    // 取得 Debug 模式狀態 (主要由 content/messaging.js 初始化時調用)
    case 'GET_DEBUG_MODE':
      chrome.storage.local.get(['debugMode'], (result) => {
        if (isDebugModeEnabled) console.log('[Background] Responding with debugMode:', result.debugMode);
        sendResponse({ success: true, debugMode: result.debugMode || false });
      });
      return true; // 異步回應

    // 保存設置 (來自 popup 或 content.js)
    case 'SAVE_SETTINGS':
      if (!request.settings || typeof request.settings !== 'object') {
        console.error('[Background] SAVE_SETTINGS error: Missing settings');
        sendResponse({ success: false, error: '缺少 settings' });
        return false;
      }
      chrome.storage.local.set(request.settings, () => {
        if (chrome.runtime.lastError) {
          console.error('[Background] SAVE_SETTINGS error:', chrome.runtime.lastError.message);
        } else {
          if (isDebugModeEnabled) console.log('[Background] Settings saved:', request.settings);
        }
        sendResponse({ success: !chrome.runtime.lastError });
      });
      return true;   // 異步回應

    // 保存視頻信息 (來自 content/video-info.js)
    case 'SAVE_VIDEO_INFO':
      if (request.data) {
        const videoInfo = {
          currentVideoId: request.data.currentVideoId,
          currentVideoTitle: request.data.currentVideoTitle,
          currentVideoLanguage: request.data.currentVideoLanguage
        };
        chrome.storage.local.set(videoInfo, () => {
          if (chrome.runtime.lastError) {
            console.error('[Background] Error saving video info:', chrome.runtime.lastError.message);
            sendResponse({ success: false, error: '保存視頻信息失敗' });
          } else {
            if (isDebugModeEnabled) console.log('[Background] Video info saved:', videoInfo);
            sendResponse({ success: true });
            // (可選) 通知 popup 更新 UI
            chrome.runtime.sendMessage({ type: 'UPDATE_STATS', videoId: videoInfo.currentVideoId });
          }
        });
      } else {
        console.error('[Background] SAVE_VIDEO_INFO error: Missing data');
        sendResponse({ success: false, error: '缺少視頻信息數據' });
      }
      return true; // 異步回應

    // 處理提交翻譯請求 (來自 content/ui-manager.js 或 translation-manager.js)
    case 'SUBMIT_TRANSLATION':
      if (isDebugModeEnabled) console.log(`[Background] Received SUBMIT_TRANSLATION request:`, request);
      handleSubmitTranslationRequest(request, sendResponse);
      return true; // 異步回應

    // 處理投票請求 (來自 content/vote-manager.js)
    case 'PROCESS_VOTE':
      if (isDebugModeEnabled) console.log(`[Background] Received PROCESS_VOTE request:`, request.payload);
      handleVoteRequest(request.payload, sendResponse);
      return true; // 異步回應

    // 處理來自 popup 的開關切換消息
    case 'TOGGLE_EXTENSION':
      if (isDebugModeEnabled) console.log(`[Background] Toggling extension: ${request.isEnabled}`);
      // 轉發消息到所有相關的 content scripts
      chrome.tabs.query({ url: "*://*.netflix.com/*" }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_EXTENSION', isEnabled: request.isEnabled }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn(`[Background] Error sending TOGGLE_EXTENSION to tab ${tab.id}:`, chrome.runtime.lastError.message); // 警告總是顯示
            } else {
              if (isDebugModeEnabled) console.log(`[Background] Sent TOGGLE_EXTENSION to tab ${tab.id}, response:`, response);
            }
          });
        });
      });
      sendResponse({ success: true }); // 回應 popup
      return false; // 同步回應

    case 'TOGGLE_DEBUG_MODE':
      isDebugModeEnabled = request.debugMode; // 更新快取狀態
      if (isDebugModeEnabled) console.log(`[Background] Toggling debug mode: ${isDebugModeEnabled}`);
      // 轉發消息到所有相關的 content scripts
      chrome.tabs.query({ url: "*://*.netflix.com/*" }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_DEBUG_MODE', debugMode: isDebugModeEnabled }, (response) => {
             if (chrome.runtime.lastError) {
              console.warn(`[Background] Error sending TOGGLE_DEBUG_MODE to tab ${tab.id}:`, chrome.runtime.lastError.message); // 警告總是顯示
            } else {
              if (isDebugModeEnabled) console.log(`[Background] Sent TOGGLE_DEBUG_MODE to tab ${tab.id}, response:`, response);
            }
          });
        });
      });
      sendResponse({ success: true }); // 回應 popup
      return false; // 同步回應

    // 可以添加 TOGGLE_TEST_MODE 的處理邏輯，如果需要

    // 獲取用戶上次選擇的語言
    case 'GET_USER_LANGUAGE':
      chrome.storage.local.get(['userLanguage'], (result) => {
        if (isDebugModeEnabled) console.log('[Background] Responding with userLanguage:', result.userLanguage);
        sendResponse({ success: true, languageCode: result.userLanguage });
      });
      return true; // 異步回應

    // 保存用戶選擇的語言
    case 'SAVE_USER_LANGUAGE':
      if (request.languageCode) {
        chrome.storage.local.set({ userLanguage: request.languageCode }, () => {
          if (chrome.runtime.lastError) {
            console.error('[Background] Error saving user language:', chrome.runtime.lastError.message); // 錯誤總是顯示
            sendResponse({ success: false, error: '保存用戶語言失敗' });
          } else {
            if (isDebugModeEnabled) console.log('[Background] User language saved:', request.languageCode);
            sendResponse({ success: true });
          }
        });
      } else {
        console.error('[Background] SAVE_USER_LANGUAGE error: Missing languageCode'); // 錯誤總是顯示
        sendResponse({ success: false, error: '缺少 languageCode' });
      }
      return true; // 異步回應

    // 處理檢查字幕請求 (來自 content/subtitle-replacer.js)
    case 'CHECK_SUBTITLE':
      if (isDebugModeEnabled) console.log(`[Background] Received CHECK_SUBTITLE request:`, request);
      handleCheckSubtitleRequest(request, sendResponse);
      return true; // 異步回應

    default:
      console.warn('[Background] 未處理的消息類型:', request.type); // 警告總是顯示
      sendResponse({ success: false, error: `Unhandled message type ${request.type}` });
      return false;
  }
});

// --- 字幕檢查處理 ---

/**
 * 處理檢查字幕請求
 * @param {object} request - 包含 videoId 和 timestamp
 * @param {function} sendResponse - 回應函數
 */
async function handleCheckSubtitleRequest(request, sendResponse) {
  const { videoId, timestamp } = request;
  if (!videoId || typeof timestamp !== 'number') {
    console.error('[Background] CHECK_SUBTITLE error: Missing videoId or timestamp');
    sendResponse({ success: false, error: '缺少 videoId 或 timestamp' });
    return;
  }

  if (isDebugModeEnabled) console.log(`[Background] Fetching subtitles for videoId: ${videoId}, starting from timestamp: ${timestamp}`);

  try {
    // 向後端請求接下來 3 分鐘的字幕數據
    const subtitles = await fetchSubtitlesFromAPI(videoId, timestamp, 180); // 180 秒 = 3 分鐘
    if (isDebugModeEnabled) console.log(`[Background] Fetched ${subtitles.length} subtitles from API`);
    sendResponse({ success: true, subtitles: subtitles });
  } catch (error) {
    console.error('[Background] Error fetching subtitles from API:', error);
    sendResponse({ success: false, error: `獲取字幕失敗: ${error.message}` });
  }
}

/**
 * 從後端 API 獲取字幕數據
 * @param {string} videoId
 * @param {number} startTime - 開始時間戳 (秒)
 * @param {number} duration - 持續時間 (秒)
 * @returns {Promise<Array>} - 字幕數據列表
 */
async function fetchSubtitlesFromAPI(videoId, startTime, duration) {
  // *** 注意：這裡的 API 端點是假設的，需要根據實際後端 API 調整 ***
  const url = `${API_BASE_URL}/translations?videoID=${encodeURIComponent(videoId)}&startTime=${startTime}&duration=${duration}`;

  if (isDebugModeEnabled) console.log('[Background] Fetching subtitles from API:', url);

  const res = await fetch(url, {
    method: 'GET', // 使用 GET 請求
    headers: {
      'Accept': 'application/json'
      // 可能需要其他 header，例如認證 token
    }
  });

  if (!res.ok) {
    let errorMsg = `API request failed with status ${res.status}`;
    try {
      const err = await res.json();
      errorMsg = err.error || errorMsg;
    } catch (e) {
      // 忽略 JSON 解析錯誤
    }
    console.error('[Background] API Error fetching subtitles:', errorMsg); // 錯誤總是顯示
    throw new Error(errorMsg);
  }

  try {
    const jsonResponse = await res.json();
    if (isDebugModeEnabled) console.log('[Background] API Subtitles Raw Response:', jsonResponse);

    // 檢查 API 回傳是否成功且包含 subtitles 陣列
    if (jsonResponse && jsonResponse.success === true && Array.isArray(jsonResponse.subtitles)) {
      const subtitles = jsonResponse.subtitles;
      if (isDebugModeEnabled) console.log(`[Background] API returned ${subtitles.length} subtitles.`);
      // 可以在這裡對回傳的字幕數據進行一些基本驗證或轉換
      return subtitles.map(sub => ({
        timestamp: sub.timestamp, // 確保有 timestamp
        originalSubtitle: sub.originalSubtitle, // 確保有 originalSubtitle
        suggestedSubtitle: sub.suggestedSubtitle, // 確保有 suggestedSubtitle
        translationID: sub.translationID // (可選) 包含翻譯 ID 以便後續投票
        // 其他可能需要的欄位...
      })); // map 函數結束
    }
    // 如果 API 回傳不成功或格式不符，拋出錯誤
    else {
      console.error('[Background] API response indicates failure or invalid format:', jsonResponse);
      throw new Error(jsonResponse.error || 'API 回傳失敗或字幕數據格式不正確');
    }
  } catch (e) {
    console.error('[Background] Error parsing subtitles API response as JSON:', e); // 錯誤總是顯示
    throw new Error('解析字幕 API 回應失敗');
  }
}


// --- 數據提交與本地緩存邏輯 (通用) ---

const VOTE_QUEUE_KEY = 'voteQueue';
const TRANSLATION_QUEUE_KEY = 'translationQueue'; // New constant
const MAX_QUEUE_SIZE = 100; // 各隊列最大大小
let isSyncingVotes = false;
let isSyncingTranslations = false;

/**
 * 通用處理提交請求的函數 (投票或翻譯)
 * @param {object} data - 請求數據 (不含 userID)
 * @param {function} sendResponse - 回應函數
 * @param {function} apiCallFunction - 實際發送 API 的函數
 * @param {function} addToQueueFunction - 添加到緩存隊列的函數
 * @param {function} triggerSyncFunction - 觸發同步的函數
 * @param {string} dataTypeLabel - 數據類型標籤 (用於日誌)
 */
async function handleGenericSubmitRequest(data, sendResponse, apiCallFunction, addToQueueFunction, triggerSyncFunction, dataTypeLabel) {
  if (isDebugModeEnabled) console.log(`[Background] Entering handleGenericSubmitRequest for ${dataTypeLabel}`);
  try {
    const { userID } = await chrome.storage.local.get(['userID']);
    if (!userID) {
      console.error(`[Background] Error in handleGenericSubmitRequest: Cannot get userID for ${dataTypeLabel}`);
      throw new Error('無法獲取 userID');
    }

    const fullData = { ...data, userID };

    if (isDebugModeEnabled) console.log(`[Background] Handling ${dataTypeLabel} submission with userID:`, fullData);
    try {
      // 嘗試直接發送到後端
      if (isDebugModeEnabled) console.log(`[Background] Attempting to send ${dataTypeLabel} directly to API with userID:`, fullData);
      const result = await apiCallFunction(fullData);
      if (isDebugModeEnabled) console.log(`[Background] ${dataTypeLabel} sent directly to API:`, result);
      sendResponse({ success: true, result });
    } catch (apiError) {
      console.warn(`[Background] Failed to send ${dataTypeLabel} directly, adding to queue:`, apiError.message, fullData); // 警告總是顯示
      // 發送失敗，加入本地緩存隊列
      await addToQueueFunction(fullData);
      sendResponse({ success: true, queued: true, message: `${dataTypeLabel}已暫存，將在網路恢復後提交` });
      // 觸發一次同步嘗試 (非阻塞)
      triggerSyncFunction();
    }
  } catch (error) {
    console.error(`[Background] Error processing ${dataTypeLabel} request:`, error); // 錯誤總是顯示
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * 處理投票請求
 */
async function handleVoteRequest(voteData, sendResponse) {
  await handleGenericSubmitRequest(
    voteData,
    sendResponse,
    sendVoteToAPI,
    addVoteToQueue,
    triggerVoteSync,
    '投票'
  );
}

/**
 * 處理提交翻譯請求
 */
async function handleSubmitTranslationRequest(requestData, sendResponse) {
  if (isDebugModeEnabled) console.log('[Background] Entering handleSubmitTranslationRequest:', requestData);

  // 從 requestData 中提取提交翻譯所需的數據 (使用前端傳來的欄位名)
  const translationData = {
    videoId: requestData.videoId,
    timestamp: requestData.timestamp,
    original: requestData.original,
    translation: requestData.translation,
    submissionReason: requestData.submissionReason, // Use submissionReason
    languageCode: requestData.languageCode // Assuming languageCode is passed from frontend
  };
   await handleGenericSubmitRequest(
    translationData,
    sendResponse,
    sendTranslationToAPI,
    addTranslationToQueue,
    triggerTranslationSync,
    '翻譯提交'
  );
}


/**
 * 將投票數據添加到投票緩存隊列
 * @param {object} voteData - 包含 userID 的投票數據
 */
async function addVoteToQueue(voteData) {
  await addToQueue(voteData, VOTE_QUEUE_KEY, 'Vote');
}

/**
 * 將翻譯數據添加到翻譯緩存隊列
 * @param {object} translationData - 包含 userID 的翻譯數據
 */
async function addTranslationToQueue(translationData) {
  await addToQueue(translationData, TRANSLATION_QUEUE_KEY, 'Translation');
}

/**
 * 通用添加到緩存隊列的函數
 * @param {object} data
 * @param {string} queueKey
 * @param {string} dataTypeLabel
 */
async function addToQueue(data, queueKey, dataTypeLabel) {
   try {
    const { [queueKey]: queue = [] } = await chrome.storage.local.get(queueKey);
    if (queue.length >= MAX_QUEUE_SIZE) {
      console.warn(`[Background] ${dataTypeLabel} queue is full, discarding oldest item.`); // 警告總是顯示
      queue.shift();
    }
    queue.push(data);
    await chrome.storage.local.set({ [queueKey]: queue });
    if (isDebugModeEnabled) console.log(`[Background] ${dataTypeLabel} added to queue. Queue size:`, queue.length);
  } catch (error) {
    console.error(`[Background] Error adding ${dataTypeLabel} to queue:`, error); // 錯誤總是顯示
  }
}


/**
 * 觸發投票同步
 */
function triggerVoteSync() {
  triggerSync(isSyncingVotes, syncPendingVotes, 'Vote');
}

/**
 * 觸發翻譯同步
 */
function triggerTranslationSync() {
  triggerSync(isSyncingTranslations, syncPendingTranslations, 'Translation');
}

/**
 * 通用觸發同步函數 (非阻塞)
 * @param {boolean} isSyncingFlag - 是否正在同步的標誌
 * @param {function} syncFunction - 實際執行同步的函數
 * @param {string} dataTypeLabel
 */
function triggerSync(isSyncingFlag, syncFunction, dataTypeLabel) {
  if (!isSyncingFlag) {
    if (isDebugModeEnabled) console.log(`[Background] Triggering ${dataTypeLabel} sync.`);
    syncFunction(); // 異步執行
  } else {
    if (isDebugModeEnabled) console.log(`[Background] ${dataTypeLabel} sync already in progress.`);
  }
}


/**
 * 同步待處理的投票隊列
 */
async function syncPendingVotes() {
  await syncPendingItems(
    VOTE_QUEUE_KEY,
    isSyncingVotes,
    sendVoteToAPI,
    'Vote',
    (flag) => { isSyncingVotes = flag; }
  );
}

/**
 * 同步待處理的翻譯隊列
 */
async function syncPendingTranslations() {
   await syncPendingItems(
    TRANSLATION_QUEUE_KEY,
    isSyncingTranslations,
    sendTranslationToAPI,
    'Translation',
    (flag) => { isSyncingTranslations = flag; }
  );
}

/**
 * 通用同步待處理隊列的函數
 * @param {string} queueKey
 * @param {boolean} isSyncingFlag
 * @param {function} apiCallFunction
 * @param {string} dataTypeLabel
 * @param {function} setSyncingFlag - 用於更新同步狀態的函數
 */
async function syncPendingItems(queueKey, isSyncingFlag, apiCallFunction, dataTypeLabel, setSyncingFlag) {
  if (isSyncingFlag) return;
  setSyncingFlag(true);
  if (isDebugModeEnabled) console.log(`[Background] Starting ${dataTypeLabel} sync...`);

  try {
    const { [queueKey]: queue = [] } = await chrome.storage.local.get(queueKey);
    if (queue.length === 0) {
      if (isDebugModeEnabled) console.log(`[Background] ${dataTypeLabel} queue is empty.`);
      setSyncingFlag(false);
      return;
    }

    if (isDebugModeEnabled) console.log(`[Background] Syncing ${queue.length} pending ${dataTypeLabel}s...`);
    const remainingItems = [];
    let successCount = 0;

    for (const itemData of queue) {
      try {
        await apiCallFunction(itemData); // Assuming itemData includes userID
        successCount++;
        if (isDebugModeEnabled) console.log(`[Background] Synced ${dataTypeLabel}:`, itemData);
      } catch (error) {
        console.warn(`[Background] Failed to sync ${dataTypeLabel}, keeping in queue:`, error.message, itemData); // 警告總是顯示
        remainingItems.push(itemData);
      }
    }

    // 更新隊列
    await chrome.storage.local.set({ [queueKey]: remainingItems });
    if (isDebugModeEnabled) console.log(`[Background] ${dataTypeLabel} sync finished. Synced: ${successCount}, Remaining: ${remainingItems.length}`);

  } catch (error) {
    console.error(`[Background] Error during ${dataTypeLabel} sync:`, error); // 錯誤總是顯示
  } finally {
    setSyncingFlag(false);
  }
}


import { API_BASE_URL } from './content/config.js';

/**
 * 發送單個投票到後端 API
 * @param {object} voteData - 包含 userID 的完整投票數據
 */
async function sendVoteToAPI(voteData) {
  const { translationID, videoID, originalSubtitle, timestamp, userID, voteType } = voteData;

  if (!userID || !videoID || typeof timestamp !== 'number' || !['upvote', 'downvote'].includes(voteType)) {
    throw new Error('Missing or invalid parameters for API call');
  }

  let url;
  let body = { userID, videoID, timestamp, voteType };
  // 根據後端 API 設計，決定是否需要 originalSubtitle
  if (originalSubtitle) body.originalSubtitle = originalSubtitle;

  if (translationID) {
    url = `${API_BASE_URL}/translations/${translationID}/vote`;
  } else {
    // 如果沒有 translationID，可能需要不同的 API 端點或處理方式
    // 這裡假設一個通用端點，如果後端需要 originalSubtitle 來查找
    url = `${API_BASE_URL}/votes`;
    if (!body.originalSubtitle) {
       console.warn("[Background] Missing originalSubtitle for vote without translationID. API call might fail."); // 警告總是顯示
    }
  }

  if (isDebugModeEnabled) console.log('[Background] Sending vote to API:', url, body);
  return await sendToAPI(url, body); // 使用通用函數
}

/**
 * 發送單個翻譯提交到後端 API
 * @param {object} translationData - 包含 userID 的完整翻譯數據
 */
async function sendTranslationToAPI(translationData) {
  // 使用後端 schema 定義的欄位名
  const { videoId, timestamp, original, translation, submissionReason, languageCode, userID } = translationData;

   // 驗證必要欄位 (根據後端 schema)
   if (!userID || !videoId || typeof timestamp !== 'number' || !original || !translation || !languageCode) {
    throw new Error('Missing or invalid parameters for translation API call');
  }

  const url = `${API_BASE_URL}/translations`; // API 端點
  const body = {
    contributorUserID: userID, // Use contributorUserID
    videoID: videoId,
    timestamp: timestamp,
    originalSubtitle: original, // Use originalSubtitle
    suggestedSubtitle: translation, // Use suggestedSubtitle
    languageCode: languageCode,
    submissionReason: submissionReason || '' // Use submissionReason, default to empty
  };

  if (isDebugModeEnabled) console.log('[Background] Sending translation to API:', url, body);
  return await sendToAPI(url, body); // 使用通用函數
}

/**
 * 通用發送 API 請求函數
 * @param {string} url
 * @param {object} body
 */
async function sendToAPI(url, body) {
   const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let errorMsg = `API request failed with status ${res.status}`;
    try {
      const err = await res.json();
      errorMsg = err.error || errorMsg;
    } catch (e) {
      // 忽略 JSON 解析錯誤
      if (isDebugModeEnabled) console.log('[Background] Failed to parse API error response as JSON.');
    }
    console.error('[Background] API Error:', errorMsg); // 錯誤總是顯示
    throw new Error(errorMsg);
  }

  // 成功時嘗試解析 JSON
  try {
    const jsonResponse = await res.json();
    if (isDebugModeEnabled) console.log('[Background] API Success Response:', jsonResponse);
    return jsonResponse;
  } catch (e) {
    console.error('[Background] Error parsing successful API response as JSON:', e); // 錯誤總是顯示
    // 即使解析失敗，請求本身是成功的，可以返回一個標誌或空對象
    return { success: true, message: 'Response received but could not be parsed as JSON.' };
  }
}

// 定期觸發同步 (例如每 5 分鐘)
// 創建兩個獨立的 alarm
chrome.alarms.create('syncVotesAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncTranslationsAlarm', { periodInMinutes: 5 }); // 可以設置不同頻率

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncVotesAlarm') {
    if (isDebugModeEnabled) console.log('[Background] Periodic vote sync triggered by alarm.');
    triggerVoteSync();
  } else if (alarm.name === 'syncTranslationsAlarm') {
    if (isDebugModeEnabled) console.log('[Background] Periodic translation sync triggered by alarm.');
    triggerTranslationSync();
  }
});

// 擴充功能啟動時觸發所有同步
chrome.runtime.onStartup.addListener(() => {
  if (isDebugModeEnabled) console.log('[Background] Extension startup, triggering all syncs.');
  triggerVoteSync();
  triggerTranslationSync();
});
