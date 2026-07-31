// background/sync.js
// 負責處理資料同步相關操作的模組 - Queue 系統版本

import * as apiModule from './api.js';
import { resolveBackendProfile } from './backend-profiles.js';
import { ensureStorageMigrationsComplete } from './storage-migrations.js';

// 常量定義
const MAX_RETRIES = 3;
const MAX_HISTORY_LENGTH = 100;
const SYNCING_STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 分鐘
const VOTE_QUEUE_KEY = 'voteQueue';
const VOTE_HISTORY_KEY = 'voteHistory';
const TRANSLATION_QUEUE_KEY = 'translationQueue';
const TRANSLATION_HISTORY_KEY = 'translationHistory';
const REPLACEMENT_EVENT_QUEUE_KEY = 'replacementEventQueue';
const REPLACEMENT_EVENT_HISTORY_KEY = 'replacementEventHistory';
const VOTE_STATE_BY_TRANSLATION_KEY = 'voteStateByTranslation';

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

// 同步狀態標誌
let isSyncingVotes = false;
let isSyncingTranslations = false;
let isSyncingReplacementEvents = false;

async function resolveSyncProfileId(profileId) {
  await ensureStorageMigrationsComplete();
  if (profileId !== undefined) return profileId;
  return (await resolveBackendProfile()).id;
}

// ==================== Storage 輔助函數 ====================

/**
 * 獲取隊列中狀態為 pending 的項目
 * @param {string} queueType - 隊列類型 (voteQueue 或 translationQueue)
 * @returns {Promise<Array>} - pending 狀態的項目列表
 */
async function getPendingItems(queueType, profileId) {
  const result = await chrome.storage.local.get(queueType);
  const queue = result[queueType] || [];
  return queue.filter(item => item.status === 'pending' && item.backendProfileId === profileId);
}

/**
 * 更新隊列項目的指定欄位
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @param {Object} updater - 要寫入的欄位
 * @returns {Promise<Object|null>} - 更新後的項目
 */
async function updateQueueItem(queueType, itemId, profileId, updater) {
  const result = await chrome.storage.local.get(queueType);
  const queue = result[queueType] || [];
  const updatedQueue = queue.map(item => {
    if (item.id !== itemId || item.backendProfileId !== profileId) {
      return item;
    }

    const nextItem = {
      ...item,
      ...updater
    };

    if ('syncStartedAt' in nextItem && nextItem.syncStartedAt == null) {
      delete nextItem.syncStartedAt;
    }

    return nextItem;
  });

  await chrome.storage.local.set({ [queueType]: updatedQueue });
  return updatedQueue.find(item => item.id === itemId && item.backendProfileId === profileId) || null;
}

/**
 * 更新隊列項目的狀態
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @param {string} status - 新狀態 (pending, syncing, completed, failed)
 * @param {string|null} error - 錯誤訊息
 * @returns {Promise<Object|null>} - 更新後的項目
 */
async function updateItemStatus(queueType, itemId, profileId, status, error = null) {
  const updates = {
    status,
    error,
    syncedAt: status === 'completed' ? Date.now() : null
  };

  if (status === 'pending' || status === 'failed' || status === 'completed') {
    updates.syncStartedAt = null;
  }

  return await updateQueueItem(queueType, itemId, profileId, updates);
}

/**
 * 將項目標記為正在同步，並記錄本次同步開始時間
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @returns {Promise<Object|null>} - 更新後的項目
 */
async function markItemAsSyncing(queueType, itemId, profileId) {
  return await updateQueueItem(queueType, itemId, profileId, {
    status: 'syncing',
    error: null,
    syncedAt: null,
    syncStartedAt: Date.now()
  });
}

/**
 * 更新隊列項目的重試次數
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @param {number} retryCount - 重試次數
 */
async function updateQueueItemRetryCount(queueType, itemId, profileId, retryCount) {
  await updateQueueItem(queueType, itemId, profileId, { retryCount });
}

/**
 * 回收卡住過久的 syncing 項目，避免舊版殘留資料永久卡住。
 * TODO: 當大多數使用者已自然遷移完成、storage 不再出現長時間殘留的 syncing 項目後，
 * 可以在未來版本移除此相容救援邏輯。
 * @param {string} queueType - 隊列類型
 * @returns {Promise<number>} - 回收的項目數量
 */
async function recoverStaleSyncingItems(queueType, profileId) {
  const result = await chrome.storage.local.get(queueType);
  const queue = result[queueType] || [];
  const now = Date.now();
  const recoveredIds = [];

  const updatedQueue = queue.map(item => {
    if (item.status !== 'syncing' || item.backendProfileId !== profileId) {
      return item;
    }

    const isStale = typeof item.createdAt === 'number' && (now - item.createdAt) > SYNCING_STALE_TIMEOUT_MS;
    if (!isStale) {
      return item;
    }

    recoveredIds.push(item.id);
    return {
      ...item,
      status: 'pending',
      error: null,
      syncedAt: null,
      syncStartedAt: null
    };
  }).map(item => {
    if ('syncStartedAt' in item && item.syncStartedAt == null) {
      const sanitizedItem = { ...item };
      delete sanitizedItem.syncStartedAt;
      return sanitizedItem;
    }
    return item;
  });

  if (recoveredIds.length === 0) {
    return 0;
  }

  await chrome.storage.local.set({ [queueType]: updatedQueue });
  console.warn(`[Sync] Recovered ${recoveredIds.length} stale syncing items from ${queueType}:`, recoveredIds);
  return recoveredIds.length;
}

/**
 * 判斷是否為可視為已完成的重複提交錯誤
 * @param {Error} error - API 錯誤
 * @returns {boolean}
 */
function isDuplicateSubmissionError(error) {
  return error?.status === 409;
}

/**
 * 將完成的項目從隊列移至歷史記錄
 * @param {string} queueType - 隊列類型
 * @param {string} itemId - 項目 ID
 * @param {string} historyType - 歷史記錄類型
 */
async function moveToHistory(queueType, itemId, historyType, profileId) {
  const storageData = await chrome.storage.local.get([queueType, historyType]);
  const queue = storageData[queueType] || [];
  const history = storageData[historyType] || [];

  const itemIndex = queue.findIndex(item => item.id === itemId && item.backendProfileId === profileId);
  if (itemIndex === -1) return;

  const [item] = queue.splice(itemIndex, 1);
  const completedItem = {
    ...item,
    status: 'completed',
    syncedAt: Date.now()
  };

  if (completedItem.resolutionContext !== undefined && completedItem.resolutionContext !== null) {
    completedItem.resolutionContext = normalizeResolutionContext(completedItem.resolutionContext);
  }

  // 移除敏感或不需要的欄位
  delete completedItem.retryCount;
  delete completedItem.error;
  delete completedItem.syncStartedAt;

  const nextHistory = history.filter((historyItem) => (
    historyItem.id !== itemId || historyItem.backendProfileId !== profileId
  ));

  // 加到歷史記錄開頭
  nextHistory.unshift(completedItem);

  let retainedProfileEntries = 0;
  const boundedHistory = nextHistory.filter((historyItem) => {
    if (historyItem.backendProfileId !== profileId) return true;
    retainedProfileEntries += 1;
    return retainedProfileEntries <= MAX_HISTORY_LENGTH;
  });

  await chrome.storage.local.set({
    [queueType]: queue,
    [historyType]: boundedHistory
  });
}

/**
 * 獲取同步狀態統計
 * @returns {Promise<Object>} - 同步狀態資訊
 */
async function getSyncStatus(profileId) {
  const storageData = await chrome.storage.local.get([
    VOTE_QUEUE_KEY,
    TRANSLATION_QUEUE_KEY,
    REPLACEMENT_EVENT_QUEUE_KEY
  ]);

  const voteQueue = storageData[VOTE_QUEUE_KEY] || [];
  const translationQueue = storageData[TRANSLATION_QUEUE_KEY] || [];
  const replacementEventQueue = storageData[REPLACEMENT_EVENT_QUEUE_KEY] || [];

  return {
    pendingVotes: voteQueue.filter(item => item.status === 'pending' && item.backendProfileId === profileId).length,
    syncingVotes: voteQueue.filter(item => item.status === 'syncing' && item.backendProfileId === profileId).length,
    failedVotes: voteQueue.filter(item => item.status === 'failed' && item.backendProfileId === profileId).length,
    pendingTranslations: translationQueue.filter(item => item.status === 'pending' && item.backendProfileId === profileId).length,
    syncingTranslations: translationQueue.filter(item => item.status === 'syncing' && item.backendProfileId === profileId).length,
    failedTranslations: translationQueue.filter(item => item.status === 'failed' && item.backendProfileId === profileId).length,
    pendingReplacementEvents: replacementEventQueue.filter(item => item.status === 'pending' && item.backendProfileId === profileId).length,
    syncingReplacementEvents: replacementEventQueue.filter(item => item.status === 'syncing' && item.backendProfileId === profileId).length,
    failedReplacementEvents: replacementEventQueue.filter(item => item.status === 'failed' && item.backendProfileId === profileId).length,
    isSyncingVotes,
    isSyncingTranslations,
    isSyncingReplacementEvents
  };
}

// ==================== 同步主函數 ====================

/**
 * 同步待處理的投票隊列
 */
async function syncPendingVotes(profileId) {
  if (isSyncingVotes) return;
  isSyncingVotes = true;
  console.log('[Sync] Starting vote sync...');

  try {
    await recoverStaleSyncingItems(VOTE_QUEUE_KEY, profileId);
    const pendingItems = await getPendingItems(VOTE_QUEUE_KEY, profileId);

    if (pendingItems.length === 0) {
      console.log('[Sync] Vote queue is empty.');
      return;
    }

    console.log(`[Sync] Syncing ${pendingItems.length} pending votes...`);

    for (const item of pendingItems) {
      try {
        const syncingItem = await markItemAsSyncing(VOTE_QUEUE_KEY, item.id, profileId);
        if (!syncingItem) continue;
        const result = await sendVoteToAPI(syncingItem, profileId);

        // 如果有權威投票數據，先寫入隊列項目再移動到歷史記錄
        if (result.data && result.data._authoritativeVoteState) {
          await updateQueueItem(VOTE_QUEUE_KEY, item.id, profileId, {
            authoritativeVoteState: result.data._authoritativeVoteState
          });
        }

        await moveToHistory(VOTE_QUEUE_KEY, item.id, VOTE_HISTORY_KEY, profileId);
        console.log(`[Sync] Vote ${item.id} synced successfully`);
      } catch (error) {
        // 對於新 voteState API，不將 409 視為成功（idempotent PUT 不應返回 409）
        // 僅對舊版 submitVote 路徑保留 409-as-completed 行為
        if (isDuplicateSubmissionError(error) && !item.voteState) {
          await moveToHistory(VOTE_QUEUE_KEY, item.id, VOTE_HISTORY_KEY, profileId);
          console.warn(`[Sync] Vote ${item.id} already exists on backend (409), moved to history`);
          continue;
        }

        // 檢查是否為永久錯誤（不應重試）
        if (apiModule.isPermanentError(error)) {
          const errorMetadata = {
            code: error.code || null,
            status: error.status || null,
            message: error.message || 'Unknown error',
            isPermanent: true,
            failedAt: Date.now()
          };
          await updateItemStatus(VOTE_QUEUE_KEY, item.id, profileId, 'failed', error.message);
          await updateQueueItem(VOTE_QUEUE_KEY, item.id, profileId, { errorMetadata });
          console.error(`[Sync] Vote ${item.id} failed permanently: ${error.message}`);
          continue;
        }

        const retryCount = item.retryCount || 0;

        if (retryCount < MAX_RETRIES) {
          await updateItemStatus(VOTE_QUEUE_KEY, item.id, profileId, 'pending', null);
          await updateQueueItemRetryCount(VOTE_QUEUE_KEY, item.id, profileId, retryCount + 1);
          console.warn(`[Sync] Vote ${item.id} retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
        } else {
          await updateItemStatus(VOTE_QUEUE_KEY, item.id, profileId, 'failed', error.message);
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
async function syncPendingTranslations(profileId) {
  if (isSyncingTranslations) return;
  isSyncingTranslations = true;
  console.log('[Sync] Starting translation sync...');

  try {
    await recoverStaleSyncingItems(TRANSLATION_QUEUE_KEY, profileId);
    const pendingItems = await getPendingItems(TRANSLATION_QUEUE_KEY, profileId);

    if (pendingItems.length === 0) {
      console.log('[Sync] Translation queue is empty.');
      return;
    }

    console.log(`[Sync] Syncing ${pendingItems.length} pending translations...`);

    for (const item of pendingItems) {
      try {
        const syncingItem = await markItemAsSyncing(TRANSLATION_QUEUE_KEY, item.id, profileId);
        if (!syncingItem) continue;
        await sendTranslationToAPI(syncingItem, profileId);
        await moveToHistory(TRANSLATION_QUEUE_KEY, item.id, TRANSLATION_HISTORY_KEY, profileId);
        console.log(`[Sync] Translation ${item.id} synced successfully`);
      } catch (error) {
        if (isDuplicateSubmissionError(error)) {
          await moveToHistory(TRANSLATION_QUEUE_KEY, item.id, TRANSLATION_HISTORY_KEY, profileId);
          console.warn(`[Sync] Translation ${item.id} already exists on backend (409), moved to history`);
          continue;
        }

        if (apiModule.isPermanentError(error)) {
          const errorMetadata = {
            code: error.code || null,
            status: error.status || null,
            message: error.message || 'Unknown error',
            isPermanent: true,
            retryExhausted: false,
            terminal: true,
            failedAt: Date.now()
          };
          await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, profileId, 'failed', error.message);
          await updateQueueItem(TRANSLATION_QUEUE_KEY, item.id, profileId, { errorMetadata });
          console.error(`[Sync] Translation ${item.id} failed permanently: ${error.message}`);
          continue;
        }

        const retryCount = item.retryCount || 0;

        if (retryCount < MAX_RETRIES) {
          await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, profileId, 'pending', null);
          await updateQueueItemRetryCount(TRANSLATION_QUEUE_KEY, item.id, profileId, retryCount + 1);
          console.warn(`[Sync] Translation ${item.id} retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
        } else {
          const errorMetadata = {
            code: error.code || null,
            status: error.status || null,
            message: error.message || 'Unknown error',
            isPermanent: false,
            retryExhausted: true,
            terminal: true,
            failedAt: Date.now()
          };
          await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, profileId, 'failed', error.message);
          await updateQueueItem(TRANSLATION_QUEUE_KEY, item.id, profileId, { errorMetadata });
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
async function retryFailedVotes(profileId) {
  const pinnedProfileId = await resolveSyncProfileId(profileId);
  await recoverStaleSyncingItems(VOTE_QUEUE_KEY, pinnedProfileId);
  const result = await chrome.storage.local.get(VOTE_QUEUE_KEY);
  const queue = result[VOTE_QUEUE_KEY] || [];
  const failedItems = queue.filter(item => item.status === 'failed' && item.backendProfileId === pinnedProfileId);

  for (const item of failedItems) {
    await updateItemStatus(VOTE_QUEUE_KEY, item.id, pinnedProfileId, 'pending', null);
    await updateQueueItemRetryCount(VOTE_QUEUE_KEY, item.id, pinnedProfileId, 0);
  }

  console.log(`[Sync] Retrying ${failedItems.length} failed votes`);
  await syncPendingVotes(pinnedProfileId);
}

/**
 * 重試所有失敗的翻譯
 */
async function retryFailedTranslations(profileId) {
  const pinnedProfileId = await resolveSyncProfileId(profileId);
  await recoverStaleSyncingItems(TRANSLATION_QUEUE_KEY, pinnedProfileId);
  const result = await chrome.storage.local.get(TRANSLATION_QUEUE_KEY);
  const queue = result[TRANSLATION_QUEUE_KEY] || [];
  const failedItems = queue.filter(item => item.status === 'failed' && item.backendProfileId === pinnedProfileId);

  for (const item of failedItems) {
    await updateItemStatus(TRANSLATION_QUEUE_KEY, item.id, pinnedProfileId, 'pending', null);
    await updateQueueItemRetryCount(TRANSLATION_QUEUE_KEY, item.id, pinnedProfileId, 0);
  }

  console.log(`[Sync] Retrying ${failedItems.length} failed translations`);
  await syncPendingTranslations(pinnedProfileId);
}

// ==================== API 調用函數 ====================

/**
 * 發送單個投票到後端 API
 * @param {object} voteData - 投票數據
 */
async function sendVoteToAPI(voteData, profileId) {
  try {
    let result;

    // 新投票狀態 API：使用 setVoteState 處理有 translationID 和 voteState 的項目
    if (voteData.translationID && voteData.voteState) {
      const payload = {
        translationID: voteData.translationID,
        voteState: voteData.voteState,
        clientVersion: voteData.clientVersion || null,
        backendProfileId: profileId
      };
      if (voteData.resolutionContext !== undefined && voteData.resolutionContext !== null) {
        payload.resolutionContext = normalizeResolutionContext(voteData.resolutionContext);
      }
      result = await apiModule.setVoteState(payload);

      // 儲存權威響應數據到 voteStateByTranslation
      if (result && voteData.translationID) {
        const storageData = await chrome.storage.local.get(VOTE_STATE_BY_TRANSLATION_KEY);
        const voteStateByTranslation = storageData[VOTE_STATE_BY_TRANSLATION_KEY] || {};
        const existingVoteState = voteStateByTranslation[voteData.translationID];
        if (existingVoteState?.backendProfileId && existingVoteState.backendProfileId !== profileId) {
          return { success: true, data: result };
        }
        const voteStateRecord = {
          myVote: result.myVote ?? null,
          upvotes: result.upvotes ?? 0,
          downvotes: result.downvotes ?? 0,
          pending: false,
          updatedAt: Date.now(),
          backendProfileId: profileId
        };

        // 更新 storage map
        voteStateByTranslation[voteData.translationID] = voteStateRecord;
        await chrome.storage.local.set({ [VOTE_STATE_BY_TRANSLATION_KEY]: voteStateByTranslation });

        // 將權威數據附加到結果供歷史記錄使用
        result._authoritativeVoteState = voteStateRecord;
      }
    } else {
      // 舊版投票 API：使用 submitVote 處理 legacy 項目
      const payload = {
        videoID: voteData.videoId,
        timestamp: voteData.timestamp,
        voteType: voteData.voteType,
        translationID: voteData.translationID || null,
        originalSubtitle: voteData.originalSubtitle || null,
        slotKey: voteData.slotKey || null,
        backendProfileId: profileId
      };
      if (voteData.resolutionContext !== undefined && voteData.resolutionContext !== null) {
        payload.resolutionContext = normalizeResolutionContext(voteData.resolutionContext);
      }
      result = await apiModule.submitVote(payload);
    }

    return { success: true, data: result };
  } catch (error) {
    console.error('[Sync] Error submitting vote:', error);
    throw error;
  }
}

/**
 * 發送單個翻譯提交到後端 API
 * @param {object} translationData - 翻譯數據
 */
async function sendTranslationToAPI(translationData, profileId) {
  console.log('[Sync] Sending translation to API:', translationData.id);

  try {
    // 直接調用 API 模組的 submitTranslation 函數
    const payload = {
      videoId: translationData.videoId,
      timestamp: translationData.timestamp,
      original: translationData.original,
      translation: translationData.translation,
      submissionReason: translationData.submissionReason || '',
      languageCode: translationData.languageCode,
      slotKey: translationData.slotKey || null,
      backendProfileId: profileId
    };
    if (translationData.resolutionContext !== undefined && translationData.resolutionContext !== null) {
      payload.translationID = translationData.translationID ?? null;
      payload.resolutionContext = normalizeResolutionContext(translationData.resolutionContext);
    } else if (Object.hasOwn(translationData, 'translationID')) {
      payload.translationID = translationData.translationID ?? null;
    }
    if (translationData.sourceTranslationID !== undefined) {
      payload.sourceTranslationID = translationData.sourceTranslationID;
    }
    const result = await apiModule.submitTranslation(payload);

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
export async function triggerVoteSync(profileId) {
  if (!isSyncingVotes) {
    const pinnedProfileId = await resolveSyncProfileId(profileId);
    console.log('[Sync] Triggering vote sync');
    await syncPendingVotes(pinnedProfileId);
  } else {
    console.log('[Sync] Vote sync already in progress');
  }
}

/**
 * 觸發翻譯同步
 */
export async function triggerTranslationSync(profileId) {
  if (!isSyncingTranslations) {
    const pinnedProfileId = await resolveSyncProfileId(profileId);
    console.log('[Sync] Triggering translation sync');
    await syncPendingTranslations(pinnedProfileId);
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

    case 'RETRY_FAILED_REPLACEMENT_EVENTS':
      retryFailedReplacementEvents().then(() => {
        portSendResponse({ success: true, message: 'Failed replacement events retry triggered' });
      }).catch(error => {
        portSendResponse({ success: false, error: error.message });
      });
      break;

    default:
      portSendResponse({
        success: false,
        error: `Unhandled message type in sync module: ${request.type}`
      });
      break;
  }
}

// ==================== 替換事件同步 ====================

/**
 * 同步待處理的替換事件隊列
 * 使用批量 API 提交（最多100個）
 */
async function syncPendingReplacementEvents(profileId) {
  if (isSyncingReplacementEvents) return;
  isSyncingReplacementEvents = true;
  console.log('[Sync] Starting replacement event sync...');

  try {
    await recoverStaleSyncingItems(REPLACEMENT_EVENT_QUEUE_KEY, profileId);
    const pendingItems = await getPendingItems(REPLACEMENT_EVENT_QUEUE_KEY, profileId);

    if (pendingItems.length === 0) {
      console.log('[Sync] Replacement event queue is empty.');
      return;
    }

    console.log(`[Sync] Syncing ${pendingItems.length} pending replacement events...`);

    // 批量發送（最多100個，符合後端API限制）
    const batchSize = 100;
    const batches = [];
    for (let i = 0; i < pendingItems.length; i += batchSize) {
      batches.push(pendingItems.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      const syncingItems = [];
      try {
        // 標記所有項目為 syncing
        for (const item of batch) {
          const syncingItem = await markItemAsSyncing(REPLACEMENT_EVENT_QUEUE_KEY, item.id, profileId);
          if (syncingItem) syncingItems.push(syncingItem);
        }
        if (syncingItems.length === 0) continue;

        // 批量發送
        await sendReplacementEventsToAPI(syncingItems, profileId);

        // 移動到歷史記錄
        for (const item of syncingItems) {
          await moveToHistory(REPLACEMENT_EVENT_QUEUE_KEY, item.id, REPLACEMENT_EVENT_HISTORY_KEY, profileId);
        }

        console.log(`[Sync] Replacement event batch of ${batch.length} synced successfully`);

      } catch (error) {
        console.error('[Sync] Error syncing replacement event batch:', error);

        if (isDuplicateSubmissionError(error)) {
          for (const item of syncingItems) {
            await moveToHistory(REPLACEMENT_EVENT_QUEUE_KEY, item.id, REPLACEMENT_EVENT_HISTORY_KEY, profileId);
          }
          continue;
        }

        // 處理批次中的每個項目
        for (const item of syncingItems) {
          if (apiModule.isPermanentError(error)) {
            await updateItemStatus(REPLACEMENT_EVENT_QUEUE_KEY, item.id, profileId, 'failed', error.message);
            console.error(`[Sync] Replacement event ${item.id} failed permanently: ${error.message}`);
            continue;
          }

          const retryCount = item.retryCount || 0;
          if (retryCount < MAX_RETRIES) {
            await updateItemStatus(REPLACEMENT_EVENT_QUEUE_KEY, item.id, profileId, 'pending', null);
            await updateQueueItemRetryCount(REPLACEMENT_EVENT_QUEUE_KEY, item.id, profileId, retryCount + 1);
            console.warn(`[Sync] Replacement event ${item.id} retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
          } else {
            await updateItemStatus(REPLACEMENT_EVENT_QUEUE_KEY, item.id, profileId, 'failed', error.message);
            console.error(`[Sync] Replacement event ${item.id} failed after ${MAX_RETRIES} retries: ${error.message}`);
          }
        }
      }
    }
  } catch (error) {
    console.error('[Sync] Error during replacement event sync:', error);
  } finally {
    isSyncingReplacementEvents = false;
  }
}

/**
 * 重試所有失敗的替換事件
 */
async function retryFailedReplacementEvents(profileId) {
  const pinnedProfileId = await resolveSyncProfileId(profileId);
  await recoverStaleSyncingItems(REPLACEMENT_EVENT_QUEUE_KEY, pinnedProfileId);
  const result = await chrome.storage.local.get(REPLACEMENT_EVENT_QUEUE_KEY);
  const queue = result[REPLACEMENT_EVENT_QUEUE_KEY] || [];
  const failedItems = queue.filter(item => item.status === 'failed' && item.backendProfileId === pinnedProfileId);

  for (const item of failedItems) {
    await updateItemStatus(REPLACEMENT_EVENT_QUEUE_KEY, item.id, pinnedProfileId, 'pending', null);
    await updateQueueItemRetryCount(REPLACEMENT_EVENT_QUEUE_KEY, item.id, pinnedProfileId, 0);
  }

  console.log(`[Sync] Retrying ${failedItems.length} failed replacement events`);
  await syncPendingReplacementEvents(pinnedProfileId);
}

/**
 * 發送替換事件批次到後端 API
 * @param {Array} items - 替換事件項目陣列
 */
async function sendReplacementEventsToAPI(items, profileId) {
  console.log('[Sync] Sending replacement events to API:', items.length);

  try {
    if (items.some(item => item.backendProfileId !== profileId)) {
      throw new Error('Replacement event batch contains multiple profiles');
    }
    // 轉換格式以符合後端 API 要求
    const events = items.map(item => ({
      translationID: item.translationID,
      contributorUserID: item.contributorUserID,
      beneficiaryUserID: item.beneficiaryUserID,
      occurredAt: item.occurredAt
    }));

    // 調用 API 模組的 submitReplacementEvents 函數
    const result = await apiModule.submitReplacementEvents(events, true, profileId);

    console.log('[Sync] Replacement events submitted successfully:', result);
    return { success: true };
  } catch (error) {
    console.error('[Sync] Error submitting replacement events:', error);
    throw error;
  }
}

/**
 * 觸發替換事件同步
 */
export async function triggerReplacementEventSync(profileId) {
  if (!isSyncingReplacementEvents) {
    const pinnedProfileId = await resolveSyncProfileId(profileId);
    console.log('[Sync] Triggering replacement event sync');
    await syncPendingReplacementEvents(pinnedProfileId);
  } else {
    console.log('[Sync] Replacement event sync already in progress');
  }
}

// ==================== 初始化 ====================

/**
 * Service Worker 啟動時初始化同步
 */
export async function initializeSync() {
  console.log('[Sync] Initializing sync service...');

  try {
    const profileId = await resolveSyncProfileId();
    await Promise.all([
      recoverStaleSyncingItems(VOTE_QUEUE_KEY, profileId),
      recoverStaleSyncingItems(TRANSLATION_QUEUE_KEY, profileId),
      recoverStaleSyncingItems(REPLACEMENT_EVENT_QUEUE_KEY, profileId)
    ]);

    const status = await getSyncStatus(profileId);
    console.log('[Sync] Current status:', status);

    // 使用 retryFailed* 系列函式：內部會將 failed 重設為 pending 後再呼叫
    // syncPending*，可同時處理 pending 與 failed 項目，避免 SW 啟動後失敗
    // 項目永遠卡住的問題
    if (status.pendingVotes > 0 || status.failedVotes > 0) {
      await retryFailedVotes(profileId);
    }

    if (status.pendingTranslations > 0 || status.failedTranslations > 0) {
      await retryFailedTranslations(profileId);
    }

    if (status.pendingReplacementEvents > 0 || status.failedReplacementEvents > 0) {
      await retryFailedReplacementEvents(profileId);
    }

    console.log('[Sync] Initialization complete');
  } catch (error) {
    console.error('[Sync] Initialization failed:', error);
  }
}

// ==================== 定期同步（Alarms）====================

// 創建三個獨立的 alarm（均為 5 分鐘）
chrome.alarms.create('syncVotesAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncTranslationsAlarm', { periodInMinutes: 5 });
chrome.alarms.create('syncReplacementEventsAlarm', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const alarmSyncs = {
    syncVotesAlarm: ['[Sync] Periodic vote sync triggered by alarm', triggerVoteSync],
    syncTranslationsAlarm: ['[Sync] Periodic translation sync triggered by alarm', triggerTranslationSync],
    syncReplacementEventsAlarm: ['[Sync] Periodic replacement events sync triggered by alarm', triggerReplacementEventSync]
  };
  const alarmSync = alarmSyncs[alarm.name];
  if (!alarmSync) return;

  try {
    console.log(alarmSync[0]);
    await alarmSync[1]();
  } catch (error) {
    console.error('[Sync] Alarm sync skipped because profile migration failed:', error);
  }
});
