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

// ==================== 配置常數 ====================

const DEBOUNCE_DELAY = 500; // 防抖延遲時間（毫秒）
const DEBUG_MODE = false; // 調試模式

// ==================== 狀態管理 ====================

let voteTimer = null;
let translationTimer = null;

// ==================== 防抖函數 ====================

/**
 * 防抖執行同步觸發函數
 * 避免短時間內多次操作觸發多次同步
 *
 * @param {Function} triggerFn - 同步觸發函數
 * @param {string} timerType - 計時器類型 ('vote' 或 'translation')
 */
function debouncedTriggerSync(triggerFn, timerType) {
  const timer = timerType === 'vote' ? voteTimer : translationTimer;

  if (timer) {
    clearTimeout(timer);
  }

  const newTimer = setTimeout(() => {
    triggerFn();
    if (timerType === 'vote') {
      voteTimer = null;
    } else {
      translationTimer = null;
    }
  }, DEBOUNCE_DELAY);

  if (timerType === 'vote') {
    voteTimer = newTimer;
  } else {
    translationTimer = newTimer;
  }

  log(`已設置 ${timerType} 同步防抖計時器（${DEBOUNCE_DELAY}ms）`);
}

// ==================== 同步觸發函數 ====================

/**
 * 觸發投票同步
 * 檢查待同步的投票項目並發送同步消息
 */
async function triggerVoteSync() {
  try {
    const { voteQueue = [] } = await chrome.storage.local.get('voteQueue');
    const pendingItems = voteQueue.filter(item => item.status === 'pending');

    if (pendingItems.length > 0) {
      log(`發現 ${pendingItems.length} 個待同步的投票，觸發同步`);

      // 觸發投票同步 (由 sync.js 處理)
      // 使用內部消息，不需要等待回應
      chrome.runtime.sendMessage({
        type: 'SYNC_VOTES',
        payload: { count: pendingItems.length }
      }).catch(error => {
        // Service Worker 可能尚未啟動，這是正常的
        warn('發送 SYNC_VOTES 消息失敗（可能 Service Worker 尚未啟動）:', error.message);
      });
    } else {
      log('投票隊列中沒有待同步項目');
    }
  } catch (error) {
    logError('觸發投票同步時發生錯誤:', error);
  }
}

/**
 * 觸發翻譯同步
 * 檢查待同步的翻譯項目並發送同步消息
 */
async function triggerTranslationSync() {
  try {
    const { translationQueue = [] } = await chrome.storage.local.get('translationQueue');
    const pendingItems = translationQueue.filter(item => item.status === 'pending');

    if (pendingItems.length > 0) {
      log(`發現 ${pendingItems.length} 個待同步的翻譯，觸發同步`);

      // 觸發翻譯同步 (由 sync.js 處理)
      chrome.runtime.sendMessage({
        type: 'SYNC_TRANSLATIONS',
        payload: { count: pendingItems.length }
      }).catch(error => {
        warn('發送 SYNC_TRANSLATIONS 消息失敗（可能 Service Worker 尚未啟動）:', error.message);
      });
    } else {
      log('翻譯隊列中沒有待同步項目');
    }
  } catch (error) {
    logError('觸發翻譯同步時發生錯誤:', error);
  }
}

// ==================== Storage 變化監聽 ====================

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
    const oldLength = changes.voteQueue.oldValue?.length || 0;
    const newLength = changes.voteQueue.newValue?.length || 0;

    if (newLength > oldLength) {
      log(`voteQueue 長度變化: ${oldLength} → ${newLength}，觸發同步`);
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
});

// ==================== 初始化同步 ====================

/**
 * Service Worker 啟動時檢查並同步待處理項目
 * 確保瀏覽器重啟後待處理項目不會丟失
 */
async function initializeSync() {
  log('初始化同步監聽器，檢查待處理項目...');

  try {
    // 檢查投票隊列
    await triggerVoteSync();

    // 檢查翻譯隊列
    await triggerTranslationSync();

    log('同步監聽器初始化完成');
  } catch (error) {
    logError('初始化同步監聽器時發生錯誤:', error);
  }
}

// Service Worker 啟動時執行初始化
initializeSync();

// 監聽 Service Worker 啟動事件
chrome.runtime.onStartup.addListener(() => {
  log('Service Worker 啟動，重新初始化同步監聽器');
  initializeSync();
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

export { triggerVoteSync, triggerTranslationSync, initializeSync };
