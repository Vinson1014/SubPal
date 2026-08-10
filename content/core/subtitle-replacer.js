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

import { registerInternalEventHandler } from '../system/messaging.js';
import { createPageSubtitles } from '../system/capabilities/subtitles.js';
import { buildSlotKey } from '../utils/slot-key.js';
import { playbackContextManager } from './playback-context-manager.js';
import {
  FETCH_DURATION_SECONDS,
  PREFETCH_THRESHOLD_SECONDS,
  SubtitleFetchCoordinator
} from './subtitle-fetch-coordinator.js';

const LOCAL_REPLACEMENT_STATUSES = new Set([
  'pending',
  'syncing',
  'completed-awaiting-authority',
  'accepted-local'
]);
const AUTHORITY_ATTEMPT_DELAYS_MS = [0, 5_000, 15_000];

class SubtitleReplacer {
  constructor() {
    this.subtitles = createPageSubtitles({
      window,
      getCurrentContext: () => playbackContextManager.getCurrentContext()
    });
    this.isInitialized = false;
    this.isEnabled = true;
    this.currentVideoId = null;
    this.localReplacements = new Map(); // 本地樂觀字幕，以 slotKey 為鍵
    
    // 配置參數
    this.FETCH_DURATION_SECONDS = FETCH_DURATION_SECONDS;
    this.PREFETCH_THRESHOLD_SECONDS = PREFETCH_THRESHOLD_SECONDS;
    
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

    this.subtitleSourceGeneration = 0;
    this.internalEventDisposers = [];
    this.fetchCoordinator = new SubtitleFetchCoordinator({
      query: (query, cancellation) => this.subtitles.query(query, cancellation),
      getCurrentTime: () => Number(globalThis.document?.querySelector?.('video')?.currentTime),
      onSnapshot: (subtitles, batchContext) => this.processSubtitleBatch(subtitles, batchContext),
      onRequest: () => {
        this.stats.apiRequests += 1;
      },
      onLog: (entry) => this.log('fetch coordinator:', entry)
    });

    // 替換事件去重記錄（15分鐘窗口）
    this.recentReplacementEvents = [];
    this.DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 分鐘
  }

  get subtitleCache() {
    return this.fetchCoordinator.cache;
  }

  get requestedIntervals() {
    return this.fetchCoordinator.intervals;
  }

  set requestedIntervals(intervals) {
    this.fetchCoordinator.intervals = Array.isArray(intervals) ? intervals : [];
  }

  activateFetchContext(videoId = this.currentVideoId) {
    const context = playbackContextManager.getCurrentContext();
    if (context?.state !== 'ready' || context?.videoId !== videoId ||
        typeof context.sessionId !== 'string' || !context.sessionId.startsWith('watch-') ||
        !Number.isInteger(context.epoch) || context.epoch < 0) {
      this.fetchCoordinator.cleanup();
      this.localReplacements.clear();
      return false;
    }

    const previousScopeKey = this.fetchCoordinator.scopeKey;
    const activated = this.fetchCoordinator.activateContext(
      context,
      this.subtitleSourceGeneration
    );
    if (activated && previousScopeKey && previousScopeKey !== this.fetchCoordinator.scopeKey) {
      this.localReplacements.clear();
    }
    return activated;
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
      // subtitle render 是 play/seek 事件漏接時的最後一道 coverage demand。
      this.activateFetchContext(videoId);
      
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
      const authoritativeReplacement = this.fetchCoordinator.getReplacement(slotKey);
      const replacement = localReplacement || authoritativeReplacement;

      if (replacement) {
        this.stats.cacheHits++;
        this.log(localReplacement ? '本地字幕命中' : '權威緩存命中');
        
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
    
    // ready context 才能啟動；若尚未 ready，後續 play/seek/render demand 會恢復。
    if (this.activateFetchContext(videoId)) {
      void this.fetchCoordinator.ensureCoverage(timestamp, { reason: 'initial' }).catch(() => {
        // 初始查詢不得阻塞字幕顯示。
      });
    }
  }

  /**
   * 清理視頻相關數據
   */
  clearVideoData() {
    this.fetchCoordinator.cleanup();
    this.localReplacements.clear();
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
    return this.fetchCoordinator.invalidateAt(timestamp);
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
    if (!this.activateFetchContext()) return;
    void this.fetchCoordinator.ensureCoverage(currentTimestamp, { reason: 'subtitle-render' }).catch(() => {
      // render path 不等待網路結果。
    });
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
      return { ok: false, error: { kind: 'invalid', code: 'subtitle-query', retryable: false } };
    }
    if (!this.activateFetchContext(videoId)) {
      return { ok: false, error: { kind: 'stale-context', code: 'subtitle-query-stale-context', retryable: false } };
    }

    const fetchOptions = {
      reason: options.reason || (options.force ? 'force-reconciliation' : 'explicit-demand'),
      requestStartedAt: options.requestStartedAt,
      reconciliationItemId: options.reconciliationItemId
    };
    return options.force
      ? this.fetchCoordinator.forceRefreshAt(startTimestamp, fetchOptions)
      : this.fetchCoordinator.requestAt(startTimestamp, fetchOptions);
  }

  /**
   * 處理字幕批次數據
   * @param {Array} subtitles - 字幕數組
   * @param {Object} batchContext - 請求批次資訊
   * @param {number} batchContext.requestStartedAt - 請求開始時間
   * @param {string|null} batchContext.reconciliationItemId - 本地字幕項目 ID
   */
  async processSubtitleBatch(subtitles, batchContext = {}) {
    const requestStartedAt = Number.isFinite(batchContext.requestStartedAt)
      ? batchContext.requestStartedAt
      : null;
    const reconciliationItemId = typeof batchContext.reconciliationItemId === 'string'
      ? batchContext.reconciliationItemId
      : null;
    
    for (const subtitle of subtitles) {
      const slotKey = subtitle.slotKey;

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
    
    this.log(`已套用權威字幕快照，批次數: ${subtitles.length}，緩存總數: ${this.subtitleCache.size}`);
    
  }


  /**
   * 檢查區間是否已請求
   */
  isIntervalRequested(start, end) {
    return this.requestedIntervals.some((interval) =>
      this.isIntervalActive(interval) && interval.start <= start && interval.end >= end
    );
  }

  isIntervalActive(interval) {
    return interval.status === 'in-progress' || interval.status === 'completed';
  }

  /**
   * 標記區間完成
   */
  markIntervalComplete(interval) {
    interval.status = 'completed';
  }

  /**
   * 標記區間失敗
   */
  markIntervalFailed(interval) {
    interval.status = 'failed';
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
    
    this.stats.totalReplacements++;
    
    const result = {
      ...originalSubtitle,
      text: suggestedSubtitle,
      htmlContent: null,
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
    
    this.log('創建替換字幕:', { translationID });

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

    for (const dispose of this.internalEventDisposers.splice(0)) {
      dispose();
    }
    
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
    for (const dispose of this.internalEventDisposers.splice(0)) {
      dispose();
    }

    // 監聽設置變更（保留用於測試模式等非配置管理的功能）
    this.internalEventDisposers.push(registerInternalEventHandler('SETTINGS_CHANGED', (message) => {
      if (message.changes.isTestModeEnabled !== undefined) {
        this.isTestModeEnabled = message.changes.isTestModeEnabled;
        this.log('測試模式設置已更新:', this.isTestModeEnabled);
      }

      if (message.changes.testRules) {
        this.testRules = message.changes.testRules || [];
        this.log('測試規則已更新:', this.testRules.length);
      }
    }));

    this.internalEventDisposers.push(registerInternalEventHandler('PLAYER_STATE_CHANGED', (message) => {
      if (!['play', 'pause', 'seeked'].includes(message?.state)) return;
      if (message.state === 'pause') {
        this.fetchCoordinator.handlePlayerState('pause', Number(message.timestamp));
        return;
      }
      if (!this.isEnabled) return;
      const videoId = typeof message.videoId === 'string' ? message.videoId : String(message.videoId || '');
      const timestamp = Number(message.timestamp);
      if (!videoId || !Number.isFinite(timestamp) || timestamp < 0) return;

      void (async () => {
        if (videoId !== this.currentVideoId) {
          await this.handleVideoChange(videoId, timestamp);
        } else if (!this.activateFetchContext(videoId)) {
          return;
        }
        this.fetchCoordinator.handlePlayerState(message.state, timestamp);
      })();
    }));

    this.internalEventDisposers.push(registerInternalEventHandler('SUBTITLE_SOURCE_CHANGED', (message) => {
      if (!Number.isInteger(message?.generation) || message.generation < 0 ||
          message.generation === this.subtitleSourceGeneration) return;
      this.subtitleSourceGeneration = message.generation;
      this.fetchCoordinator.cleanup();
      this.localReplacements.clear();
      if (this.currentVideoId && this.isEnabled) this.activateFetchContext(this.currentVideoId);
    }));
  }

  /**
   * 記錄替換事件到隊列
   * @param {string} translationID - 翻譯 ID
   * @param {string} contributorUserID - 貢獻者用戶 ID
   * @returns {Promise<void>}
   */
  async recordReplacementEvent(translationID, contributorUserID) {
    try {
      // 檢查是否重複（15分鐘窗口）
      if (this.isDuplicateReplacementEvent(translationID)) {
        this.log('跳過重複的替換事件:', { translationID });
        return;
      }

      // 記錄到去重列表
      const now = Date.now();
      this.recentReplacementEvents.push({
        translationID,
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
        occurredAt
      });

      this.log('替換事件已記錄:', { translationID, contributorUserID });

    } catch (error) {
      // 錯誤已在 createReplacedSubtitle 中處理，這裡只記錄詳細信息
      throw new Error(`記錄替換事件失敗: ${error.message}`);
    }
  }

  /**
   * 檢查是否為重複的替換事件（15分鐘窗口）
   * @param {string} translationID - 翻譯 ID
   * @returns {boolean} 是否重複
   */
  isDuplicateReplacementEvent(translationID) {
    const now = Date.now();
    const windowStart = now - this.DEDUP_WINDOW_MS;

    return this.recentReplacementEvents.some(event =>
      event.translationID === translationID &&
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
