// background/sync.js
// 負責處理資料同步相關操作的模組

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
  if (isDebugModeEnabled) console.log('[Sync Module] Sending vote to API via api.js:', voteData);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'PROCESS_VOTE', payload: voteData }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Sync Module] Error sending vote to API:', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        if (isDebugModeEnabled) console.log('[Sync Module] Vote sent to API:', response);
        if (response.success) {
          resolve(response.result || response);
        } else {
          reject(new Error(response.error || 'Failed to send vote to API'));
        }
      }
    });
  });
}

/**
 * 發送單個翻譯提交到後端 API
 * @param {object} translationData - 包含 userID 的完整翻譯數據
 */
async function sendTranslationToAPI(translationData) {
  if (isDebugModeEnabled) console.log('[Sync Module] Sending translation to API via api.js:', translationData);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'SUBMIT_TRANSLATION',
      videoId: translationData.videoId,
      timestamp: translationData.timestamp,
      original: translationData.original,
      translation: translationData.translation,
      submissionReason: translationData.submissionReason,
      languageCode: translationData.languageCode
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Sync Module] Error sending translation to API:', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        if (isDebugModeEnabled) console.log('[Sync Module] Translation sent to API:', response);
        if (response.success) {
          resolve(response.result || response);
        } else {
          reject(new Error(response.error || 'Failed to send translation to API'));
        }
      }
    });
  });
}

/**
 * 設置調試模式狀態
 * @param {boolean} debugMode - 調試模式是否啟用
 */
export function setDebugMode(debugMode) {
  isDebugModeEnabled = debugMode;
}

// 定期觸發同步 (例如每 5 分鐘)
// 創建兩個獨立的 alarm
chrome.alarms.create('syncVotesAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncTranslationsAlarm', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncVotesAlarm') {
    if (isDebugModeEnabled) console.log('[Sync Module] Periodic vote sync triggered by alarm.');
    triggerVoteSync();
  } else if (alarm.name === 'syncTranslationsAlarm') {
    if (isDebugModeEnabled) console.log('[Sync Module] Periodic translation sync triggered by alarm.');
    triggerTranslationSync();
  }
});

// 擴充功能啟動時觸發所有同步
chrome.runtime.onStartup.addListener(() => {
  if (isDebugModeEnabled) console.log('[Sync Module] Extension startup, triggering all syncs.');
  triggerVoteSync();
  triggerTranslationSync();
});
