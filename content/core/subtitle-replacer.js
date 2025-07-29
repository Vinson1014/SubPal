/**
 * 字幕替換器 - 專責字幕替換邏輯的核心模組
 * 
 * 設計理念：
 * 1. 支援兩種字幕模式（DOM監聽、intercept攔截）的統一替換邏輯
 * 2. 智能緩存管理，預加載和批次獲取字幕數據
 * 3. 與 UI 組件解耦，專注於純邏輯處理
 * 4. 完整的錯誤處理和降級機制
 * 5. 支援測試模式和調試功能
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class SubtitleReplacer {
  constructor() {
    this.isInitialized = false;
    this.isEnabled = true;
    this.currentVideoId = null;
    this.subtitleCache = new Map(); // 替換字幕緩存
    this.requestedIntervals = []; // 已請求的時間區間
    
    // 配置參數（從舊版移植並優化）
    this.FETCH_DURATION_SECONDS = 180; // 每次獲取3分鐘字幕
    this.PREFETCH_THRESHOLD_SECONDS = 60; // 預加載閾值
    this.TIMESTAMP_TOLERANCE_SECONDS = 2; // 時間戳容差
    this.MAX_CACHE_SIZE = 500; // 最大緩存條目
    
    // 測試模式狀態
    this.isTestModeEnabled = false;
    this.testRules = [];
    
    // 調試模式
    this.debug = false;
    
    // 統計數據
    this.stats = {
      totalReplacements: 0,
      cacheHits: 0,
      cacheMisses: 0,
      apiRequests: 0,
      lastActivity: null
    };
  }

  async initialize() {
    this.log('字幕替換器初始化中...');
    
    try {
      // 載入設置
      await this.loadSettings();
      
      // 設置事件處理器
      this.setupEventHandlers();
      
      this.isInitialized = true;
      this.log('字幕替換器初始化完成');
      
    } catch (error) {
      console.error('字幕替換器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 處理字幕替換 - 核心方法
   * @param {Object} subtitleData - 字幕數據（已標準化）
   * @param {string} videoId - 視頻 ID
   * @param {number} timestamp - 當前時間戳
   * @returns {Promise<Object|null>} 替換後的字幕數據或 null
   */
  async processSubtitle(subtitleData, videoId, timestamp) {
    if (!this.isInitialized) {
      console.warn('字幕替換器未初始化');
      return null;
    }
    
    if (!this.isEnabled) {
      this.log('字幕替換器已禁用');
      return null;
    }
    
    if (!subtitleData.text || !videoId) {
      this.log('無效的字幕數據或視頻 ID');
      return null;
    }
    
    this.stats.lastActivity = Date.now();
    
    try {
      // 檢查視頻 ID 變更
      if (videoId !== this.currentVideoId) {
        await this.handleVideoChange(videoId, timestamp);
      }
      
      // 1. 測試模式檢查（如果啟用）
      if (this.isTestModeEnabled && this.testRules.length > 0) {
        const testReplacement = this.checkTestRules(subtitleData.text);
        if (testReplacement) {
          this.log('測試模式替換:', testReplacement);
          return this.createReplacedSubtitle(subtitleData, testReplacement);
        }
      }
      
      // 2. 緩存中查找替換
      const cachedReplacement = this.findReplacementInCache(subtitleData.text, timestamp);
      if (cachedReplacement) {
        this.stats.cacheHits++;
        this.log('緩存命中:', cachedReplacement.suggestedSubtitle);
        
        // 檢查預加載需求
        this.checkAndTriggerPrefetch(timestamp);
        
        return this.createReplacedSubtitle(subtitleData, cachedReplacement);
      }
      
      this.stats.cacheMisses++;
      
      // 3. 觸發預加載（如果需要）
      this.checkAndTriggerPrefetch(timestamp);
      
      // 4. 沒有找到替換
      return null;
      
    } catch (error) {
      console.error('處理字幕替換時出錯:', error);
      return null;
    }
  }

  /**
   * 處理視頻變更
   */
  async handleVideoChange(videoId, timestamp) {
    this.log(`視頻變更: ${this.currentVideoId} -> ${videoId}`);
    
    // 清理舊數據
    this.clearVideoData();
    
    // 設置新的視頻 ID
    this.currentVideoId = videoId;
    
    // 立即觸發第一批字幕獲取
    await this.fetchSubtitleBatch(videoId, timestamp);
  }

  /**
   * 清理視頻相關數據
   */
  clearVideoData() {
    this.subtitleCache.clear();
    this.requestedIntervals = [];
    this.log('已清理視頻數據');
  }

  /**
   * 檢查測試規則
   * @param {string} text - 字幕文本
   * @returns {Object|null} 替換規則或 null
   */
  checkTestRules(text) {
    // 精確匹配優先
    for (const rule of this.testRules) {
      if (rule.original === text) {
        return {
          suggestedSubtitle: rule.replacement,
          translationID: `test_exact_${Date.now()}`,
          contributorUserID: 'test_user',
          isTestReplacement: true
        };
      }
    }
    
    // 包含匹配
    for (const rule of this.testRules) {
      if (text.includes(rule.original)) {
        const replacedText = text.replace(rule.original, rule.replacement);
        return {
          suggestedSubtitle: replacedText,
          translationID: `test_partial_${Date.now()}`,
          contributorUserID: 'test_user',
          isTestReplacement: true
        };
      }
    }
    
    return null;
  }

  /**
   * 在緩存中查找替換字幕
   * @param {string} text - 字幕文本
   * @param {number} timestamp - 時間戳
   * @returns {Object|null} 緩存的替換數據
   */
  findReplacementInCache(text, timestamp) {
    // 使用文本作為主鍵進行快速查找
    const cacheKey = this.generateCacheKey(text, timestamp);
    
    // 精確匹配
    if (this.subtitleCache.has(cacheKey)) {
      return this.subtitleCache.get(cacheKey);
    }
    
    // 模糊匹配（時間戳容差範圍內）
    for (const [key, value] of this.subtitleCache.entries()) {
      if (value.originalSubtitle === text && 
          Math.abs(value.timestamp - timestamp) <= this.TIMESTAMP_TOLERANCE_SECONDS) {
        return value;
      }
    }
    
    return null;
  }

  /**
   * 生成緩存鍵
   */
  generateCacheKey(text, timestamp) {
    // 使用文本和時間戳的組合作為鍵
    return `${text}_${Math.floor(timestamp / this.TIMESTAMP_TOLERANCE_SECONDS)}`;
  }

  /**
   * 檢查並觸發預加載
   * @param {number} currentTimestamp - 當前時間戳
   */
  checkAndTriggerPrefetch(currentTimestamp) {
    // 如果沒有已請求的區間，立即觸發請求
    if (this.requestedIntervals.length === 0) {
      this.log('沒有已請求區間，觸發初始加載');
      this.fetchSubtitleBatch(this.currentVideoId, currentTimestamp);
      return;
    }
    
    // 查找當前時間戳所在的區間
    let needsPrefetch = true;
    let nearestEndTime = Infinity;
    
    for (const interval of this.requestedIntervals) {
      if (currentTimestamp >= interval.start && currentTimestamp < interval.end) {
        // 當前時間在這個區間內
        const timeToEnd = interval.end - currentTimestamp;
        if (timeToEnd >= this.PREFETCH_THRESHOLD_SECONDS) {
          needsPrefetch = false; // 時間充足，不需要預加載
        } else {
          nearestEndTime = interval.end; // 需要從這個時間點開始預加載
        }
        break;
      }
    }
    
    if (needsPrefetch && nearestEndTime !== Infinity) {
      this.log(`距離區間結束 ${nearestEndTime - currentTimestamp}s，觸發預加載`);
      this.fetchSubtitleBatch(this.currentVideoId, nearestEndTime);
    } else if (needsPrefetch) {
      // 當前時間不在任何區間內，立即請求
      this.log('當前時間不在任何已請求區間，觸發請求');
      this.fetchSubtitleBatch(this.currentVideoId, currentTimestamp);
    }
  }

  /**
   * 獲取字幕批次數據
   * @param {string} videoId - 視頻 ID
   * @param {number} startTimestamp - 開始時間戳
   */
  async fetchSubtitleBatch(videoId, startTimestamp) {
    if (!videoId) {
      this.log('無效的視頻 ID，跳過獲取');
      return;
    }
    
    const start = startTimestamp;
    const end = start + this.FETCH_DURATION_SECONDS;
    
    // 檢查是否已經請求過這個區間
    const alreadyRequested = this.isIntervalRequested(start, end);
    if (alreadyRequested) {
      this.log(`區間 ${start}-${end} 已請求過，跳過`);
      return;
    }
    
    // 記錄請求區間
    this.requestedIntervals.push({
      start: start,
      end: end,
      status: 'in-progress',
      timestamp: Date.now()
    });
    
    this.log(`開始獲取字幕批次: ${start} ~ ${end}`);
    this.stats.apiRequests++;
    
    try {
      const response = await sendMessage({
        type: 'CHECK_SUBTITLE',
        videoId: videoId,
        timestamp: startTimestamp
      });
      
      if (response && response.success && Array.isArray(response.subtitles)) {
        await this.processSubtitleBatch(response.subtitles, start);
        this.markIntervalComplete(start);
        this.log(`成功處理 ${response.subtitles.length} 條字幕`);
      } else {
        console.warn('獲取字幕批次失敗或格式錯誤:', response);
        this.markIntervalFailed(start);
      }
      
    } catch (error) {
      console.error('獲取字幕批次時出錯:', error);
      this.markIntervalFailed(start);
    }
  }

  /**
   * 處理字幕批次數據
   * @param {Array} subtitles - 字幕數組
   * @param {number} requestStart - 請求開始時間
   */
  async processSubtitleBatch(subtitles, requestStart) {
    let newCount = 0;
    
    for (const subtitle of subtitles) {
      if (!subtitle.originalSubtitle || !subtitle.suggestedSubtitle) {
        continue; // 跳過無效數據
      }
      
      const cacheKey = this.generateCacheKey(subtitle.originalSubtitle, subtitle.timestamp);
      
      // 避免重複緩存
      if (!this.subtitleCache.has(cacheKey)) {
        this.subtitleCache.set(cacheKey, {
          ...subtitle,
          cacheTime: Date.now()
        });
        newCount++;
      }
    }
    
    this.log(`新增 ${newCount} 條字幕到緩存，總數: ${this.subtitleCache.size}`);
    
    // 限制緩存大小
    this.limitCacheSize();
  }

  /**
   * 限制緩存大小
   */
  limitCacheSize() {
    if (this.subtitleCache.size > this.MAX_CACHE_SIZE) {
      // 移除最舊的條目
      const entries = Array.from(this.subtitleCache.entries());
      entries.sort((a, b) => (a[1].cacheTime || 0) - (b[1].cacheTime || 0));
      
      const toRemove = entries.length - this.MAX_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.subtitleCache.delete(entries[i][0]);
      }
      
      this.log(`清理 ${toRemove} 條舊緩存，當前大小: ${this.subtitleCache.size}`);
    }
  }

  /**
   * 檢查區間是否已請求
   */
  isIntervalRequested(start, end) {
    return this.requestedIntervals.some(interval => 
      interval.start <= start && interval.end >= end
    );
  }

  /**
   * 標記區間完成
   */
  markIntervalComplete(start) {
    const interval = this.requestedIntervals.find(i => i.start === start);
    if (interval) {
      interval.status = 'completed';
    }
  }

  /**
   * 標記區間失敗
   */
  markIntervalFailed(start) {
    const interval = this.requestedIntervals.find(i => i.start === start);
    if (interval) {
      interval.status = 'failed';
    }
  }

  /**
   * 創建替換後的字幕數據
   * @param {Object} originalSubtitle - 原始字幕數據
   * @param {Object} replacementData - 替換數據
   * @returns {Object} 替換後的字幕數據
   */
  createReplacedSubtitle(originalSubtitle, replacementData) {
    const {
      suggestedSubtitle = '',
      translationID = null,
      contributorUserID = null,
      isTestReplacement = false
    } = replacementData;
    
    // 處理換行符號
    const replacementHtml = suggestedSubtitle.replace(/\n/g, '<br>');
    
    this.stats.totalReplacements++;
    
    const result = {
      ...originalSubtitle,
      text: suggestedSubtitle, // 更新純文本
      htmlContent: `<span>${replacementHtml}</span>`, // 更新 HTML 內容
      original: originalSubtitle.text, // 保留原始文本
      isReplaced: true,
      translationID: translationID,
      contributorUserID: contributorUserID,
      isTestReplacement: isTestReplacement,
      replacementTime: Date.now()
    };
    
    // 同步更新 dualSubtitleData.primaryText
    if (result.mode === 'intercept' && result.dualSubtitleData) {
      result.dualSubtitleData = {
        ...result.dualSubtitleData,
        primaryText: suggestedSubtitle  // 同步更新 primaryText
      };
    }
    
    this.log('創建替換字幕:', {
      original: originalSubtitle.text,
      replacement: suggestedSubtitle,
      translationID: translationID
    });
    
    return result;
  }

  /**
   * 獲取統計數據
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.subtitleCache.size,
      requestedIntervals: this.requestedIntervals.length,
      isEnabled: this.isEnabled,
      currentVideoId: this.currentVideoId
    };
  }

  /**
   * 獲取當前狀態
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isEnabled: this.isEnabled,
      currentVideoId: this.currentVideoId,
      cacheSize: this.subtitleCache.size,
      stats: this.getStats(),
      testMode: {
        enabled: this.isTestModeEnabled,
        rulesCount: this.testRules.length
      }
    };
  }

  /**
   * 設置啟用/禁用
   * @param {boolean} enabled - 是否啟用
   */
  setEnabled(enabled) {
    const wasEnabled = this.isEnabled;
    this.isEnabled = !!enabled;
    
    this.log(`字幕替換器${this.isEnabled ? '啟用' : '禁用'}`);
    
    if (wasEnabled && !this.isEnabled) {
      // 禁用時清理緩存
      this.clearVideoData();
    }
  }

  /**
   * 設置測試模式
   * @param {boolean} enabled - 是否啟用測試模式
   * @param {Array} rules - 測試規則
   */
  setTestMode(enabled, rules = []) {
    this.isTestModeEnabled = !!enabled;
    this.testRules = Array.isArray(rules) ? rules : [];
    
    this.log(`測試模式${this.isTestModeEnabled ? '啟用' : '禁用'}，規則數: ${this.testRules.length}`);
  }

  /**
   * 清理資源
   */
  cleanup() {
    this.log('清理字幕替換器資源...');
    
    this.clearVideoData();
    this.isInitialized = false;
    this.isEnabled = false;
    this.currentVideoId = null;
    
    this.log('字幕替換器資源清理完成');
  }

  /**
   * 載入設置
   */
  async loadSettings() {
    try {
      const result = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['debugMode', 'isEnabled', 'isTestModeEnabled', 'testRules']
      });
      
      if (result) {
        this.debug = result.debugMode || false;
        this.isEnabled = result.isEnabled !== false; // 默認啟用
        this.isTestModeEnabled = result.isTestModeEnabled || false;
        this.testRules = result.testRules || [];
        
        this.log('設置載入完成:', {
          debug: this.debug,
          enabled: this.isEnabled,
          testMode: this.isTestModeEnabled,
          testRulesCount: this.testRules.length
        });
      }
    } catch (error) {
      console.error('載入設置時出錯:', error);
    }
  }

  /**
   * 設置事件處理器
   */
  setupEventHandlers() {
    // 監聽設置變更
    registerInternalEventHandler('SETTINGS_CHANGED', (message) => {
      if (message.changes.isTestModeEnabled !== undefined) {
        this.isTestModeEnabled = message.changes.isTestModeEnabled;
        this.log('測試模式設置已更新:', this.isTestModeEnabled);
      }
      
      if (message.changes.testRules) {
        this.testRules = message.changes.testRules || [];
        this.log('測試規則已更新:', this.testRules.length);
      }
      
      if (message.changes.isEnabled !== undefined) {
        this.setEnabled(message.changes.isEnabled);
      }
    });

    // 監聽調試模式切換
    registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
      this.debug = message.debugMode;
      this.log('調試模式已更新:', this.debug);
    });

    // 監聽擴充功能開關
    registerInternalEventHandler('TOGGLE_EXTENSION', (message) => {
      this.setEnabled(message.isEnabled);
    });
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleReplacer] ${message}`, ...args);
    }
  }
}

export { SubtitleReplacer };
