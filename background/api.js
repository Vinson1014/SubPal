// background/api.js
// API 模組 - 負責 HTTP 通信層
// 重構版本：職責單一，只負責 API 請求與響應處理

import {
  resolveBackendProfile,
  setBackendProfileCredentials
} from './backend-profiles.js';
import { ensureStorageMigrationsComplete } from './storage-migrations.js';

// ==================== 配置 ====================

/**
 * 獲取 API Base URL（從新配置系統讀取）
 * @returns {Promise<string>} - API Base URL
 */
async function resolveApiProfile(backendProfileId) {
  await ensureStorageMigrationsComplete(chrome.storage.local);
  return await resolveBackendProfile(chrome.storage.local, backendProfileId);
}

async function getApiBaseUrl(profile) {
  return profile.endpoint;
}

function normalizeResolutionContext(context) {
  if (!context || typeof context !== 'object') {
    throw new Error('resolutionContext must be an object');
  }

  const requiredKeys = ['taskID', 'targetType', 'action', 'slotKey', 'timestamp'];
  if (!requiredKeys.every((key) => Object.hasOwn(context, key))) {
    throw new Error('resolutionContext is missing required fields');
  }

  return {
    taskID: context.taskID,
    targetType: context.targetType,
    action: context.action,
    slotKey: context.slotKey,
    timestamp: context.timestamp
  };
}

/**
 * 取得前端 clientVersion，供後端 rollout 與行為觀測使用。
 * @returns {string|null}
 */
function getClientVersion() {
  try {
    const version = chrome.runtime.getManifest()?.version;
    return version ? `frontend-${version}` : null;
  } catch {
    console.warn('[API Module] Unable to resolve clientVersion');
    return null;
  }
}

function normalizeErrorCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null;
}

// ==================== 底層 HTTP 通信 ====================

const jwtRefreshPromises = new Map();

/**
 * 通用發送 API 請求函數
 * @param {string} url - 完整的 API URL
 * @param {object} body - 請求體（POST/PUT）
 * @param {string} method - HTTP 方法，預設為 POST
 * @returns {Promise<Object>} - API 響應 JSON
 * @throws {Error} - 包含 status, code, details 屬性的錯誤
 */
async function sendToAPI(url, body, method = 'POST', profile) {
  // 添加超時控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超時

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (profile.jwt) {
      headers['Authorization'] = `Bearer ${profile.jwt}`;
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
      let errorCode = null;
      try {
        const errJson = await res.json();
        errorCode = normalizeErrorCode(errJson?.error?.code);
      } catch {
        // 無法解析 JSON 錯誤響應
      }
      console.error('[API Module] API Error:', { method, status: res.status, code: errorCode });
      const error = new Error(`API request failed with status ${res.status}`);
      error.status = res.status;
      error.details = { status: res.status, code: errorCode };
      // 提取統一錯誤格式中的 error code
      if (errorCode) error.code = errorCode;
      throw error;
    }

    try {
      const jsonResponse = await res.json();
      return jsonResponse;
    } catch {
      console.error('[API Module] Error parsing successful API response as JSON');
      return { success: true, message: 'Response received but could not be parsed as JSON.' };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('[API Module] Send API request timed out:', { method });
      throw new Error('發送 API 請求超時');
    } else {
      console.error('[API Module] Error during send API request:', {
        method,
        status: error.status ?? null,
        code: error.code ?? null
      });
      throw error;
    }
  }
}

async function sendToAPIWithAutoRefresh(url, body, method, autoRetryOn401 = true, profile) {
  if (!autoRetryOn401) return await sendToAPI(url, body, method, profile);

  try {
    return await sendToAPI(url, body, method, profile);
  } catch (error) {
    if (error.status !== 401) throw error;

    try {
      const refreshedProfile = await refreshJwtTokenOnce(profile);
      return await sendToAPI(url, body, method, refreshedProfile);
    } catch (refreshError) {
      console.error('[API Module] JWT refresh failed.');
      throw new Error('認證已過期且刷新失敗，請重新啟動擴展。');
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
 * @param {string} [voteData.slotKey] - 字幕 slot 識別值（可選）
 * @param {string} [voteData.clientVersion] - 前端版本（可選）
 * @returns {Promise<Object>} - API 響應
 * @throws {Error} - 錯誤包含 status, code, details 屬性
 */
export async function submitVote(voteData) {
  const { translationID, videoID, originalSubtitle, timestamp, voteType, slotKey, clientVersion, resolutionContext, backendProfileId } = voteData;

  if (!videoID || typeof timestamp !== 'number' || !['upvote', 'downvote'].includes(voteType)) {
    throw new Error('Missing or invalid parameters for vote submission');
  }

  const profile = await resolveApiProfile(backendProfileId);
  const apiBaseUrl = await getApiBaseUrl(profile);
  const url = `${apiBaseUrl}/votes`;
  const body = {
    videoID,
    timestamp,
    voteType,
    translationID: translationID || null
  };
  if (originalSubtitle) body.originalSubtitle = originalSubtitle;
  if (slotKey) body.slotKey = slotKey;
  const resolvedClientVersion = clientVersion || getClientVersion();
  if (resolvedClientVersion) body.clientVersion = resolvedClientVersion;
  if (resolutionContext !== undefined && resolutionContext !== null) {
    body.resolutionContext = normalizeResolutionContext(resolutionContext);
  }

  if (!body.originalSubtitle) {
    console.warn("[API Module] Missing originalSubtitle for vote submission. API call might fail.");
  }

  const response = await sendToAPIWithAutoRefresh(url, body, undefined, true, profile);
  return response.data || response;
}

/**
 * 設定投票狀態（支援取消投票與切換投票）
 * @param {Object} params - 投票狀態參數
 * @param {string} params.translationID - 翻譯 ID（必填，非空字串）
 * @param {string} params.voteState - 投票狀態：'like' | 'dislike' | 'none'
 * @param {string} [params.clientVersion] - 前端版本（可選）
 * @returns {Promise<Object>} - API 響應
 * @throws {Error} - 參數驗證失敗或 API 錯誤
 */
export async function setVoteState({ translationID, voteState, clientVersion, resolutionContext, backendProfileId }) {
  if (!translationID || typeof translationID !== 'string') {
    throw new Error('Missing or invalid parameter: translationID must be a non-empty string');
  }
  if (!['like', 'dislike', 'none'].includes(voteState)) {
    throw new Error("Missing or invalid parameter: voteState must be one of 'like', 'dislike', 'none'");
  }

  const profile = await resolveApiProfile(backendProfileId);
  const apiBaseUrl = await getApiBaseUrl(profile);
  const url = `${apiBaseUrl}/votes/state`;
  const body = {
    translationID,
    voteState
  };
  const resolvedClientVersion = clientVersion || getClientVersion();
  if (resolvedClientVersion) body.clientVersion = resolvedClientVersion;
  if (resolutionContext !== undefined && resolutionContext !== null) {
    body.resolutionContext = normalizeResolutionContext(resolutionContext);
  }

  const response = await sendToAPIWithAutoRefresh(url, body, 'PUT', true, profile);
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
 * @param {string} [translationData.slotKey] - 字幕 slot 識別值（可選）
 * @param {string} [translationData.clientVersion] - 前端版本（可選）
 * @returns {Promise<Object>} - API 響應
 * @throws {Error} - 錯誤包含 status, code, details 屬性
 */
export async function submitTranslation(translationData) {
  const {
    videoId,
    timestamp,
    original,
    translation,
    submissionReason,
    languageCode,
    slotKey,
    clientVersion,
    translationID,
    sourceTranslationID,
    resolutionContext,
    backendProfileId
  } = translationData;

  if (!videoId || typeof timestamp !== 'number' || !original || !translation || !languageCode) {
    throw new Error('Missing or invalid parameters for translation submission');
  }

  const profile = await resolveApiProfile(backendProfileId);
  const apiBaseUrl = await getApiBaseUrl(profile);
  const url = `${apiBaseUrl}/translations`;
  const body = {
    videoID: videoId,
    timestamp: timestamp,
    originalSubtitle: original,
    suggestedSubtitle: translation,
    languageCode: languageCode,
    submissionReason: submissionReason || ''
  };
  if (slotKey) body.slotKey = slotKey;
  if (resolutionContext !== undefined && resolutionContext !== null) {
    body.translationID = translationID ?? null;
    body.resolutionContext = normalizeResolutionContext(resolutionContext);
  } else if (Object.hasOwn(translationData, 'translationID')) {
    body.translationID = translationID ?? null;
  }
  if (sourceTranslationID !== undefined) body.sourceTranslationID = sourceTranslationID;
  const resolvedClientVersion = clientVersion || getClientVersion();
  if (resolvedClientVersion) body.clientVersion = resolvedClientVersion;

  const response = await sendToAPIWithAutoRefresh(url, body, undefined, true, profile);
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
  const { videoId, startTime, duration, autoRetryOn401 = true, backendProfileId } = options;

  if (!videoId || typeof startTime !== 'number' || typeof duration !== 'number') {
    throw new Error('Missing or invalid parameters for fetching subtitles');
  }

  const profile = await resolveApiProfile(backendProfileId);
  const apiBaseUrl = await getApiBaseUrl(profile);
  const url = `${apiBaseUrl}/translations?videoID=${encodeURIComponent(videoId)}&startTime=${startTime}&duration=${duration}`;

  const jsonResponse = await sendToAPIWithAutoRefresh(url, null, 'GET', autoRetryOn401, profile);
  return parseSubtitlesResponse(jsonResponse);
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
      contributorUserID: sub.contributorUserID,
      languageCode: sub.languageCode,
      slotKey: sub.slotKey,
      slotKeySource: sub.slotKeySource,
      clientVersion: sub.clientVersion,
      upvotes: sub.upvotes,
      downvotes: sub.downvotes,
      myVote: sub.myVote ?? null,
      status: sub.status
    }));
  } else {
    console.error('[API Module] API response indicates failure or invalid format:', {
      success: response?.success === true
    });
    throw new Error(response.error || 'API 回傳失敗或字幕數據格式不正確');
  }
}

export async function fetchCrowdsourcingTasks({ videoID, languageCode, limit, backendProfileId }) {
  if (!videoID || typeof videoID !== 'string' || !videoID.trim()) {
    throw new Error('Missing or invalid parameter: videoID must be a non-empty string');
  }
  const normalizedLanguageCode = typeof languageCode === 'string' ? languageCode.trim() : '';
  if (normalizedLanguageCode.length < 2 || normalizedLanguageCode.length > 5) {
    throw new Error('Missing or invalid parameter: languageCode must be 2-5 characters');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20)) {
    throw new Error('Missing or invalid parameter: limit must be an integer from 1 to 20');
  }

  const profile = await resolveApiProfile(backendProfileId);
  const apiBaseUrl = await getApiBaseUrl(profile);
  const query = new URLSearchParams({
    videoID: videoID.trim(),
    languageCode: normalizedLanguageCode
  });
  if (limit !== undefined) query.set('limit', String(limit));

  const response = await sendToAPIWithAutoRefresh(`${apiBaseUrl}/crowdsourcing-tasks?${query.toString()}`, null, 'GET', true, profile);
  if (response && response.success === true && Array.isArray(response.data?.tasks)) {
    return response.data;
  }

  console.error('[API Module] Crowdsourcing tasks response invalid:', {
    success: response?.success,
    hasData: Boolean(response?.data),
    tasksIsArray: Array.isArray(response?.data?.tasks)
  });
  throw new Error(response?.error || 'API 回傳失敗或眾包任務數據格式不正確');
}

// ==================== 用戶 API ====================

/**
 * 註冊用戶並獲取 JWT
 * @param {string} userID - 用戶 ID
 * @returns {Promise<Object>} - 包含 success 和 token 的響應
 */
async function registerUserForProfile(userID, profile) {
  const apiBaseUrl = await getApiBaseUrl(profile);
  const url = `${apiBaseUrl}/users`;
  return await sendToAPI(url, { userID }, 'POST', profile);
}

export async function registerUser(userID, backendProfileId) {
  const profile = await resolveApiProfile(backendProfileId);
  return await registerUserForProfile(userID, profile);
}

/**
 * 獲取用戶統計數據
 * @param {string} userID - 用戶 ID
 * @param {boolean} [autoRetryOn401=true] - 401 錯誤時自動重試
 * @returns {Promise<Object>} - 包含用戶統計數據的響應
 */
export async function fetchUserStats(userID, autoRetryOn401 = true, backendProfileId) {
  const profile = await resolveApiProfile(backendProfileId);
  const apiBaseUrl = await getApiBaseUrl(profile);
  const url = `${apiBaseUrl}/users/${encodeURIComponent(userID)}`;

  return await sendToAPIWithAutoRefresh(url, null, 'GET', autoRetryOn401, profile);
}

// ==================== 替換事件 API ====================

/**
 * 提交替換事件到後端 API
 * @param {Array} events - 替換事件陣列
 * @param {boolean} [autoRetryOn401=true] - 401 錯誤時自動重試
 * @returns {Promise<Object>} - API 回應結果
 */
export async function submitReplacementEvents(events, autoRetryOn401 = true, backendProfileId) {
  const profile = await resolveApiProfile(backendProfileId);
  const apiBaseUrl = await getApiBaseUrl(profile);
  const url = `${apiBaseUrl}/replacement-events`;
  const serializedEvents = events.map(({ translationID, contributorUserID, beneficiaryUserID, occurredAt }) => ({
    translationID,
    contributorUserID,
    beneficiaryUserID,
    occurredAt
  }));

  return await sendToAPIWithAutoRefresh(url, { events: serializedEvents }, 'POST', autoRetryOn401, profile);
}

// ==================== JWT 管理 ====================

/**
 * 刷新 JWT Token - 重新註冊用戶獲取新的 JWT
 * @returns {Promise<void>} - 成功刷新或拋出錯誤
 */
async function refreshJwtToken(profile) {
  console.log('[API Module] Starting JWT token refresh...');

  try {
    const response = await registerUserForProfile(profile.userId, profile);
    if (!response.token) {
      throw new Error(response.error || 'Failed to refresh JWT token');
    }
    await setBackendProfileCredentials(chrome.storage.local, profile.id, { jwt: response.token });
    console.log('[API Module] JWT refreshed successfully.');
    return { ...profile, jwt: response.token };
  } catch (error) {
    console.error('[API Module] Error during JWT token refresh');
    throw error;
  }
}

function refreshJwtTokenOnce(profile) {
  const currentRefresh = jwtRefreshPromises.get(profile.id);
  if (currentRefresh) return currentRefresh;

  const refresh = refreshJwtToken(profile).finally(() => {
    if (jwtRefreshPromises.get(profile.id) === refresh) {
      jwtRefreshPromises.delete(profile.id);
    }
  });
  jwtRefreshPromises.set(profile.id, refresh);
  return refresh;
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
