/**
 * sync-listener.js - Chrome Storage 同步監聽器
 *
 * 監聽 Chrome Storage 變化，當有新的待同步項目時自動觸發同步程序
 * 職責：
 * - 監聽 voteQueue 和 translationQueue 的變化
 * - 偵測新項目加入（隊列長度增加）
 * - 使用防抖機制避免短時間內多次觸發
 * - Service Worker 啟動時檢查並同步待處理項目
 *
 * @module sync-listener
 */

import * as syncModule from './sync.js';
import { resolveBackendProfile } from './backend-profiles.js';
import { ensureStorageMigrationsComplete } from './storage-migrations.js';

// ==================== 配置常數 ====================

const DEBOUNCE_DELAY = 500; // 防抖延遲時間（毫秒）
const DEBUG_MODE = false; // 調試模式

// ==================== 狀態管理 ====================

let voteTimer = null;
let translationTimer = null;
let replacementEventTimer = null;

// ==================== 防抖函數 ====================

/**
 * 防抖執行同步觸發函數
 * 避免短時間內多次操作觸發多次同步
 *
 * @param {Function} triggerFn - 同步觸發函數
 * @param {string} timerType - 計時器類型 ('vote'、'translation' 或 'replacementEvent')
 */
function debouncedTriggerSync(triggerFn, timerType) {
  let timer;
  if (timerType === 'vote') {
    timer = voteTimer;
  } else if (timerType === 'translation') {
    timer = translationTimer;
  } else {
    timer = replacementEventTimer;
  }

  if (timer) {
    clearTimeout(timer);
  }

  const newTimer = setTimeout(() => {
    triggerFn();
    if (timerType === 'vote') {
      voteTimer = null;
    } else if (timerType === 'translation') {
      translationTimer = null;
    } else {
      replacementEventTimer = null;
    }
  }, DEBOUNCE_DELAY);

  if (timerType === 'vote') {
    voteTimer = newTimer;
  } else if (timerType === 'translation') {
    translationTimer = newTimer;
  } else {
    replacementEventTimer = newTimer;
  }

  log(`已設置 ${timerType} 同步防抖計時器（${DEBOUNCE_DELAY}ms）`);
}

// ==================== 同步觸發函數 ====================

/**
 * 觸發投票同步
 * 檢查待同步的投票項目並直接調用同步函數
 */
async function triggerVoteSync() {
  try {
    await ensureStorageMigrationsComplete();
    const activeProfile = await resolveBackendProfile();
    const { voteQueue = [] } = await chrome.storage.local.get('voteQueue');
    const pendingItems = voteQueue.filter(item => item.status === 'pending' && item.backendProfileId === activeProfile.id);

    if (pendingItems.length > 0) {
      log(`發現 ${pendingItems.length} 個待同步的投票，觸發同步`);

      // 直接調用 sync 模組的同步函數（避免消息傳遞問題）
      await syncModule.triggerVoteSync(activeProfile.id);
    } else {
      log('投票隊列中沒有待同步項目');
    }
  } catch (error) {
    logError('觸發投票同步時發生錯誤:', error);
  }
}

/**
 * 觸發翻譯同步
 * 檢查待同步的翻譯項目並直接調用同步函數
 */
async function triggerTranslationSync() {
  try {
    await ensureStorageMigrationsComplete();
    const activeProfile = await resolveBackendProfile();
    const { translationQueue = [] } = await chrome.storage.local.get('translationQueue');
    const pendingItems = translationQueue.filter(item => item.status === 'pending' && item.backendProfileId === activeProfile.id);

    if (pendingItems.length > 0) {
      log(`發現 ${pendingItems.length} 個待同步的翻譯，觸發同步`);

      // 直接調用 sync 模組的同步函數（避免消息傳遞問題）
      await syncModule.triggerTranslationSync(activeProfile.id);
    } else {
      log('翻譯隊列中沒有待同步項目');
    }
  } catch (error) {
    logError('觸發翻譯同步時發生錯誤:', error);
  }
}

/**
 * 觸發替換事件同步
 * 檢查待同步的替換事件項目並直接調用同步函數
 */
async function triggerReplacementEventSync() {
  try {
    await ensureStorageMigrationsComplete();
    const activeProfile = await resolveBackendProfile();
    const { replacementEventQueue = [] } = await chrome.storage.local.get('replacementEventQueue');
    const pendingItems = replacementEventQueue.filter(item => item.status === 'pending' && item.backendProfileId === activeProfile.id);

    if (pendingItems.length > 0) {
      log(`發現 ${pendingItems.length} 個待同步的替換事件，觸發同步`);

      // 直接調用 sync 模組的同步函數（避免消息傳遞問題）
      await syncModule.triggerReplacementEventSync(activeProfile.id);
    } else {
      log('替換事件隊列中沒有待同步項目');
    }
  } catch (error) {
    logError('觸發替換事件同步時發生錯誤:', error);
  }
}

// ==================== Storage 變化監聽 ====================

function hasQueueContentChanged(oldQueue, newQueue) {
  if (!Array.isArray(oldQueue) || !Array.isArray(newQueue)) {
    return true;
  }
  if (oldQueue.length !== newQueue.length) {
    return true;
  }
  for (const newItem of newQueue) {
    const oldItem = oldQueue.find(item => item.id === newItem.id);
    if (!oldItem || newItem.updatedAt !== oldItem.updatedAt) {
      return true;
    }
  }
  return false;
}

/**
 * 監聽 Chrome Storage 變化
 * 當有新項目加入隊列時觸發同步
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }

  // 投票隊列變化
  if (changes.voteQueue) {
    const oldQueue = changes.voteQueue.oldValue || [];
    const newQueue = changes.voteQueue.newValue || [];

    if (hasQueueContentChanged(oldQueue, newQueue)) {
      log(`voteQueue 內容變化，觸發同步`);
      debouncedTriggerSync(triggerVoteSync, 'vote');
    }
  }

  // 翻譯隊列變化
  if (changes.translationQueue) {
    const oldLength = changes.translationQueue.oldValue?.length || 0;
    const newLength = changes.translationQueue.newValue?.length || 0;

    if (newLength > oldLength) {
      log(`translationQueue 長度變化: ${oldLength} → ${newLength}，觸發同步`);
      debouncedTriggerSync(triggerTranslationSync, 'translation');
    }
  }

  // 替換事件隊列變化
  if (changes.replacementEventQueue) {
    const oldLength = changes.replacementEventQueue.oldValue?.length || 0;
    const newLength = changes.replacementEventQueue.newValue?.length || 0;

    if (newLength > oldLength) {
      log(`replacementEventQueue 長度變化: ${oldLength} → ${newLength}，觸發同步`);
      debouncedTriggerSync(triggerReplacementEventSync, 'replacementEvent');
    }
  }
});

// ==================== 日誌工具函數 ====================

/**
 * 輸出日誌
 * @private
 */
function log(...args) {
  if (DEBUG_MODE) {
    console.log('[SyncListener]', ...args);
  }
}

/**
 * 輸出警告
 * @private
 */
function warn(...args) {
  if (DEBUG_MODE) {
    console.warn('[SyncListener]', ...args);
  }
}

/**
 * 輸出錯誤
 * @private
 */
function logError(...args) {
  console.error('[SyncListener]', ...args);
}

// ==================== 導出 ====================

export { triggerVoteSync, triggerTranslationSync, triggerReplacementEventSync };
