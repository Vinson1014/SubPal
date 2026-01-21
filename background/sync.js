// background/sync.js
// 負責處理資料同步相關操作的模組 - Queue 系統版本

import * as apiModule from './api.js';

// 常量定義
const MAX_RETRIES = 3;
const MAX_HISTORY_LENGTH = 100;
const VOTE_QUEUE_KEY = 'voteQueue';
const VOTE_HISTORY_KEY = 'voteHistory';
const TRANSLATION_QUEUE_KEY = 'translationQueue';
const TRANSLATION_HISTORY_KEY = 'translationHistory';

// 同步狀態標誌
let isSyncingVotes = false;
let isSyncingTranslations = false;

// ==================== Storage 輔助函數 ====================

/**
 * 獲取隊列中狀態為 pending 的項目
 * @param {string} queueType - 隊列類型 (voteQueue 或 translationQueue)
 * @returns {Promise<Array>} - pending 狀態的項目列表
 */
async function getPendingItems(queueType) {
  const result = await chrome.storage.local.get(queueType);
  const queue = result[queueType] || [];
  return queue.filter(item => item.status === 'pending');
}

/**
 * 更新隊列項目的狀態
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @param {string} status - 新狀態 (pending, syncing, completed, failed)
 * @param {string|null} error - 錯誤訊息
 * @returns {Promise<Object|null>} - 更新後的項目
 */
async function updateItemStatus(queueType, itemId, status, error = null) {
  const result = await chrome.storage.local.get(queueType);
  const queue = result[queueType] || [];
  const updatedQueue = queue.map(item => {
    if (item.id === itemId) {
      return {
        ...item,
        status,
        error,
        syncedAt: status === 'completed' ? Date.now() : null
      };
    }
    return item;
  });
  await chrome.storage.local.set({ [queueType]: updatedQueue });
  return updatedQueue.find(item => item.id === itemId) || null;
}

/**
 * 更新隊列項目的重試次數
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @param {number} retryCount - 重試次數
 */
async function updateQueueItemRetryCount(queueType, itemId, retryCount) {
  const result = await chrome.storage.local.get(queueType);
  const queue = result[queueType] || [];
  const updatedQueue = queue.map(item => {
    if (item.id === itemId) {
      return { ...item, retryCount };
    }
    return item;
  });
  await chrome.storage.local.set({ [queueType]: updatedQueue });
}

/**
 * 將完成的項目從隊列移至歷史記錄
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @param {string} historyType - 歷史記錄類型
 */
async function moveToHistory(queueType, itemId, historyType) {
  const storageData = await chrome.storage.local.get([queueType, historyType]);
  const queue = storageData[queueType] || [];
  const history = storageData[historyType] || [];

  const itemIndex = queue.findIndex(item => item.id === itemId);
  if (itemIndex === -1) return;

  const [item] = queue.splice(itemIndex, 1);
  const completedItem = {
    ...item,
    status: 'completed',
    syncedAt: Date.now()
  };

  // 移除敏感或不需要的欄位
  delete completedItem.retryCount;
  delete completedItem.error;

  // 加到歷史記錄開頭
  history.unshift(completedItem);

  // 限制歷史記錄長度
  if (history.length > MAX_HISTORY_LENGTH) {
    history.splice(MAX_HISTORY_LENGTH);
  }

  await chrome.storage.local.set({
    [queueType]: queue,
    [historyType]: history
  });
}

/**
 * 獲取同步狀態統計
 * @returns {Promise<Object>} - 同步狀態資訊
 */
async function getSyncStatus() {
  const storageData = await chrome.storage.local.get([
    VOTE_QUEUE_KEY,
    TRANSLATION_QUEUE_KEY
  ]);

  const voteQueue = storageData[VOTE_QUEUE_KEY] || [];
  const translationQueue = storageData[TRANSLATION_QUEUE_KEY] || [];

  return {
    pendingVotes: voteQueue.filter(item => item.status === 'pending').length,
    syncingVotes: voteQueue.filter(item => item.status === 'syncing').length,
    failedVotes: voteQueue.filter(item => item.status === 'failed').length,
    pendingTranslations: translationQueue.filter(item => item.status === 'pending').length,
    syncingTranslations: translationQueue.filter(item => item.status === 'syncing').length,
    failedTranslations: translationQueue.filter(item => item.status === 'failed').length,
    isSyncingVotes,
    isSyncingTranslations
  };
}

// ==================== 同步主函數 ====================

/**
 * 同步待處理的投票隊列
 */
async function syncPendingVotes() {
  if (isSyncingVotes) return;
  isSyncingVotes = true;
  console.log('[Sync] Starting vote sync...');

  try {
    const pendingItems = await getPendingItems(VOTE_QUEUE_KEY);

    if (pendingItems.length === 0) {
      console.log('[Sync] Vote queue is empty.');
      return;
    }

    console.log(`[Sync] Syncing ${pendingItems.length} pending votes...`);

    for (const item of pendingItems) {
      try {
        await updateItemStatus(VOTE_QUEUE_KEY, item.id, 'syncing');
        await sendVoteToAPI(item);
        await moveToHistory(VOTE_QUEUE_KEY, item.id, VOTE_HISTORY_KEY);
        console.log(`[Sync] Vote ${item.id} synced successfully`);
      } catch (error) {
        const retryCount = item.retryCount || 0;

        if (retryCount < MAX_RETRIES) {
          await updateItemStatus(VOTE_QUEUE_KEY, item.id, 'pending', null);
          await updateQueueItemRetryCount(VOTE_QUEUE_KEY, item.id, retryCount + 1);
          console.warn(`[Sync] Vote ${item.id} retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
        } else {
          await updateItemStatus(VOTE_QUEUE_KEY, item.id, 'failed', error.message);
          console.error(`[Sync] Vote ${item.id} failed after ${MAX_RETRIES} retries: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.error('[Sync] Error during vote sync:', error);
  } finally {
    isSyncingVotes = false;
  }
}

/**
 * 同步待處理的翻譯隊列
 */
async function syncPendingTranslations() {
  if (isSyncingTranslations) return;
  isSyncingTranslations = true;
  console.log('[Sync] Starting translation sync...');

  try {
    const pendingItems = await getPendingItems(TRANSLATION_QUEUE_KEY);

    if (pendingItems.length === 0) {
      console.log('[Sync] Translation queue is empty.');
      return;
    }

    console.log(`[Sync] Syncing ${pendingItems.length} pending translations...`);

    for (const item of pendingItems) {
      try {
        await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, 'syncing');
        await sendTranslationToAPI(item);
        await moveToHistory(TRANSLATION_QUEUE_KEY, item.id, TRANSLATION_HISTORY_KEY);
        console.log(`[Sync] Translation ${item.id} synced successfully`);
      } catch (error) {
        const retryCount = item.retryCount || 0;

        if (retryCount < MAX_RETRIES) {
          await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, 'pending', null);
          await updateQueueItemRetryCount(TRANSLATION_QUEUE_KEY, item.id, retryCount + 1);
          console.warn(`[Sync] Translation ${item.id} retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
        } else {
          await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, 'failed', error.message);
          console.error(`[Sync] Translation ${item.id} failed after ${MAX_RETRIES} retries: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.error('[Sync] Error during translation sync:', error);
  } finally {
    isSyncingTranslations = false;
  }
}

/**
 * 重試所有失敗的投票
 */
async function retryFailedVotes() {
  const result = await chrome.storage.local.get(VOTE_QUEUE_KEY);
  const queue = result[VOTE_QUEUE_KEY] || [];
  const failedItems = queue.filter(item => item.status === 'failed');

  for (const item of failedItems) {
    await updateItemStatus(VOTE_QUEUE_KEY, item.id, 'pending', null);
    await updateQueueItemRetryCount(VOTE_QUEUE_KEY, item.id, 0);
  }

  console.log(`[Sync] Retrying ${failedItems.length} failed votes`);
  await syncPendingVotes();
}

/**
 * 重試所有失敗的翻譯
 */
async function retryFailedTranslations() {
  const result = await chrome.storage.local.get(TRANSLATION_QUEUE_KEY);
  const queue = result[TRANSLATION_QUEUE_KEY] || [];
  const failedItems = queue.filter(item => item.status === 'failed');

  for (const item of failedItems) {
    await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, 'pending', null);
    await updateQueueItemRetryCount(TRANSLATION_QUEUE_KEY, item.id, 0);
  }

  console.log(`[Sync] Retrying ${failedItems.length} failed translations`);
  await syncPendingTranslations();
}

// ==================== API 調用函數 ====================

/**
 * 發送單個投票到後端 API
 * @param {object} voteData - 投票數據
 */
async function sendVoteToAPI(voteData) {
  console.log('[Sync] Sending vote to API:', voteData.id);

  try {
    // 直接調用 API 模組的 submitVote 函數
    const result = await apiModule.submitVote({
      videoID: voteData.videoId,
      timestamp: voteData.timestamp,
      voteType: voteData.voteType,
      translationID: voteData.translationID || null,
      originalSubtitle: voteData.originalSubtitle || null
    });

    console.log('[Sync] Vote submitted successfully:', result);
    return { success: true };
  } catch (error) {
    console.error('[Sync] Error submitting vote:', error);
    throw error;
  }
}

/**
 * 發送單個翻譯提交到後端 API
 * @param {object} translationData - 翻譯數據
 */
async function sendTranslationToAPI(translationData) {
  console.log('[Sync] Sending translation to API:', translationData.id);

  try {
    // 直接調用 API 模組的 submitTranslation 函數
    const result = await apiModule.submitTranslation({
      videoId: translationData.videoId,
      timestamp: translationData.timestamp,
      original: translationData.original,
      translation: translationData.translation,
      submissionReason: translationData.submissionReason || '',
      languageCode: translationData.languageCode
    });

    console.log('[Sync] Translation submitted successfully:', result);
    return { success: true };
  } catch (error) {
    console.error('[Sync] Error submitting translation:', error);
    throw error;
  }
}

// ==================== 觸發函數（供外部調用）====================

/**
 * 觸發投票同步
 */
export async function triggerVoteSync() {
  if (!isSyncingVotes) {
    console.log('[Sync] Triggering vote sync');
    await syncPendingVotes();
  } else {
    console.log('[Sync] Vote sync already in progress');
  }
}

/**
 * 觸發翻譯同步
 */
export async function triggerTranslationSync() {
  if (!isSyncingTranslations) {
    console.log('[Sync] Triggering translation sync');
    await syncPendingTranslations();
  } else {
    console.log('[Sync] Translation sync already in progress');
  }
}

// ==================== 消息處理器 ====================

/**
 * 處理資料同步相關的訊息 (通過 port)
 * @param {Object} request - 接收到的訊息請求
 * @param {object} sender - 發送者信息
 * @param {Function} portSendResponse - 回應函數 (通過 port 發送)
 */
export function handleMessage(request, sender, portSendResponse) {
  switch (request.type) {
    case 'SYNC_VOTES':
      syncPendingVotes().then(() => {
        portSendResponse({ success: true, message: 'Vote sync triggered' });
      }).catch(error => {
        portSendResponse({ success: false, error: error.message });
      });
      break;

    case 'SYNC_TRANSLATIONS':
      syncPendingTranslations().then(() => {
        portSendResponse({ success: true, message: 'Translation sync triggered' });
      }).catch(error => {
        portSendResponse({ success: false, error: error.message });
      });
      break;

    case 'GET_SYNC_STATUS':
      getSyncStatus().then(status => {
        portSendResponse({ success: true, status });
      }).catch(error => {
        portSendResponse({ success: false, error: error.message });
      });
      break;

    case 'RETRY_FAILED_VOTES':
      retryFailedVotes().then(() => {
        portSendResponse({ success: true, message: 'Failed votes retry triggered' });
      }).catch(error => {
        portSendResponse({ success: false, error: error.message });
      });
      break;

    case 'RETRY_FAILED_TRANSLATIONS':
      retryFailedTranslations().then(() => {
        portSendResponse({ success: true, message: 'Failed translations retry triggered' });
      }).catch(error => {
        portSendResponse({ success: false, error: error.message });
      });
      break;

    case 'TRIGGER_VOTE_SYNC':
      triggerVoteSync();
      portSendResponse({ success: true, message: 'Vote sync triggered' });
      break;

    case 'TRIGGER_TRANSLATION_SYNC':
      triggerTranslationSync();
      portSendResponse({ success: true, message: 'Translation sync triggered' });
      break;

    default:
      portSendResponse({
        success: false,
        error: `Unhandled message type in sync module: ${request.type}`
      });
      break;
  }
}

// ==================== 替換事件同步（保留舊功能）====================

/**
 * 發送替換事件到後端 API
 * @param {Array} events - 替換事件陣列
 * @returns {Promise<Object>} - API 回應結果
 */
async function sendReplacementEventsToAPI(events) {
  return await apiModule.submitReplacementEvents(events);
}

/**
 * 同步待處理的替換事件列表
 */
async function syncPendingReplacementEvents() {
  console.log('[Sync] Starting replacement events sync...');

  try {
    const { replacementEvents = [] } = await chrome.storage.local.get(['replacementEvents']);
    if (replacementEvents.length === 0) {
      console.log('[Sync] Replacement events queue is empty.');
      return;
    }

    console.log(`[Sync] Syncing ${replacementEvents.length} pending replacement events...`);

    try {
      const result = await sendReplacementEventsToAPI(replacementEvents);
      await chrome.storage.local.set({ replacementEvents: [] });
      console.log(`[Sync] Successfully synced ${replacementEvents.length} replacement events and cleared local storage.`);
    } catch (error) {
      console.warn('[Sync] Failed to sync replacement events, keeping in storage:', error.message);
    }
  } catch (error) {
    console.error('[Sync] Error during replacement events sync:', error);
  }
}

/**
 * 觸發替換事件同步
 */
function triggerReplacementEventsSync() {
  console.log('[Sync] Triggering replacement events sync');
  syncPendingReplacementEvents();
}

// ==================== 初始化 ====================

/**
 * Service Worker 啟動時初始化同步
 */
async function initializeSync() {
  console.log('[Sync] Initializing sync service...');

  try {
    const status = await getSyncStatus();
    console.log('[Sync] Current status:', status);

    if (status.pendingVotes > 0 || status.failedVotes > 0) {
      await syncPendingVotes();
    }

    if (status.pendingTranslations > 0 || status.failedTranslations > 0) {
      await syncPendingTranslations();
    }

    console.log('[Sync] Initialization complete');
  } catch (error) {
    console.error('[Sync] Initialization failed:', error);
  }
}

// 模組載入時初始化
initializeSync();

// ==================== 定期同步（Alarms）====================

// 創建三個獨立的 alarm
chrome.alarms.create('syncVotesAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncTranslationsAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncReplacementEventsAlarm', { periodInMinutes: 15 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncVotesAlarm') {
    console.log('[Sync] Periodic vote sync triggered by alarm');
    triggerVoteSync();
  } else if (alarm.name === 'syncTranslationsAlarm') {
    console.log('[Sync] Periodic translation sync triggered by alarm');
    triggerTranslationSync();
  } else if (alarm.name === 'syncReplacementEventsAlarm') {
    console.log('[Sync] Periodic replacement events sync triggered by alarm');
    triggerReplacementEventsSync();
  }
});

// 擴充功能啟動時觸發所有同步
chrome.runtime.onStartup.addListener(() => {
  console.log('[Sync] Extension startup, triggering all syncs');
  triggerVoteSync();
  triggerTranslationSync();
  triggerReplacementEventsSync();
});
