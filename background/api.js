// background/api.js
// 負責處理與後端 API 相關的操作的模組

// API Base URL，初始值將從 chrome.storage.sync 中載入
let API_BASE_URL = 'http://localhost:3000'; // 初始預設值
let isDebugModeEnabled = false;

// 從 chrome.storage.local 載入初始 API Base URL
chrome.storage.local.get({ apiBaseUrl: 'http://localhost:3000' }, (items) => {
  API_BASE_URL = items.apiBaseUrl;
  if (isDebugModeEnabled) console.log('[API Module] Initial API Base URL loaded:', API_BASE_URL);
});

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

  try {
    // 改用 sendToAPI 函數發送 GET 請求
    const jsonResponse = await sendToAPI(url, null, 'GET');

    if (jsonResponse && jsonResponse.success === true && Array.isArray(jsonResponse.subtitles)) {
      const subtitles = jsonResponse.subtitles;
      if (isDebugModeEnabled) console.log(`[API Module] API returned ${subtitles.length} subtitles.`);
      return subtitles.map(sub => ({
        videoID: sub.videoID,
        timestamp: sub.timestamp,
        translationID: sub.translationID,
        originalSubtitle: sub.originalSubtitle,
        suggestedSubtitle: sub.suggestedSubtitle,
        contributorUserID: sub.contributorUserID
      }));
    } else {
      console.error('[API Module] API response indicates failure or invalid format:', jsonResponse);
      throw new Error(jsonResponse.error || 'API 回傳失敗或字幕數據格式不正確');
    }
  } catch (error) {
    console.error('[API Module] Error during fetch subtitles:', error);
    throw error;
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
    // 不再從 chrome.storage.local 獲取 userID，因為 JWT 會處理身份驗證
    // const { userID } = await chrome.storage.local.get(['userID']);
    // if (!userID) {
    //   console.error(`[API Module] Error in handleGenericSubmitRequest (port): Cannot get userID for ${dataTypeLabel}`);
    //   portSendResponse({ success: false, error: '無法獲取 userID' });
    //   return;
    // }

    // fullData 不再包含 userID，因為後端會從 JWT 中獲取
    const fullData = { ...data }; // 移除 userID

    if (isDebugModeEnabled) console.log(`[API Module] Handling ${dataTypeLabel} submission (port):`, fullData);
    try {
      if (isDebugModeEnabled) console.log(`[API Module] Attempting to send ${dataTypeLabel} directly to API (port):`, fullData);
      const result = await apiCallFunction(fullData);
      if (isDebugModeEnabled) console.log(`[API Module] ${dataTypeLabel} sent directly to API (port):`, result);
      // 使用 portSendResponse 發送成功響應
      portSendResponse({ success: true, result });
    } catch (apiError) {
      // 檢查是否為 401 Unauthorized 錯誤
      if (apiError.status === 401) {
        console.error(`[API Module] ${dataTypeLabel} submission failed due to Unauthorized (401). JWT might be invalid or expired.`, apiError.message);
        portSendResponse({ success: false, error: '認證失敗，請重新登錄或檢查擴展權限。' });
        // TODO: 觸發 JWT 刷新或重新註冊流程
        return;
      }
      // 檢查是否為 409 衝突錯誤
      if (apiError.status === 409) {
        console.warn(`[API Module] ${dataTypeLabel} already exists (409 Conflict), treating as success:`, apiError.message, fullData);
        // 視為成功，不添加到隊列，直接返回成功響應
        portSendResponse({ success: true, message: `${dataTypeLabel}已存在，無需重複提交` });
      } else {
        // 其他錯誤，添加到隊列
        console.warn(`[API Module] Failed to send ${dataTypeLabel} directly, adding to queue (port):`, apiError.message, fullData);
        await addToQueueFunction(fullData);
        // 使用 portSendResponse 發送排隊響應
        portSendResponse({ success: true, queued: true, message: `${dataTypeLabel}已暫存，將在網路恢復後提交` });
        // 觸發一次同步嘗試 (非阻塞)
        triggerSyncFunction();
      }
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
  const { translationID, videoID, originalSubtitle, timestamp, voteType } = voteData; // 移除 userID

  if (!videoID || typeof timestamp !== 'number' || !['upvote', 'downvote'].includes(voteType)) {
    throw new Error('Missing or invalid parameters for API call');
  }

  let url;
  let body = { videoID, timestamp, voteType }; // 移除 userID
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
  const { videoId, timestamp, original, translation, submissionReason, languageCode } = translationData; // 移除 userID

  if (!videoId || typeof timestamp !== 'number' || !original || !translation || !languageCode) {
    throw new Error('Missing or invalid parameters for translation API call');
  }

  const url = `${API_BASE_URL}/translations`;
  const body = {
    // contributorUserID 將由後端從 JWT 中獲取
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
async function sendToAPI(url, body, method = 'POST') { // 允許指定方法，預設為 POST
  // 添加超時控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超時
  
  // debug message
  if (isDebugModeEnabled) console.log(`[API Module] Sending request to URL:`, url);
  if (isDebugModeEnabled) console.log(`[API Module] Request body:`, body);
  if (isDebugModeEnabled) console.log(`[API Module] Request method:`, method);

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json' // 確保接收 JSON 響應
    };

    // 從 chrome.storage.local 中獲取 JWT
    const { jwt } = await chrome.storage.local.get('jwt');
    if (jwt) {
      headers['Authorization'] = `Bearer ${jwt}`;
      if (isDebugModeEnabled) console.log('[API Module] Attaching JWT to request headers.');
    } else {
      if (isDebugModeEnabled) console.log('[API Module] No JWT found in storage for this request.');
    }

    const fetchOptions = {
      method: method,
      headers: headers,
      signal: controller.signal // 綁定 AbortSignal
    };

    if (body) { // 只有 POST/PUT 請求才需要 body
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOptions);

    clearTimeout(timeoutId); // 清除超時計時器

    if (!res.ok) {
      let errorMsg = `API request failed with status ${res.status}`;
      let errorDetails = {};
      try {
        const errJson = await res.json();
        errorMsg = errJson.error || errorMsg;
        errorDetails = errJson;
      } catch (e) {
        if (isDebugModeEnabled) console.log('[API Module] Failed to parse API error response as JSON.');
      }
      console.error('[API Module] API Error:', errorMsg, errorDetails);
      const error = new Error(errorMsg);
      error.status = res.status; // 添加 status 屬性
      error.details = errorDetails; // 添加詳細錯誤信息
      throw error;
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

/**
 * 設置 API Base URL
 * @param {string} url - 新的 API Base URL
 */
export function setApiBaseUrl(url) {
  API_BASE_URL = url;
  if (isDebugModeEnabled) console.log('[API Module] API Base URL updated:', API_BASE_URL);
}

/**
 * 註冊用戶並獲取 JWT
 * @param {string} userID - 用戶 ID
 * @returns {Promise<Object>} - 包含 success 和 token 的響應
 */
export async function registerUser(userID) {
  const url = `${API_BASE_URL}/users`;
  return await sendToAPI(url, { userID }, 'POST');
}

/**
 * 獲取用戶統計數據
 * @param {string} userID - 用戶 ID
 * @returns {Promise<Object>} - 包含用戶統計數據的響應
 */
export async function fetchUserStats(userID) {
  const url = `${API_BASE_URL}/users/${userID}`;
  return await sendToAPI(url, null, 'GET');
}

/**
 * 提交替換事件到後端 API
 * @param {Array} events - 替換事件陣列
 * @returns {Promise<Object>} - API 回應結果
 */
export async function submitReplacementEvents(events) {
  const url = `${API_BASE_URL}/replacement-events`;
  return await sendToAPI(url, { events }, 'POST');
}
