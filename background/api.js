// background/api.js
// API 模組 - 負責 HTTP 通信層
// 重構版本：職責單一，只負責 API 請求與響應處理

// ==================== 配置 ====================

/**
 * 獲取 API Base URL（從新配置系統讀取）
 * @returns {Promise<string>} - API Base URL
 */
async function getApiBaseUrl() {
  const result = await chrome.storage.local.get(['api']);
  console.log('[API Module] Retrieved API Base URL from storage:', result.api?.baseUrl);
  return result.api?.baseUrl || 'https://subnfbackend.zeabur.app';
}

// ==================== 底層 HTTP 通信 ====================

/**
 * 通用發送 API 請求函數
 * @param {string} url - 完整的 API URL
 * @param {object} body - 請求體（POST/PUT）
 * @param {string} method - HTTP 方法，預設為 POST
 * @returns {Promise<Object>} - API 響應 JSON
 * @throws {Error} - 包含 status, code, details 屬性的錯誤
 */
async function sendToAPI(url, body, method = 'POST') {
  // 添加超時控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超時

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // 從 chrome.storage.local 中獲取 JWT
    const { jwt } = await chrome.storage.local.get('jwt');
    if (jwt) {
      headers['Authorization'] = `Bearer ${jwt}`;
    }

    const fetchOptions = {
      method: method,
      headers: headers,
      signal: controller.signal
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    if (!res.ok) {
      let errorMsg = `API request failed with status ${res.status}`;
      let errorDetails = {};
      try {
        const errJson = await res.json();
        // 正確處理錯誤訊息格式
        if (errJson.error && typeof errJson.error === 'object' && errJson.error.message) {
          errorMsg = errJson.error.message;
        } else if (typeof errJson.error === 'string') {
          errorMsg = errJson.error;
        }
        errorDetails = errJson;
      } catch (e) {
        // 無法解析 JSON 錯誤響應
      }
      console.error('[API Module] API Error:', errorMsg, errorDetails);
      const error = new Error(errorMsg);
      error.status = res.status;
      error.details = errorDetails;
      // 提取統一錯誤格式中的 error code
      if (errorDetails.error && errorDetails.error.code) {
        error.code = errorDetails.error.code;
      }
      throw error;
    }

    try {
      const jsonResponse = await res.json();
      return jsonResponse;
    } catch (e) {
      console.error('[API Module] Error parsing successful API response as JSON:', e);
      return { success: true, message: 'Response received but could not be parsed as JSON.' };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('[API Module] Send API request timed out:', url);
      throw new Error('發送 API 請求超時');
    } else {
      console.error('[API Module] Error during send API request:', error.details);
      throw error;
    }
  }
}

// ==================== 投票 API ====================

/**
 * 提交投票到後端 API
 * @param {Object} voteData - 投票數據
 * @param {string} voteData.videoID - 影片 ID
 * @param {number} voteData.timestamp - 時間戳（秒）
 * @param {string} voteData.voteType - 投票類型 ('upvote' | 'downvote')
 * @param {string} [voteData.translationID] - 翻譯 ID（可選）
 * @param {string} [voteData.originalSubtitle] - 原始字幕（無 translationID 時必填）
 * @returns {Promise<Object>} - API 響應
 * @throws {Error} - 錯誤包含 status, code, details 屬性
 */
export async function submitVote(voteData) {
  const { translationID, videoID, originalSubtitle, timestamp, voteType } = voteData;

  if (!videoID || typeof timestamp !== 'number' || !['upvote', 'downvote'].includes(voteType)) {
    throw new Error('Missing or invalid parameters for vote submission');
  }

  const apiBaseUrl = await getApiBaseUrl();
  let url;
  let body = { videoID, timestamp, voteType };
  if (originalSubtitle) body.originalSubtitle = originalSubtitle;

  if (translationID) {
    url = `${apiBaseUrl}/translations/${translationID}/vote`;
  } else {
    url = `${apiBaseUrl}/votes`;
    if (!body.originalSubtitle) {
      console.warn("[API Module] Missing originalSubtitle for vote without translationID. API call might fail.");
    }
  }

  const response = await sendToAPI(url, body);
  return response.data || response;
}

// ==================== 翻譯 API ====================

/**
 * 提交翻譯到後端 API
 * @param {Object} translationData - 翻譯數據
 * @param {string} translationData.videoId - 影片 ID
 * @param {number} translationData.timestamp - 時間戳（秒）
 * @param {string} translationData.original - 原始字幕
 * @param {string} translationData.translation - 翻譯字幕
 * @param {string} translationData.languageCode - 語言代碼
 * @param {string} [translationData.submissionReason] - 提交原因（可選）
 * @returns {Promise<Object>} - API 響應
 * @throws {Error} - 錯誤包含 status, code, details 屬性
 */
export async function submitTranslation(translationData) {
  const { videoId, timestamp, original, translation, submissionReason, languageCode } = translationData;

  if (!videoId || typeof timestamp !== 'number' || !original || !translation || !languageCode) {
    throw new Error('Missing or invalid parameters for translation submission');
  }

  const apiBaseUrl = await getApiBaseUrl();
  const url = `${apiBaseUrl}/translations`;
  const body = {
    videoID: videoId,
    timestamp: timestamp,
    originalSubtitle: original,
    suggestedSubtitle: translation,
    languageCode: languageCode,
    submissionReason: submissionReason || ''
  };

  const response = await sendToAPI(url, body);
  return response.data || response;
}

// ==================== 字幕查詢 API ====================

/**
 * 獲取字幕數據
 * @param {Object} options - 查詢選項
 * @param {string} options.videoId - 影片 ID
 * @param {number} options.startTime - 開始時間戳（秒）
 * @param {number} options.duration - 持續時間（秒）
 * @param {boolean} [options.autoRetryOn401=true] - 401 錯誤時自動重試
 * @returns {Promise<Array>} - 字幕數據陣列
 * @throws {Error} - 錯誤包含 status, code, details 屬性
 */
export async function fetchSubtitles(options) {
  const { videoId, startTime, duration, autoRetryOn401 = true } = options;

  if (!videoId || typeof startTime !== 'number' || typeof duration !== 'number') {
    throw new Error('Missing or invalid parameters for fetching subtitles');
  }

  const apiBaseUrl = await getApiBaseUrl();
  const url = `${apiBaseUrl}/translations?videoID=${encodeURIComponent(videoId)}&startTime=${startTime}&duration=${duration}`;

  try {
    const jsonResponse = await sendToAPI(url, null, 'GET');
    return parseSubtitlesResponse(jsonResponse);
  } catch (error) {
    // 處理 401 錯誤 - JWT 過期
    if (error.status === 401 && autoRetryOn401) {
      console.log('[API Module] JWT expired during fetchSubtitles, attempting to refresh and retry...');
      try {
        await refreshJwtToken();
        // 重新嘗試請求
        const retryResponse = await sendToAPI(url, null, 'GET');
        return parseSubtitlesResponse(retryResponse);
      } catch (refreshError) {
        console.error('[API Module] JWT refresh failed during fetchSubtitles:', refreshError);
        throw new Error('認證已過期且刷新失敗，請重新啟動擴展。');
      }
    } else {
      throw error;
    }
  }
}

/**
 * 解析字幕 API 響應
 * @param {Object} response - API 響應
 * @returns {Array} - 字幕數據陣列
 * @throws {Error} - 響應格式錯誤時拋出
 */
function parseSubtitlesResponse(response) {
  if (response && response.success === true && Array.isArray(response.data?.translations)) {
    return response.data.translations.map(sub => ({
      videoID: sub.videoID,
      timestamp: sub.timestamp,
      translationID: sub.translationID,
      originalSubtitle: sub.originalSubtitle,
      suggestedSubtitle: sub.suggestedSubtitle,
      contributorUserID: sub.contributorUserID
    }));
  } else {
    console.error('[API Module] API response indicates failure or invalid format:', response);
    throw new Error(response.error || 'API 回傳失敗或字幕數據格式不正確');
  }
}

// ==================== 用戶 API ====================

/**
 * 註冊用戶並獲取 JWT
 * @param {string} userID - 用戶 ID
 * @returns {Promise<Object>} - 包含 success 和 token 的響應
 */
export async function registerUser(userID) {
  const apiBaseUrl = await getApiBaseUrl();
  const url = `${apiBaseUrl}/users`;
  return await sendToAPI(url, { userID }, 'POST');
}

/**
 * 獲取用戶統計數據
 * @param {string} userID - 用戶 ID
 * @param {boolean} [autoRetryOn401=true] - 401 錯誤時自動重試
 * @returns {Promise<Object>} - 包含用戶統計數據的響應
 */
export async function fetchUserStats(userID, autoRetryOn401 = true) {
  const apiBaseUrl = await getApiBaseUrl();
  const url = `${apiBaseUrl}/users/${userID}`;

  try {
    return await sendToAPI(url, null, 'GET');
  } catch (error) {
    // 處理 401 錯誤 - JWT 過期
    if (error.status === 401 && autoRetryOn401) {
      console.log('[API Module] JWT expired during fetchUserStats, attempting to refresh and retry...');
      try {
        await refreshJwtToken();
        return await sendToAPI(url, null, 'GET');
      } catch (refreshError) {
        console.error('[API Module] JWT refresh failed during fetchUserStats:', refreshError);
        throw new Error('認證已過期且刷新失敗，請重新啟動擴展。');
      }
    } else {
      throw error;
    }
  }
}

// ==================== 替換事件 API ====================

/**
 * 提交替換事件到後端 API
 * @param {Array} events - 替換事件陣列
 * @param {boolean} [autoRetryOn401=true] - 401 錯誤時自動重試
 * @returns {Promise<Object>} - API 回應結果
 */
export async function submitReplacementEvents(events, autoRetryOn401 = true) {
  const apiBaseUrl = await getApiBaseUrl();
  const url = `${apiBaseUrl}/replacement-events`;

  try {
    return await sendToAPI(url, { events }, 'POST');
  } catch (error) {
    // 處理 401 錯誤 - JWT 過期
    if (error.status === 401 && autoRetryOn401) {
      console.log('[API Module] JWT expired during submitReplacementEvents, attempting to refresh and retry...');
      try {
        await refreshJwtToken();
        const retryApiBaseUrl = await getApiBaseUrl();
        const retryUrl = `${retryApiBaseUrl}/replacement-events`;
        return await sendToAPI(retryUrl, { events }, 'POST');
      } catch (refreshError) {
        console.error('[API Module] JWT refresh failed during submitReplacementEvents:', refreshError);
        throw new Error('認證已過期且刷新失敗，請重新啟動擴展。');
      }
    } else {
      throw error;
    }
  }
}

// ==================== JWT 管理 ====================

/**
 * 刷新 JWT Token - 重新註冊用戶獲取新的 JWT
 * @returns {Promise<void>} - 成功刷新或拋出錯誤
 */
async function refreshJwtToken() {
  console.log('[API Module] Starting JWT token refresh...');

  try {
    // 獲取當前的 userId（新格式：user.userId）
    const { user } = await chrome.storage.local.get(['user']);
    const userId = user?.userId || '';

    if (!userId) {
      // 如果沒有 userId，生成一個新的
      const newUserId = crypto.randomUUID();
      await chrome.storage.local.set({ user: { userId: newUserId } });
      console.log('[API Module] Generated new userId for JWT refresh:', newUserId);

      // 使用新的 userId 註冊
      const response = await registerUser(newUserId);
      if (response.token) {
        await chrome.storage.local.set({ jwt: response.token });
        console.log('[API Module] JWT refreshed successfully with new userId.');
      } else {
        throw new Error(response.error || 'Failed to get new JWT token');
      }
    } else {
      // 使用現有 userId 重新註冊
      console.log('[API Module] Re-registering existing userId for JWT refresh:', userId);
      const response = await registerUser(userId);

      if (response.token) {
        await chrome.storage.local.set({ jwt: response.token });
        console.log('[API Module] JWT refreshed successfully for existing userId.');
      } else {
        throw new Error(response.error || 'Failed to refresh JWT token');
      }
    }
  } catch (error) {
    console.error('[API Module] Error during JWT token refresh:', error);
    throw error;
  }
}

// ==================== 錯誤輔助函數 ====================

/**
 * 判斷是否為永久錯誤（不應重試）
 * @param {Error} error - 錯誤對象
 * @returns {boolean}
 */
export function isPermanentError(error) {
  // 優先使用 error code 判斷
  if (error.code) {
    const permanentErrorCodes = [
      'VALIDATION_ERROR',    // 參數驗證失敗
      'INVALID_FORMAT',      // ID格式錯誤
      'NOT_FOUND',          // 資源不存在
      'FORBIDDEN',          // 禁止操作（如投票自己的翻譯）
      'BUSINESS_RULE_VIOLATION' // 業務規則違反
    ];

    if (permanentErrorCodes.includes(error.code)) {
      return true;
    }
  }

  // 備用：檢查錯誤訊息（包含特定的業務邏輯錯誤）
  const permanentErrorMessages = [
    'Cannot vote on your own translation',
    'User not authorized to perform this action',
    'Invalid translation ID format',
    'Translation does not exist',
    'Invalid vote type'
  ];

  if (error.message) {
    for (const permanentMsg of permanentErrorMessages) {
      if (error.message.includes(permanentMsg)) {
        return true;
      }
    }
  }

  // 檢查錯誤詳情中的訊息
  if (error.details && error.details.error && error.details.error.message) {
    for (const permanentMsg of permanentErrorMessages) {
      if (error.details.error.message.includes(permanentMsg)) {
        return true;
      }
    }
  }

  // 400 Bad Request 和 403 Forbidden 通常也是永久錯誤
  if (error.status === 400 || error.status === 403 || error.status === 404) {
    return true;
  }

  // 409 Conflict 也視為永久錯誤（重複提交）
  if (error.status === 409) {
    return true;
  }

  return false;
}

/**
 * 判斷是否為可重試錯誤
 * @param {Error} error - 錯誤對象
 * @returns {boolean}
 */
export function isRetryableError(error) {
  // 網路錯誤、超時
  if (!error.status || error.message.includes('超時') || error.name === 'AbortError') {
    return true;
  }

  // 5xx 伺服器錯誤
  if (error.status >= 500 && error.status < 600) {
    return true;
  }

  // 429 Too Many Requests
  if (error.status === 429) {
    return true;
  }

  return false;
}
