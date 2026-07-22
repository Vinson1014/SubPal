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
import { buildSlotKey } from '../utils/slot-key.js';

const LOCAL_REPLACEMENT_STATUSES = new Set([
  'pending',
  'syncing',
  'completed-awaiting-authority',
  'accepted-local'
]);
const AUTHORITY_ATTEMPT_DELAYS_MS = [0, 5_000, 15_000];

class SubtitleReplacer {
  constructor() {
    this.isInitialized = false;
    this.isEnabled = true;
    this.currentVideoId = null;
    this.subtitleCache = new Map(); // 權威字幕緩存，以 slotKey 為鍵
    this.localReplacements = new Map(); // 本地樂觀字幕，以 slotKey 為鍵
    this.requestedIntervals = []; // 已請求的時間區間
    
    // 配置參數（從舊版移植並優化）
    this.FETCH_DURATION_SECONDS = 180; // 每次獲取3分鐘字幕
    this.PREFETCH_THRESHOLD_SECONDS = 60; // 預加載閾值
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

    // 替換事件去重記錄（15分鐘窗口）
    this.recentReplacementEvents = [];
    this.DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 分鐘
  }

  async initialize() {
    this.log('字幕替換器初始化中...');

    try {
      // 初始化 ConfigBridge 並讀取配置
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取配置
      this.debug = configBridge.get('debugMode');
      this.isEnabled = configBridge.get('isEnabled') !== false; // 默認啟用

      this.log('設置載入完成:', {
        debug: this.debug,
        enabled: this.isEnabled
      });

      // 訂閱配置變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log('調試模式已更新:', this.debug);
      });

      configBridge.subscribe('isEnabled', (newValue) => {
        this.setEnabled(newValue);
      });

      this.configBridge = configBridge;

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
      
      // 2. 依 exact slot 解析本地樂觀字幕，再查詢權威緩存
      const slotKey = typeof subtitleData.slotKey === 'string' ? subtitleData.slotKey : null;
      const localReplacement = slotKey ? this.localReplacements.get(slotKey) : null;
      const authoritativeReplacement = slotKey ? this.subtitleCache.get(slotKey) : null;
      const replacement = localReplacement || authoritativeReplacement;

      if (replacement) {
        this.stats.cacheHits++;
        this.log(localReplacement ? '本地字幕命中:' : '權威緩存命中:', replacement.suggestedSubtitle);
        
        // 檢查預加載需求
        this.checkAndTriggerPrefetch(timestamp);
        
        return this.createReplacedSubtitle(subtitleData, replacement);
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
   * 注意：fetchSubtitleBatch 在背景非阻塞執行，避免阻塞字幕顯示鏈條
   */
  async handleVideoChange(videoId, timestamp) {
    this.log(`視頻變更: ${this.currentVideoId} -> ${videoId}`);
    
    // 清理舊數據
    this.clearVideoData();
    
    // 設置新的視頻 ID
    this.currentVideoId = videoId;
    
    // 觸發第一批字幕獲取（背景非阻塞，避免阻塞字幕顯示）
    // 首次顯示將使用原始字幕，API 返回後後續字幕自動替換
    // 首次載入使用 500ms 短超時，避免長時間阻塞顯示
    this.fetchSubtitleBatch(videoId, timestamp, { timeout: 500 }).catch(error => {
      console.error('首次字幕批次獲取失敗:', error);
    });
  }

  /**
   * 清理視頻相關數據
   */
  clearVideoData() {
    this.subtitleCache.clear();
    this.localReplacements.clear();
    this.requestedIntervals = [];
    this.log('已清理視頻數據');
  }

  /**
   * 新增或更新 exact-slot 本地字幕。
   * @param {Object} record - 本地字幕資料
   * @returns {Object|null} 完整的本地字幕記錄
   */
  upsertLocalReplacement(record) {
    const itemId = typeof record?.itemId === 'string' ? record.itemId.trim() : '';
    const videoId = typeof record?.videoId === 'string' ? record.videoId.trim() : '';
    const originalSubtitle = String(record?.originalSubtitle || '').trim();
    const suggestedSubtitle = String(record?.suggestedSubtitle || '');
    const languageCode = typeof record?.languageCode === 'string' ? record.languageCode.trim() : '';
    const timestamp = Number(record?.timestamp);
    const canonicalSlotKey = buildSlotKey({
      videoID: videoId,
      originalSubtitle,
      languageCode,
      timestamp
    });
    const suppliedSlotKey = typeof record?.slotKey === 'string' ? record.slotKey.trim() : '';
    const status = record?.status || 'pending';

    if (!itemId || !canonicalSlotKey || suppliedSlotKey !== canonicalSlotKey || !LOCAL_REPLACEMENT_STATUSES.has(status)) {
      return null;
    }

    const createdAt = Number.isFinite(Number(record.createdAt))
      ? Number(record.createdAt)
      : Date.now();
    let completedAt = record.completedAt !== null && record.completedAt !== undefined && Number.isFinite(Number(record.completedAt))
      ? Number(record.completedAt)
      : null;
    const authorityAttemptIndex = Number.isInteger(record.authorityAttemptIndex) && record.authorityAttemptIndex >= 0
      ? record.authorityAttemptIndex
      : 0;
    let nextAuthorityAttemptAt = record.nextAuthorityAttemptAt !== null && record.nextAuthorityAttemptAt !== undefined && Number.isFinite(Number(record.nextAuthorityAttemptAt))
      ? Number(record.nextAuthorityAttemptAt)
      : null;

    if (status === 'completed-awaiting-authority') {
      completedAt ??= Date.now();
      if (authorityAttemptIndex < AUTHORITY_ATTEMPT_DELAYS_MS.length && nextAuthorityAttemptAt === null) {
        nextAuthorityAttemptAt = completedAt + AUTHORITY_ATTEMPT_DELAYS_MS[authorityAttemptIndex];
      }
    } else if (status === 'accepted-local') {
      nextAuthorityAttemptAt = null;
    }

    this.removeLocalReplacement(itemId);

    const localRecord = {
      itemId,
      slotKey: canonicalSlotKey,
      videoId,
      originalSubtitle,
      suggestedSubtitle,
      languageCode,
      timestamp,
      status,
      createdAt,
      completedAt,
      authorityAttemptIndex,
      nextAuthorityAttemptAt
    };
    this.localReplacements.set(canonicalSlotKey, localRecord);

    return { ...localRecord };
  }

  /**
   * 更新本地字幕同步狀態。
   * @param {string} itemId - 隊列項目 ID
   * @param {string} status - 本地字幕狀態
   * @param {Object} metadata - 完成與權威重試資料
   * @returns {Object|null} 更新後的本地字幕記錄
   */
  setLocalReplacementStatus(itemId, status, metadata = {}) {
    if (!LOCAL_REPLACEMENT_STATUSES.has(status)) {
      return null;
    }

    const entry = this.findLocalReplacementEntry(itemId);
    if (!entry) {
      return null;
    }

    const updatedRecord = {
      ...entry.record,
      status
    };

    if (metadata.completedAt !== undefined) {
      updatedRecord.completedAt = Number.isFinite(Number(metadata.completedAt))
        ? Number(metadata.completedAt)
        : null;
    }
    if (Number.isInteger(metadata.authorityAttemptIndex) && metadata.authorityAttemptIndex >= 0) {
      updatedRecord.authorityAttemptIndex = metadata.authorityAttemptIndex;
    }
    const hasNextAuthorityAttemptAt = metadata.nextAuthorityAttemptAt !== undefined;
    if (hasNextAuthorityAttemptAt) {
      updatedRecord.nextAuthorityAttemptAt = metadata.nextAuthorityAttemptAt !== null && Number.isFinite(Number(metadata.nextAuthorityAttemptAt))
        ? Number(metadata.nextAuthorityAttemptAt)
        : null;
    }

    if (status === 'completed-awaiting-authority') {
      updatedRecord.completedAt ??= Date.now();
      if (!hasNextAuthorityAttemptAt && updatedRecord.authorityAttemptIndex < AUTHORITY_ATTEMPT_DELAYS_MS.length) {
        updatedRecord.nextAuthorityAttemptAt ??= updatedRecord.completedAt + AUTHORITY_ATTEMPT_DELAYS_MS[updatedRecord.authorityAttemptIndex];
      }
    } else if (status === 'accepted-local') {
      updatedRecord.nextAuthorityAttemptAt = null;
    }

    this.localReplacements.set(entry.slotKey, updatedRecord);
    return { ...updatedRecord };
  }

  /**
   * 移除指定隊列項目的本地字幕。
   * @param {string} itemId - 隊列項目 ID
   * @returns {Object|null} 被移除的本地字幕記錄
   */
  removeLocalReplacement(itemId) {
    const entry = this.findLocalReplacementEntry(itemId);
    if (!entry) {
      return null;
    }

    this.localReplacements.delete(entry.slotKey);
    return { ...entry.record };
  }

  /**
   * 列出本影片 session 的本地字幕。
   * @returns {Array<Object>} 本地字幕記錄副本
   */
  listLocalReplacements() {
    return Array.from(this.localReplacements.values(), record => ({ ...record }));
  }

  /**
   * 使包含指定時間點的請求區間失效，允許精準重新獲取。
   * @param {number} timestamp - 字幕時間戳
   * @returns {number} 移除的區間數
   */
  invalidateIntervalAt(timestamp) {
    const numericTimestamp = Number(timestamp);
    if (!Number.isFinite(numericTimestamp)) {
      return 0;
    }

    const previousCount = this.requestedIntervals.length;
    this.requestedIntervals = this.requestedIntervals.filter(interval =>
      numericTimestamp < interval.start || numericTimestamp >= interval.end
    );
    return previousCount - this.requestedIntervals.length;
  }

  isLocalReplacementReconciliationDue(itemId, now) {
    const entry = this.findLocalReplacementEntry(itemId);
    const currentTime = Number(now);

    if (!entry || entry.record.status !== 'completed-awaiting-authority' ||
        entry.record.completedAt === null || !Number.isFinite(currentTime) ||
        entry.record.authorityAttemptIndex >= AUTHORITY_ATTEMPT_DELAYS_MS.length) {
      return false;
    }

    const dueAt = entry.record.completedAt +
      AUTHORITY_ATTEMPT_DELAYS_MS[entry.record.authorityAttemptIndex];
    return currentTime >= dueAt;
  }

  /**
   * 依 0/5/15 秒上限向權威來源重新查詢完成的本地字幕。
   * @param {string} itemId - 隊列項目 ID
   * @param {number} now - 當前時間
   * @returns {Promise<Object|null>} 仍存在的本地字幕記錄
   */
  async reconcileCompletedLocalReplacement(itemId, now) {
    const entry = this.findLocalReplacementEntry(itemId);
    const currentTime = Number(now);

    if (!entry || entry.record.status !== 'completed-awaiting-authority' || !Number.isFinite(currentTime)) {
      return entry ? { ...entry.record } : null;
    }

    const { record } = entry;
    if (record.completedAt === null) {
      return this.setLocalReplacementStatus(itemId, 'accepted-local', {
        authorityAttemptIndex: AUTHORITY_ATTEMPT_DELAYS_MS.length,
        nextAuthorityAttemptAt: null
      });
    }
    if (record.authorityAttemptIndex >= AUTHORITY_ATTEMPT_DELAYS_MS.length) {
      return { ...record };
    }

    if (!this.isLocalReplacementReconciliationDue(itemId, currentTime)) {
      return { ...record };
    }

    const nextAttemptIndex = record.authorityAttemptIndex + 1;
    const nextAuthorityAttemptAt = nextAttemptIndex < AUTHORITY_ATTEMPT_DELAYS_MS.length
      ? record.completedAt + AUTHORITY_ATTEMPT_DELAYS_MS[nextAttemptIndex]
      : null;
    this.setLocalReplacementStatus(itemId, 'completed-awaiting-authority', {
      authorityAttemptIndex: nextAttemptIndex,
      nextAuthorityAttemptAt
    });
    this.invalidateIntervalAt(record.timestamp);

    await this.fetchSubtitleBatch(record.videoId, record.timestamp, {
      force: true,
      requestStartedAt: Date.now(),
      reconciliationItemId: itemId
    });

    const currentEntry = this.findLocalReplacementEntry(itemId);
    if (!currentEntry) {
      return null;
    }
    if (currentEntry.record.status !== 'completed-awaiting-authority') {
      return { ...currentEntry.record };
    }
    if (nextAttemptIndex >= AUTHORITY_ATTEMPT_DELAYS_MS.length) {
      return this.setLocalReplacementStatus(itemId, 'accepted-local', {
        authorityAttemptIndex: nextAttemptIndex,
        nextAuthorityAttemptAt: null
      });
    }

    return { ...currentEntry.record };
  }

  findLocalReplacementEntry(itemId) {
    for (const [slotKey, record] of this.localReplacements.entries()) {
      if (record.itemId === itemId) {
        return { slotKey, record };
      }
    }

    return null;
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
          translationID: null,
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
          translationID: null,
          contributorUserID: 'test_user',
          isTestReplacement: true
        };
      }
    }
    
    return null;
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
   * @param {Object} options - 選項
   * @param {number} options.timeout - 超時時間（毫秒），預設不設限
   * @param {boolean} options.force - 是否略過已請求區間檢查
   * @param {number} options.requestStartedAt - 請求開始時間
   * @param {string} options.reconciliationItemId - 對應的本地字幕項目 ID
   */
  async fetchSubtitleBatch(videoId, startTimestamp, options = {}) {
    if (!videoId) {
      this.log('無效的視頻 ID，跳過獲取');
      return;
    }
    
    const start = startTimestamp;
    const end = start + this.FETCH_DURATION_SECONDS;
    
    // 檢查是否已經請求過這個區間
    const alreadyRequested = this.isIntervalRequested(start, end);
    if (alreadyRequested && !options.force) {
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
    const requestStartedAt = Number.isFinite(options.requestStartedAt)
      ? options.requestStartedAt
      : Date.now();
    
    try {
      const sendPromise = sendMessage({
        type: 'CHECK_SUBTITLE',
        videoId: videoId,
        timestamp: startTimestamp
      });
      
      // 如果指定了超時，使用 Promise.race
      const response = options.timeout
        ? await Promise.race([
            sendPromise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), options.timeout)
            )
          ])
        : await sendPromise;
      
      if (response && response.success && Array.isArray(response.subtitles)) {
        await this.processSubtitleBatch(response.subtitles, {
          requestStartedAt,
          reconciliationItemId: options.reconciliationItemId || null
        });
        this.markIntervalComplete(start);
        this.log(`成功處理 ${response.subtitles.length} 條字幕`);
      } else {
        console.warn('獲取字幕批次失敗或格式錯誤:', response);
        this.markIntervalFailed(start);
      }
      
    } catch (error) {
      if (error.message === 'timeout') {
        console.warn(`獲取字幕批次超時 (${options.timeout}ms)，使用原始字幕`);
      } else {
        console.error('獲取字幕批次時出錯:', error);
      }
      this.markIntervalFailed(start);
    }
  }

  /**
   * 處理字幕批次數據
   * @param {Array} subtitles - 字幕數組
   * @param {Object} batchContext - 請求批次資訊
   * @param {number} batchContext.requestStartedAt - 請求開始時間
   * @param {string|null} batchContext.reconciliationItemId - 本地字幕項目 ID
   */
  async processSubtitleBatch(subtitles, batchContext = {}) {
    let newCount = 0;
    const requestStartedAt = Number.isFinite(batchContext.requestStartedAt)
      ? batchContext.requestStartedAt
      : null;
    const reconciliationItemId = typeof batchContext.reconciliationItemId === 'string'
      ? batchContext.reconciliationItemId
      : null;
    
    for (const subtitle of subtitles) {
      if (!subtitle.originalSubtitle || !subtitle.suggestedSubtitle) {
        continue; // 跳過無效數據
      }

      const suppliedSlotKey = typeof subtitle.slotKey === 'string' ? subtitle.slotKey.trim() : '';
      const slotKey = suppliedSlotKey || buildSlotKey({
        videoID: subtitle.videoID,
        originalSubtitle: subtitle.originalSubtitle,
        languageCode: subtitle.languageCode,
        timestamp: subtitle.timestamp
      });

      if (!slotKey) {
        continue;
      }

      if (!this.subtitleCache.has(slotKey)) {
        newCount++;
      }

      this.subtitleCache.set(slotKey, {
        ...subtitle,
        slotKey,
        cacheTime: Date.now()
      });

      const localRecord = this.localReplacements.get(slotKey);
      if (!localRecord) {
        continue;
      }

      const isPostCompletionAuthority = localRecord.status === 'completed-awaiting-authority' &&
        localRecord.completedAt !== null &&
        requestStartedAt !== null &&
        requestStartedAt >= localRecord.completedAt;
      const isLaterNormalAuthority = localRecord.status === 'accepted-local' &&
        localRecord.completedAt !== null &&
        requestStartedAt !== null &&
        requestStartedAt >= localRecord.completedAt &&
        reconciliationItemId === null;

      if (isPostCompletionAuthority || isLaterNormalAuthority) {
        this.localReplacements.delete(slotKey);
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
      isTestReplacement = false,
      upvotes = 0,
      downvotes = 0,
      myVote = null
    } = replacementData;
    
    // 處理換行符號
    const replacementHtml = suggestedSubtitle.replace(/\n/g, '<br>');
    
    this.stats.totalReplacements++;
    
    const result = {
      ...originalSubtitle,
      text: suggestedSubtitle,
      htmlContent: `<span>${replacementHtml}</span>`,
      original: originalSubtitle.text,
      isReplaced: true,
      translationID: translationID,
      contributorUserID: contributorUserID,
      isTestReplacement: isTestReplacement,
      upvotes: upvotes,
      downvotes: downvotes,
      myVote: myVote,
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

    // 記錄 replacement event（異步，不阻塞字幕替換）
    // 忽略測試模式的替換
    if (!isTestReplacement && translationID && contributorUserID) {
      this.recordReplacementEvent(translationID, contributorUserID)
        .catch(error => {
          // 靜默處理錯誤，不影響字幕替換功能
          console.warn('[SubtitleReplacer] 記錄替換事件失敗:', error);
        });
    }

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
   * 設置事件處理器
   */
  setupEventHandlers() {
    // 監聽設置變更（保留用於測試模式等非配置管理的功能）
    registerInternalEventHandler('SETTINGS_CHANGED', (message) => {
      if (message.changes.isTestModeEnabled !== undefined) {
        this.isTestModeEnabled = message.changes.isTestModeEnabled;
        this.log('測試模式設置已更新:', this.isTestModeEnabled);
      }

      if (message.changes.testRules) {
        this.testRules = message.changes.testRules || [];
        this.log('測試規則已更新:', this.testRules.length);
      }
    });
  }

  /**
   * 記錄替換事件到隊列
   * @param {string} translationID - 翻譯 ID
   * @param {string} contributorUserID - 貢獻者用戶 ID
   * @returns {Promise<void>}
   */
  async recordReplacementEvent(translationID, contributorUserID) {
    try {
      // 獲取當前用戶 ID（受益者）
      const beneficiaryUserID = this.configBridge?.get('user.userId');

      // 如果沒有用戶 ID，跳過記錄
      if (!beneficiaryUserID) {
        this.log('未找到用戶 ID，跳過記錄替換事件');
        return;
      }

      // 檢查是否重複（15分鐘窗口）
      if (this.isDuplicateReplacementEvent(translationID, beneficiaryUserID)) {
        this.log('跳過重複的替換事件:', { translationID, beneficiaryUserID });
        return;
      }

      // 記錄到去重列表
      const now = Date.now();
      this.recentReplacementEvents.push({
        translationID,
        beneficiaryUserID,
        timestamp: now
      });

      // 清理過期記錄（超過15分鐘）
      this.cleanupReplacementEventHistory();

      // 動態導入 replacement-event-bridge
      const { replacementEventBridge } = await import('./replacement-event-bridge.js');

      // 確保 bridge 已初始化
      if (!replacementEventBridge.isInitialized) {
        await replacementEventBridge.initialize();
      }

      // 記錄事件
      const occurredAt = new Date(now).toISOString();
      await replacementEventBridge.enqueue({
        translationID,
        contributorUserID,
        beneficiaryUserID,
        occurredAt
      });

      this.log('替換事件已記錄:', { translationID, contributorUserID, beneficiaryUserID });

    } catch (error) {
      // 錯誤已在 createReplacedSubtitle 中處理，這裡只記錄詳細信息
      throw new Error(`記錄替換事件失敗: ${error.message}`);
    }
  }

  /**
   * 檢查是否為重複的替換事件（15分鐘窗口）
   * @param {string} translationID - 翻譯 ID
   * @param {string} beneficiaryUserID - 受益者用戶 ID
   * @returns {boolean} 是否重複
   */
  isDuplicateReplacementEvent(translationID, beneficiaryUserID) {
    const now = Date.now();
    const windowStart = now - this.DEDUP_WINDOW_MS;

    return this.recentReplacementEvents.some(event =>
      event.translationID === translationID &&
      event.beneficiaryUserID === beneficiaryUserID &&
      event.timestamp >= windowStart
    );
  }

  /**
   * 清理過期的替換事件記錄（超過15分鐘）
   */
  cleanupReplacementEventHistory() {
    const now = Date.now();
    const windowStart = now - this.DEDUP_WINDOW_MS;

    this.recentReplacementEvents = this.recentReplacementEvents.filter(
      event => event.timestamp >= windowStart
    );

    this.log(`清理過期替換事件記錄，剩餘: ${this.recentReplacementEvents.length}`);
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleReplacer] ${message}`, ...args);
    }
  }
}

export { SubtitleReplacer };
