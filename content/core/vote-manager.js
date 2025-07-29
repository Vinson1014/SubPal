/**
 * 投票管理器 - 專責字幕投票管理的核心模組
 * 
 * 設計理念：
 * 1. 支援兩種字幕模式的統一投票接口
 * 2. 批量投票和離線隊列支援
 * 3. 完整的重試、狀態管理機制
 * 4. 與 interaction-panel 的緊密整合
 * 5. 用戶友善的反饋和進度提示
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class VoteManager {
  constructor() {
    this.isInitialized = false;
    this.isProcessing = false;
    this.voteQueue = []; // 離線投票隊列
    this.recentVotes = new Map(); // 防重複投票緩存
    this.voteHistory = new Map(); // 投票歷史記錄
    
    // 配置參數
    this.MAX_RETRY_ATTEMPTS = 3;
    this.RETRY_DELAY = 1000; // 1秒
    this.DUPLICATE_DETECTION_WINDOW = 3 * 60 * 1000; // 3分鐘
    this.MAX_QUEUE_SIZE = 50;
    this.BATCH_SIZE = 5; // 批量處理數量
    
    // 統計數據
    this.stats = {
      totalVotes: 0,
      upvotes: 0,
      downvotes: 0,
      successfulVotes: 0,
      failedVotes: 0,
      duplicateBlocked: 0,
      queuedVotes: 0,
      lastVoteTime: null
    };
    
    // 調試模式
    this.debug = false;
    
    // 回調函數
    this.callbacks = {
      onVoteStart: null,
      onVoteSuccess: null,
      onVoteError: null,
      onVoteStateChange: null,
      onQueueChange: null
    };
  }

  async initialize() {
    this.log('投票管理器初始化中...');
    
    try {
      // 載入設置
      await this.loadSettings();
      
      // 設置事件處理器
      this.setupEventHandlers();
      
      // 處理離線隊列
      await this.processOfflineQueue();
      
      this.isInitialized = true;
      this.log('投票管理器初始化完成');
      
    } catch (error) {
      console.error('投票管理器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 主要的投票方法 - 向後兼容舊版 API
   * @param {Object} params 投票參數
   * @returns {Promise<Object>} 投票結果
   */
  async handleVote(params) {
    return this.vote(params);
  }

  /**
   * 新版投票方法
   * @param {Object} params 投票參數
   * @param {string} [params.translationID] 翻譯 ID
   * @param {string} params.videoID 視頻 ID
   * @param {string} [params.originalSubtitle] 原始字幕
   * @param {number} params.timestamp 時間戳
   * @param {'upvote'|'downvote'} params.voteType 投票類型
   * @param {Object} subtitleData 字幕數據（用於更好的驗證和狀態管理）
   * @param {Object} options 額外選項
   * @returns {Promise<Object>} 投票結果
   */
  async vote(params, subtitleData = null, options = {}) {
    if (!this.isInitialized) {
      throw new Error('投票管理器未初始化');
    }
    
    this.stats.totalVotes++;
    if (params.voteType === 'upvote') {
      this.stats.upvotes++;
    } else {
      this.stats.downvotes++;
    }
    
    try {
      // 1. 驗證參數
      const validatedParams = this.validateVoteParams(params);
      
      // 2. 防重複檢查
      if (this.isDuplicateVote(validatedParams)) {
        this.stats.duplicateBlocked++;
        throw new Error('重複投票，請稍後再試');
      }
      
      // 3. 檢查是否需要排隊
      if (options.allowQueue !== false && this.shouldQueueVote()) {
        return this.queueVote(validatedParams, subtitleData, options);
      }
      
      // 4. 立即處理投票
      return await this.processVote(validatedParams, subtitleData, options);
      
    } catch (error) {
      this.stats.failedVotes++;
      this.log('投票失敗:', error.message);
      
      if (this.callbacks.onVoteError) {
        this.callbacks.onVoteError(error, params, subtitleData);
      }
      
      throw error;
    }
  }

  /**
   * 驗證投票參數
   * @param {Object} params 原始參數
   * @returns {Object} 驗證後的參數
   */
  validateVoteParams(params) {
    const {
      translationID,
      videoID,
      originalSubtitle,
      timestamp,
      voteType
    } = params;

    // 基本參數檢查
    if (!videoID || typeof videoID !== 'string') {
      throw new Error('videoID 是必需的字符串參數');
    }
    
    if (!timestamp || typeof timestamp !== 'number' || timestamp < 0) {
      throw new Error('timestamp 必須是有效的正數');
    }
    
    if (!voteType || !['upvote', 'downvote'].includes(voteType)) {
      throw new Error('voteType 必須是 "upvote" 或 "downvote"');
    }
    
    // 選擇性參數檢查
    if (translationID && typeof translationID !== 'string') {
      throw new Error('translationID 必須是字符串');
    }
    
    if (originalSubtitle && (typeof originalSubtitle !== 'string' || originalSubtitle.trim().length === 0)) {
      throw new Error('originalSubtitle 必須是非空字符串');
    }

    return {
      translationID: translationID || null,
      videoID: videoID.trim(),
      originalSubtitle: originalSubtitle ? originalSubtitle.trim() : null,
      timestamp,
      voteType,
      voteTime: Date.now()
    };
  }

  /**
   * 檢查是否為重複投票
   * @param {Object} params 投票參數
   * @returns {boolean} 是否重複
   */
  isDuplicateVote(params) {
    const key = this.generateVoteKey(params);
    const now = Date.now();
    
    if (this.recentVotes.has(key)) {
      const voteTime = this.recentVotes.get(key);
      if (now - voteTime < this.DUPLICATE_DETECTION_WINDOW) {
        return true;
      } else {
        // 過期的緩存，清理
        this.recentVotes.delete(key);
      }
    }
    
    // 記錄這次投票
    this.recentVotes.set(key, now);
    return false;
  }

  /**
   * 生成投票唯一鍵
   */
  generateVoteKey(params) {
    const {
      translationID = '',
      videoID,
      timestamp,
      voteType
    } = params;
    
    return `${videoID}_${timestamp}_${translationID}_${voteType}`;
  }

  /**
   * 檢查是否需要排隊
   */
  shouldQueueVote() {
    return this.isProcessing || navigator.onLine === false;
  }

  /**
   * 將投票加入隊列
   * @param {Object} params 投票參數
   * @param {Object} subtitleData 字幕數據
   * @param {Object} options 選項
   * @returns {Promise<Object>} 排隊結果
   */
  async queueVote(params, subtitleData, options) {
    if (this.voteQueue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error('投票隊列已滿，請稍後再試');
    }
    
    const queueItem = {
      ...params,
      subtitleData,
      options,
      queueTime: Date.now(),
      retryCount: 0
    };
    
    this.voteQueue.push(queueItem);
    this.stats.queuedVotes++;
    
    this.log(`投票已加入隊列，當前隊列長度: ${this.voteQueue.length}`);
    
    if (this.callbacks.onQueueChange) {
      this.callbacks.onQueueChange(this.voteQueue.length);
    }
    
    return {
      success: true,
      queued: true,
      queuePosition: this.voteQueue.length,
      message: '投票已加入隊列，將在網路恢復後自動處理'
    };
  }

  /**
   * 處理實際投票
   * @param {Object} params 投票參數
   * @param {Object} subtitleData 字幕數據
   * @param {Object} options 選項
   * @returns {Promise<Object>} 投票結果
   */
  async processVote(params, subtitleData, options = {}) {
    this.isProcessing = true;
    
    if (this.callbacks.onVoteStart) {
      this.callbacks.onVoteStart(params, subtitleData);
    }
    
    try {
      const result = await this.sendVoteWithRetry(params, options);
      
      this.stats.successfulVotes++;
      this.stats.lastVoteTime = Date.now();
      
      // 更新投票歷史
      this.updateVoteHistory(params, result);
      
      this.log('投票成功:', result);
      
      if (this.callbacks.onVoteSuccess) {
        this.callbacks.onVoteSuccess(result, params, subtitleData);
      }
      
      // 觸發狀態變更回調
      if (this.callbacks.onVoteStateChange) {
        this.callbacks.onVoteStateChange(params.voteType, result, subtitleData);
      }
      
      return result;
      
    } finally {
      this.isProcessing = false;
      
      // 處理隊列中的下一個投票
      setTimeout(() => {
        this.processNextInQueue();
      }, 100);
    }
  }

  /**
   * 帶重試的投票發送
   * @param {Object} params 投票參數
   * @param {Object} options 選項
   * @returns {Promise<Object>} 投票結果
   */
  async sendVoteWithRetry(params, options) {
    let lastError;
    const maxRetries = options.maxRetries || this.MAX_RETRY_ATTEMPTS;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.log(`投票嘗試 ${attempt}/${maxRetries}`);
        
        const result = await sendMessage({
          type: 'PROCESS_VOTE',
          payload: params
        });
        
        // 檢查結果
        if (result && result.success) {
          return result;
        } else {
          throw new Error(result?.error || '投票失敗，未知錯誤');
        }
        
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          const delay = this.RETRY_DELAY * attempt;
          this.log(`投票失敗，${delay}ms 後重試:`, error.message);
          await this.delay(delay);
        } else {
          this.log(`所有重試都失敗了`, error.message);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * 更新投票歷史
   * @param {Object} params 投票參數
   * @param {Object} result 投票結果
   */
  updateVoteHistory(params, result) {
    const historyKey = `${params.videoID}_${params.timestamp}`;
    const historyItem = {
      ...params,
      result,
      voteTime: Date.now()
    };
    
    this.voteHistory.set(historyKey, historyItem);
    
    // 限制歷史記錄大小（保留最近 100 條）
    if (this.voteHistory.size > 100) {
      const entries = Array.from(this.voteHistory.entries());
      entries.sort((a, b) => (a[1].voteTime || 0) - (b[1].voteTime || 0));
      
      const toRemove = entries.length - 100;
      for (let i = 0; i < toRemove; i++) {
        this.voteHistory.delete(entries[i][0]);
      }
    }
  }

  /**
   * 獲取字幕的投票歷史
   * @param {string} videoID 視頻 ID
   * @param {number} timestamp 時間戳
   * @returns {Object|null} 投票歷史
   */
  getVoteHistory(videoID, timestamp) {
    const historyKey = `${videoID}_${timestamp}`;
    return this.voteHistory.get(historyKey) || null;
  }

  /**
   * 檢查用戶是否已經投過票
   * @param {string} videoID 視頻 ID
   * @param {number} timestamp 時間戳
   * @returns {Object|null} 投票記錄
   */
  getUserVoteStatus(videoID, timestamp) {
    const history = this.getVoteHistory(videoID, timestamp);
    if (history) {
      return {
        hasVoted: true,
        voteType: history.voteType,
        voteTime: history.voteTime
      };
    }
    
    return {
      hasVoted: false,
      voteType: null,
      voteTime: null
    };
  }

  /**
   * 處理隊列中的下一個投票
   */
  async processNextInQueue() {
    if (this.isProcessing || this.voteQueue.length === 0 || navigator.onLine === false) {
      return;
    }
    
    const nextVote = this.voteQueue.shift();
    
    try {
      await this.processVote(nextVote, nextVote.subtitleData, nextVote.options);
      this.log('隊列中的投票處理成功');
    } catch (error) {
      // 重試邏輯
      nextVote.retryCount++;
      
      if (nextVote.retryCount < this.MAX_RETRY_ATTEMPTS) {
        // 重新加入隊列末尾
        this.voteQueue.push(nextVote);
        this.log(`隊列投票失敗，重試第 ${nextVote.retryCount} 次`);
      } else {
        this.log('隊列投票達到最大重試次數，丟棄:', error.message);
      }
    }
    
    if (this.callbacks.onQueueChange) {
      this.callbacks.onQueueChange(this.voteQueue.length);
    }
  }

  /**
   * 批量處理隊列
   */
  async processBatch() {
    if (this.isProcessing || this.voteQueue.length === 0 || navigator.onLine === false) {
      return;
    }
    
    const batchSize = Math.min(this.BATCH_SIZE, this.voteQueue.length);
    const batch = this.voteQueue.splice(0, batchSize);
    
    this.log(`批量處理 ${batchSize} 個投票`);
    
    for (const voteItem of batch) {
      try {
        await this.processVote(voteItem, voteItem.subtitleData, voteItem.options);
        await this.delay(100); // 略微延遲避免過於頻繁
      } catch (error) {
        // 失敗的重新加入隊列
        if (voteItem.retryCount < this.MAX_RETRY_ATTEMPTS) {
          voteItem.retryCount++;
          this.voteQueue.push(voteItem);
        }
      }
    }
    
    if (this.callbacks.onQueueChange) {
      this.callbacks.onQueueChange(this.voteQueue.length);
    }
  }

  /**
   * 處理離線隊列
   */
  async processOfflineQueue() {
    // 網路恢復時自動處理隊列
    window.addEventListener('online', () => {
      this.log('網路恢復，開始處理離線隊列');
      setTimeout(() => {
        this.processBatch();
      }, 1000);
    });
  }

  /**
   * 獲取統計數據
   */
  getStats() {
    return {
      ...this.stats,
      queueLength: this.voteQueue.length,
      historyCount: this.voteHistory.size,
      isProcessing: this.isProcessing,
      isOnline: navigator.onLine
    };
  }

  /**
   * 獲取當前狀態
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isProcessing: this.isProcessing,
      queueLength: this.voteQueue.length,
      recentVotesCount: this.recentVotes.size,
      historyCount: this.voteHistory.size,
      stats: this.getStats()
    };
  }

  /**
   * 清空隊列
   */
  clearQueue() {
    const clearedCount = this.voteQueue.length;
    this.voteQueue = [];
    
    this.log(`已清空 ${clearedCount} 個投票隊列項目`);
    
    if (this.callbacks.onQueueChange) {
      this.callbacks.onQueueChange(0);
    }
    
    return clearedCount;
  }

  /**
   * 清理歷史記錄
   */
  clearHistory() {
    const clearedCount = this.voteHistory.size;
    this.voteHistory.clear();
    this.recentVotes.clear();
    
    this.log(`已清理 ${clearedCount} 條投票歷史`);
    
    return clearedCount;
  }

  /**
   * 清理資源
   */
  cleanup() {
    this.log('清理投票管理器資源...');
    
    this.isInitialized = false;
    this.isProcessing = false;
    this.voteQueue = [];
    this.recentVotes.clear();
    this.voteHistory.clear();
    this.callbacks = {};
    
    this.log('投票管理器資源清理完成');
  }

  // 事件註冊方法
  onVoteStart(callback) {
    this.callbacks.onVoteStart = callback;
  }
  
  onVoteSuccess(callback) {
    this.callbacks.onVoteSuccess = callback;
  }
  
  onVoteError(callback) {
    this.callbacks.onVoteError = callback;
  }
  
  onVoteStateChange(callback) {
    this.callbacks.onVoteStateChange = callback;
  }
  
  onQueueChange(callback) {
    this.callbacks.onQueueChange = callback;
  }

  // 工具方法
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 載入設置
   */
  async loadSettings() {
    try {
      const result = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['debugMode']
      });
      
      if (result) {
        this.debug = result.debugMode || false;
        this.log('設置載入完成:', { debug: this.debug });
      }
    } catch (error) {
      console.error('載入設置時出錯:', error);
    }
  }

  /**
   * 設置事件處理器
   */
  setupEventHandlers() {
    // 監聽調試模式變更
    registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
      this.debug = message.debugMode;
      this.log('調試模式設置已更新:', this.debug);
    });
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[VoteManager] ${message}`, ...args);
    }
  }
}

// 創建單例實例
const voteManager = new VoteManager();

// 向後兼容的導出函數
export async function handleVote(params) {
  if (!voteManager.isInitialized) {
    await voteManager.initialize();
  }
  return voteManager.handleVote(params);
}

// 導出類和實例
export { VoteManager, voteManager };

// 新版使用建議：
// import { voteManager } from './vote-manager.js';
// await voteManager.initialize();
// const result = await voteManager.vote(params, subtitleData);

// 舊版兼容使用：
// import { handleVote } from './vote-manager.js';
// const result = await handleVote(params);
