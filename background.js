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

// Service Worker 實例 ID，用於追踪是否發生重啟
const serviceWorkerInstanceId = `sw-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
console.log(`[Background] Service Worker script executing. Current Instance ID: ${serviceWorkerInstanceId}`);
chrome.storage.local.set({ currentSWInstanceId: serviceWorkerInstanceId });

// 檢查是否發生了重啟 (與上次存儲的 currentSWInstanceId 比較)
chrome.storage.local.get(['previousSWInstanceIdForRestartCheck'], (result) => {
  if (result.previousSWSWInstanceIdForRestartCheck && result.previousSWInstanceIdForRestartCheck !== serviceWorkerInstanceId) {
    console.warn(`[Background] Service Worker appears to have restarted. Previous Instance ID (from storage): ${result.previousSWInstanceIdForRestartCheck}, Current Instance ID: ${serviceWorkerInstanceId}`);
  }
  // 更新 previousSWInstanceIdForRestartCheck 供下次腳本執行時比較
  chrome.storage.local.set({ previousSWInstanceIdForRestartCheck: serviceWorkerInstanceId });
});

import * as storageModule from './background/storage.js';
import * as apiModule from './background/api.js';
import * as syncModule from './background/sync.js';

let isDebugModeEnabled = false; // 快取 Debug 模式狀態

// 擴充功能安裝/更新事件
chrome.runtime.onInstalled.addListener(async () => {
  const installedInstanceId = serviceWorkerInstanceId; // 捕獲當前腳本執行上下文的實例 ID
  console.log(`[Background] onInstalled event. Instance ID: ${installedInstanceId}. 字幕助手擴充功能已安裝或更新`);
  await chrome.storage.local.set({ onInstalledSWInstanceId: installedInstanceId });
  
  // 設置初始值並更新快取
  const result = await chrome.storage.local.get(['debugMode']);
  if (result.debugMode === undefined) {
    await chrome.storage.local.set({ debugMode: false });
    isDebugModeEnabled = false;
  } else {
    isDebugModeEnabled = result.debugMode;
  }
  if (isDebugModeEnabled) console.log('[Background] Debug mode is initially enabled.');
  // 設置各模組的調試模式
  storageModule.setDebugMode(isDebugModeEnabled);
  apiModule.setDebugMode(isDebugModeEnabled);
  syncModule.setDebugMode(isDebugModeEnabled);

  // 執行用戶註冊/JWT獲取邏輯
  await ensureUserRegisteredAndJwtPresent();
});

// 擴充功能啟動事件
chrome.runtime.onStartup.addListener(async () => {
  const startupInstanceId = serviceWorkerInstanceId; // 捕獲當前腳本執行上下文的實例 ID
  console.log(`[Background] onStartup event. Instance ID: ${startupInstanceId}. Extension startup, triggering initialization.`);
  await chrome.storage.local.set({ onStartupSWInstanceId: startupInstanceId });
  
  // 執行用戶註冊/JWT獲取邏輯
  await ensureUserRegisteredAndJwtPresent();
  // 設置 JWT 刷新警報
  setupJwtRefreshAlarm();
});

/**
 * 確保用戶已註冊並存在 JWT
 */
async function ensureUserRegisteredAndJwtPresent() {
  console.log('[Background] Checking user registration and JWT presence...');
  try {
    let { userID, jwt } = await chrome.storage.local.get(['userID', 'jwt']);

    if (!userID) {
      // 如果沒有 userID，生成一個新的
      userID = crypto.randomUUID();
      await chrome.storage.local.set({ userID });
      console.log('[Background] Generated new userID:', userID);
    }

    if (!jwt) {
      console.log('[Background] No JWT found, attempting to register user and get JWT...');
      // 調用後端 /users API 進行註冊並獲取 JWT
      const response = await apiModule.registerUser(userID); // 使用 apiModule.registerUser
      
      if (response.token) {
        await chrome.storage.local.set({ jwt: response.token });
        console.log('[Background] Successfully registered user and obtained JWT.');
      } else {
        // 處理 API 返回的明確錯誤
        const errorMessage = response.error || '未知錯誤';
        console.error('[Background] Failed to register user or obtain JWT:', errorMessage, response);
      }
    } else {
      console.log('[Background] UserID and JWT already present.');
      // 可以選擇在這裡驗證 JWT 有效性，但通常由後續 API 請求的 401 響應觸發刷新
    }
  } catch (error) {
    let errorMsg = error.message;
    let errorDetails = error.details || {};
    let errorStatus = error.status || 'N/A';

    if (error.name === 'AbortError') {
      errorMsg = 'API請求超時';
    } else if (error.message.includes('Failed to fetch')) {
      errorMsg = '無法連接後端服務，請檢查後端是否運行或網路連接';
    }

    console.error(
      `[Background] Error in ensureUserRegisteredAndJwtPresent:`,
      `類型: ${error.name || '未知'}`,
      `訊息: ${errorMsg}`,
      `狀態碼: ${errorStatus}`,
      `詳細: ${JSON.stringify(errorDetails)}`,
      error // 打印原始錯誤對象以獲取完整堆棧
    );
  }
}

/**
 * 設置 JWT 刷新警報
 */
function setupJwtRefreshAlarm() {
  chrome.alarms.clear('jwtRefresh'); // 清除舊的警報
  // 設置警報，例如每 24 小時檢查一次 (1440 分鐘)
  chrome.alarms.create('jwtRefresh', { periodInMinutes: 1440 });
  console.log('[Background] JWT refresh alarm set.');
}

// 監聽警報事件
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'jwtRefresh') {
    console.log('[Background] JWT refresh alarm triggered, checking JWT validity...');
    // 在這裡可以添加 JWT 有效期檢查邏輯
    // 簡單起見，直接嘗試重新註冊/獲取 JWT
    await ensureUserRegisteredAndJwtPresent();
  }
});

// 儲存 content script 的 port，以 tabId 為鍵
const contentScriptPorts = new Map();

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
      console.log(`[Background] Message [${messageData.message?.type}] received by SW Instance ID: ${serviceWorkerInstanceId} via content script port from Tab ${tabId}`, messageData);
      const { messageId, message } = messageData;
      if (!message || !message.type) {
        console.error('[Background] Invalid message format received via content script port:', messageData);
        port.postMessage({ messageId, response: { success: false, error: '無效的消息格式' } });
        return;
      }
      const handledCoreMessageTypes = [
        'CONTENT_SCRIPT_LOADED', 'TOGGLE_EXTENSION', 'TOGGLE_DEBUG_MODE', 'VIDEO_ID_CHANGED', 'UPDATE_STATS'
      ];
      if (handledCoreMessageTypes.includes(message.type)) {
        handleCoreMessagePort(messageId, message, port);
      } else {
        routeMessageToModulePort(messageId, message, port);
      }
    });

    port.onDisconnect.addListener(() => {
      console.log(`[Background] Content script port disconnected for tabId: ${tabId}`);
      contentScriptPorts.delete(tabId);
    });

    port.postMessage({ messageId: 'initial-debug-mode', response: { type: 'SET_DEBUG_MODE', debugMode: isDebugModeEnabled } });

  } else if (port.name === "options-page-channel") {
    // 來自 options 頁面的連接
    console.log('[Background] Options page connected.');
    // options 頁面不需要 tabId，因為它不是針對特定 tab 的
    // 可以將 options 頁面的 port 存儲在一個單獨的變量中，如果需要向其主動發送消息
    // 例如：optionsPagePort = port;

    port.onMessage.addListener((messageData) => {
      console.log(`[Background] Message [${messageData.message?.type}] received by SW Instance ID: ${serviceWorkerInstanceId} via options page port`, messageData);
      const { messageId, message } = messageData;
      if (!message || !message.type) {
        console.error('[Background] Invalid message format received via options page port:', messageData);
        port.postMessage({ messageId, response: { success: false, error: '無效的消息格式' } });
        return;
      }
      // 處理來自 options 頁面的消息，直接路由到模組
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
  // 在 onMessage 中打印當前實例 ID
  console.log(`[Background] Message [${request.type}] received by SW Instance ID: ${serviceWorkerInstanceId}`, request, 'from:', sender.tab ? `Tab ${sender.tab.id}` : 'Popup/Options/Other');

  // 只處理來自 popup 或選項頁面的消息 (sender.tab 為 undefined)
  if (sender.tab) {
    // 來自 content script 的消息應該通過 port 處理
    console.warn('[Background] Received message from content script via onMessage, expected via port:', request.type);
    // 可以選擇發送一個錯誤響應，或者忽略
    sendResponse({ success: false, error: '請通過長連接發送消息' });
    return false; // 同步回應
  }

  if (!request || !request.type) {
    console.error('[Background] Invalid message format:', request); // 錯誤訊息總是顯示
    sendResponse({ success: false, error: '無效的消息格式' });
    return false; // 同步回應
  }

  // 定義需要背景腳本處理的核心訊息類型清單 (來自 popup)
  const handledPopupMessageTypes = [
    'TOGGLE_EXTENSION', // Popup 可以切換擴充功能狀態
    'TOGGLE_DEBUG_MODE', // Popup 可以切換調試模式
    'GET_SETTINGS', // Popup 獲取設置
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
        'GET_SETTINGS': 'storage',
        'TOGGLE_EXTENSION': 'core', // 核心處理
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
      storageModule.handleMessage(request, sender, sendResponse);
    } else if (moduleName === 'core') {
        // 處理核心消息 (與 handleCoreMessage 類似，但使用 sendResponse)
        switch (request.type) {
            case 'TOGGLE_EXTENSION':
                if (isDebugModeEnabled) console.log(`[Background] Toggling extension (from popup): ${request.isEnabled}`);
                // 轉發消息到所有相關的 content scripts (通過 port)
                contentScriptPorts.forEach(port => {
                    port.postMessage({ type: 'TOGGLE_EXTENSION', isEnabled: request.isEnabled });
                });
                sendResponse({ success: true }); // 回應 popup
                break;
            case 'TOGGLE_DEBUG_MODE':
                isDebugModeEnabled = request.debugMode; // 更新快取狀態
                if (isDebugModeEnabled) console.log(`[Background] Toggling debug mode (from popup): ${isDebugModeEnabled}`);
                // 轉發消息到所有相關的 content scripts (通過 port)
                contentScriptPorts.forEach(port => {
                    port.postMessage({ type: 'TOGGLE_DEBUG_MODE', debugMode: isDebugModeEnabled });
                });
                // 更新各模組的調試模式狀態
                storageModule.setDebugMode(isDebugModeEnabled);
                apiModule.setDebugMode(isDebugModeEnabled); // 保持 apiModule.setDebugMode
                syncModule.setDebugMode(isDebugModeEnabled);
                sendResponse({ success: true }); // 回應 popup
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
    const { api, params } = request;
    if (isDebugModeEnabled) console.log(`[Background] Handling POPUP_API_REQUEST for API: ${api} with params:`, params);

    try {
        let result;
        switch (api) {
            case 'registerUser':
                result = await apiModule.registerUser(params.userID);
                break;
            case 'fetchUserStats':
                result = await apiModule.fetchUserStats(params.userID);
                break;
            default:
                throw new Error(`Unknown API request: ${api}`);
        }
        sendResponse({ success: true, data: result });
    } catch (error) {
        console.error(`[Background] Error handling POPUP_API_REQUEST for ${api}:`, error);
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
    case 'CONTENT_SCRIPT_LOADED':
      if (isDebugModeEnabled) console.log('[Background] 內容腳本已加載 (port):', port.sender?.tab?.url);
      // 通過 port 發送響應
      port.postMessage({ messageId, response: { success: true } });
      break;

    case 'TOGGLE_EXTENSION':
      // 來自 content script 的 TOGGLE_EXTENSION 消息，通常不需要再轉發回 content script
      if (isDebugModeEnabled) console.log(`[Background] Received TOGGLE_EXTENSION from content script (port): ${request.isEnabled}`);
      // 如果需要，可以更新狀態或通知其他地方
      port.postMessage({ messageId, response: { success: true } }); // 發送響應
      break;

    case 'TOGGLE_DEBUG_MODE':
       // 來自 content script 的 TOGGLE_DEBUG_MODE 消息
      isDebugModeEnabled = request.debugMode; // 更新快取狀態
      if (isDebugModeEnabled) console.log(`[Background] Received TOGGLE_DEBUG_MODE from content script (port): ${isDebugModeEnabled}`);
      // 更新各模組的調試模式狀態
      storageModule.setDebugMode(isDebugModeEnabled);
      apiModule.setDebugMode(isDebugModeEnabled);
      syncModule.setDebugMode(isDebugModeEnabled);
      port.postMessage({ messageId, response: { success: true } }); // 發送響應
      break;

    case 'VIDEO_ID_CHANGED':
      if (isDebugModeEnabled) console.log('[Background] Received VIDEO_ID_CHANGED message (port)');
      port.postMessage({ messageId, response: { success: true } }); // 發送響應
      break;

    case 'UPDATE_STATS':
      if (isDebugModeEnabled) console.log('[Background] Received UPDATE_STATS message (port)');
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
      
    case 'API_BASE_URL_CHANGED':
      if (isDebugModeEnabled) console.log('[Background] API Base URL changed to:', request.url);
      apiModule.setApiBaseUrl(request.url);
      port.postMessage({ messageId, response: { success: true } });
      break;

    default:
      console.warn('[Background] 未處理的核心消息類型 (port):', request.type); // 警告總是顯示
      port.postMessage({ messageId, response: { success: false, error: `Unhandled core message type (port) ${request.type}` } });
      break;
  }
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
    'GET_USER_ID': 'storage',
    'GET_SETTINGS': 'storage', // Content script 獲取設置
    'GET_DEBUG_MODE': 'storage',
    'SAVE_SETTINGS': 'storage',
    'SAVE_VIDEO_INFO': 'storage',
    'GET_USER_LANGUAGE': 'storage',
    'SAVE_USER_LANGUAGE': 'storage',
    'SUBMIT_TRANSLATION': 'api',
    'PROCESS_VOTE': 'api',
    'CHECK_SUBTITLE': 'api',
    'SYNC_DATA': 'sync',
    'GET_SYNC_STATUS': 'sync',
    'TRIGGER_VOTE_SYNC': 'sync',
    'TRIGGER_TRANSLATION_SYNC': 'sync',
    'REPORT_REPLACEMENT_EVENTS': 'storage',
    'CLEAR_QUEUE': 'storage', // 新增 CLEAR_QUEUE 消息類型
    'API_BASE_URL_CHANGED': 'core' // 添加 API_BASE_URL_CHANGED 消息路由
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
      case 'storage':
        console.log('[Background] Handling in storage module (port):', request.type);
        // 調用模組處理函數，傳遞包裝後的 sendResponse
        // 注意：storageModule.handleMessage 需要修改以接受 portSendResponse
        storageModule.handleMessage(request, port.sender, portSendResponse);
        break;
      case 'api':
        console.log('[Background] Handling in api module (port):', request.type);
        // 調用模組處理函數，傳遞包裝後的 sendResponse
        // 注意：apiModule.handleMessage 需要修改以接受 portSendResponse
        apiModule.handleMessage(request, port.sender, portSendResponse);
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
