// background/api.js
// 負責處理與後端 API 相關的操作的模組

// 從 config.js中導入 API Base URL
import { API_BASE_URL } from '../content/config.js'; // 從 config.js 中導入 API Base URL

// const API_BASE_URL = 'http://localhost:3000'; // 暫時硬編碼
let isDebugModeEnabled = false;

/**
 * 處理 API 相關的訊息 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {Object} sender - 訊息發送者資訊
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
export function handleMessage(request, sender, portSendResponse) {
  if (isDebugModeEnabled) console.log('[API Module] Handling message (port):', request.type);

  // 移除原有的超時保護和 wrappedSendResponse，由 background.js 的 port 處理

  switch (request.type) {
    case 'SUBMIT_TRANSLATION':
      // 處理提交翻譯邏輯
      handleSubmitTranslation(request, portSendResponse);
      break; // 使用 break 代替 return
    case 'PROCESS_VOTE':
      // 處理投票邏輯
      handleProcessVote(request, portSendResponse);
      break; // 使用 break 代替 return
    case 'CHECK_SUBTITLE':
      // 處理檢查字幕邏輯
      handleCheckSubtitle(request, portSendResponse);
      break; // 使用 break 代替 return
    default:
      // 如果模組未處理訊息，則返回錯誤
      console.warn('[API Module] Unhandled message type (port):', request.type);
      portSendResponse({ success: false, error: `Unhandled message type in API module (port): ${request.type}` });
      break; // 使用 break 代替 return
  }
}

/**
 * 處理提交翻譯的邏輯 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
async function handleSubmitTranslation(request, portSendResponse) {
  if (isDebugModeEnabled) console.log('[API Module] Entering handleSubmitTranslation (port):', request);

  // 從 request 中提取提交翻譯所需的數據
  const translationData = {
    videoId: request.videoId,
    timestamp: request.timestamp,
    original: request.original,
    translation: request.translation,
    submissionReason: request.submissionReason,
    languageCode: request.languageCode
  };

  await handleGenericSubmitRequest(
    translationData,
    portSendResponse, // 傳遞 portSendResponse
    sendTranslationToAPI,
    addTranslationToQueue,
    triggerTranslationSync,
    '翻譯提交'
  );
}

/**
 * 處理投票的邏輯 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
async function handleProcessVote(request, portSendResponse) {
  if (isDebugModeEnabled) console.log('[API Module] Processing vote (port):', request.payload);

  await handleGenericSubmitRequest(
    request.payload,
    portSendResponse, // 傳遞 portSendResponse
    sendVoteToAPI,
    addVoteToQueue,
    triggerVoteSync,
    '投票'
  );
}

/**
 * 處理檢查字幕的邏輯 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
async function handleCheckSubtitle(request, portSendResponse) {
  const { videoId, timestamp } = request;
  if (!videoId || typeof timestamp !== 'number') {
    console.error('[API Module] CHECK_SUBTITLE error (port): Missing videoId or timestamp');
    portSendResponse({ success: false, error: '缺少 videoId 或 timestamp' });
    return;
  }

  if (isDebugModeEnabled) console.log(`[API Module] Fetching subtitles for videoId: ${videoId}, starting from timestamp: ${timestamp} (port)`);

  try {
    // 向後端請求接下來 3 分鐘的字幕數據
    console.log('[API Module] Starting fetch subtitles from API for CHECK_SUBTITLE request (port):', videoId, timestamp);
    const subtitles = await fetchSubtitlesFromAPI(videoId, timestamp, 180); // 180 秒 = 3 分鐘
    console.log(`[API Module] Successfully fetched ${subtitles.length} subtitles from API for CHECK_SUBTITLE request (port):`, videoId, timestamp);
    portSendResponse({ success: true, subtitles: subtitles });
  } catch (error) {
    console.error('[API Module] Error fetching subtitles from API for CHECK_SUBTITLE request (port):', videoId, timestamp, error);
    portSendResponse({ success: false, error: `獲取字幕失敗: ${error.message}` });
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
  const url = `${API_BASE_URL}/translations?videoID=${encodeURIComponent(videoId)}&startTime=${startTime}&duration=${duration}`;

  if (isDebugModeEnabled) console.log('[API Module] Fetching subtitles from API:', url);

  // 添加超時控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超時

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: controller.signal // 綁定 AbortSignal
    });

    clearTimeout(timeoutId); // 清除超時計時器

    if (!res.ok) {
      let errorMsg = `API request failed with status ${res.status}`;
      try {
        const err = await res.json();
        errorMsg = err.error || errorMsg;
      } catch (e) {
        // 忽略 JSON 解析錯誤
      }
      console.error('[API Module] API Error fetching subtitles:', errorMsg);
      throw new Error(errorMsg);
    }

    try {
      const jsonResponse = await res.json();
      if (isDebugModeEnabled) console.log('[API Module] API Subtitles Raw Response:', jsonResponse);

      if (jsonResponse && jsonResponse.success === true && Array.isArray(jsonResponse.subtitles)) {
        const subtitles = jsonResponse.subtitles;
        if (isDebugModeEnabled) console.log(`[API Module] API returned ${subtitles.length} subtitles.`);
        return subtitles.map(sub => ({
          timestamp: sub.timestamp,
          originalSubtitle: sub.originalSubtitle,
          suggestedSubtitle: sub.suggestedSubtitle,
          translationID: sub.translationID
        }));
      } else {
        console.error('[API Module] API response indicates failure or invalid format:', jsonResponse);
        throw new Error(jsonResponse.error || 'API 回傳失敗或字幕數據格式不正確');
      }
    } catch (e) {
      console.error('[API Module] Error parsing subtitles API response as JSON:', e);
      throw new Error('解析字幕 API 回應失敗');
    }
  } catch (error) {
    clearTimeout(timeoutId); // 確保在錯誤發生時也清除計時器
    if (error.name === 'AbortError') {
      console.error('[API Module] Fetch subtitles request timed out:', url);
      throw new Error('獲取字幕請求超時');
    } else {
      console.error('[API Module] Error during fetch subtitles:', error);
      throw error; // 重新拋出其他錯誤
    }
  }
}

/**
 * 通用處理提交請求的函數 (投票或翻譯) (通過 port)
 * @param {object} data - 請求數據 (不含 userID)
 * @param {function} portSendResponse - 回應函數 (通過 port 發送)
 * @param {function} apiCallFunction - 實際發送 API 的函數
 * @param {function} addToQueueFunction - 添加到緩存隊列的函數
 * @param {function} triggerSyncFunction - 觸發同步的函數
 * @param {string} dataTypeLabel - 數據類型標籤 (用於日誌)
 */
async function handleGenericSubmitRequest(data, portSendResponse, apiCallFunction, addToQueueFunction, triggerSyncFunction, dataTypeLabel) {
  if (isDebugModeEnabled) console.log(`[API Module] Entering handleGenericSubmitRequest for ${dataTypeLabel} (port)`);
  try {
    const { userID } = await chrome.storage.local.get(['userID']);
    if (!userID) {
      console.error(`[API Module] Error in handleGenericSubmitRequest (port): Cannot get userID for ${dataTypeLabel}`);
      // 使用 portSendResponse 發送錯誤
      portSendResponse({ success: false, error: '無法獲取 userID' });
      return; // 提前返回
    }

    const fullData = { ...data, userID };

    if (isDebugModeEnabled) console.log(`[API Module] Handling ${dataTypeLabel} submission with userID (port):`, fullData);
    try {
      if (isDebugModeEnabled) console.log(`[API Module] Attempting to send ${dataTypeLabel} directly to API with userID (port):`, fullData);
      const result = await apiCallFunction(fullData);
      if (isDebugModeEnabled) console.log(`[API Module] ${dataTypeLabel} sent directly to API (port):`, result);
      // 使用 portSendResponse 發送成功響應
      portSendResponse({ success: true, result });
    } catch (apiError) {
      console.warn(`[API Module] Failed to send ${dataTypeLabel} directly, adding to queue (port):`, apiError.message, fullData);
      await addToQueueFunction(fullData);
      // 使用 portSendResponse 發送排隊響應
      portSendResponse({ success: true, queued: true, message: `${dataTypeLabel}已暫存，將在網路恢復後提交` });
      // 觸發一次同步嘗試 (非阻塞)
      triggerSyncFunction();
    }
  } catch (error) {
    console.error(`[API Module] Error processing ${dataTypeLabel} request (port):`, error);
    // 使用 portSendResponse 發送錯誤響應
    portSendResponse({ success: false, error: error.message });
  }
}

/**
 * 將投票數據添加到投票緩存隊列
 * @param {object} voteData - 包含 userID 的投票數據
 */
async function addVoteToQueue(voteData) {
  await addToQueue(voteData, 'voteQueue', 'Vote');
}

/**
 * 將翻譯數據添加到翻譯緩存隊列
 * @param {object} translationData - 包含 userID 的翻譯數據
 */
async function addTranslationToQueue(translationData) {
  await addToQueue(translationData, 'translationQueue', 'Translation');
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
    const MAX_QUEUE_SIZE = 100;
    if (queue.length >= MAX_QUEUE_SIZE) {
      console.warn(`[API Module] ${dataTypeLabel} queue is full, discarding oldest item.`);
      queue.shift();
    }
    queue.push(data);
    await chrome.storage.local.set({ [queueKey]: queue });
    if (isDebugModeEnabled) console.log(`[API Module] ${dataTypeLabel} added to queue. Queue size:`, queue.length);
  } catch (error) {
    console.error(`[API Module] Error adding ${dataTypeLabel} to queue:`, error);
  }
}

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
  if (originalSubtitle) body.originalSubtitle = originalSubtitle;

  if (translationID) {
    url = `${API_BASE_URL}/translations/${translationID}/vote`;
  } else {
    url = `${API_BASE_URL}/votes`;
    if (!body.originalSubtitle) {
      console.warn("[API Module] Missing originalSubtitle for vote without translationID. API call might fail.");
    }
  }

  if (isDebugModeEnabled) console.log('[API Module] Sending vote to API:', url, body);
  return await sendToAPI(url, body);
}

/**
 * 發送單個翻譯提交到後端 API
 * @param {object} translationData - 包含 userID 的完整翻譯數據
 */
async function sendTranslationToAPI(translationData) {
  const { videoId, timestamp, original, translation, submissionReason, languageCode, userID } = translationData;

  if (!userID || !videoId || typeof timestamp !== 'number' || !original || !translation || !languageCode) {
    throw new Error('Missing or invalid parameters for translation API call');
  }

  const url = `${API_BASE_URL}/translations`;
  const body = {
    contributorUserID: userID,
    videoID: videoId,
    timestamp: timestamp,
    originalSubtitle: original,
    suggestedSubtitle: translation,
    languageCode: languageCode,
    submissionReason: submissionReason || ''
  };

  if (isDebugModeEnabled) console.log('[API Module] Sending translation to API:', url, body);
  return await sendToAPI(url, body);
}

/**
 * 通用發送 API 請求函數
 * @param {string} url
 * @param {object} body
 */
async function sendToAPI(url, body) {
  // 添加超時控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超時

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal // 綁定 AbortSignal
    });

    clearTimeout(timeoutId); // 清除超時計時器

    if (!res.ok) {
      let errorMsg = `API request failed with status ${res.status}`;
      try {
        const err = await res.json();
        errorMsg = err.error || errorMsg;
      } catch (e) {
        if (isDebugModeEnabled) console.log('[API Module] Failed to parse API error response as JSON.');
      }
      console.error('[API Module] API Error:', errorMsg);
      throw new Error(errorMsg);
    }

    try {
      const jsonResponse = await res.json();
      if (isDebugModeEnabled) console.log('[API Module] API Success Response:', jsonResponse);
      return jsonResponse;
    } catch (e) {
      console.error('[API Module] Error parsing successful API response as JSON:', e);
      return { success: true, message: 'Response received but could not be parsed as JSON.' };
    }
  } catch (error) {
    clearTimeout(timeoutId); // 確保在錯誤發生時也清除計時器
    if (error.name === 'AbortError') {
      console.error('[API Module] Send API request timed out:', url);
      throw new Error('發送 API 請求超時');
    } else {
      console.error('[API Module] Error during send API request:', error);
      throw error; // 重新拋出其他錯誤
    }
  }
}

/**
 * 觸發投票同步
 */
function triggerVoteSync() {
  if (isDebugModeEnabled) console.log('[API Module] Triggering vote sync');
  // 發送訊息到背景腳本，路由到 sync.js
  chrome.runtime.sendMessage({ type: 'TRIGGER_VOTE_SYNC' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[API Module] Error triggering vote sync:', chrome.runtime.lastError.message);
    } else {
      if (isDebugModeEnabled) console.log('[API Module] Vote sync triggered:', response);
    }
  });
}

/**
 * 觸發翻譯同步
 */
function triggerTranslationSync() {
  if (isDebugModeEnabled) console.log('[API Module] Triggering translation sync');
  // 發送訊息到背景腳本，路由到 sync.js
  chrome.runtime.sendMessage({ type: 'TRIGGER_TRANSLATION_SYNC' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[API Module] Error triggering translation sync:', chrome.runtime.lastError.message);
    } else {
      if (isDebugModeEnabled) console.log('[API Module] Translation sync triggered:', response);
    }
  });
}

/**
 * 設置調試模式狀態
 * @param {boolean} debugMode - 調試模式是否啟用
 */
export function setDebugMode(debugMode) {
  isDebugModeEnabled = debugMode;
}
