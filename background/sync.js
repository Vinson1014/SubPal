// background/sync.js
// 負責處理資料同步相關操作的模組

import * as apiModule from './api.js';

let isDebugModeEnabled = false;
let isSyncingVotes = false;
let isSyncingTranslations = false;

const VOTE_QUEUE_KEY = 'voteQueue';
const TRANSLATION_QUEUE_KEY = 'translationQueue';
const MAX_QUEUE_SIZE = 100;

/**
 * 處理資料同步相關的訊息 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {object} sender - 發送者信息
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
export function handleMessage(request, sender, portSendResponse) {
  if (isDebugModeEnabled) console.log('[Sync Module] Handling message (port):', request.type);

  switch (request.type) {
    case 'SYNC_DATA':
      // 處理資料同步邏輯
      handleSyncData(request, portSendResponse);
      break; // 使用 break 代替 return
    case 'GET_SYNC_STATUS':
      // 處理獲取同步狀態邏輯
      handleGetSyncStatus(request, portSendResponse);
      break; // 使用 break 代替 return
    case 'TRIGGER_VOTE_SYNC':
      // 觸發投票同步
      triggerVoteSync();
      portSendResponse({ success: true, message: 'Vote sync triggered' });
      break; // 使用 break 代替 return false
    case 'TRIGGER_TRANSLATION_SYNC':
      // 觸發翻譯同步
      triggerTranslationSync();
      portSendResponse({ success: true, message: 'Translation sync triggered' });
      break; // 使用 break 代替 return false
    default:
      portSendResponse({ success: false, error: `Unhandled message type in sync module (port): ${request.type}` });
      break; // 使用 break 代替 return false
  }
}

/**
 * 處理資料同步的邏輯 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
function handleSyncData(request, portSendResponse) {
  if (isDebugModeEnabled) console.log('[Sync Module] Syncing data (port):', request.data);
  // 根據請求數據決定同步類型
  if (request.data.type === 'vote') {
    syncPendingVotes().then(() => {
      portSendResponse({ success: true, message: 'Votes synced successfully' });
    }).catch(error => {
      console.error('[Sync Module] Error syncing votes (port):', error);
      portSendResponse({ success: false, error: error.message });
    });
  } else if (request.data.type === 'translation') {
    syncPendingTranslations().then(() => {
      portSendResponse({ success: true, message: 'Translations synced successfully' });
    }).catch(error => {
      console.error('[Sync Module] Error syncing translations (port):', error);
      portSendResponse({ success: false, error: error.message });
    });
  } else {
    portSendResponse({ success: false, error: 'Invalid sync data type' });
  }
  // 移除原有的 return true
}

/**
 * 處理獲取同步狀態的邏輯 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
async function handleGetSyncStatus(request, portSendResponse) {
  if (isDebugModeEnabled) console.log('[Sync Module] Getting sync status (port)');
  try {
    const voteQueue = await chrome.storage.local.get(VOTE_QUEUE_KEY);
    const translationQueue = await chrome.storage.local.get(TRANSLATION_QUEUE_KEY);
    portSendResponse({
      success: true,
      status: {
        lastSync: new Date().toISOString(),
        pendingVotes: voteQueue[VOTE_QUEUE_KEY] ? voteQueue[VOTE_QUEUE_KEY].length : 0,
        pendingTranslations: translationQueue[TRANSLATION_QUEUE_KEY] ? translationQueue[TRANSLATION_QUEUE_KEY].length : 0,
        isSyncingVotes: isSyncingVotes,
        isSyncingTranslations: isSyncingTranslations
      }
    });
  } catch (error) {
    console.error('[Sync Module] Error getting sync status (port):', error);
    portSendResponse({ success: false, error: error.message });
  }
  // 移除原有的 return true
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
    if (isDebugModeEnabled) console.log(`[Sync Module] Triggering ${dataTypeLabel} sync.`);
    syncFunction(); // 異步執行
  } else {
    if (isDebugModeEnabled) console.log(`[Sync Module] ${dataTypeLabel} sync already in progress.`);
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
  if (isDebugModeEnabled) console.log(`[Sync Module] Starting ${dataTypeLabel} sync...`);

  try {
    const { [queueKey]: queue = [] } = await chrome.storage.local.get(queueKey);
    if (queue.length === 0) {
      if (isDebugModeEnabled) console.log(`[Sync Module] ${dataTypeLabel} queue is empty.`);
      setSyncingFlag(false);
      return;
    }

    if (isDebugModeEnabled) console.log(`[Sync Module] Syncing ${queue.length} pending ${dataTypeLabel}s...`);
    const remainingItems = [];
    let successCount = 0;

    for (const itemData of queue) {
      try {
        await apiCallFunction(itemData); // Assuming itemData includes userID
        successCount++;
        if (isDebugModeEnabled) console.log(`[Sync Module] Synced ${dataTypeLabel}:`, itemData);
      } catch (error) {
        console.warn(`[Sync Module] Failed to sync ${dataTypeLabel}, keeping in queue:`, error.message, itemData);
        remainingItems.push(itemData);
      }
    }

    // 更新隊列
    await chrome.storage.local.set({ [queueKey]: remainingItems });
    if (isDebugModeEnabled) console.log(`[Sync Module] ${dataTypeLabel} sync finished. Synced: ${successCount}, Remaining: ${remainingItems.length}`);

  } catch (error) {
    console.error(`[Sync Module] Error during ${dataTypeLabel} sync:`, error);
  } finally {
    setSyncingFlag(false);
  }
}

/**
 * 發送單個投票到後端 API
 * @param {object} voteData - 包含 userID 的完整投票數據
 */
async function sendVoteToAPI(voteData) {
  if (isDebugModeEnabled) console.log('[Sync Module] Sending vote to API via direct apiModule call:', voteData);
  try {
    // 模擬一個 sendResponse 函數，因為 apiModule.handleProcessVote 期望這個參數
    // 這裡我們不需要實際的 portSendResponse，因為 sync 模組是直接呼叫
    // 我們只需要確保 apiModule.handleProcessVote 內部邏輯能正常執行並返回結果
    const dummySendResponse = (response) => {
      if (isDebugModeEnabled) console.log('[Sync Module] Dummy sendResponse received for vote:', response);
      // 這裡可以根據 response 判斷成功或失敗，並拋出錯誤
      if (!response.success) {
        throw new Error(response.error || 'Failed to process vote via API module');
      }
    };

    // 直接呼叫 apiModule.handleProcessVote
    // 構造一個符合 apiModule.handleProcessVote 期望的 request 對象
    const request = { type: 'PROCESS_VOTE', payload: voteData };
    // sender 參數可以為空對象或 null，因為是內部呼叫
    await apiModule.handleMessage(request, {}, dummySendResponse);
    if (isDebugModeEnabled) console.log('[Sync Module] Vote processed successfully by apiModule.');
    return { success: true }; // 假設成功處理
  } catch (error) {
    console.error('[Sync Module] Error processing vote via apiModule:', error);
    throw error; // 重新拋出錯誤，讓 syncPendingItems 捕獲
  }
}

/**
 * 發送單個翻譯提交到後端 API
 * @param {object} translationData - 包含 userID 的完整翻譯數據
 */
async function sendTranslationToAPI(translationData) {
  if (isDebugModeEnabled) console.log('[Sync Module] Sending translation to API via direct apiModule call:', translationData);
  try {
    const dummySendResponse = (response) => {
      if (isDebugModeEnabled) console.log('[Sync Module] Dummy sendResponse received for translation:', response);
      if (!response.success) {
        throw new Error(response.error || 'Failed to submit translation via API module');
      }
    };

    // 直接呼叫 apiModule.handleSubmitTranslation
    // 構造一個符合 apiModule.handleSubmitTranslation 期望的 request 對象
    const request = {
      type: 'SUBMIT_TRANSLATION',
      videoId: translationData.videoId,
      timestamp: translationData.timestamp,
      original: translationData.original,
      translation: translationData.translation,
      submissionReason: translationData.submissionReason,
      languageCode: translationData.languageCode
    };
    // sender 參數可以為空對象或 null
    await apiModule.handleMessage(request, {}, dummySendResponse);
    if (isDebugModeEnabled) console.log('[Sync Module] Translation submitted successfully by apiModule.');
    return { success: true }; // 假設成功處理
  } catch (error) {
    console.error('[Sync Module] Error submitting translation via apiModule:', error);
    throw error; // 重新拋出錯誤，讓 syncPendingItems 捕獲
  }
}

/**
 * 發送替換事件到後端 API
 * @param {Array} events - 替換事件陣列
 * @returns {Promise<Object>} - API 回應結果
 */
async function sendReplacementEventsToAPI(events) {
  // 使用 apiModule.submitReplacementEvents 函數發送請求
  return await apiModule.submitReplacementEvents(events);
}

/**
 * 同步待處理的替換事件列表
 */
async function syncPendingReplacementEvents() {
  if (isDebugModeEnabled) console.log('[Sync Module] Starting replacement events sync...');
  
  try {
    const { replacementEvents = [] } = await chrome.storage.local.get(['replacementEvents']);
    if (replacementEvents.length === 0) {
      if (isDebugModeEnabled) console.log('[Sync Module] Replacement events queue is empty.');
      return;
    }

    if (isDebugModeEnabled) console.log(`[Sync Module] Syncing ${replacementEvents.length} pending replacement events...`);
    
    try {
      // 嘗試發送所有事件到 API
      const result = await sendReplacementEventsToAPI(replacementEvents);
      
      // 成功發送後清空本地存儲的事件
      await chrome.storage.local.set({ replacementEvents: [] });
      console.log(`[Sync Module] Successfully synced ${replacementEvents.length} replacement events and cleared local storage.`);
      
    } catch (error) {
      console.warn('[Sync Module] Failed to sync replacement events, keeping in storage:', error.message);
      // 失敗時保留事件，等待下次同步
    }

  } catch (error) {
    console.error('[Sync Module] Error during replacement events sync:', error);
  }
}

/**
 * 觸發替換事件同步
 */
function triggerReplacementEventsSync() {
  if (isDebugModeEnabled) console.log('[Sync Module] Triggering replacement events sync');
  syncPendingReplacementEvents(); // 異步執行
}

/**
 * 設置調試模式狀態
 * @param {boolean} debugMode - 調試模式是否啟用
 */
export function setDebugMode(debugMode) {
  isDebugModeEnabled = debugMode;
}

// 定期觸發同步 (例如每 5 分鐘)
// 創建三個獨立的 alarm
chrome.alarms.create('syncVotesAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncTranslationsAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncReplacementEventsAlarm', { periodInMinutes: 15 }); // 每15分鐘同步替換事件

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncVotesAlarm') {
    if (isDebugModeEnabled) console.log('[Sync Module] Periodic vote sync triggered by alarm.');
    triggerVoteSync();
  } else if (alarm.name === 'syncTranslationsAlarm') {
    if (isDebugModeEnabled) console.log('[Sync Module] Periodic translation sync triggered by alarm.');
    triggerTranslationSync();
  } else if (alarm.name === 'syncReplacementEventsAlarm') {
    if (isDebugModeEnabled) console.log('[Sync Module] Periodic replacement events sync triggered by alarm.');
    triggerReplacementEventsSync();
  }
});

// 擴充功能啟動時觸發所有同步
chrome.runtime.onStartup.addListener(() => {
  if (isDebugModeEnabled) console.log('[Sync Module] Extension startup, triggering all syncs.');
  triggerVoteSync();
  triggerTranslationSync();
  triggerReplacementEventsSync();
});
