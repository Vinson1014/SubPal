// background.js - 用於跨模組消息與全局狀態管理
// 使用 chrome.runtime.connect 處理 content script 消息以提高穩定性

// 全局未處理的 Promise Rejection 監聽器
self.addEventListener('unhandledrejection', function(event) {
  console.error('[Background] Unhandled Promise Rejection:', event.reason);
  // 考慮記錄更詳細的錯誤信息，例如 event.reason.stack
  if (event.reason && event.reason.stack) {
    console.error('[Background] Stack trace:', event.reason.stack);
  }
});

// Service Worker 實例 ID，僅用於本次執行期的日誌關聯
const serviceWorkerInstanceId = `sw-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
console.log(`[Background] Service Worker script executing. Current Instance ID: ${serviceWorkerInstanceId}`);

import * as apiModule from './background/api.js';
import * as syncModule from './background/sync.js';
import './background/sync-listener.js'; // 載入同步監聽器，自動註冊 storage 變化監聽
import {
  activateBackendProfile,
  createBackendProfile,
  deleteBackendProfile,
  exportBackendProfileQueue,
  listBackendProfiles,
  resolveBackendProfile,
  setBackendProfileCredentials
} from './background/backend-profiles.js';
import { ensureStorageMigrationsComplete } from './background/storage-migrations.js';

let lifecycleInitialization;

function initializeLifecycle() {
  if (!lifecycleInitialization) {
    lifecycleInitialization = (async () => {
      await ensureStorageMigrationsComplete();
      await ensureUserRegisteredAndJwtPresent();
      await syncModule.initializeSync();
    })().finally(() => {
      lifecycleInitialization = null;
    });
  }
  return lifecycleInitialization;
}

// 擴充功能安裝/更新事件
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[Background] onInstalled event. Instance ID: ${serviceWorkerInstanceId}. 字幕助手擴充功能已安裝或更新`);

  try {
    await initializeLifecycle();
  } catch (error) {
    console.error('[Background] Lifecycle initialization failed:', error);
    throw error;
  }
  
  // 檢查是否需要顯示教學頁面
  if (details.reason === 'install') {
    await showTutorialIfNeeded();
  }
});

/**
 * 檢查是否需要顯示教學頁面，如果是首次安裝且未完成教學則顯示
 */
async function showTutorialIfNeeded() {
  try {
    const result = await chrome.storage.local.get(['tutorialCompleted']);
    if (!result.tutorialCompleted) {
      // 首次安裝且未完成教學，打開教學頁面
      console.log('[Background] Opening tutorial page for new installation');
      const tutorialUrl = chrome.runtime.getURL('tutorial.html');
      await chrome.tabs.create({
        url: tutorialUrl,
        active: true
      });
      console.log('[Background] Tutorial page opened successfully');
    } else {
      console.log('[Background] Tutorial already completed, skipping');
    }
  } catch (error) {
    console.error('[Background] Error checking tutorial status or opening tutorial page:', error);
  }
}

// 擴充功能啟動事件
chrome.runtime.onStartup.addListener(async () => {
  console.log(`[Background] onStartup event. Instance ID: ${serviceWorkerInstanceId}. Extension startup, triggering initialization.`);

  try {
    await initializeLifecycle();
  } catch (error) {
    console.error('[Background] Lifecycle initialization failed:', error);
    throw error;
  }
});

/**
 * 確保用戶已註冊並存在 JWT
 */
async function ensureUserRegisteredAndJwtPresent() {
  console.log('[Background] Checking user registration and JWT presence...');
  const profile = await resolveBackendProfile(chrome.storage.local);
  if (profile.jwt) return;
  const response = await apiModule.registerUser(profile.userId, profile.id);
  if (!response?.token) throw new Error(response?.error || 'User registration returned no token');
  await setBackendProfileCredentials(chrome.storage.local, profile.id, { jwt: response.token });
  console.log('[Background] Successfully registered user and obtained JWT.');
}

// 儲存 content script 的 port，以 tabId 為鍵
const contentScriptPorts = new Map();
const BACKEND_PROFILE_COMMANDS = new Set([
  'BACKEND_PROFILES_LIST',
  'BACKEND_PROFILES_CREATE',
  'BACKEND_PROFILES_ACTIVATE',
  'BACKEND_PROFILES_DELETE',
  'BACKEND_PROFILES_EXPORT_QUEUE'
]);

function profileFailure(kind, code) {
  return { ok: false, error: { kind, code, retryable: false } };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPortRequest(messageData) {
  let messageId;
  try {
    if (!isRecord(messageData)) return { messageId, valid: false };
    messageId = messageData.messageId;
    const message = messageData.message;
    if (!isRecord(message) || typeof message.type !== 'string') return { messageId, valid: false };
    return { messageId, message, type: message.type, valid: true };
  } catch {
    return { messageId, valid: false };
  }
}

function isBackendProfileCommand(type) {
  return BACKEND_PROFILE_COMMANDS.has(type);
}

function isTrustedOptionsSender(port) {
  try {
    if (port?.name !== 'options-page-channel') return false;
    const sender = port.sender;
    const optionsUrl = chrome.runtime.getURL('options.html');
    const parsedOptionsUrl = new URL(optionsUrl);
    const optionsOrigin = parsedOptionsUrl.origin === 'null'
      ? optionsUrl.slice(0, optionsUrl.indexOf('/', optionsUrl.indexOf('//') + 2))
      : parsedOptionsUrl.origin;
    const senderTab = sender.tab;
    return isRecord(sender) &&
      sender.id === chrome.runtime.id &&
      (senderTab === undefined || (isRecord(senderTab) && senderTab.url === optionsUrl)) &&
      sender.url === optionsUrl &&
      (sender.origin === undefined || sender.origin === optionsOrigin);
  } catch {
    return false;
  }
}

function parseBackendProfileRequest(request) {
  try {
    if (!isRecord(request) || !isBackendProfileCommand(request.type) || !Object.hasOwn(request, 'type')) return null;
    const keys = Object.keys(request);
    const hasOnly = (...allowed) => keys.every((key) => allowed.includes(key));
    const profileId = request.profileId;
    const validProfileId = typeof profileId === 'string' && profileId.length > 0;
    switch (request.type) {
      case 'BACKEND_PROFILES_LIST':
        return hasOnly('type') ? { type: request.type } : null;
      case 'BACKEND_PROFILES_CREATE':
        return hasOnly('type', 'endpoint') && Object.hasOwn(request, 'endpoint') && typeof request.endpoint === 'string'
          ? { type: request.type, endpoint: request.endpoint }
          : null;
      case 'BACKEND_PROFILES_ACTIVATE':
      case 'BACKEND_PROFILES_EXPORT_QUEUE':
        return hasOnly('type', 'profileId') && Object.hasOwn(request, 'profileId') && validProfileId
          ? { type: request.type, profileId }
          : null;
      case 'BACKEND_PROFILES_DELETE':
        return hasOnly('type', 'profileId', 'discard') && Object.hasOwn(request, 'profileId') && validProfileId &&
          (!Object.hasOwn(request, 'discard') || typeof request.discard === 'boolean')
          ? { type: request.type, profileId, discard: Object.hasOwn(request, 'discard') ? request.discard : false }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function profileOperationFailure(type, error) {
  let message = '';
  try {
    message = typeof error?.message === 'string' ? error.message : '';
  } catch {
    return profileFailure('domain-rejected', 'profile-operation-failed');
  }
  if (type === 'BACKEND_PROFILES_CREATE' && message.includes('Invalid backend endpoint')) {
    return profileFailure('domain-rejected', 'unsafe-endpoint');
  }
  if (type === 'BACKEND_PROFILES_DELETE' && message.startsWith('Cannot delete')) {
    return profileFailure('domain-rejected', 'profile-delete-blocked');
  }
  if (message.startsWith('Unknown backend profile')) {
    return profileFailure('domain-rejected', 'profile-unavailable');
  }
  if (type === 'BACKEND_PROFILES_EXPORT_QUEUE' && message.includes('active profile')) {
    return profileFailure('forbidden', 'profile-export-not-active');
  }
  return profileFailure('domain-rejected', 'profile-operation-failed');
}

async function handleBackendProfilePortRequest(messageId, request, port) {
  if (!isTrustedOptionsSender(port)) {
    port.postMessage({ messageId, response: profileFailure('forbidden', 'options-profile-access') });
    return;
  }
  const parsed = parseBackendProfileRequest(request);
  if (!parsed) {
    port.postMessage({ messageId, response: profileFailure('invalid', 'profile-input') });
    return;
  }
  try {
    await ensureStorageMigrationsComplete(chrome.storage.local);
  } catch {
    port.postMessage({ messageId, response: profileFailure('domain-rejected', 'profile-migration-failed') });
    return;
  }
  try {
    let value;
    switch (parsed.type) {
      case 'BACKEND_PROFILES_LIST':
        value = await listBackendProfiles(chrome.storage.local);
        break;
      case 'BACKEND_PROFILES_CREATE':
        value = await createBackendProfile(chrome.storage.local, { endpoint: parsed.endpoint });
        break;
      case 'BACKEND_PROFILES_ACTIVATE':
        value = await activateBackendProfile(chrome.storage.local, parsed.profileId);
        break;
      case 'BACKEND_PROFILES_DELETE':
        value = await deleteBackendProfile(chrome.storage.local, parsed.profileId, { discard: parsed.discard });
        break;
      case 'BACKEND_PROFILES_EXPORT_QUEUE':
        value = await exportBackendProfileQueue(chrome.storage.local, parsed.profileId);
        break;
    }
    port.postMessage({ messageId, response: { ok: true, value } });
  } catch (error) {
    port.postMessage({ messageId, response: profileOperationFailure(parsed.type, error) });
  }
}

// 監聽來自 content script 的長連接
chrome.runtime.onConnect.addListener((port) => {
  console.log(`[Background] Content script connected. Port name: ${port.name}`);
  // 根據 port.name 區分連接來源
  if (port.name === "subtitle-assistant-channel") {
    // 來自 content script 的連接
    const tabId = port.sender?.tab?.id;
    if (!tabId) {
      console.error('[Background] Received content script connection from unknown sender (no tabId).');
      port.disconnect();
      return;
    }
    console.log(`[Background] Storing content script port for tabId: ${tabId}`);
    contentScriptPorts.set(tabId, port);

    port.onMessage.addListener((messageData) => {
      const request = readPortRequest(messageData);
      console.log(`[Background] Message [${request?.type}] received by SW Instance ID: ${serviceWorkerInstanceId} via content script port from Tab ${tabId}`, messageData);
      if (!request.valid) {
        console.error('[Background] Invalid message format received via content script port:', messageData);
        port.postMessage({ response: { success: false, error: '無效的消息格式' } });
        return;
      }
      const { messageId, message, type } = request;
      if (isBackendProfileCommand(type)) {
        port.postMessage({ messageId, response: profileFailure('forbidden', 'page-profile-change') });
        return;
      }
      const handledCoreMessageTypes = [
        'CONTENT_SCRIPT_LOADED', 'CONTENT_SCRIPT_READY', 'TOGGLE_DEBUG_MODE', 'VIDEO_ID_CHANGED', 'UPDATE_STATS'
      ];
      if (handledCoreMessageTypes.includes(type)) {
        handleCoreMessagePort(messageId, message, port);
      } else {
        routeMessageToModulePort(messageId, message, port);
      }
    });

    port.onDisconnect.addListener(() => {
      console.log(`[Background] Content script port disconnected for tabId: ${tabId}`);
      contentScriptPorts.delete(tabId);
    });

  } else if (port.name === "options-page-channel") {
    // 來自 options 頁面的連接
    console.log('[Background] Options page connected.');
    // options 頁面不需要 tabId，因為它不是針對特定 tab 的
    // 可以將 options 頁面的 port 存儲在一個單獨的變量中，如果需要向其主動發送消息
    // 例如：optionsPagePort = port;

    port.onMessage.addListener((messageData) => {
      const request = readPortRequest(messageData);
      console.log(`[Background] Message [${request?.type}] received by SW Instance ID: ${serviceWorkerInstanceId} via options page port`, messageData);
      if (!request.valid) {
        console.error('[Background] Invalid message format received via options page port:', messageData);
        const response = isTrustedOptionsSender(port)
          ? profileFailure('invalid', 'profile-input')
          : profileFailure('forbidden', 'options-profile-access');
        port.postMessage({ messageId: request.messageId, response });
        return;
      }
      const { messageId, message, type } = request;
      if (isBackendProfileCommand(type)) {
        void handleBackendProfilePortRequest(messageId, message, port);
        return;
      }
      routeMessageToModulePort(messageId, message, port);
    });

    port.onDisconnect.addListener(() => {
      console.log('[Background] Options page port disconnected.');
      // optionsPagePort = null;
    });

  } else {
    console.warn('[Background] Unknown connection name:', port.name);
    port.disconnect();
  }
});


/**
 * 監聽來自 popup 或選項頁面的消息 (content script 消息現在通過 port 處理)
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const requestType = (() => {
    try {
      return typeof request?.type === 'string' ? request.type : null;
    } catch {
      return null;
    }
  })();
  // 在 onMessage 中打印當前實例 ID
  console.log(`[Background] Message [${requestType}] received by SW Instance ID: ${serviceWorkerInstanceId}`, 'from:', sender.tab ? `Tab ${sender.tab.id}` : 'Popup/Options/Other');

  if (isBackendProfileCommand(requestType)) {
    sendResponse(profileFailure('forbidden', 'options-profile-access'));
    return false;
  }

  if (requestType === 'GET_CROWDSOURCING_TASKS') {
    return handleRuntimeCrowdsourcingTasks(request, sender, sendResponse);
  }

  // 只處理來自 popup 或選項頁面的消息 (sender.tab 為 undefined)
  if (sender.tab) {
    // 來自 content script 的消息應該通過 port 處理
    console.warn('[Background] Received message from content script via onMessage, expected via port:', request.type);
    // 可以選擇發送一個錯誤響應，或者忽略
    sendResponse({ success: false, error: '請通過長連接發送消息' });
    return false; // 同步回應
  }

  if (!request || !requestType) {
    console.error('[Background] Invalid message format:', request); // 錯誤訊息總是顯示
    sendResponse({ success: false, error: '無效的消息格式' });
    return false; // 同步回應
  }

  // 定義需要背景腳本處理的核心訊息類型清單 (來自 popup)
  const handledPopupMessageTypes = [
    // 'TOGGLE_DEBUG_MODE', // Popup 可以切換調試模式
    // 'GET_SETTINGS', // Popup 獲取設置
    'POPUP_API_REQUEST' // 新增：來自 Popup 的 API 請求
    // 'DEBUG_MODE_CHANGED', // 來自選項頁面的調試模式變更 - 現在通過 port 處理
    // 'API_BASE_URL_CHANGED' // 來自選項頁面的 API Base URL 變更 - 現在通過 port 處理
    // 其他 popup 相關消息
  ];

  // 訊息路由邏輯 (來自 popup)
  console.log('[Background] Processing popup message type:', request.type);
  if (handledPopupMessageTypes.includes(request.type)) {
     // 處理 popup 消息，使用原有的 sendResponse 回調
     handlePopupMessage(request, sender, sendResponse);
  } else {
    console.warn('[Background] 未處理的 Popup 消息類型:', request.type); // 警告總是顯示
    sendResponse({ success: false, error: `Unhandled popup message type ${request.type}` });
  }

  // 對於 popup 消息，如果需要異步響應，必須返回 true
  // 這裡假設 handlePopupMessage 會同步或異步調用 sendResponse
  return true; // 假設所有 popup 消息處理都是異步的，或者由 handlePopupMessage 決定
});

/**
 * 處理來自 Popup 的消息
 * @param {object} request - 請求對象
 * @param {object} sender - 發送者信息
 * @param {function} sendResponse - 回應函數
 */
function handlePopupMessage(request, sender, sendResponse) {
    // 定義訊息類型到模組的映射 (僅限 popup 相關)
    const moduleMapping = {
        // 'GET_SETTINGS': 'storage',
        'TOGGLE_DEBUG_MODE': 'core', // 核心處理
        'POPUP_API_REQUEST': 'api_proxy' // 新增：路由到 API 代理處理
        // 'DEBUG_MODE_CHANGED': 'core', // 來自選項頁面的調試模式變更 - 現在通過 port 處理
        // 'API_BASE_URL_CHANGED': 'core', // 來自選項頁面的 API Base URL 變更 - 現在通過 port 處理
        // 'CLEAR_QUEUE': 'storage' // 來自選項頁面的清除隊列 - 現在通過 port 處理
        // 其他 popup 相關消息
    };

    const moduleName = moduleMapping[request.type];
    if (moduleName === 'storage') {
      // 路由到 storage 模組，使用原有的 sendResponse
      // 注意：這裡 storageModule.handleMessage 仍然需要接受 sendResponse
      // storageModule.handleMessage(request, sender, sendResponse);
      console.warn(`[Background] Storage module has been deprecated, please update: ${request}`);
    } else if (moduleName === 'core') {
        // 處理核心消息 (與 handleCoreMessage 類似，但使用 sendResponse)
        switch (request.type) {
            case 'TOGGLE_DEBUG_MODE':
                console.warn('[Background] TOGGLE_DEBUG_MODE is deprecated. Use ConfigManager instead.');
                // 為了向後兼容，將配置寫入 chrome.storage
                // ConfigManager 會自動監聽並通知所有訂閱者
                chrome.storage.local.set({ debugMode: request.debugMode }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('[Background] Error setting debugMode:', chrome.runtime.lastError);
                        sendResponse({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                        console.log(`[Background] debugMode set to ${request.debugMode} (deprecated path)`);
                        sendResponse({ success: true });
                    }
                });
                break;
            // case 'DEBUG_MODE_CHANGED': // 現在通過 port 處理
            // case 'API_BASE_URL_CHANGED': // 現在通過 port 處理
            default:
                sendResponse({ success: false, error: `Unhandled core popup message type ${request.type}` });
                break;
        }
    } else if (moduleName === 'api_proxy') { // 新增 API 代理處理
        handlePopupApiRequest(request, sendResponse);
    } else {
        sendResponse({ success: false, error: `Unhandled popup message type ${request.type}` });
    }
}

/**
 * 處理來自 Popup 的 API 請求，並轉發給 apiModule
 * @param {object} request - 請求對象，包含 api 和 params
 * @param {function} sendResponse - 回應函數
 */
async function handlePopupApiRequest(request, sendResponse) {
    const { api } = request;
    console.log(`[Background] Handling POPUP_API_REQUEST for API: ${api}`);

    try {
        const profile = await resolveBackendProfile(chrome.storage.local);
        let result;
        switch (api) {
            case 'registerUser':
                result = await apiModule.registerUser(profile.userId, profile.id);
                if (!result?.token) throw new Error('User registration returned no token');
                await setBackendProfileCredentials(chrome.storage.local, profile.id, { jwt: result.token });
                result = { registered: true };
                break;
            case 'fetchUserStats':
                result = await apiModule.fetchUserStats(profile.userId, true, profile.id);
                break;
            default:
                throw new Error(`Unknown API request: ${api}`);
        }
        sendResponse({ success: true, data: result });
    } catch (error) {
        console.error(`[Background] Error handling POPUP_API_REQUEST for ${api}`);
        sendResponse({ success: false, error: error.message });
    }
}


/**
 * 處理核心訊息類型 (通過 port)
 * @param {string} messageId - 消息 ID
 * @param {object} request - 請求對象
 * @param {Port} port - 連接 port
 */
function handleCoreMessagePort(messageId, request, port) {
  switch (request.type) {
    case 'UPDATE_STATS':
      console.log('[Background] Received UPDATE_STATS message (port)');
      // 將統計數據轉發到 popup
      chrome.runtime.sendMessage({
        type: 'UPDATE_STATS',
        replacementCount: request.replacementCount,
        videoId: request.videoId
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Background] Error forwarding UPDATE_STATS to popup:', chrome.runtime.lastError.message);
        }
      });
      port.postMessage({ messageId, response: { success: true } }); // 發送響應
      break;
    case 'CONTENT_SCRIPT_READY':
      console.log('[Background] Content script ready with features:', request.features);
      // 記錄內容腳本已準備就緒，可以執行相關邏輯
      port.postMessage({ messageId, response: { success: true } });
      break;
    default:
      console.warn('[Background] 未處理的核心消息類型 (port):', request.type); // 警告總是顯示
      port.postMessage({ messageId, response: { success: false, error: `Unhandled core message type (port) ${request.type}` } });
      break;
  }
}


/**
 * 處理私有字幕查詢
 * @param {Object} request - 私有 Port 請求對象
 * @param {Function} portSendResponse - 回應函數
 */
async function handleSubtitleQuery(request, portSendResponse) {
  const { videoId, timestamp, duration } = request.query || {};

  if (!videoId || typeof timestamp !== 'number' || duration !== 180) {
    console.error('[Background] SUBTITLE_QUERY error: invalid subtitle query');
    portSendResponse({ ok: false, error: { kind: 'invalid', code: 'subtitle-query', retryable: false } });
    return;
  }

  console.log('[Background] Fetching subtitles for:', videoId, timestamp);

  try {
    const subtitles = await apiModule.fetchSubtitles({
      videoId: videoId,
      startTime: timestamp,
      duration
    });

    console.log(`[Background] Successfully fetched ${subtitles.length} subtitles`);
    portSendResponse({ ok: true, value: { subtitles } });
  } catch (error) {
    console.error('[Background] Error fetching subtitles:', error);
    portSendResponse({ ok: false, error: { kind: 'domain-rejected', code: 'subtitle-fetch-failed', retryable: false } });
  }
}

async function handleGetCrowdsourcingTasks(request, portSendResponse) {
  const { videoID, languageCode, limit } = request;

  if (!videoID || typeof videoID !== 'string' || !videoID.trim()) {
    console.error('[Background] GET_CROWDSOURCING_TASKS error: Missing videoID');
    portSendResponse({ success: false, error: '缺少或無效的 videoID' });
    return;
  }

  try {
    const data = await apiModule.fetchCrowdsourcingTasks({ videoID, languageCode, limit });
    portSendResponse({ ...data, success: true });
  } catch (error) {
    console.error('[Background] Error fetching crowdsourcing tasks:', error);
    portSendResponse({ success: false, error: `獲取眾包字幕任務失敗: ${error.message}` });
  }
}

function isNetflixContentSender(sender) {
  const senderUrl = sender?.tab?.url || '';
  if (sender?.id !== chrome.runtime.id) return false;
  if (!sender?.tab?.id || !senderUrl) return false;

  try {
    const { hostname, protocol } = new URL(senderUrl);
    return protocol === 'https:' && (hostname === 'netflix.com' || hostname.endsWith('.netflix.com'));
  } catch (error) {
    console.warn('[Background] Invalid sender URL for crowdsourcing tasks:', error.message);
    return false;
  }
}

function handleRuntimeCrowdsourcingTasks(request, sender, sendResponse) {
  if (!isNetflixContentSender(sender)) {
    console.warn('[Background] Unauthorized GET_CROWDSOURCING_TASKS sender');
    sendResponse({ success: false, error: 'Unauthorized sender for GET_CROWDSOURCING_TASKS' });
    return false;
  }

  const senderUrl = sender.tab.url;
  const senderVideoMatch = new URL(senderUrl).pathname.match(/^\/watch\/(\d+)(?:\/|$)/);
  const senderVideoID = senderVideoMatch ? senderVideoMatch[1] : null;
  const supportedLanguages = new Set([
    'zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru',
    'ar', 'th', 'vi', 'id', 'ms', 'hi', 'tr', 'nl', 'pl', 'sv'
  ]);
  if (!senderVideoID || request.videoID !== senderVideoID) {
    sendResponse({ success: false, error: 'videoID does not match sender watch URL' });
    return false;
  }
  if (request.limit !== 5) {
    sendResponse({ success: false, error: 'limit must equal 5' });
    return false;
  }
  if (!supportedLanguages.has(request.languageCode)) {
    sendResponse({ success: false, error: 'Unsupported languageCode' });
    return false;
  }

  handleGetCrowdsourcingTasks(request, sendResponse);
  return true;
}

/**
 * 將訊息路由到對應模組 (通過 port)
 * @param {string} messageId - 消息 ID
 * @param {object} request - 請求對象
 * @param {Port} port - 連接 port
 */
function routeMessageToModulePort(messageId, request, port) {
  // 定義訊息類型到模組的映射
  const moduleMapping = {
    'SUBTITLE_QUERY': 'api',
    'RETRY_FAILED_VOTES': 'sync',
    'RETRY_FAILED_TRANSLATIONS': 'sync',
    'RETRY_FAILED_REPLACEMENT_EVENTS': 'sync',
    'SUBTITLE_STYLE_UPDATED': 'core' // 添加字幕樣式更新消息路由
  };

  const moduleName = moduleMapping[request.type];
  if (moduleName) {
    console.log(`[Background] Routing message ${request.type} to ${moduleName} module (port).`);

    // 創建一個包裝後的 sendResponse 函數，用於通過 port 發送響應
    // 這裡不再需要處理中間響應和超時，因為 port 連接本身更穩定
    const portSendResponse = (response) => {
        // 將 messageId 和實際響應一起發送
        port.postMessage({ messageId, response });
    };

    switch (moduleName) {
      case 'api':
        console.log('[Background] Handling in api module (port):', request.type);
        if (request.type === 'SUBTITLE_QUERY') {
          handleSubtitleQuery(request, portSendResponse);
        } else {
          console.error('[Background] Unhandled API request type:', request.type);
          portSendResponse({ success: false, error: `Unhandled API request type: ${request.type}` });
        }
        break;
      case 'sync':
        console.log('[Background] Handling in sync module (port):', request.type);
        // 調用模組處理函數，傳遞包裝後的 sendResponse
        // 注意：syncModule.handleMessage 需要修改以接受 portSendResponse
        syncModule.handleMessage(request, port.sender, portSendResponse);
        break;
      default:
        // 如果模組未處理訊息，則返回錯誤
        console.error(`[Background] Message type ${request.type} not handled by ${moduleName} module (port)`);
        portSendResponse({ success: false, error: `Message type ${request.type} not handled by ${moduleName} module (port)` });
        break;
    }

    // 使用 port.postMessage 不需要返回 true/false
    // return true; // 移除原有的異步標記
  } else {
    console.warn('[Background] 未處理的消息類型 (port):', request.type); // 警告總是顯示
    port.postMessage({ messageId, response: { success: false, error: `Unhandled message type (port) ${request.type}` } });
    // return false; // 移除原有的同步標記
  }
}
