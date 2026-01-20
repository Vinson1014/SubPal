/**
 * SubmissionQueueManager - 提交隊列管理器
 *
 * 職責：
 * - 管理投票和翻譯提交的隊列
 * - 提供隊列操作 API（enqueue、history、status、retry）
 * - 處理來自 page context 的消息請求
 * - 狀態追蹤（pending、syncing、completed、failed）
 *
 * 架構模式：
 * - 運行在 content script context
 * - 直接訪問 chrome.storage.local（通過 StorageAdapter）
 * - 接收來自 vote-bridge 和 translation-bridge 的消息
 *
 * @module submission-queue-manager
 */

import { StorageAdapter, generateUUID } from '../system/config/storage-adapter.js';

/**
 * SubmissionQueueManager 類
 * 管理所有提交數據的隊列操作和狀態追蹤
 */
export class SubmissionQueueManager {
  constructor(options = {}) {
    // Storage 適配器
    this.storage = options.storage || new StorageAdapter(options);

    // 初始化標記
    this.isInitialized = false;

    // 調試模式
    this.debug = options.debug || false;
  }

  /**
   * 初始化 SubmissionQueueManager
   * 必須先調用此方法才能使用其他功能
   */
  async initialize() {
    if (this.isInitialized) {
      this.log('SubmissionQueueManager 已經初始化');
      return;
    }

    this.log('開始初始化 SubmissionQueueManager...');

    try {
      // 初始化 StorageAdapter
      await this.storage.initialize();

      this.isInitialized = true;
      this.log('SubmissionQueueManager 初始化成功');
    } catch (error) {
      this.error('SubmissionQueueManager 初始化失敗:', error);
      throw error;
    }
  }

  // ==================== 投票操作 ====================

  /**
   * 將投票加入隊列
   *
   * @param {Object} data - 投票數據
   * @param {string} data.videoId - 影片 ID
   * @param {number} data.timestamp - 字幕時間戳
   * @param {string} data.voteType - 投票類型 ('upvote' 或 'downvote')
   * @param {string} [data.translationID] - 翻譯 ID（可選）
   * @param {string} [data.originalSubtitle] - 原始字幕（可選）
   * @returns {Promise<{itemId: string, message: string}>}
   */
  async enqueueVote(data) {
    this.log('enqueueVote 被調用:', data);

    // 驗證必要參數
    if (!data.videoId || !data.timestamp || !data.voteType) {
      throw new Error('缺少必要參數: videoId, timestamp, voteType');
    }

    if (!['upvote', 'downvote'].includes(data.voteType)) {
      throw new Error('voteType 必須是 "upvote" 或 "downvote"');
    }

    // 建立隊列項目
    const item = {
      id: generateUUID(),
      videoId: data.videoId,
      timestamp: data.timestamp,
      voteType: data.voteType,
      translationID: data.translationID || null,
      originalSubtitle: data.originalSubtitle || null,
      status: 'pending',
      createdAt: Date.now(),
      syncedAt: null,
      retryCount: 0,
      error: null
    };

    // 加入隊列
    await this.storage.appendToQueue('vote', item);

    this.log('投票已加入隊列:', item.id);

    return {
      itemId: item.id,
      message: '投票已加入同步隊列'
    };
  }

  /**
   * 獲取投票歷史記錄
   *
   * @param {number} limit - 返回記錄數量上限（預設 100）
   * @returns {Promise<Array>} 投票歷史陣列
   */
  async getVoteHistory(limit = 100) {
    this.log('getVoteHistory 被調用, limit:', limit);

    const history = await this.storage.getHistory('vote', limit);

    this.log(`獲取到 ${history.length} 筆投票歷史`);

    return history;
  }

  /**
   * 獲取投票項目狀態
   *
   * @param {string} itemId - 項目 ID
   * @returns {Promise<{status: string, error?: string}>}
   */
  async getVoteStatus(itemId) {
    this.log('getVoteStatus 被調用, itemId:', itemId);

    if (!itemId) {
      throw new Error('itemId 是必要參數');
    }

    // 先在隊列中查找
    const queue = await this.storage.getQueue('vote');
    const queueItem = queue.find(item => item.id === itemId);

    if (queueItem) {
      return {
        status: queueItem.status,
        error: queueItem.error
      };
    }

    // 再在歷史中查找
    const history = await this.storage.getHistory('vote', 100);
    const historyItem = history.find(item => item.id === itemId);

    if (historyItem) {
      return {
        status: historyItem.status,
        error: null
      };
    }

    // 找不到項目
    throw new Error(`找不到投票項目: ${itemId}`);
  }

  /**
   * 重試失敗的投票
   *
   * @param {string} itemId - 項目 ID
   * @returns {Promise<boolean>} 是否成功重試
   */
  async retryVote(itemId) {
    this.log('retryVote 被調用, itemId:', itemId);

    if (!itemId) {
      throw new Error('itemId 是必要參數');
    }

    // 更新項目狀態為 pending，並重設 retryCount
    const updated = await this.storage.updateQueueItem('vote', itemId, {
      status: 'pending',
      retryCount: 0,
      error: null
    });

    if (!updated) {
      throw new Error(`找不到投票項目或無法重試: ${itemId}`);
    }

    this.log('投票項目已重設為 pending:', itemId);

    return true;
  }

  // ==================== 翻譯操作 ====================

  /**
   * 將翻譯提交加入隊列
   *
   * @param {Object} data - 翻譯數據
   * @param {string} data.videoId - 影片 ID
   * @param {number} data.timestamp - 字幕時間戳
   * @param {string} data.original - 原始字幕
   * @param {string} data.translation - 翻譯建議
   * @param {string} data.languageCode - 語言代碼
   * @param {string} data.submissionReason - 提交原因
   * @returns {Promise<{itemId: string, message: string}>}
   */
  async enqueueTranslation(data) {
    this.log('enqueueTranslation 被調用:', data);

    // 驗證必要參數
    if (!data.videoId || !data.timestamp || !data.original || !data.translation || !data.languageCode || !data.submissionReason) {
      throw new Error('缺少必要參數: videoId, timestamp, original, translation, languageCode, submissionReason');
    }

    // 建立隊列項目
    const item = {
      id: generateUUID(),
      videoId: data.videoId,
      timestamp: data.timestamp,
      original: data.original,
      translation: data.translation,
      languageCode: data.languageCode,
      submissionReason: data.submissionReason,
      status: 'pending',
      createdAt: Date.now(),
      syncedAt: null,
      retryCount: 0,
      error: null
    };

    // 加入隊列
    await this.storage.appendToQueue('translation', item);

    this.log('翻譯已加入隊列:', item.id);

    return {
      itemId: item.id,
      message: '翻譯已加入同步隊列'
    };
  }

  /**
   * 獲取翻譯歷史記錄
   *
   * @param {number} limit - 返回記錄數量上限（預設 100）
   * @returns {Promise<Array>} 翻譯歷史陣列
   */
  async getTranslationHistory(limit = 100) {
    this.log('getTranslationHistory 被調用, limit:', limit);

    const history = await this.storage.getHistory('translation', limit);

    this.log(`獲取到 ${history.length} 筆翻譯歷史`);

    return history;
  }

  /**
   * 重試失敗的翻譯
   *
   * @param {string} itemId - 項目 ID
   * @returns {Promise<boolean>} 是否成功重試
   */
  async retryTranslation(itemId) {
    this.log('retryTranslation 被調用, itemId:', itemId);

    if (!itemId) {
      throw new Error('itemId 是必要參數');
    }

    // 更新項目狀態為 pending，並重設 retryCount
    const updated = await this.storage.updateQueueItem('translation', itemId, {
      status: 'pending',
      retryCount: 0,
      error: null
    });

    if (!updated) {
      throw new Error(`找不到翻譯項目或無法重試: ${itemId}`);
    }

    this.log('翻譯項目已重設為 pending:', itemId);

    return true;
  }

  // ==================== 通用操作 ====================

  /**
   * 獲取所有待同步的項目
   *
   * @returns {Promise<{votes: Array, translations: Array}>}
   */
  async getAllPending() {
    this.log('getAllPending 被調用');

    const [voteQueue, translationQueue] = await Promise.all([
      this.storage.getQueue('vote'),
      this.storage.getQueue('translation')
    ]);

    const pendingVotes = voteQueue.filter(item => item.status === 'pending');
    const pendingTranslations = translationQueue.filter(item => item.status === 'pending');

    this.log(`待同步項目: ${pendingVotes.length} 筆投票, ${pendingTranslations.length} 筆翻譯`);

    return {
      votes: pendingVotes,
      translations: pendingTranslations
    };
  }

  /**
   * 獲取隊列統計資訊
   *
   * @returns {Promise<{votes: Object, translations: Object}>}
   */
  async getStats() {
    this.log('getStats 被調用');

    const [voteQueue, translationQueue] = await Promise.all([
      this.storage.getQueue('vote'),
      this.storage.getQueue('translation')
    ]);

    const voteStats = this._calculateStats(voteQueue);
    const translationStats = this._calculateStats(translationQueue);

    this.log('統計資訊:', { votes: voteStats, translations: translationStats });

    return {
      votes: voteStats,
      translations: translationStats
    };
  }

  // ==================== 內部方法 ====================

  /**
   * 計算隊列統計資訊
   *
   * @private
   * @param {Array} queue - 隊列陣列
   * @returns {Object} 統計資訊
   */
  _calculateStats(queue) {
    const stats = {
      total: queue.length,
      pending: 0,
      syncing: 0,
      completed: 0,
      failed: 0
    };

    for (const item of queue) {
      if (item.status in stats) {
        stats[item.status]++;
      }
    }

    return stats;
  }

  // ==================== 日誌方法 ====================

  /**
   * 輸出日誌
   * @private
   */
  log(...args) {
    if (this.debug) {
      console.log('[SubmissionQueueManager]', ...args);
    }
  }

  /**
   * 輸出錯誤
   * @private
   */
  error(...args) {
    console.error('[SubmissionQueueManager]', ...args);
  }
}

/**
 * 消息處理器
 * 處理來自 page context (vote-bridge, translation-bridge) 的消息
 *
 * @param {Object} request - 消息請求對象
 * @param {string} request.type - 消息類型
 * @param {Object} request.payload - 消息負載
 * @param {Function} sendResponse - 回應函數
 * @returns {boolean} 是否非同步回應
 */
export function handleQueueMessage(request, sendResponse) {
  const { type, payload } = request;

  // 確保 manager 已初始化
  if (!submissionQueueManager.isInitialized) {
    sendResponse({
      error: 'SubmissionQueueManager 尚未初始化'
    });
    return true;
  }

  try {
    switch (type) {
      // 投票消息
      case 'VOTE_ENQUEUE':
        submissionQueueManager.enqueueVote(payload)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ error: error.message }));
        break;

      case 'VOTE_GET_HISTORY':
        submissionQueueManager.getVoteHistory(payload?.limit)
          .then(result => sendResponse({ history: result }))
          .catch(error => sendResponse({ error: error.message }));
        break;

      case 'VOTE_GET_STATUS':
        submissionQueueManager.getVoteStatus(payload.itemId)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ error: error.message }));
        break;

      case 'VOTE_RETRY':
        submissionQueueManager.retryVote(payload.itemId)
          .then(result => sendResponse({ success: result }))
          .catch(error => sendResponse({ error: error.message }));
        break;

      // 翻譯消息
      case 'TRANSLATION_ENQUEUE':
        submissionQueueManager.enqueueTranslation(payload)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ error: error.message }));
        break;

      case 'TRANSLATION_GET_HISTORY':
        submissionQueueManager.getTranslationHistory(payload?.limit)
          .then(result => sendResponse({ history: result }))
          .catch(error => sendResponse({ error: error.message }));
        break;

      case 'TRANSLATION_RETRY':
        submissionQueueManager.retryTranslation(payload.itemId)
          .then(result => sendResponse({ success: result }))
          .catch(error => sendResponse({ error: error.message }));
        break;

      // 通用消息
      case 'GET_ALL_PENDING':
        submissionQueueManager.getAllPending()
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ error: error.message }));
        break;

      case 'GET_QUEUE_STATS':
        submissionQueueManager.getStats()
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ error: error.message }));
        break;

      default:
        sendResponse({ error: `未知的消息類型: ${type}` });
        return true;
    }
  } catch (error) {
    console.error('[handleQueueMessage] 處理消息時發生錯誤:', error);
    sendResponse({ error: error.message });
  }

  // 返回 true 表示會非同步回應
  return true;
}

// ==================== 單例實例 ====================

/**
 * 導出預設的 SubmissionQueueManager 實例（單例模式）
 */
export const submissionQueueManager = new SubmissionQueueManager({
  debug: false
});
