/**
 * 翻譯管理器 - 專責翻譯提交和管理的核心模組
 * 
 * 設計理念：
 * 1. 統一的翻譯提交接口，支援兩種字幕模式
 * 2. 完整的驗證、重試、狀態管理機制
 * 3. 離線隊列和批量提交支援
 * 4. 與 UI 組件（submission-dialog、toast-manager）的緊密整合
 * 5. 用戶友善的錯誤處理和進度反饋
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class TranslationManager {
  constructor() {
    this.isInitialized = false;
    this.isProcessing = false;
    this.submitQueue = []; // 離線提交隊列
    this.recentSubmissions = new Map(); // 防重複提交緩存
    
    // 配置參數
    this.MAX_RETRY_ATTEMPTS = 3;
    this.RETRY_DELAY = 1000; // 1秒
    this.DUPLICATE_DETECTION_WINDOW = 5 * 60 * 1000; // 5分鐘
    this.MAX_QUEUE_SIZE = 100;
    
    // 統計數據
    this.stats = {
      totalSubmissions: 0,
      successfulSubmissions: 0,
      failedSubmissions: 0,
      duplicateBlocked: 0,
      queuedSubmissions: 0,
      lastSubmissionTime: null
    };
    
    // 調試模式
    this.debug = false;
    
    // 回調函數
    this.callbacks = {
      onSubmissionStart: null,
      onSubmissionSuccess: null,
      onSubmissionError: null,
      onQueueChange: null
    };
  }

  async initialize() {
    this.log('翻譯管理器初始化中...');
    
    try {
      // 載入設置
      await this.loadSettings();
      
      // 設置事件處理器
      this.setupEventHandlers();
      
      // 處理離線隊列
      await this.processOfflineQueue();
      
      this.isInitialized = true;
      this.log('翻譯管理器初始化完成');
      
    } catch (error) {
      console.error('翻譯管理器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 主要的翻譯提交方法 - 向後兼容舊版 API
   * @param {Object} params 提交參數
   * @returns {Promise<Object>} 提交結果
   */
  async handleSubmitTranslation(params) {
    return this.submitTranslation(params);
  }

  /**
   * 新版翻譯提交方法
   * @param {Object} params 提交參數
   * @param {string} params.videoId 視頻 ID
   * @param {number} params.timestamp 時間戳
   * @param {string} params.original 原始字幕
   * @param {string} params.translation 翻譯建議
   * @param {string} params.submissionReason 提交原因
   * @param {string} params.languageCode 語言代碼
   * @param {Object} options 額外選項
   * @returns {Promise<Object>} 提交結果
   */
  async submitTranslation(params, options = {}) {
    if (!this.isInitialized) {
      throw new Error('翻譯管理器未初始化');
    }
    
    this.stats.totalSubmissions++;
    
    try {
      // 1. 驗證參數
      const validatedParams = this.validateSubmissionParams(params);
      
      // 2. 防重複檢查
      if (this.isDuplicateSubmission(validatedParams)) {
        this.stats.duplicateBlocked++;
        throw new Error('重複提交，請稍後再試');
      }
      
      // 3. 檢查是否需要排隊
      if (options.allowQueue !== false && this.shouldQueueSubmission()) {
        return this.queueSubmission(validatedParams, options);
      }
      
      // 4. 立即處理提交
      return await this.processSubmission(validatedParams, options);
      
    } catch (error) {
      this.stats.failedSubmissions++;
      this.log('翻譯提交失敗:', error.message);
      
      if (this.callbacks.onSubmissionError) {
        this.callbacks.onSubmissionError(error, params);
      }
      
      throw error;
    }
  }

  /**
   * 驗證提交參數
   * @param {Object} params 原始參數
   * @returns {Object} 驗證後的參數
   */
  validateSubmissionParams(params) {
    const {
      videoId,
      timestamp,
      original,
      translation,
      submissionReason,
      languageCode
    } = params;

    // 基本參數檢查
    if (!videoId || typeof videoId !== 'string') {
      throw new Error('videoId 是必需的字符串參數');
    }
    
    if (!timestamp || typeof timestamp !== 'number' || timestamp < 0) {
      throw new Error('timestamp 必須是有效的正數');
    }
    
    if (!original || typeof original !== 'string' || original.trim().length === 0) {
      throw new Error('original 是必需的非空字符串');
    }
    
    if (!translation || typeof translation !== 'string' || translation.trim().length === 0) {
      throw new Error('translation 是必需的非空字符串');
    }
    
    if (!submissionReason || typeof submissionReason !== 'string') {
      throw new Error('submissionReason 是必需的字符串參數');
    }
    
    if (!languageCode || typeof languageCode !== 'string') {
      throw new Error('languageCode 是必需的字符串參數');
    }

    // 內容檢查
    if (original.trim() === translation.trim()) {
      throw new Error('原始字幕與翻譯建議不能相同');
    }
    
    if (translation.length > 500) {
      throw new Error('翻譯建議長度不能超過 500 字符');
    }
    
    if (original.length > 500) {
      throw new Error('原始字幕長度異常');
    }

    return {
      videoId: videoId.trim(),
      timestamp,
      original: original.trim(),
      translation: translation.trim(),
      submissionReason: submissionReason.trim(),
      languageCode: languageCode.trim(),
      submissionTime: Date.now()
    };
  }

  /**
   * 檢查是否為重複提交
   * @param {Object} params 提交參數
   * @returns {boolean} 是否重複
   */
  isDuplicateSubmission(params) {
    const key = this.generateSubmissionKey(params);
    const now = Date.now();
    
    if (this.recentSubmissions.has(key)) {
      const submissionTime = this.recentSubmissions.get(key);
      if (now - submissionTime < this.DUPLICATE_DETECTION_WINDOW) {
        return true;
      } else {
        // 過期的緩存，清理
        this.recentSubmissions.delete(key);
      }
    }
    
    // 記錄這次提交
    this.recentSubmissions.set(key, now);
    return false;
  }

  /**
   * 生成提交唯一鍵
   */
  generateSubmissionKey(params) {
    return `${params.videoId}_${params.timestamp}_${params.original}_${params.translation}`;
  }

  /**
   * 檢查是否需要排隊
   */
  shouldQueueSubmission() {
    return this.isProcessing || navigator.onLine === false;
  }

  /**
   * 將提交加入隊列
   * @param {Object} params 提交參數
   * @param {Object} options 選項
   * @returns {Promise<Object>} 排隊結果
   */
  async queueSubmission(params, options) {
    if (this.submitQueue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error('提交隊列已滿，請稍後再試');
    }
    
    const queueItem = {
      ...params,
      queueTime: Date.now(),
      options,
      retryCount: 0
    };
    
    this.submitQueue.push(queueItem);
    this.stats.queuedSubmissions++;
    
    this.log(`提交已加入隊列，當前隊列長度: ${this.submitQueue.length}`);
    
    if (this.callbacks.onQueueChange) {
      this.callbacks.onQueueChange(this.submitQueue.length);
    }
    
    return {
      success: true,
      queued: true,
      queuePosition: this.submitQueue.length,
      message: '提交已加入隊列，將在網絡恢復後自動處理'
    };
  }

  /**
   * 處理實際提交
   * @param {Object} params 提交參數
   * @param {Object} options 選項
   * @returns {Promise<Object>} 提交結果
   */
  async processSubmission(params, options = {}) {
    this.isProcessing = true;
    
    if (this.callbacks.onSubmissionStart) {
      this.callbacks.onSubmissionStart(params);
    }
    
    try {
      const result = await this.sendSubmissionWithRetry(params, options);
      
      this.stats.successfulSubmissions++;
      this.stats.lastSubmissionTime = Date.now();
      
      this.log('翻譯提交成功:', result);
      
      if (this.callbacks.onSubmissionSuccess) {
        this.callbacks.onSubmissionSuccess(result, params);
      }
      
      return result;
      
    } finally {
      this.isProcessing = false;
      
      // 處理隊列中的下一個提交
      setTimeout(() => {
        this.processNextInQueue();
      }, 100);
    }
  }

  /**
   * 帶重試的提交發送
   * @param {Object} params 提交參數
   * @param {Object} options 選項
   * @returns {Promise<Object>} 提交結果
   */
  async sendSubmissionWithRetry(params, options) {
    let lastError;
    const maxRetries = options.maxRetries || this.MAX_RETRY_ATTEMPTS;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.log(`提交嘗試 ${attempt}/${maxRetries}`);
        
        const result = await sendMessage({
          type: 'SUBMIT_TRANSLATION',
          ...params
        });
        
        // 檢查結果
        if (result && result.success) {
          return result;
        } else {
          throw new Error(result?.error || '提交失敗，未知錯誤');
        }
        
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          const delay = this.RETRY_DELAY * attempt;
          this.log(`提交失敗，${delay}ms 後重試:`, error.message);
          await this.delay(delay);
        } else {
          this.log(`所有重試都失敗了`, error.message);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * 處理隊列中的下一個提交
   */
  async processNextInQueue() {
    if (this.isProcessing || this.submitQueue.length === 0 || navigator.onLine === false) {
      return;
    }
    
    const nextSubmission = this.submitQueue.shift();
    
    try {
      await this.processSubmission(nextSubmission, nextSubmission.options);
      this.log('隊列中的提交處理成功');
    } catch (error) {
      // 重試邏輯
      nextSubmission.retryCount++;
      
      if (nextSubmission.retryCount < this.MAX_RETRY_ATTEMPTS) {
        // 重新加入隊列末尾
        this.submitQueue.push(nextSubmission);
        this.log(`隊列提交失敗，重試第 ${nextSubmission.retryCount} 次`);
      } else {
        this.log('隊列提交達到最大重試次數，丟棄:', error.message);
      }
    }
    
    if (this.callbacks.onQueueChange) {
      this.callbacks.onQueueChange(this.submitQueue.length);
    }
  }

  /**
   * 處理離線隊列
   */
  async processOfflineQueue() {
    // 網絡恢復時自動處理隊列
    window.addEventListener('online', () => {
      this.log('網絡恢復，開始處理離線隊列');
      setTimeout(() => {
        this.processNextInQueue();
      }, 1000);
    });
  }

  /**
   * 獲取統計數據
   */
  getStats() {
    return {
      ...this.stats,
      queueLength: this.submitQueue.length,
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
      queueLength: this.submitQueue.length,
      recentSubmissionsCount: this.recentSubmissions.size,
      stats: this.getStats()
    };
  }

  /**
   * 清空隊列
   */
  clearQueue() {
    const clearedCount = this.submitQueue.length;
    this.submitQueue = [];
    
    this.log(`已清空 ${clearedCount} 個隊列項目`);
    
    if (this.callbacks.onQueueChange) {
      this.callbacks.onQueueChange(0);
    }
    
    return clearedCount;
  }

  /**
   * 清理資源
   */
  cleanup() {
    this.log('清理翻譯管理器資源...');
    
    this.isInitialized = false;
    this.isProcessing = false;
    this.submitQueue = [];
    this.recentSubmissions.clear();
    this.callbacks = {};
    
    this.log('翻譯管理器資源清理完成');
  }

  // 事件註冊方法
  onSubmissionStart(callback) {
    this.callbacks.onSubmissionStart = callback;
  }
  
  onSubmissionSuccess(callback) {
    this.callbacks.onSubmissionSuccess = callback;
  }
  
  onSubmissionError(callback) {
    this.callbacks.onSubmissionError = callback;
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
      console.log(`[TranslationManager] ${message}`, ...args);
    }
  }
}

// 創建單例實例
const translationManager = new TranslationManager();

// 向後兼容的導出函數
export async function handleSubmitTranslation(params) {
  if (!translationManager.isInitialized) {
    await translationManager.initialize();
  }
  return translationManager.handleSubmitTranslation(params);
}

// 導出類和實例
export { TranslationManager, translationManager };

// 新版使用建議：
// import { translationManager } from './translation-manager.js';
// await translationManager.initialize();
// const result = await translationManager.submitTranslation(params);

// 舊版兼容使用：
// import { handleSubmitTranslation } from './translation-manager.js';
// const result = await handleSubmitTranslation(params);
