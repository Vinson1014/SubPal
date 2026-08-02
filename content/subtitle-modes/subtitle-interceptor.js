/**
 * 字幕攔截模式 - 重構版字幕攔截器
 * 
 * 設計理念：
 * 1. 模塊化：從原有 subtitle-renderer.js 重構而來
 * 2. 專責化：只負責字幕攔截和數據處理
 * 3. 統一接口：提供標準化的字幕數據格式
 * 4. 雙語支持：保留原有的雙語字幕功能
 */

import { parseSubtitle, findSubtitleByTime, buildTimeIndex, findSubtitleByTimeIndex } from '../utils/subtitle-parser.js';
import { registerInternalEventHandler, dispatchInternalEvent } from '../system/messaging.js';
import { getCurrentTimestamp, getVideoId } from '../core/video-info.js';
import { playbackContextManager } from '../core/playback-context-manager.js';
import { getPlayerAdapter, setRegionConfigs } from '../ui/netflix-player-adapter.js';
import { DOMOverlapMatcher } from './dom-overlap-matcher.js';
import { TtmlAcquisitionIngress, bindTtmlAcquisitionCapture } from '../system/capabilities/ttml-acquisition-ingress.js';

class SubtitleInterceptor {
  constructor() {
    this.isActive = false;
    this.isInitialized = false;
    this.callback = null;
    
    // 語言設置（默認值）
    this.primaryLanguage = 'zh-Hant';
    this.secondaryLanguage = 'en';
    this.dualSubtitleEnabled = true; // 是否啟用雙語模式
    
    // 字幕數據
    this.primarySubtitles = [];
    this.secondarySubtitles = [];
    this.primaryTimeIndex = null;
    this.secondaryTimeIndex = null;
    this.primarySubtitleMeta = null;
    this.secondarySubtitleMeta = null;
    
    // 攔截的原始字幕數據
    this.interceptedSubtitles = new Map();
    
    // 渲染狀態
    this.currentTimestamp = 0;
    this.lastRenderedSubtitle = null;
    this.renderInterval = null;
    this._renderGeneration = 0;
    this._internalEventDisposers = [];
    this.ttmlAcquisitionIngress = null;
    this.disposeTtmlAcquisitionCapture = null;
    this.contextReloadTimer = null;
    this.isLoadingInterceptedSubtitles = false;
    this.pendingLoadInterceptedSubtitles = false;
    this.pendingLoadReason = null;
    
    // 調試模式（從 ConfigBridge 讀取）
    this.debug = false;

    // 診斷資料（不影響字幕行為）
    this.debugEvents = [];
    this.maxDebugEvents = 50;
    this.lastProcessedTTMLEvidence = null;
    this.lastSubtitleMissingReasons = {
      primary: null,
      secondary: null
    };
    this.lastAcquisitionResults = {
      primary: null,
      secondary: null
    };
    this.acquisitionWaiters = new Map();
    this.nextAcquisitionWaiterId = 1;

    // Primary Discovery State Machine
    this.primaryDiscovery = {
      state: 'idle',
      startedAt: null,
      sampleCount: 0,
      matchAttemptCount: 0,
      lastSample: null,
      selectedCacheKey: null,
      selectedScore: null,
      lastFailureReason: null,
      toastShown: false
    };

    // DOM Overlap Matcher，在 startPrimaryDiscovery 時 lazy 初始化
    this.domOverlapMatcher = null;

    // Primary discovery 輪詢計時器
    this.primaryDiscoveryTimer = null;

    // Secondary acquisition in-flight tracking（idempotent 用）
    this._secondaryAcquisitionInFlight = null;

    // Secondary DOM recovery cooldown（per videoId|epoch|secondaryLanguage）
    this._secondaryRecoveryCooldown = new Map();
    this._secondaryRecoveryLastResult = null;

    // Secondary DOM recovery in-flight flag（idempotent 用）
    this._secondaryRecoveryInFlight = false;

    // Sticky flag：SubPal 是否曾成功顯示過字幕（用於控制原生字幕隱藏時機）
    this._hasSubpalEverShownSubtitle = false;
  }

  recordDebugEvent(type, data = {}) {
    this.debugEvents.push({
      type,
      timestamp: Date.now(),
      currentVideoId: getVideoId(),
      ...data
    });

    if (this.debugEvents.length > this.maxDebugEvents) {
      this.debugEvents.splice(0, this.debugEvents.length - this.maxDebugEvents);
    }
  }

  async initialize() {
    this.log('字幕攔截模式初始化中...');

    try {
      // 獲取 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');
      this.configBridge = configBridge;

      // 一次性獲取所有需要的配置（從本地緩存，無需 chrome API）
      this.debug = configBridge.get('debugMode');
      this.dualSubtitleEnabled = configBridge.get('subtitle.dualModeEnabled');
      this.primaryLanguage = configBridge.get('subtitle.primaryLanguage');
      this.secondaryLanguage = configBridge.get('subtitle.secondaryLanguage');

      this.log(`配置已載入: debug=${this.debug}, dualMode=${this.dualSubtitleEnabled}, primary=${this.primaryLanguage}, secondary=${this.secondaryLanguage}`);

      // 訂閱配置變更（通過 messaging 接收通知）
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log('調試模式已更新:', newValue);
      });

      configBridge.subscribe('subtitle.dualModeEnabled', (newValue) => {
        this.dualSubtitleEnabled = newValue;
        this.log('雙語字幕開關已更新:', newValue);
        if (this.isActive) {
          this.loadInterceptedSubtitles(); // 重新載入字幕
        }
      });

      configBridge.subscribe('subtitle.primaryLanguage', (newValue) => {
        this.primaryLanguage = newValue;
        this.log('主要語言已更新:', newValue);
        if (this.isActive) {
          this.loadInterceptedSubtitles();
        }
      });

      configBridge.subscribe('subtitle.secondaryLanguage', (newValue) => {
        this.secondaryLanguage = newValue;
        this.log('次要語言已更新:', newValue);
        if (this.isActive) {
          this.loadInterceptedSubtitles();
        }
      });

      this.bindTtmlAcquisitionIngress();

      // 設置事件處理器
      this.setupEventHandlers();

      // 播放器與字幕語言列表在 Netflix SPA 換片時可能暫時不可讀。
      // 初始化攔截器只需要完成事件與設定綁定；字幕資料交給後續 reload/retry 補齊。
      await this.waitForPlayerReady();

      this.isInitialized = true;
      this.log('字幕攔截模式初始化完成');

    } catch (error) {
      console.error('字幕攔截模式初始化失敗:', error);
      throw error;
    }
  }

  start() {
    if (this.isActive) {
      this.log('字幕攔截已經啟動，跳過');
      return;
    }
    
    if (!this.isInitialized) {
      console.error('字幕攔截模式未初始化，無法啟動');
      return;
    }

    this.bindTtmlAcquisitionIngress();
    this.setupEventHandlers();
    
    this.log('啟動字幕攔截模式...');
    this.isActive = true;
    this.dispatchSubtitleReadinessChanged('interceptor-started-primary-not-ready');
    
    // ★ A: interceptor 啟動後立即嘗試啟動 primary discovery（不等 loadInterceptedSubtitles 完成）
    this.tryStartPrimaryDiscovery('interceptor-start');

    // 載入攔截的字幕數據
    this.loadInterceptedSubtitles();
    this.scheduleReloadAfterContextReady('interceptor-start', this.getCurrentPlaybackContext());
    
    // 開始渲染循環
    this.startRenderLoop();
    
    this.log('字幕攔截模式已啟動');
  }

  stop() {
    this.disposeInternalEventHandlers();
    this.disposeTtmlAcquisitionIngress();

    if (!this.isActive) {
      this.log('字幕攔截已經停止，跳過');
      return;
    }
    
    this.log('停止字幕攔截模式...');
    this.isActive = false;
    
    // 停止渲染循環
    this.stopRenderLoop();
    this.clearAcquisitionWaiters('interceptor-stopped');
    this.abortPrimaryDiscovery('interceptor-stopped');

    if (this.contextReloadTimer) {
      clearTimeout(this.contextReloadTimer);
      this.contextReloadTimer = null;
    }
    
    // 清理狀態
    this.currentTimestamp = 0;
    this.lastRenderedSubtitle = null;
    this._secondaryAcquisitionInFlight = null;
    this._hasSubpalEverShownSubtitle = false;
    this.dispatchSubtitleReadinessChanged('interceptor-stopped');
    
    this.log('字幕攔截模式已停止');
  }

  onSubtitleDetected(callback) {
    this.callback = callback;
    this.log('字幕檢測回調已註冊');
  }

  getTtmlAcquisitionIngress() {
    if (!this.ttmlAcquisitionIngress) {
      this.ttmlAcquisitionIngress = new TtmlAcquisitionIngress(this);
    }
    return this.ttmlAcquisitionIngress;
  }

  bindTtmlAcquisitionIngress() {
    const ingress = this.getTtmlAcquisitionIngress();
    if (!this.disposeTtmlAcquisitionCapture && typeof window !== 'undefined') {
      this.disposeTtmlAcquisitionCapture = bindTtmlAcquisitionCapture(window, this.ttmlAcquisitionIngress);
    }
    return ingress;
  }

  disposeTtmlAcquisitionIngress() {
    this.disposeTtmlAcquisitionCapture?.();
    this.disposeTtmlAcquisitionCapture = null;
    const ingress = this.ttmlAcquisitionIngress;
    this.ttmlAcquisitionIngress = null;
    ingress?.dispose();
  }

  captureRawTTMLEvidence(evidence, options) {
    const normalized = {
      cacheKey: evidence.cacheKey,
      rawContent: evidence.rawContent,
      language: evidence.language,
      requestInfo: evidence.requestInfo,
      source: 'netflix-page-script'
    };
    if (evidence.rawMetadata !== undefined) normalized.rawMetadata = evidence.rawMetadata;
    if (evidence.metadata !== undefined) normalized.metadata = evidence.metadata;
    return this.getTtmlAcquisitionIngress().capture(normalized, options);
  }

  getReadyPlaybackRequest() {
    try {
      const context = playbackContextManager.getCurrentContext();
      if (context?.state !== 'ready' || !context.videoId || !context.sessionId?.startsWith('watch-') ||
          !Number.isInteger(context.epoch) || context.epoch < 0) {
        return null;
      }

      const playback = playbackContextManager.getPlayback();
      if (!playback || typeof playback.perform !== 'function') {
        return null;
      }

      return {
        playback,
        expected: {
          videoId: context.videoId,
          sessionId: context.sessionId,
          epoch: context.epoch
        }
      };
    } catch (error) {
      return null;
    }
  }

  async performPlayback(variant, payload) {
    const request = this.getReadyPlaybackRequest();
    if (!request) {
      return {
        ok: false,
        error: { kind: 'stale-context', code: 'playback-context-not-ready', retryable: true }
      };
    }

    try {
      const result = await request.playback.perform({ variant, payload, expected: request.expected });
      if (result?.ok && result.value?.variant === variant) {
        return result;
      }
      return result?.ok ? {
        ok: false,
        error: { kind: 'domain-rejected', code: 'invalid-playback-response', retryable: false }
      } : result;
    } catch (error) {
      return {
        ok: false,
        error: { kind: 'domain-rejected', code: 'invalid-playback-response', retryable: false }
      };
    }
  }

  getPlaybackFailureCode(result, fallback) {
    return result?.error?.code || fallback;
  }

  // 等待播放器準備就緒（簡化版本，假設播放器助手已在 initialization-manager 中初始化）
  async waitForPlayerReady() {
    this.log('檢查播放器準備狀態...');
    const result = await this.performPlayback('available-languages', {});
    const languages = result?.ok ? result.value.languages : [];
    if (Array.isArray(languages) && languages.length > 0) {
      this.log('播放器已準備就緒，可用語言:', languages.map(language => language.code));
      return true;
    }

    const reason = this.getPlaybackFailureCode(result, 'player-not-ready');
    this.log('播放器暫時未準備就緒:', reason);
    this.recordDebugEvent('PLAYER_SOFT_NOT_READY', {
      reason,
      languagesCount: languages.length
    });
    return false;
  }

  // 載入攔截的字幕數據（優化流程：緩存檢查優先 -> 智能語言切換 -> 恢復設定）
  async loadInterceptedSubtitles() {
    // ★ A: 在 acquisition 前嘗試啟動 primary discovery，避免太晚接管
    // 此時 context 可能已 ready，primary slot 尚未 ready → 適合提早啟動 DOM match
    this.tryStartPrimaryDiscovery('early-load-intercepted');

    if (this.isLoadingInterceptedSubtitles) {
      this.log('字幕數據載入中，跳過重複請求');
      this.pendingLoadInterceptedSubtitles = true;
      this.pendingLoadReason = 'load-request-during-active-load';
      this.recordDebugEvent('LOAD_INTERCEPTED_SUBTITLES_DEFERRED', {
        reason: this.pendingLoadReason
      });
      return;
    }

    this.isLoadingInterceptedSubtitles = true;
    this.log('載入攔截的字幕數據...');
    
    try {
      // 階段1: 緩存檢查與分析
      await this.checkExistingCache();
      
      // 階段2: 記錄 Netflix 預設語言
      const defaultLanguage = await this.recordDefaultLanguage();
      
      // 階段3: 逐一確保目標語言存在有效 watch-session TTML。
      // ensureLanguageAvailable 會先用 parsed/raw cache，再必要時切換或 refresh Netflix 字幕軌。
      await this.ensureLanguageAvailable(this.primaryLanguage, 'primary', { defaultLanguage });
      if (this.dualSubtitleEnabled) {
        await this.ensureSecondaryLanguageAvailableOnce('load-intercepted-subtitles', { defaultLanguage });
      }

      // 階段4: 切回預設語言
      // ★ D: 若 secondary acquisition 仍在進行中，延後 restore 避免干擾 track switching
      if (this._secondaryAcquisitionInFlight) {
        this.recordDebugEvent('DEFAULT_LANGUAGE_RESTORE_DEFERRED_SECONDARY_IN_FLIGHT', {
          inFlightKey: this._secondaryAcquisitionInFlight.key
        });
        try {
          await this._secondaryAcquisitionInFlight.promise;
        } catch (e) {
          // 即使失敗仍繼續 restore
        }
      }
      await this.restoreDefaultLanguage(defaultLanguage);
      
      this.log('字幕數據載入完成，已恢復用戶原始設定');
      
    } catch (error) {
      console.error('載入字幕數據失敗:', error);
      throw error;
    } finally {
      this.isLoadingInterceptedSubtitles = false;
      // 載入完成後檢查是否需啟動 primary discovery
      this.tryStartPrimaryDiscovery();
      if (this.pendingLoadInterceptedSubtitles && this.isActive) {
        const pendingReason = this.pendingLoadReason;
        this.pendingLoadInterceptedSubtitles = false;
        this.pendingLoadReason = null;
        this.recordDebugEvent('LOAD_INTERCEPTED_SUBTITLES_PENDING_RETRY', {
          reason: pendingReason
        });
        setTimeout(() => {
          this.loadInterceptedSubtitles().catch(error => {
            console.error('延遲重跑字幕載入失敗:', error);
          });
        }, 0);
      }
    }
  }

  /**
   * 檢查已緩存的 TTML 數據 - 增加 videoID 驗證
   */
  async checkExistingCache() {
    const rawPoolResult = await this.getTtmlAcquisitionIngress().readRawPool();
    if (rawPoolResult?.ok) {
      const existingTTMLs = rawPoolResult.value.entries;
      this.log('發現已緩存的TTML數據，開始驗證和處理...');
      
      // 獲取當前影片 ID 用於驗證
      const currentVideoId = this.getCurrentPlaybackContext().videoId || getVideoId();
      if (!currentVideoId) {
        this.log('無法獲取當前影片 ID，跳過緩存檢查');
        return new Map();
      }
      
      const needsProcessing = [];
      const validCacheData = new Map();
      let skippedWrongVideo = 0;
      let skippedAlreadyProcessed = 0;
      let reprocessedStale = 0;
      
      Object.entries(existingTTMLs).forEach(([cacheKey, ttmlData]) => {
        // 步驟1: 解析緩存鍵驗證 videoID  
        const parsedKey = this.parseCacheKey(cacheKey);
        if (!parsedKey) {
          this.log(`跳過無效緩存鍵: ${cacheKey}`);
          return;
        }
        
        // 步驟2: 檢查是否屬於目前 PlaybackContext
        const gate = this.evaluateSubtitleGate(cacheKey, ttmlData.requestInfo);
        if (!gate.accepted) {
          this.log(`跳過不符合目前 PlaybackContext 的緩存: ${cacheKey}`, gate);
          this.recordDebugEvent('CACHE_SKIPPED_BY_GATE', {
            cacheKey,
            language: ttmlData.language,
            gate
          });
          if (gate.reason === 'playback-context-transitioning') {
            this.scheduleReloadAfterContextReady('cache-gate-transitioning', this.getCurrentPlaybackContext());
          }
          skippedWrongVideo++;
          return;
        }
        
        // 步驟3: 檢查是否已經處理過；Netflix 可能重用同一 cache key，
        // 因此已解析資料若屬於舊 PlaybackContext，必須重新 parse raw TTML。
        if (this.interceptedSubtitles.has(cacheKey)) {
          const existingData = this.interceptedSubtitles.get(cacheKey);
          const hasParsedSubtitleData = Array.isArray(existingData?.subtitles) &&
            existingData.subtitles.length > 0 &&
            existingData.timeIndex &&
            existingData.playbackContext;

          if (!hasParsedSubtitleData || !this.isSubtitleEntryCurrent(cacheKey, existingData)) {
            this.log(`已處理緩存已過期，重新處理 raw TTML: ${cacheKey}`);
            this.recordDebugEvent('CACHE_REPROCESS_STALE_ENTRY', {
              cacheKey,
              language: ttmlData.language,
              hasParsedSubtitleData,
              existingPlaybackContext: existingData?.playbackContext || null,
              currentPlaybackContext: this.getCurrentPlaybackContext()
            });
            needsProcessing.push({ cacheKey, ttmlData });
            validCacheData.set(ttmlData.language, ttmlData);
            reprocessedStale++;
            return;
          }

          this.log(`跳過已處理的緩存: ${cacheKey}`);
          skippedAlreadyProcessed++;
          // 但仍要加入 validCacheData 用於狀態分析
          validCacheData.set(ttmlData.language, ttmlData);
          return;
        }
        
        // 步驟4: 標記需要處理的數據
        needsProcessing.push({ cacheKey, ttmlData });
        validCacheData.set(ttmlData.language, ttmlData);
      });
      
      // 處理有效的新數據
      needsProcessing.forEach(({ cacheKey, ttmlData }) => {
        this.captureRawTTMLEvidence({
          cacheKey: cacheKey,
          rawContent: ttmlData.rawContent,
          requestInfo: ttmlData.requestInfo,
          rawMetadata: ttmlData.rawMetadata || ttmlData.metadata || ttmlData.requestInfo?.rawTtmlMetadata || null,
          metadata: ttmlData.metadata || ttmlData.rawMetadata || null,
          language: ttmlData.language
        });
      });
      
      this.log(`✅ 緩存檢查完成:`, {
        處理新數據: needsProcessing.length,
        跳過已處理: skippedAlreadyProcessed,
        重新處理過期: reprocessedStale,
        跳過其他影片: skippedWrongVideo,
        當前影片ID: currentVideoId,
        有效語言: Array.from(validCacheData.keys())
      });
      
      return validCacheData;
    }

    this.recordDebugEvent('RAW_TTML_CACHE_READ_FAILED', {
      reason: this.getPlaybackFailureCode(rawPoolResult, 'ttml-raw-pool-unavailable')
    });
    return new Map();
  }

  /**
   * 診斷 page script raw TTML cache：逐筆檢查 gate 與 parse 結果。
   * 可在 Netflix console 執行：
   * await window.subpalApp?.components?.subtitleCoordinator?.interceptor?.debugRawTTMLCache()
   */
  async debugRawTTMLCache() {
    const rawPoolResult = await this.getTtmlAcquisitionIngress().readRawPool();
    if (!rawPoolResult?.ok) {
      const result = {
        success: false,
        error: 'page-raw-cache-unavailable'
      };
      this.recordDebugEvent('RAW_TTML_CACHE_DIAGNOSTIC_FAILED', result);
      return result;
    }

    const context = this.getCurrentPlaybackContext();
    const entries = Object.entries(rawPoolResult.value.entries).map(([cacheKey, data]) => {
      const rawContent = data?.rawContent || '';
      const gate = this.evaluateSubtitleGate(cacheKey, data?.requestInfo);
      const requestInfo = data?.requestInfo || {};
      let parse = {
        ok: false,
        subtitleCount: 0,
        regionCount: 0,
        firstSubtitle: null,
        lastSubtitle: null,
        error: null
      };

      try {
        const parseResult = parseSubtitle(rawContent);
        const subtitles = parseResult?.subtitles || [];
        parse = {
          ok: true,
          subtitleCount: subtitles.length,
          regionCount: Object.keys(parseResult?.regionConfigs || {}).length,
          firstSubtitle: subtitles[0] ? {
            startTime: subtitles[0].startTime,
            endTime: subtitles[0].endTime
          } : null,
          lastSubtitle: subtitles.length > 0 ? {
            startTime: subtitles[subtitles.length - 1].startTime,
            endTime: subtitles[subtitles.length - 1].endTime
          } : null,
          error: null
        };
      } catch (error) {
        parse = {
          ...parse,
          error: 'parse-error'
        };
      }

      return {
        cacheKey,
        language: data?.language || null,
        rawMetadata: data?.rawMetadata || data?.metadata || data?.requestInfo?.rawTtmlMetadata || null,
        rawLength: rawContent.length,
        hasXmlDeclaration: rawContent.includes('<?xml'),
        hasTTElement: rawContent.includes('<tt'),
        paragraphTagCount: (rawContent.match(/<p[\s>]/g) || []).length,
        gate,
        parse,
        requestInfo: {
          source: requestInfo.source || requestInfo.type || null,
          requestUrl: requestInfo.requestUrl || requestInfo.url || null,
          manifestVideoIdAtRequest: requestInfo.manifestVideoIdAtRequest || requestInfo.manifestVideoId || null,
          activePlayerVideoIdAtRequest: requestInfo.activePlayerVideoIdAtRequest || null,
          pageUrlVideoIdAtRequest: requestInfo.pageUrlVideoIdAtRequest || null,
          currentTrackAtRequest: requestInfo.currentTrackAtRequest || null,
          sessionIdAtRequest: requestInfo.sessionIdAtRequest || null,
          derivedSubtitleVideo: requestInfo.derivedSubtitleVideo || null,
          // attribution 診斷欄位
          attributionReason: requestInfo.attributionReason || null,
          attributedVideoId: requestInfo.attributedVideoId || null,
          overlapScore: requestInfo.overlapScore || null
        }
      };
    });

    const result = {
      success: true,
      context,
      primaryLanguage: this.primaryLanguage,
      secondaryLanguage: this.secondaryLanguage,
      activeSubtitleCounts: {
        primary: this.primarySubtitles.length,
        secondary: this.secondarySubtitles.length
      },
      interceptedSubtitleCacheKeys: Array.from(this.interceptedSubtitles.keys()),
      rawEntryCount: entries.length,
      entries
    };

    this.recordDebugEvent('RAW_TTML_CACHE_DIAGNOSTIC', {
      rawEntryCount: entries.length,
      summary: entries.map(entry => ({
        cacheKey: entry.cacheKey,
        language: entry.language,
        rawLength: entry.rawLength,
        gateAccepted: entry.gate.accepted,
        gateReason: entry.gate.reason,
        subtitleCount: entry.parse.subtitleCount,
        parseError: entry.parse.error
      }))
    });

    return result;
  }

  /**
   * 分析緩存狀態
   */
  analyzeCacheStatus(existingCache) {
    // 使用 base-code fallback 檢查緩存（如 "zh" 匹配 "zh-Hant"）
    const hasPrimary = Array.from(existingCache.keys()).some(k => this.matchesLanguageForAcquisition(k, this.primaryLanguage));
    const hasSecondary = Array.from(existingCache.keys()).some(k => this.matchesLanguageForAcquisition(k, this.secondaryLanguage));
    
    const status = {
      hasPrimary,
      hasSecondary,
      availableLanguages: Array.from(existingCache.keys()),
      needsPrimary: !hasPrimary,
      needsSecondary: this.dualSubtitleEnabled && !hasSecondary
    };
    
    this.log('緩存狀態分析:', {
      主要語言: `${this.primaryLanguage} (${hasPrimary ? '已緩存' : '需要獲取'})`,
      次要語言: `${this.secondaryLanguage} (${hasSecondary ? '已緩存' : this.dualSubtitleEnabled ? '需要獲取' : '不需要'})`,
      可用語言: status.availableLanguages
    });
    
    return status;
  }

  /**
   * 記錄 Netflix 預設語言
   */
  async recordDefaultLanguage() {
    const result = await this.performPlayback('current-language', {});
    const defaultLanguage = result?.ok ? result.value.language?.code : undefined;
    if (!result?.ok) {
      this.recordDebugEvent('LANGUAGE_ACQUISITION_CURRENT_LANGUAGE_FAILED', {
        error: this.getPlaybackFailureCode(result, 'current-language-unavailable')
      });
    }
    this.log('記錄Netflix預設語言:', defaultLanguage);
    return defaultLanguage;
  }

  /**
   * 根據緩存狀態決定策略
   */
  determineStrategy(cacheStatus) {
    if (!cacheStatus.needsPrimary && !cacheStatus.needsSecondary) {
      return 'USE_CACHE_ONLY';  // 所有需要的都有了
    }
    
    if (cacheStatus.needsPrimary && cacheStatus.needsSecondary) {
      return 'FETCH_BOTH';  // 需要獲取兩種語言
    }
    
    if (cacheStatus.needsPrimary) {
      return 'FETCH_PRIMARY';  // 只需要主要語言
    }
    
    if (cacheStatus.needsSecondary) {
      return 'FETCH_SECONDARY';  // 只需要次要語言
    }
    
    return 'USE_CACHE_ONLY';  // 預設策略
  }

  /**
   * 執行字幕獲取策略
   */
  async executeStrategy(strategy, defaultLanguage) {
    switch (strategy) {
      case 'USE_CACHE_ONLY':
        this.log('使用緩存數據，無需語言切換');
        break;
        
      case 'FETCH_PRIMARY':
        this.log('只需要獲取主要語言');
        await this.fetchLanguageIfNeeded(this.primaryLanguage, defaultLanguage);
        break;
        
      case 'FETCH_SECONDARY':
        this.log('只需要獲取次要語言');
        await this.fetchLanguageIfNeeded(this.secondaryLanguage, defaultLanguage);
        break;
        
      case 'FETCH_BOTH':
        this.log('需要獲取兩種語言');
        await this.fetchLanguageIfNeeded(this.primaryLanguage, defaultLanguage);
        await this.fetchLanguageIfNeeded(this.secondaryLanguage, defaultLanguage);
        break;
    }
  }

  /**
   * 智能語言切換：只在需要時切換
   */
  async fetchLanguageIfNeeded(languageCode, defaultLanguage) {
    // 檢查是否已經是目標語言
    if (defaultLanguage === languageCode) {
      this.log(`已經是 ${languageCode}，無需切換`);
      // 但仍要等待可能的攔截事件
      await this.waitForInterception(languageCode);
      // 重要：等待後需要從緩存載入字幕數據到對應的屬性
      const type = this.resolveLanguageRole(languageCode, 'auto');
      await this.loadLanguageDataFromCache(languageCode, type);
    } else {
      this.log(`切換到 ${languageCode}`);
      await this.loadSubtitleForLanguage(languageCode, 'auto');
    }
  }

  /**
   * 同一語言可能同時存在 Netflix 預載/短片段/完整影片 TTML。
   * 優先選目前時間能命中的資料，避免第一筆短片段 cache 讓字幕被誤判為空。
   */
  selectBestLanguageCacheEntry(languageCode) {
    const currentTime = getCurrentTimestamp();
    const candidates = [];

    for (const [cacheKey, data] of this.interceptedSubtitles.entries()) {
      const keyLang = cacheKey.split('_')[0];
      if (!this.matchesLanguageForAcquisition(keyLang, languageCode) || !this.isSubtitleEntryCurrent(cacheKey, data)) {
        continue;
      }

      const subtitles = Array.isArray(data?.subtitles) ? data.subtitles : [];
      let subtitleAtCurrentTime = null;
      if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
        try {
          subtitleAtCurrentTime = data.timeIndex ?
            findSubtitleByTimeIndex(data.timeIndex, currentTime) :
            findSubtitleByTime(subtitles, currentTime);
        } catch (error) {
          this.log(`評估 ${cacheKey} 當前時間字幕失敗:`, error);
        }
      }

      const requestInfo = data?.requestInfo || {};
      const attributionReason = requestInfo.attributionReason || null;
      const overlapScore = requestInfo.overlapScore || 0;

      candidates.push({
        cacheKey,
        data,
        hasCurrentSubtitle: !!subtitleAtCurrentTime,
        subtitleCount: subtitles.length,
        requestTime: data?.requestInfo?.requestTime || data?.timestamp || 0,
        // DOM match 排序資訊
        attributionReason,
        overlapScore,
        gateReason: data?.gate?.reason || null,
        parsedVideoId: data?.gate?.parsedVideoId || null,
        attributedVideoId: requestInfo.attributedVideoId || null
      });
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      // DOM match 優先，次依 overlapScore
      const aDomMatch = a.attributionReason === 'native-dom-match' ? 1 : 0;
      const bDomMatch = b.attributionReason === 'native-dom-match' ? 1 : 0;
      if (aDomMatch !== bDomMatch) {
        return bDomMatch - aDomMatch;
      }
      if (aDomMatch && bDomMatch && a.overlapScore !== b.overlapScore) {
        return b.overlapScore - a.overlapScore;
      }
      // 既有排序條件
      if (a.hasCurrentSubtitle !== b.hasCurrentSubtitle) {
        return a.hasCurrentSubtitle ? -1 : 1;
      }
      if (a.subtitleCount !== b.subtitleCount) {
        return b.subtitleCount - a.subtitleCount;
      }
      return b.requestTime - a.requestTime;
    });

    const selected = candidates[0];
    this.recordDebugEvent('LANGUAGE_CACHE_SELECTED', {
      languageCode,
      selectedCacheKey: selected.cacheKey,
      currentTime,
      selectedAttributionReason: selected.attributionReason,
      selectedOverlapScore: selected.overlapScore,
      selectedGateReason: selected.gateReason,
      selectedParsedVideoId: selected.parsedVideoId,
      selectedAttributedVideoId: selected.attributedVideoId,
      candidates: candidates.map(candidate => ({
        cacheKey: candidate.cacheKey,
        hasCurrentSubtitle: candidate.hasCurrentSubtitle,
        subtitleCount: candidate.subtitleCount,
        requestTime: candidate.requestTime,
        attributionReason: candidate.attributionReason,
        overlapScore: candidate.overlapScore,
        gateReason: candidate.gateReason,
        parsedVideoId: candidate.parsedVideoId,
        attributedVideoId: candidate.attributedVideoId
      })).slice(0, 10)
    });

    return selected;
  }

  /**
   * 從緩存載入語言數據（不觸發語言切換）
   */
  async loadLanguageDataFromCache(languageCode, type) {
    try {
      this.log(`從緩存載入 ${languageCode} (${type}) 字幕數據...`);

      const selectedEntry = this.selectBestLanguageCacheEntry(languageCode);
      const matchedKey = selectedEntry?.cacheKey || null;
      
      if (!matchedKey) {
        this.log(`未找到 ${languageCode} 的緩存數據，可用鍵:`, Array.from(this.interceptedSubtitles.keys()));
        this.lastSubtitleMissingReasons[type] = 'no-parsed-language-cache';
        this.recordDebugEvent('LANGUAGE_CACHE_MISSING', {
          slot: type,
          languageCode,
          reason: this.lastSubtitleMissingReasons[type],
          availableCacheKeys: Array.from(this.interceptedSubtitles.keys())
        });
        this.dispatchSubtitleReadinessChanged('language-cache-missing', { slot: type, languageCode });
        return;
      }
      
      const languageData = selectedEntry.data;
      if (!languageData || !languageData.subtitles) {
        this.log(`${languageCode} 緩存數據無效`);
        this.lastSubtitleMissingReasons[type] = 'invalid-parsed-language-cache';
        this.dispatchSubtitleReadinessChanged('invalid-language-cache', { slot: type, languageCode });
        return;
      }
      
      const subtitles = languageData.subtitles;
      this.log(`從緩存載入 ${languageCode} 的 ${subtitles.length} 個字幕條目`);
      
      if (subtitles.length > 0) {
        const timeIndex = languageData.timeIndex;
        
        // 儲存到對應的屬性
        if (type === 'primary') {
          this.primarySubtitles = subtitles;
          this.primaryTimeIndex = timeIndex;
          this.primarySubtitleMeta = this.createSubtitleSlotMeta(matchedKey, languageData);
          this.lastSubtitleMissingReasons.primary = null;
          this.dispatchSubtitleReadinessChanged('primary-cache-loaded', { slot: type, languageCode, cacheKey: matchedKey });
        } else if (type === 'secondary') {
          this.secondarySubtitles = subtitles;
          this.secondaryTimeIndex = timeIndex;
          this.secondarySubtitleMeta = this.createSubtitleSlotMeta(matchedKey, languageData);
          this.lastSubtitleMissingReasons.secondary = null;
          this.dispatchSubtitleReadinessChanged('secondary-cache-loaded', { slot: type, languageCode, cacheKey: matchedKey });
        }
        
        this.log(`${languageCode} (${type}) 字幕從緩存載入完成`);
      }
    } catch (error) {
      console.error(`從緩存載入 ${languageCode} 字幕時出錯:`, error);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isLanguageSlotReady(languageCode, role) {
    this.ensureActiveSubtitleSlotsCurrent();

    const subtitles = role === 'primary' ? this.primarySubtitles : this.secondarySubtitles;
    const meta = role === 'primary' ? this.primarySubtitleMeta : this.secondarySubtitleMeta;
    if (!Array.isArray(subtitles) || subtitles.length === 0 || !meta) {
      return false;
    }

    if (!this.isSubtitleSlotMetaCurrent(meta)) {
      return false;
    }

    const parsedLanguage = this.parseCacheKey(meta.cacheKey || '')?.language;
    return this.matchesLanguageForAcquisition(parsedLanguage, languageCode);
  }

  setLanguageAcquisitionResult(role, result) {
    const normalized = {
      role,
      timestamp: Date.now(),
      ...result
    };
    this.lastAcquisitionResults[role] = normalized;

    if (!normalized.success && normalized.reason) {
      this.lastSubtitleMissingReasons[role] = normalized.reason;
      this.dispatchSubtitleReadinessChanged('language-acquisition-failed', {
        slot: role,
        languageCode: normalized.languageCode,
        failureReason: normalized.reason
      });
    }

    return normalized;
  }

  async tryLoadLanguageFromCaches(languageCode, role, reason) {
    await this.checkExistingCache();
    await this.loadLanguageDataFromCache(languageCode, role);

    const ready = this.isLanguageSlotReady(languageCode, role);
    this.recordDebugEvent('LANGUAGE_ACQUISITION_CACHE_CHECK', {
      role,
      languageCode,
      reason,
      ready,
      subtitleCount: role === 'primary' ? this.primarySubtitles.length : this.secondarySubtitles.length
    });

    return ready;
  }

  /**
   * Idempotent secondary acquisition helper。
   * 確保同 videoId/epoch/language 下只進行一次 secondary track switching，
   * 避免重複切換造成 flicker/卡頓。
   *
   * @param {string} reason - 觸發原因（用於 debug event）
   * @param {Object} [options] - 傳給 ensureLanguageAvailable 的選項
   * @returns {Promise<Object>} { success, reason, ... }
   */
  async ensureSecondaryLanguageAvailableOnce(reason, options = {}) {
    // 1. Dual subtitle disabled → skip
    if (!this.dualSubtitleEnabled) {
      this.recordDebugEvent('SECONDARY_ACQUISITION_SKIPPED_DISABLED', { reason });
      return { success: false, reason: 'dual-subtitle-disabled' };
    }

    // 2. Secondary language 未設定 → skip
    if (!this.secondaryLanguage) {
      this.recordDebugEvent('SECONDARY_ACQUISITION_SKIPPED_INVALID_CONTEXT', {
        reason,
        missingField: 'secondaryLanguage'
      });
      return { success: false, reason: 'missing-secondary-language' };
    }

    const context = this.getCurrentPlaybackContext();

    // 3. Secondary slot already ready for current context → 不回傳 success 以外的資訊，不切 track
    if (this.isLanguageSlotReady(this.secondaryLanguage, 'secondary')) {
      this.recordDebugEvent('SECONDARY_ACQUISITION_SKIPPED_READY', { reason, context });
      return { success: true, source: 'already-ready', reason };
    }

    // 4. Primary 未 ready → 禁止 secondary track switching
    // 避免 primary 接管畫面前切換 track 造成 native subtitle 閃爍或空窗
    if (!this.isLanguageSlotReady(this.primaryLanguage, 'primary')) {
      this.recordDebugEvent('SECONDARY_ACQUISITION_DEFERRED_PRIMARY_NOT_READY', {
        reason,
        primaryLanguage: this.primaryLanguage,
        secondaryLanguage: this.secondaryLanguage
      });
      return { success: false, reason: 'deferred-primary-not-ready' };
    }

    // 5. Context 無效 → skip
    if (!context.videoId || context.videoId === 'unknown' || context.state === 'transitioning') {
      this.recordDebugEvent('SECONDARY_ACQUISITION_SKIPPED_INVALID_CONTEXT', {
        reason,
        contextState: context.state,
        videoId: context.videoId
      });
      return { success: false, reason: 'invalid-context' };
    }

    // 6. In-flight key 檢查（videoId + epoch + language）
    const epoch = context.epoch ?? 'null';
    const inFlightKey = `${context.videoId}|${epoch}|${this.secondaryLanguage}`;

    this.recordDebugEvent('SECONDARY_ACQUISITION_REQUESTED', { reason, inFlightKey, context });

    if (this._secondaryAcquisitionInFlight &&
        this._secondaryAcquisitionInFlight.key === inFlightKey) {
      // 同一 key 已有 in-flight → reuse
      this.recordDebugEvent('SECONDARY_ACQUISITION_REUSED_IN_FLIGHT', {
        reason,
        inFlightKey,
        context
      });
      return await this._secondaryAcquisitionInFlight.promise;
    }

    // 6. 建立新的 in-flight record
    const inFlightRecord = {
      key: inFlightKey,
      language: this.secondaryLanguage,
      promise: null
    };
    this._secondaryAcquisitionInFlight = inFlightRecord;

    this.recordDebugEvent('SECONDARY_ACQUISITION_STARTED', { reason, inFlightKey, context });

    const acquisitionPromise = (async () => {
      // ★ 擷取 starting track 供 restore 使用
      const startTrack = await this.captureCurrentNetflixTrack();
      try {
        const result = await this.ensureLanguageAvailable(this.secondaryLanguage, 'secondary', options);
        this.recordDebugEvent('SECONDARY_ACQUISITION_COMPLETED', {
          ...result,
          reason,
          inFlightKey
        });

        // ★ 若 acquisition 失敗，嘗試 secondary DOM recovery（fallback-only）
        if (!result.success) {
          const failureReason = result.reason || '';
          const diagnosis = result.diagnosis;
          const gateCounts = diagnosis?.gateReasonCounts || {};
          const isEligibleForRecovery =
            failureReason === 'switch-track-timeout' ||
            (gateCounts['evidence-video-mismatch'] || 0) > 0 ||
            (gateCounts['cache-key-video-mismatch'] || 0) > 0;

          if (isEligibleForRecovery) {
            try {
              await this.trySecondaryDomRecovery('post-acquisition-failure', {
                ...options,
                startTrack
              });
            } catch (recoveryError) {
              this.log('Secondary DOM recovery error:', recoveryError.message);
            }
          }
        }

        return result;
      } catch (error) {
        this.recordDebugEvent('SECONDARY_ACQUISITION_COMPLETED', {
          success: false,
          error: error.message,
          reason,
          inFlightKey
        });
        return { success: false, error: error.message, reason: 'exception' };
      } finally {
        // ★ 還原 starting track（優先使用 trackId 精確恢復）
        await this.restoreNetflixTrack(startTrack, options.defaultLanguage || this.primaryLanguage, 'secondary-acquisition-finally');
        // 只清掉同一筆 record，避免新一筆被舊 promise finally 清掉
        if (this._secondaryAcquisitionInFlight === inFlightRecord) {
          this._secondaryAcquisitionInFlight = null;
        }
      }
    })();

    inFlightRecord.promise = acquisitionPromise;
    return await acquisitionPromise;
  }

  async ensureLanguageAvailable(languageCode, role, options = {}) {
    const startedAt = Date.now();
    const context = this.getCurrentPlaybackContext();

    this.recordDebugEvent('LANGUAGE_ACQUISITION_STARTED', {
      role,
      languageCode,
      context,
      defaultLanguage: options.defaultLanguage || null
    });

    if (context.state === 'transitioning') {
      this.scheduleReloadAfterContextReady('language-acquisition-context-transitioning', context);
      return this.setLanguageAcquisitionResult(role, {
        success: false,
        languageCode,
        reason: 'playback-context-transitioning',
        context,
        durationMs: Date.now() - startedAt
      });
    }

    if (!context.videoId || context.videoId === 'unknown') {
      return this.setLanguageAcquisitionResult(role, {
        success: false,
        languageCode,
        reason: 'missing-current-video-id',
        context,
        durationMs: Date.now() - startedAt
      });
    }

    if (await this.tryLoadLanguageFromCaches(languageCode, role, 'initial-cache-check')) {
      return this.setLanguageAcquisitionResult(role, {
        success: true,
        languageCode,
        source: 'cache',
        durationMs: Date.now() - startedAt
      });
    }

    if (role === 'secondary' && !this.isLanguageSlotReady(this.primaryLanguage, 'primary')) {
      this.recordDebugEvent('SECONDARY_TRACK_SWITCH_BLOCKED_PRIMARY_NOT_READY', {
        languageCode,
        context,
        primaryLanguage: this.primaryLanguage
      });
      return this.setLanguageAcquisitionResult(role, {
        success: false,
        languageCode,
        reason: 'deferred-primary-not-ready',
        context,
        durationMs: Date.now() - startedAt
      });
    }

    const currentLanguage = await this.getCurrentNetflixLanguage();
    const currentMatchesTarget = this.matchesLanguageForAcquisition(currentLanguage?.code, languageCode);
    const trackAcquisition = currentMatchesTarget ?
      await this.refreshLanguageTrack(languageCode, role, currentLanguage, options) :
      await this.switchLanguageAndWait(languageCode, role, {
        reason: 'target-language-not-current',
        timeoutMs: 10000
      });

    if (trackAcquisition.ready || await this.tryLoadLanguageFromCaches(languageCode, role, 'post-track-acquisition-cache-check')) {
      return this.setLanguageAcquisitionResult(role, {
        success: true,
        languageCode,
        source: currentMatchesTarget ? 'track-refresh' : 'track-switch',
        currentLanguage,
        durationMs: Date.now() - startedAt
      });
    }

    const diagnosis = await this.diagnoseLanguageAvailability(languageCode, role);
    const directReason = trackAcquisition.reason && trackAcquisition.reason !== 'not-ready' ?
      trackAcquisition.reason :
      null;
    return this.setLanguageAcquisitionResult(role, {
      success: false,
      languageCode,
      reason: directReason || diagnosis.reason,
      currentLanguage,
      diagnosis,
      trackAcquisition,
      durationMs: Date.now() - startedAt
    });
  }

  async getCurrentNetflixLanguage() {
    const result = await this.performPlayback('current-language', {});
    if (!result?.ok) {
      this.recordDebugEvent('LANGUAGE_ACQUISITION_CURRENT_LANGUAGE_FAILED', {
        error: this.getPlaybackFailureCode(result, 'current-language-unavailable')
      });
      return null;
    }
    return result.value.language || null;
  }

  async getAvailableNetflixLanguages() {
    const result = await this.performPlayback('available-languages', {});
    if (!result?.ok) {
      this.recordDebugEvent('LANGUAGE_ACQUISITION_AVAILABLE_LANGUAGES_FAILED', {
        error: this.getPlaybackFailureCode(result, 'available-languages-unavailable')
      });
      return [];
    }
    return Array.isArray(result.value.languages) ? result.value.languages : [];
  }

  /**
   * 擷取目前 Netflix active track（含完整欄位：code, trackId, trackType, rawTrackType, name）
   * @returns {Promise<Object|null>}
   */
  async captureCurrentNetflixTrack() {
    const result = await this.performPlayback('current-language', {});
    const track = result?.ok ? result.value.language : null;
    if (track?.code) {
      this.recordDebugEvent('SECONDARY_TRACK_CAPTURED', {
        code: track.code,
        trackId: track.trackId,
        trackType: track.trackType,
        rawTrackType: track.rawTrackType
      });
      return track;
    }
    if (!result?.ok) {
      this.recordDebugEvent('SECONDARY_TRACK_CAPTURE_FAILED', {
        error: this.getPlaybackFailureCode(result, 'current-language-unavailable')
      });
    }
    return null;
  }

  /**
   * 恢復 Netflix active track。
   * 優先使用 trackId 精確恢復；若失敗或 unsupported，降級為 language code 切換。
   * @param {Object|null} startTrack - 欲恢復的軌道（含 code, trackId 等）
   * @param {string|null} fallbackLanguage - 降級語言代碼
   * @param {string} reason - 診斷用原因
   */
  async restoreNetflixTrack(startTrack, fallbackLanguage, reason) {
    // 若無 startTrack，跳過 restore（null 可能代表字幕關閉或 track 不可用）
    if (!startTrack) {
      this.recordDebugEvent('SECONDARY_TRACK_RESTORE_SKIPPED_NO_START_TRACK', {
        reason,
        fallbackLanguage
      });
      return;
    }

    if (startTrack.trackId) {
      this.recordDebugEvent('SECONDARY_TRACK_RESTORE_STARTED', {
        reason,
        method: 'trackId',
        trackId: startTrack.trackId,
        code: startTrack.code
      });
      try {
        const result = await this.performPlayback('switch-track', { trackId: startTrack.trackId });
        if (!result?.ok) throw new Error(this.getPlaybackFailureCode(result, 'switch-track-failed'));
        this.recordDebugEvent('SECONDARY_TRACK_RESTORE_COMPLETED', {
          reason,
          method: 'trackId',
          trackId: startTrack.trackId
        });
        return;
      } catch (error) {
        this.recordDebugEvent('SECONDARY_TRACK_RESTORE_FAILED', {
          reason: 'trackId-switch-failed',
          error: error.message,
          startTrackCode: startTrack.code,
          fallbackLanguage
        });
        // 降級到 language code
      }
    }

    // 降級：使用 language code 或 fallbackLanguage
    const targetCode = startTrack?.code || fallbackLanguage;
    if (!targetCode) return;

    this.recordDebugEvent('SECONDARY_TRACK_RESTORE_STARTED', {
      reason,
      method: 'languageCode',
      code: targetCode
    });

    try {
      const result = await this.performPlayback('switch-language', { languageCode: targetCode });
      if (!result?.ok) throw new Error(this.getPlaybackFailureCode(result, 'switch-language-failed'));
      this.recordDebugEvent('SECONDARY_TRACK_RESTORE_COMPLETED', {
        reason,
        method: 'languageCode',
        code: targetCode
      });
    } catch (error) {
      this.recordDebugEvent('SECONDARY_TRACK_RESTORE_FAILED', {
        reason: 'language-switch-fallback-failed',
        error: error.message,
        targetCode
      });
    }
  }

  /**
   * 檢查 Netflix track list 是否包含指定語言
   * @param {string} languageCode
   * @returns {Promise<boolean>}
   */
  async hasAvailableNetflixLanguage(languageCode) {
    const languages = await this.getAvailableNetflixLanguages();
    return languages.some(lang => this.matchesLanguageForAcquisition(lang.code, languageCode));
  }

  /**
   * 檢查 raw TTML pool 是否有至少一筆候選符合指定語言
   * @param {string} languageCode
   * @returns {Promise<boolean>}
   */
  async hasRawTTMLCandidateForLanguage(languageCode) {
    const result = await this.getTtmlAcquisitionIngress().readRawPool();
    if (!result?.ok) {
      this.recordDebugEvent('RAW_TTML_CANDIDATE_CHECK_FAILED', {
        error: this.getPlaybackFailureCode(result, 'ttml-raw-pool-unavailable'),
        languageCode
      });
      return false;
    }
    return Object.values(result.value.entries).some(data =>
      this.matchesLanguageForAcquisition(data?.language, languageCode)
    );
  }

  findAlternateLanguage(targetLanguage, availableLanguages, preferredLanguage = null) {
    const candidates = (availableLanguages || [])
      .filter(language => language?.code && !this.matchesLanguageForAcquisition(language.code, targetLanguage));

    if (preferredLanguage) {
      const preferred = candidates.find(language => this.matchesLanguageForAcquisition(language.code, preferredLanguage));
      if (preferred) {
        return preferred;
      }
    }

    return candidates[0] || null;
  }

  resolveLanguageRole(languageCode, requestedRole = 'auto') {
    if (requestedRole === 'primary' || requestedRole === 'secondary') {
      return requestedRole;
    }

    if (this.matchesLanguageForAcquisition(languageCode, this.primaryLanguage)) {
      return 'primary';
    }

    if (this.matchesLanguageForAcquisition(languageCode, this.secondaryLanguage)) {
      return 'secondary';
    }

    return 'primary';
  }

  async switchNetflixLanguage(languageCode, reason) {
    this.recordDebugEvent('LANGUAGE_ACQUISITION_SWITCH_LANGUAGE', {
      languageCode,
      reason
    });

    const switchResult = await this.performPlayback('switch-language', { languageCode });

    if (!switchResult?.ok) {
      throw new Error(this.getPlaybackFailureCode(switchResult, `switch-language-failed-${languageCode}`));
    }

    await this.sleep(600);
    return switchResult;
  }

  async switchLanguageAndWait(languageCode, role, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    const reason = options.reason || 'switch-language';

    const waitPromise = this.waitForInterception(languageCode, timeoutMs);
    try {
      await this.switchNetflixLanguage(languageCode, reason);
    } catch (error) {
      this.clearAcquisitionWaiters('switch-language-failed');
      this.recordDebugEvent('LANGUAGE_ACQUISITION_SWITCH_FAILED', {
        role,
        languageCode,
        reason,
        error: error.message
      });
      this.lastSubtitleMissingReasons[role] = 'switch-track-timeout';
      return {
        ready: false,
        reason: 'switch-track-timeout',
        error: error.message
      };
    }

    const interception = await waitPromise;
    await this.tryLoadLanguageFromCaches(languageCode, role, `after-${reason}`);

    const ready = this.isLanguageSlotReady(languageCode, role);
    this.recordDebugEvent('LANGUAGE_ACQUISITION_SWITCH_RESULT', {
      role,
      languageCode,
      reason,
      ready,
      interception
    });

    if (!ready && interception?.reason === 'timeout') {
      this.lastSubtitleMissingReasons[role] = 'switch-track-timeout';
    }

    return {
      ready,
      reason: ready ? null : (interception?.reason === 'timeout' ? 'switch-track-timeout' : (interception?.reason || 'not-ready')),
      interception
    };
  }

  async refreshLanguageTrack(languageCode, role, currentLanguage, options = {}) {
    const availableLanguages = await this.getAvailableNetflixLanguages();
    const alternateLanguage = this.findAlternateLanguage(
      languageCode,
      availableLanguages,
      options.defaultLanguage
    );

    this.recordDebugEvent('LANGUAGE_ACQUISITION_REFRESH_STARTED', {
      role,
      languageCode,
      currentLanguage,
      alternateLanguage,
      availableLanguageCodes: availableLanguages.map(language => language.code)
    });

    if (alternateLanguage?.code) {
      try {
        await this.switchNetflixLanguage(alternateLanguage.code, 'refresh-away-from-target-language');
      } catch (error) {
        this.recordDebugEvent('LANGUAGE_ACQUISITION_REFRESH_AWAY_FAILED', {
          role,
          languageCode,
          alternateLanguage,
          error: error.message
        });
      }
    }

    return await this.switchLanguageAndWait(languageCode, role, {
      reason: alternateLanguage?.code ? 'refresh-back-to-target-language' : 'refresh-target-language-no-alternate',
      timeoutMs: 10000
    });
  }

  async diagnoseLanguageAvailability(languageCode, role = null) {
    const context = this.getCurrentPlaybackContext();
    const matchingParsedEntries = Array.from(this.interceptedSubtitles.entries())
      .filter(([, data]) => this.matchesLanguageForAcquisition(data?.language, languageCode));

    let rawEntries = [];
    let rawError = null;
    const rawPoolResult = await this.getTtmlAcquisitionIngress().readRawPool();
    if (rawPoolResult?.ok) {
      rawEntries = Object.entries(rawPoolResult.value.entries)
        .filter(([cacheKey, data]) => {
          const parsedKey = this.parseCacheKey(cacheKey);
          return this.matchesLanguageForAcquisition(data?.language || parsedKey?.language, languageCode);
        })
        .map(([cacheKey, data]) => ({
          cacheKey,
          language: data?.language || null,
          gate: this.evaluateSubtitleGate(cacheKey, data?.requestInfo)
        }));
    } else {
      rawError = this.getPlaybackFailureCode(rawPoolResult, 'ttml-raw-pool-unavailable');
    }

    let recentNonTTMLCandidateCount = 0;
    const diagnosticResult = await this.getTtmlAcquisitionIngress().readDiagnosticSummary();
    if (diagnosticResult?.ok) {
      recentNonTTMLCandidateCount = diagnosticResult.value.recentNonTtmlCandidateCount;
    }

    const gateReasonCounts = rawEntries.reduce((counts, entry) => {
      const reason = entry.gate?.reason || 'unknown';
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});

    let reason = 'no-watch-session-ttml';
    if (context.state === 'transitioning') {
      reason = 'playback-context-transitioning';
    } else if (role && this.lastSubtitleMissingReasons[role] === 'parse-error') {
      reason = 'parse-error';
    } else if (matchingParsedEntries.some(([, data]) => Array.isArray(data?.subtitles) && data.subtitles.length === 0)) {
      reason = 'parse-empty';
    } else if (rawEntries.length === 0 && recentNonTTMLCandidateCount > 0) {
      reason = 'response-not-ttml';
    } else if (rawEntries.length > 0 && rawEntries.every(entry => entry.gate?.reason === 'request-session-not-watch')) {
      reason = 'only-billboard-ttml';
    } else if (rawEntries.length > 0 && rawEntries.some(entry => entry.gate?.accepted)) {
      reason = 'parse-empty';
    }

    return {
      reason,
      context,
      rawEntryCount: rawEntries.length,
      parsedEntryCount: matchingParsedEntries.length,
      gateReasonCounts,
      recentNonTTMLCandidateCount,
      rawError,
      rawEntries: rawEntries.slice(0, 10)
    };
  }

  /**
   * 等待攔截事件
   */
  async waitForInterception(languageCode, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const waiterId = this.nextAcquisitionWaiterId++;
      const timeout = setTimeout(() => {
        this.acquisitionWaiters.delete(waiterId);
        this.log(`等待 ${languageCode} 攔截事件超時`);
        resolve({
          matched: false,
          reason: 'timeout'
        });
      }, timeoutMs);

      this.acquisitionWaiters.set(waiterId, {
        languageCode,
        timeout,
        resolve,
        createdAt: Date.now()
      });
    });
  }

  resolveAcquisitionWaiters(event) {
    if (!this.acquisitionWaiters.size) {
      return;
    }

    const gate = this.evaluateSubtitleGate(event.cacheKey, event.requestInfo);
    for (const [waiterId, waiter] of this.acquisitionWaiters.entries()) {
      if (!this.matchesLanguageForAcquisition(event.language, waiter.languageCode)) {
        continue;
      }

      if (!gate.accepted) {
        this.log(`忽略不符合目前 PlaybackContext 的 ${waiter.languageCode} 攔截事件:`, gate);
        continue;
      }

      clearTimeout(waiter.timeout);
      this.acquisitionWaiters.delete(waiterId);
      this.log(`收到 ${waiter.languageCode} 攔截事件 (TTML lang: ${event.language})`);
      waiter.resolve({
        matched: true,
        cacheKey: event.cacheKey,
        language: event.language,
        gate
      });
    }
  }

  clearAcquisitionWaiters(reason = 'cleared') {
    for (const [, waiter] of this.acquisitionWaiters.entries()) {
      clearTimeout(waiter.timeout);
      waiter.resolve({
        matched: false,
        reason
      });
    }
    this.acquisitionWaiters.clear();
  }

  /**
   * 恢復預設語言
   */
  async restoreDefaultLanguage(defaultLanguage) {
    if (defaultLanguage && defaultLanguage !== 'unknown') {
      this.log('切回Netflix預設語言:', defaultLanguage);
      try {
        const result = await this.performPlayback('switch-language', { languageCode: defaultLanguage });
        if (!result?.ok) throw new Error(this.getPlaybackFailureCode(result, 'switch-language-failed'));
        this.log('已成功切回預設語言，不影響用戶設定');
      } catch (error) {
        console.warn('切回預設語言失敗:', error);
      }
    }
  }

  // 為特定語言載入字幕（使用事件通知的攔截邏輯）
  async loadSubtitleForLanguage(languageCode, type) {
    this.log(`載入 ${type} 語言字幕: ${languageCode}`);

    const role = this.resolveLanguageRole(languageCode, type);
    const result = await this.switchLanguageAndWait(languageCode, role, {
      reason: 'legacy-load-subtitle-for-language',
      timeoutMs: 10000
    });

    if (!result.ready) {
      this.lastSubtitleMissingReasons[role] = result.reason || 'switch-track-timeout';
      this.dispatchSubtitleReadinessChanged('language-cache-missing-after-switch', {
        slot: role,
        languageCode,
        failureReason: this.lastSubtitleMissingReasons[role]
      });
    }
  }

  // 開始渲染循環（保留原有邏輯）
  startRenderLoop() {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
    }
    
    this.log('開始字幕渲染循環');
    
    this.renderInterval = setInterval(() => {
      if (!this.isActive) return;
      
      try {
        this.updateSubtitleDisplay();
      } catch (error) {
        console.error('字幕渲染循環出錯:', error);
      }
    }, 100); // 每100ms更新一次
  }

  // 停止渲染循環
  stopRenderLoop() {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
      this.log('字幕渲染循環已停止');
    }
  }

  // 更新字幕顯示（保留原有邏輯，但移除 UI 操作）
  updateSubtitleDisplay() {
    try {
      if (!this.ensureActiveSubtitleSlotsCurrent()) {
        return;
      }

      // 獲取當前播放時間
      const currentTime = getCurrentTimestamp();
      if (currentTime === null || currentTime === undefined) {
        return;
      }
      
      this.currentTimestamp = currentTime;
      
      // 查找當前時間的字幕
      let primarySubtitle = null;
      let secondarySubtitle = null;
      
      // 使用時間索引查找字幕（優先），降級到線性查找
      try {
        primarySubtitle = this.primaryTimeIndex ? 
          findSubtitleByTimeIndex(this.primaryTimeIndex, currentTime) :
          findSubtitleByTime(this.primarySubtitles, currentTime);
      } catch (error) {
        this.log('主要字幕時間索引查找失敗，使用線性查找:', error);
        primarySubtitle = findSubtitleByTime(this.primarySubtitles, currentTime);
      }
      
      try {
        secondarySubtitle = this.secondaryTimeIndex ? 
          findSubtitleByTimeIndex(this.secondaryTimeIndex, currentTime) :
          findSubtitleByTime(this.secondarySubtitles, currentTime);
      } catch (error) {
        this.log('次要字幕時間索引查找失敗，使用線性查找:', error);
        secondarySubtitle = findSubtitleByTime(this.secondarySubtitles, currentTime);
      }
      
      // 構造雙語字幕數據
      const dualSubtitleData = {
        primaryText: primarySubtitle?.text || '',
        secondaryText: this.dualSubtitleEnabled ? (secondarySubtitle?.text || '') : '',
        primaryLanguage: this.primaryLanguage,
        secondaryLanguage: this.secondaryLanguage,
        timestamp: primarySubtitle?.startTime ?? currentTime,
        primarySubtitle: primarySubtitle,
        secondarySubtitle: this.dualSubtitleEnabled ? secondarySubtitle : null,
        isDualModeEnabled: this.dualSubtitleEnabled,
        renderReadiness: this.getSubtitleReadinessSnapshot().renderReadiness
      };
      
      // 檢查是否需要更新（避免重複渲染）
      if (this.shouldUpdateSubtitle(dualSubtitleData)) {
        this.lastRenderedSubtitle = dualSubtitleData;
        
        // 通過回調發送字幕數據（不再直接操作UI）
        if (this.callback) {
          const subtitleData = this.convertToStandardFormat(dualSubtitleData);
          this.recordDebugEvent('UI_RENDER', {
            primaryTextLength: subtitleData.dualSubtitle?.primaryText?.length || 0,
            secondaryTextLength: subtitleData.dualSubtitle?.secondaryText?.length || 0,
            subtitleTimestamp: subtitleData.timestamp,
            isEmpty: subtitleData.isEmpty
          });
          this.callback(subtitleData);
          
          // 標記 SubPal 已成功送出字幕數據，允許隱藏原生字幕
          if (dualSubtitleData.primaryText) {
            this._hasSubpalEverShownSubtitle = true;
          }
        }
      }
      
    } catch (error) {
      console.error('更新字幕顯示時出錯:', error);
    }
  }

  // 檢查是否需要更新字幕
  shouldUpdateSubtitle(newData) {
    if (!this.lastRenderedSubtitle) {
      return true; // 首次渲染
    }
    
    return (
      this.lastRenderedSubtitle.primaryText !== newData.primaryText ||
      this.lastRenderedSubtitle.secondaryText !== newData.secondaryText
    );
  }

  // 轉換為標準字幕數據格式
  convertToStandardFormat(dualSubtitleData) {
    let position = null;
    let region = null;
    
    // 優先使用 netflix-player-adapter 進行精確的位置計算
    if (dualSubtitleData.primarySubtitle?.region) {
      try {
        const playerAdapter = getPlayerAdapter();
        region = dualSubtitleData.primarySubtitle.region;
        position = playerAdapter.calculatePosition(region);
        
        if (position) {
          this.log(`使用 PlayerAdapter 計算位置: region=${region}`, position);
        }
      } catch (error) {
        console.warn('使用 PlayerAdapter 計算位置失敗:', error);
      }
    }
    
    // 回退到現有的簡化位置計算
    if (!position) {
      position = this.calculatePosition();
      this.log('使用回退位置計算方法');
    }
    
    return {
      text: dualSubtitleData.primaryText,
      htmlContent: dualSubtitleData.primaryText,
      position: position,
      region: region, // 保留 region 資訊供調試和後續使用
      timestamp: dualSubtitleData.timestamp,
      mode: 'intercept',
      dualSubtitle: dualSubtitleData, // 保留完整的雙語字幕信息
      renderReadiness: dualSubtitleData.renderReadiness || this.getSubtitleReadinessSnapshot().renderReadiness,
      isDualSubtitle: true,
      isEmpty: !dualSubtitleData.primaryText && !dualSubtitleData.secondaryText
    };
  }

  // 計算字幕位置（簡化版本）
  calculatePosition() {
    // 返回 Netflix 原生字幕的大致位置
    const videoPlayer = document.querySelector('.VideoContainer');
    if (videoPlayer) {
      const rect = videoPlayer.getBoundingClientRect();
      return {
        top: rect.bottom - 120, // 距離底部120px
        left: rect.left + rect.width / 2, // 水平居中
        width: rect.width * 0.8, // 80% 寬度
        height: 60 // 固定高度
      };
    }
    
    return { top: 0, left: 0, width: 0, height: 0 };
  }

  // 設置語言配置
  async setLanguages(primaryLanguage, secondaryLanguage) {
    this.log(`設置語言配置: 主要=${primaryLanguage}, 次要=${secondaryLanguage}`);

    try {
      await this.configBridge.setSubtitleLanguages(primaryLanguage, secondaryLanguage);

      // 本地設置會通過訂閱機制自動更新
      // 但為了避免訂閱回調觸發 loadInterceptedSubtitles 之前就返回，也手動更新
      this.primaryLanguage = primaryLanguage;
      this.secondaryLanguage = secondaryLanguage;

      // 如果已經初始化，重新載入字幕
      if (this.isInitialized && this.isActive) {
        this.loadInterceptedSubtitles();
      }
    } catch (error) {
      console.error('設置語言配置失敗:', error);
      throw error;
    }
  }

  // 設置雙語字幕開關
  async setDualSubtitleEnabled(enabled) {
    this.log(`設置雙語字幕開關: ${enabled}`);

    try {
      await this.configBridge.setDualSubtitleEnabled(enabled);

      // 本地設置會通過訂閱機制自動更新
      // 但為了避免訂閱回調觸發 loadInterceptedSubtitles 之前就返回，也手動更新
      this.dualSubtitleEnabled = enabled;

      // 如果已經初始化，重新載入字幕
      if (this.isInitialized && this.isActive) {
        this.loadInterceptedSubtitles();
      }
    } catch (error) {
      console.error('設置雙語字幕開關失敗:', error);
      throw error;
    }
  }

  // 獲取攔截狀態
  getStatus() {
    const subtitleReadiness = this.getSubtitleReadinessSnapshot();

    return {
      isActive: this.isActive,
      isInitialized: this.isInitialized,
      dualSubtitleEnabled: this.dualSubtitleEnabled,
      primaryLanguage: this.primaryLanguage,
      secondaryLanguage: this.secondaryLanguage,
      currentTimestamp: this.currentTimestamp,
      primarySubtitleCount: this.primarySubtitles.length,
      secondarySubtitleCount: this.secondarySubtitles.length,
      currentVideoId: getVideoId(),
      playbackContext: this.getCurrentPlaybackContext(),
      interceptedSubtitleCacheKeys: Array.from(this.interceptedSubtitles.keys()),
      lastProcessedTTMLEvidence: this.lastProcessedTTMLEvidence,
      primaryMissingReason: subtitleReadiness.primary.missingReason,
      secondaryMissingReason: subtitleReadiness.secondary.missingReason,
      subtitleReadiness,
      lastAcquisitionResults: this.lastAcquisitionResults,
      pendingAcquisitionWaiters: this.acquisitionWaiters.size,
      nativeSubtitleVisibility: subtitleReadiness.nativeSubtitle,
      // DOM overlap matcher 除錯資訊（僅在有 active matcher 時提供）
      domOverlapMatcher: this.domOverlapMatcher?.getDebugInfo() || null,
      // primary discovery 狀態
      primaryDiscovery: {
        state: this.primaryDiscovery.state,
        startedAt: this.primaryDiscovery.startedAt,
        sampleCount: this.primaryDiscovery.sampleCount,
        matchAttemptCount: this.primaryDiscovery.matchAttemptCount,
        lastSample: this.primaryDiscovery.lastSample,
        selectedCacheKey: this.primaryDiscovery.selectedCacheKey,
        selectedScore: this.primaryDiscovery.selectedScore,
        lastFailureReason: this.primaryDiscovery.lastFailureReason,
        toastShown: this.primaryDiscovery.toastShown
      },
      // secondary DOM recovery 狀態
      secondaryRecovery: {
        lastResult: this._secondaryRecoveryLastResult,
        inFlight: this._secondaryRecoveryInFlight,
        cooldownEntries: this._secondaryRecoveryCooldown?.size || 0
      },
      rawTTMLMetadata: Array.from(this.interceptedSubtitles.entries()).map(([cacheKey, data]) => {
        const requestInfo = data?.requestInfo || {};
        return {
          cacheKey,
          language: data?.language || null,
          rawMetadata: data?.rawMetadata || data?.metadata || requestInfo?.rawTtmlMetadata || null,
          gate: data?.gate || null,
          subtitleCount: Array.isArray(data?.subtitles) ? data.subtitles.length : 0,
          playbackContext: data?.playbackContext || null,
          // attribution 診斷欄位
          attributionReason: requestInfo.attributionReason || null,
          attributedVideoId: requestInfo.attributedVideoId || null,
          overlapScore: requestInfo.overlapScore || null
        };
      }),
      recentEvents: this.debugEvents.slice(-20),
      hasTimeIndex: {
        primary: !!this.primaryTimeIndex,
        secondary: !!this.secondaryTimeIndex
      },
      subtitleMeta: {
        primary: this.primarySubtitleMeta,
        secondary: this.secondarySubtitleMeta
      },
      lastSubtitle: this.lastRenderedSubtitle ? {
        primaryText: this.lastRenderedSubtitle.primaryText.substring(0, 50) + '...',
        secondaryText: this.lastRenderedSubtitle.secondaryText.substring(0, 50) + '...',
        timestamp: this.lastRenderedSubtitle.timestamp
      } : null
    };
  }

  getNativeSubtitleVisibilitySnapshot() {
    const hideStyle = document.getElementById('subpal-hide-native-subtitles');
    return {
      hidden: !!hideStyle,
      nativeSubtitleHidden: !!hideStyle,
      nativeHideReason: hideStyle ?
        'subpal-hide-native-subtitles-style-present-existing-behavior' :
        'native-hide-style-not-present'
    };
  }

  getSubtitleReadinessSnapshot() {
    const context = this.getCurrentPlaybackContext();
    const nativeSubtitle = this.getNativeSubtitleVisibilitySnapshot();
    const playbackContextReady = context.state === 'ready' && !!context.videoId && context.videoId !== 'unknown';
    const primaryMetaCurrent = this.primarySubtitleMeta ? this.isSubtitleSlotMetaCurrent(this.primarySubtitleMeta) : false;
    const secondaryMetaCurrent = this.secondarySubtitleMeta ? this.isSubtitleSlotMetaCurrent(this.secondarySubtitleMeta) : false;
    const primaryReady = this.primarySubtitles.length > 0 && primaryMetaCurrent;
    const secondaryReady = this.secondarySubtitles.length > 0 && secondaryMetaCurrent;
    // 使用 sticky flag：一旦 SubPal 成功顯示過字幕就保持 true，避免 cue 間隙時原生字幕閃爍
    const canHideNativeSubtitles = this.isActive && playbackContextReady && primaryReady && this._hasSubpalEverShownSubtitle;
    let nativeHideReason = 'intercept-primary-ready';
    if (!canHideNativeSubtitles) {
      if (!this.isActive) {
        nativeHideReason = 'intercept-mode-inactive';
      } else if (!playbackContextReady) {
        nativeHideReason = 'playback-context-not-ready';
      } else if (!this._hasSubpalEverShownSubtitle) {
        nativeHideReason = 'subpal-has-never-shown-subtitle';
      } else {
        nativeHideReason = this.computeSubtitleMissingReason('primary', this.primaryLanguage, context);
      }
    }

    return {
      primary: {
        language: this.primaryLanguage,
        ready: primaryReady,
        count: this.primarySubtitles.length,
        cacheKey: this.primarySubtitleMeta?.cacheKey || null,
        metaCurrent: primaryMetaCurrent,
        missingReason: primaryReady ? null : this.computeSubtitleMissingReason('primary', this.primaryLanguage, context)
      },
      secondary: {
        language: this.secondaryLanguage,
        ready: secondaryReady,
        count: this.secondarySubtitles.length,
        cacheKey: this.secondarySubtitleMeta?.cacheKey || null,
        metaCurrent: secondaryMetaCurrent,
        missingReason: secondaryReady ? null : this.computeSubtitleMissingReason('secondary', this.secondaryLanguage, context)
      },
      renderReadiness: {
        interceptModeActive: this.isActive,
        playbackContextReady,
        primarySubtitleSlotReady: primaryReady,
        primarySubtitleMetaCurrent: primaryMetaCurrent,
        primarySubtitleCount: this.primarySubtitles.length,
        canHideNativeSubtitles,
        nativeHideReason
      },
      canHideNativeSubtitles,
      nativeSubtitleHidden: nativeSubtitle.hidden,
      nativeHideReason,
      nativeSubtitle,
      context
    };
  }

  dispatchSubtitleReadinessChanged(reason, extra = {}) {
    const readiness = this.getSubtitleReadinessSnapshot();
    this.recordDebugEvent('SUBTITLE_READINESS_CHANGED', {
      reason,
      renderReadiness: readiness.renderReadiness,
      primary: readiness.primary,
      secondary: readiness.secondary
    });

    dispatchInternalEvent({
      type: 'SUBTITLE_READINESS_CHANGED',
      source: 'subtitle-interceptor',
      reason,
      readiness,
      ...extra,
      timestamp: Date.now()
    });
  }

  computeSubtitleMissingReason(slot, languageCode, context = this.getCurrentPlaybackContext()) {
    if (!languageCode) {
      return 'missing-target-language';
    }

    if (!context.videoId || context.videoId === 'unknown') {
      return 'missing-current-video-id';
    }

    if (context.state === 'transitioning') {
      return 'playback-context-transitioning';
    }

    const matchingEntries = Array.from(this.interceptedSubtitles.entries())
      .filter(([, data]) => this.matchesLanguageForAcquisition(data?.language, languageCode));

    if (matchingEntries.length === 0) {
      return this.lastSubtitleMissingReasons[slot] || 'no-parsed-language-cache';
    }

    const gateResults = matchingEntries.map(([cacheKey, data]) => {
      const gate = this.evaluateSubtitleGate(cacheKey, data?.requestInfo);
      const epochMatches = data?.playbackContext?.epoch === undefined ||
        context.epoch === null ||
        data.playbackContext.epoch === context.epoch;
      return {
        cacheKey,
        gate,
        epochMatches,
        subtitleCount: Array.isArray(data?.subtitles) ? data.subtitles.length : 0
      };
    });

    const currentEntries = gateResults.filter(result => result.gate.accepted && result.epochMatches);
    if (currentEntries.length === 0) {
      const rejected = gateResults.find(result => !result.gate.accepted);
      if (rejected?.gate?.reason) {
        return `parsed-language-cache-gate-${rejected.gate.reason}`;
      }

      if (gateResults.some(result => !result.epochMatches)) {
        return 'parsed-language-cache-epoch-mismatch';
      }

      return 'parsed-language-cache-not-current';
    }

    if (!currentEntries.some(result => result.subtitleCount > 0)) {
      return 'parse-empty';
    }

    return 'slot-not-assigned';
  }

  // 清理資源
  cleanup() {
    this.log('清理字幕攔截器資源...');
    
    this.abortPrimaryDiscovery('interceptor-cleanup');
    this.domOverlapMatcher?.stopWatching();
    this.stop();
    this.callback = null;
    this.isInitialized = false;
    
    // 清理字幕數據
    this.primarySubtitles = [];
    this.secondarySubtitles = [];
    this.primaryTimeIndex = null;
    this.secondaryTimeIndex = null;
    this.primarySubtitleMeta = null;
    this.secondarySubtitleMeta = null;
    this.interceptedSubtitles.clear();
    this.clearAcquisitionWaiters('interceptor-cleanup');
    this.lastSubtitleMissingReasons = {
      primary: null,
      secondary: null
    };
    this.lastAcquisitionResults = {
      primary: null,
      secondary: null
    };
    this.pendingLoadInterceptedSubtitles = false;
    this.pendingLoadReason = null;
    this._secondaryAcquisitionInFlight = null;
    this._secondaryRecoveryCooldown?.clear();
    this._secondaryRecoveryInFlight = false;
    this._secondaryRecoveryLastResult = null;
    if (this.contextReloadTimer) {
      clearTimeout(this.contextReloadTimer);
      this.contextReloadTimer = null;
    }
    
    this.log('字幕攔截器資源清理完成');
  }


  /**
   * 語言匹配：支援 base-code fallback
   * 例如 "zh" 可匹配 "zh-Hant"，"zh-Hant" 可匹配 "zh"
   * 解決 Netflix TTML xml:lang 標記不精確的問題（如 "zh" 代替 "zh-Hant"）
   */
  matchesLanguage(langA, langB) {
    if (!langA || !langB) return false;
    // 精確匹配（大小寫不敏感）
    if (langA.toLowerCase() === langB.toLowerCase()) return true;
    // base-code fallback：比較第一段（如 zh-Hant → zh）
    const baseA = langA.split('-')[0].toLowerCase();
    const baseB = langB.split('-')[0].toLowerCase();
    return baseA === baseB;
  }

  normalizeLanguageCode(languageCode) {
    return (languageCode || '').trim().toLowerCase();
  }

  /**
   * acquisition 使用嚴格語言匹配，避免 zh-Hant / zh-Hans / generic zh 互相污染。
   * 若未來需要 generic fallback，必須在呼叫端明確傳入 allowGenericFallback。
   */
  matchesLanguageForAcquisition(actualLanguage, targetLanguage, options = {}) {
    const actual = this.normalizeLanguageCode(actualLanguage);
    const target = this.normalizeLanguageCode(targetLanguage);
    if (!actual || !target) {
      return false;
    }

    if (actual === target) {
      return true;
    }

    if (!options.allowGenericFallback) {
      return false;
    }

    const [actualBase, actualScript] = actual.split('-');
    const [targetBase, targetScript] = target.split('-');
    return actualBase === targetBase && (!actualScript || !targetScript);
  }

  /**
   * 解析緩存鍵，提取語言和 videoID 等信息
   */
  parseCacheKey(cacheKey) {
    try {
      const parts = cacheKey.split('_');
      if (parts.length < 2) {
        this.log(`緩存鍵格式不正確，至少需要 language_videoID: ${cacheKey}`);
        return null;
      }
      
      return {
        language: parts[0],
        videoId: parts[1],
        // 保留其他參數用於完整性檢查
        otherParams: parts.slice(2)
      };
    } catch (error) {
      this.log('解析緩存鍵失敗:', error);
      return null;
    }
  }

  /**
   * 取得目前播放 context。若 manager 尚未 ready，降級使用 video-info 的 videoId。
   */
  getCurrentPlaybackContext() {
    try {
      const context = playbackContextManager.getCurrentContext();
      if (context?.videoId) {
        return context;
      }
    } catch (error) {
      this.log('取得 PlaybackContext 失敗，使用 video-info fallback:', error);
    }

    return {
      epoch: null,
      videoId: getVideoId(),
      sessionId: null,
      currentTrack: null,
      state: 'fallback',
      source: 'video-info-fallback'
    };
  }

  isWatchSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('watch-');
  }

  /**
   * 判斷 requestInfo 是否為有效的 native-dom-match 歸屬。
   * 只有通過此檢查的 entry 才能在 evaluateSubtitleGate 中豁免特定 mismatch 拒絕。
   */
  isNativeDomMatchedRequest(requestInfo, context = this.getCurrentPlaybackContext()) {
    if (!requestInfo) return false;

    // 1. attributionReason 必須為 'native-dom-match'
    if (requestInfo.attributionReason !== 'native-dom-match') return false;

    // 2. attributedVideoId 必須等於目前 context videoId
    if (requestInfo.attributedVideoId !== context.videoId) return false;

    // 3. overlapScore 須達安全最低門檻（與 DOM overlap matcher 短文字 >= 6 chars 的 0.75 門檻一致）
    if (!requestInfo.overlapScore || requestInfo.overlapScore < 0.75) return false;

    // 4. context state 必須為 ready
    if (context.state !== 'ready') return false;

    // 5. request session 若存在，不可為 non-watch（request-session-not-watch 永不免責）
    const sessionId = requestInfo.sessionIdAtRequest ||
      requestInfo.playbackSnapshot?.sessionId || null;
    if (sessionId && !this.isWatchSession(sessionId)) return false;

    return true;
  }

  /**
   * 依 PlaybackContext 與 request-time evidence 判斷字幕是否可進入 content 端處理流程。
   */
  evaluateSubtitleGate(cacheKey, requestInfo = null) {
    const parsedKey = this.parseCacheKey(cacheKey);
    const context = this.getCurrentPlaybackContext();
    const currentVideoId = context.videoId;
    const derived = requestInfo?.derivedSubtitleVideo || null;
    const derivedVideoId = derived?.videoId ? String(derived.videoId) : null;
    const parsedVideoId = parsedKey?.videoId ? String(parsedKey.videoId) : null;
    const snapshotSessionConfidence = requestInfo?.sessionSelectionConfidenceAtRequest ||
      requestInfo?.playbackSnapshot?.sessionSelectionConfidence ||
      null;
    const canUseSnapshotSession = !snapshotSessionConfidence ||
      ['high', 'medium'].includes(snapshotSessionConfidence);
    const requestSessionId = requestInfo?.sessionIdAtRequest ||
      (canUseSnapshotSession ? requestInfo?.playbackSnapshot?.sessionId : null) ||
      null;
    const contextSessionId = context.sessionId || null;
    const requestTrack = requestInfo?.currentTrackAtRequest ||
      requestInfo?.playbackSnapshot?.currentTrack ||
      null;

    const baseResult = {
      accepted: false,
      reason: null,
      cacheKey,
      parsedVideoId,
      currentVideoId,
      contextEpoch: context.epoch,
      contextState: context.state,
      evidenceVideoId: derivedVideoId,
      evidenceConfidence: derived?.confidence || null,
      evidenceReason: derived?.reason || null,
      requestSessionId,
      contextSessionId,
      requestTrack: requestTrack ? {
        code: requestTrack.code || null,
        trackId: requestTrack.trackId || null,
        trackType: requestTrack.trackType || null,
        rawTrackType: requestTrack.rawTrackType || null
      } : null,
      contextTrack: context.currentTrack ? {
        code: context.currentTrack.code || null,
        trackId: context.currentTrack.trackId || null,
        trackType: context.currentTrack.trackType || null,
        rawTrackType: context.currentTrack.rawTrackType || null
      } : null
    };

    if (!parsedKey) {
      return { ...baseResult, reason: 'invalid-cache-key' };
    }

    if (!currentVideoId || currentVideoId === 'unknown') {
      return { ...baseResult, reason: 'missing-current-video-id' };
    }

    if (context.state === 'transitioning') {
      return { ...baseResult, reason: 'playback-context-transitioning' };
    }

    // Netflix 首頁 billboard / preview 也可能請求字幕。即使 manifest videoId 看起來正確，
    // 非 watch session 的 TTML 不能進入目前播放器顯示池，否則會污染同語言 cache。
    if (requestSessionId && !this.isWatchSession(requestSessionId)) {
      return { ...baseResult, reason: 'request-session-not-watch' };
    }

    // 檢查是否為 native-dom-match 歸屬，可豁免特定 video/session mismatch
    const isDomMatch = this.isNativeDomMatchedRequest(requestInfo, context);

    // Exemptible: watch-to-watch request-session-mismatch
    if (!isDomMatch &&
        contextSessionId &&
        requestSessionId &&
        this.isWatchSession(contextSessionId) &&
        this.isWatchSession(requestSessionId) &&
        requestSessionId !== contextSessionId) {
      return { ...baseResult, reason: 'request-session-mismatch' };
    }

    // 非豁免：evidence-none（DOM match 可豁免 confidence=none 的證據不足）
    if (!isDomMatch && derived?.confidence === 'none') {
      return { ...baseResult, reason: `evidence-${derived.confidence}` };
    }

    // Exemptible: evidence-video-mismatch
    if (!isDomMatch && derivedVideoId && derivedVideoId !== currentVideoId) {
      return { ...baseResult, reason: 'evidence-video-mismatch' };
    }

    // Exemptible: cache-key-video-mismatch
    if (!isDomMatch && parsedVideoId !== currentVideoId) {
      return { ...baseResult, reason: 'cache-key-video-mismatch' };
    }

    // 若為 DOM match 歸屬，回傳 accepted-native-dom-match
    if (isDomMatch) {
      return {
        ...baseResult,
        accepted: true,
        reason: 'accepted-native-dom-match',
        attributionReason: 'native-dom-match',
        attributedVideoId: requestInfo.attributedVideoId,
        overlapScore: requestInfo.overlapScore
      };
    }

    return {
      ...baseResult,
      accepted: true,
      reason: 'accepted'
    };
  }

  /**
   * 已解析字幕 cache 的二次 gate，用於避免舊 epoch 或舊影片資料被重新載入。
   */
  isSubtitleEntryCurrent(cacheKey, data) {
    const gate = this.evaluateSubtitleGate(cacheKey, data?.requestInfo);
    if (!gate.accepted) {
      return false;
    }

    const context = this.getCurrentPlaybackContext();
    if (data?.playbackContext?.epoch !== undefined &&
        context.epoch !== null &&
        data.playbackContext.epoch !== context.epoch) {
      this.recordDebugEvent('CACHE_SKIPPED_BY_EPOCH', {
        cacheKey,
        cacheEpoch: data.playbackContext.epoch,
        contextEpoch: context.epoch
      });
      return false;
    }

    return true;
  }

  createSubtitleSlotMeta(cacheKey, data) {
    const gate = this.evaluateSubtitleGate(cacheKey, data?.requestInfo);
    const context = this.getCurrentPlaybackContext();
    const requestInfo = data?.requestInfo || {};
    const isDomMatch = requestInfo.attributionReason === 'native-dom-match' &&
      requestInfo.attributedVideoId === context.videoId;

    const meta = {
      cacheKey,
      videoId: gate.currentVideoId,
      parsedVideoId: gate.parsedVideoId,
      contextEpoch: context.epoch,
      contextState: context.state,
      gate,
      rawMetadata: data?.rawMetadata || data?.metadata || requestInfo?.rawTtmlMetadata || null,
      assignedAt: Date.now()
    };

    // DOM matched entry 加入 attribution 欄位
    if (isDomMatch) {
      meta.attributionReason = 'native-dom-match';
      meta.attributedVideoId = context.videoId;
      meta.overlapScore = requestInfo.overlapScore;
    }

    // 加入 slot lock-in metadata，防止短暫 PlaybackContext 轉換時閃爍
    if (isDomMatch) {
      // DOM match：高信賴鎖定到 attributedVideoId
      meta.lockedVideoId = context.videoId;
      meta.lockConfidence = 'high';
      meta.lockReason = 'native-dom-match';
      meta.isProvisional = false;
    } else {
      // 一般 accepted entry（gate 已確保 parsedVideoId === currentVideoId）
      const evidenceConfidence = gate.evidenceConfidence;
      const isProvisional = !evidenceConfidence || evidenceConfidence === 'low' || evidenceConfidence === 'none';
      meta.lockedVideoId = gate.currentVideoId;
      meta.lockConfidence = isProvisional ? 'medium' : 'high';
      meta.lockReason = 'gate-accepted';
      meta.isProvisional = isProvisional;
    }

    return meta;
  }

  isSubtitleSlotMetaCurrent(meta) {
    if (!meta) {
      return false;
    }

    const context = this.getCurrentPlaybackContext();
    if (!context.videoId || context.videoId === 'unknown') {
      return false;
    }

    // 若 lock 指向不同影片，立即拒絕
    if (meta.lockedVideoId && meta.lockedVideoId !== context.videoId) {
      return false;
    }

    // transitioning 時若 lockedVideoId 與目前相同，允許通過（防止同影片短暫轉換閃爍）
    if (context.state === 'transitioning') {
      if (meta.lockedVideoId === context.videoId) {
        // 仍須 epoch 檢查
        if (meta.contextEpoch !== null &&
            meta.contextEpoch !== undefined &&
            context.epoch !== null &&
            meta.contextEpoch !== context.epoch) {
          return false;
        }
        return true;
      }
      return false;
    }

    // DOM matched slot — 允許 parsedVideoId 與 context.videoId 不符
    if (meta.attributionReason === 'native-dom-match' && meta.attributedVideoId === context.videoId) {
      if (meta.contextEpoch !== null &&
          meta.contextEpoch !== undefined &&
          context.epoch !== null &&
          meta.contextEpoch !== context.epoch) {
        return false;
      }
      return true;
    }

    // 非 provisional 的 lock 足以證明影片歸屬，跳過 parsedVideoId 嚴格檢查
    if (!meta.isProvisional && meta.lockedVideoId === context.videoId) {
      if (meta.contextEpoch !== null &&
          meta.contextEpoch !== undefined &&
          context.epoch !== null &&
          meta.contextEpoch !== context.epoch) {
        return false;
      }
      return true;
    }

    // 一般 slot 或 provisional entry：嚴格檢查 parsedVideoId（現有行為）
    if (meta.videoId !== context.videoId || meta.parsedVideoId !== context.videoId) {
      return false;
    }

    if (meta.contextEpoch !== null &&
        meta.contextEpoch !== undefined &&
        context.epoch !== null &&
        meta.contextEpoch !== context.epoch) {
      return false;
    }

    return true;
  }

  ensureActiveSubtitleSlotsCurrent() {
    let changed = false;

    if (this.primarySubtitles.length > 0 && !this.isSubtitleSlotMetaCurrent(this.primarySubtitleMeta)) {
      this.recordDebugEvent('ACTIVE_SLOT_CLEARED_BY_GATE', {
        slot: 'primary',
        meta: this.primarySubtitleMeta,
        context: this.getCurrentPlaybackContext()
      });
      this.primarySubtitles = [];
      this.primaryTimeIndex = null;
      this.primarySubtitleMeta = null;
      this.lastSubtitleMissingReasons.primary = 'active-slot-cleared-by-gate';
      changed = true;
    }

    if (this.secondarySubtitles.length > 0 && !this.isSubtitleSlotMetaCurrent(this.secondarySubtitleMeta)) {
      this.recordDebugEvent('ACTIVE_SLOT_CLEARED_BY_GATE', {
        slot: 'secondary',
        meta: this.secondarySubtitleMeta,
        context: this.getCurrentPlaybackContext()
      });
      this.secondarySubtitles = [];
      this.secondaryTimeIndex = null;
      this.secondarySubtitleMeta = null;
      this.lastSubtitleMissingReasons.secondary = 'active-slot-cleared-by-gate';
      changed = true;
    }

    if (changed) {
      this.dispatchSubtitleReadinessChanged('active-slot-cleared-by-gate');
    }

    return !changed;
  }

  scheduleReloadAfterContextReady(reason, context = this.getCurrentPlaybackContext(), attempt = 0) {
    if (!this.isActive) {
      return;
    }

    if (this.contextReloadTimer) {
      clearTimeout(this.contextReloadTimer);
    }

    this.contextReloadTimer = setTimeout(() => {
      this.contextReloadTimer = null;

      const latestContext = this.getCurrentPlaybackContext();
      if (latestContext?.state !== 'ready' || !latestContext.videoId) {
        this.recordDebugEvent('RELOAD_AFTER_PLAYBACK_CONTEXT_READY_SKIPPED', {
          reason,
          attempt,
          originalContext: context,
          latestContext
        });
        if (attempt < 5) {
          this.scheduleReloadAfterContextReady(reason, latestContext, attempt + 1);
        }
        return;
      }

      this.recordDebugEvent('RELOAD_AFTER_PLAYBACK_CONTEXT_READY', {
        reason,
        attempt,
        originalContext: context,
        context: latestContext
      });

      this.loadInterceptedSubtitles().catch(error => {
        console.error('PlaybackContext ready 後重新載入字幕失敗:', error);
      });
    }, context?.state === 'ready' ? 300 : 1000);
  }

  // ==================== Primary Discovery State Machine ====================

  /**
   * 嘗試啟動 primary discovery。檢查所有 start condition，符合則開始 DOM overlap match 流程。
   * @param {string} [initiator] - 可指定觸發來源，如 'video-id-changed' 可繞過 missing reason 檢查
   */
  tryStartPrimaryDiscovery(initiator) {
    // 若 discovery 處於終止狀態（aborted/timed-out/matched）且 context 已改變，
    // 重置為 idle 以允許新的影片開始 discovery。相同 context 的進行中狀態不受影響。
    if (this.primaryDiscovery.state !== 'idle') {
      const currentContext = this.getCurrentPlaybackContext();
      const startedContext = this.primaryDiscovery._startedContext;
      if (startedContext && currentContext.videoId &&
          (startedContext.videoId !== currentContext.videoId || startedContext.epoch !== currentContext.epoch)) {
        // 完整清理 stale discovery 資源（timer、observer、isMatching），
        // 避免舊資源使 startWatching() 回傳 false 或 timer 在 state idle 後仍觸發
        this.cleanupPrimaryDiscoveryRuntimeResources('context-changed-reset');
        this.primaryDiscovery.state = 'idle';
        this.primaryDiscovery.startedAt = null;
        this.recordDebugEvent('PRIMARY_DISCOVERY_CONTEXT_RESET_CLEANUP', {
          startedVideoId: startedContext.videoId,
          startedEpoch: startedContext.epoch,
          currentVideoId: currentContext.videoId,
          currentEpoch: currentContext.epoch
        });
        // _startedContext 留供除錯，但 state 已 idle，不影響後續流程
      }
    }

    // 已在 discovery 中或 idle 狀態不適用
    if (this.primaryDiscovery.state !== 'idle') return;
    if (!this.isActive) return;

    const context = this.getCurrentPlaybackContext();
    if (context.state === 'transitioning' || !context.videoId || context.videoId === 'unknown') return;

    // 若 primary 已就緒，無需啟動 discovery
    if (this.isLanguageSlotReady(this.primaryLanguage, 'primary')) return;

    // Condition 1: 由 VIDEO_ID_CHANGED 或早期窗口 initiator 明確觸發
    // 'interceptor-start' / 'early-context-ready' / 'early-load-intercepted' 在安全條件下
    // 繞過 missing reason 檢查，使 discovery 在 B 集 context ready 時更早啟動
    if (initiator === 'video-id-changed' ||
        initiator === 'interceptor-start' ||
        initiator === 'early-context-ready' ||
        initiator === 'early-load-intercepted') {
      this.startPrimaryDiscovery();
      return;
    }

    // Condition 3: 檢查 missing reason 是否符合特定模式
    const missingReason = this.computeSubtitleMissingReason('primary', this.primaryLanguage, context);
    const lastMissing = this.lastSubtitleMissingReasons.primary;
    const discoveryReasons = [
      'parsed-language-cache-gate-cache-key-video-mismatch',
      'raw-ttml-gate-cache-key-video-mismatch',
      'switch-track-timeout',
      'no-parsed-language-cache'
    ];

    if (discoveryReasons.includes(missingReason) || discoveryReasons.includes(lastMissing)) {
      this.startPrimaryDiscovery();
      return;
    }

    // Condition 2: ensureLanguageAvailable 失敗且診斷顯示 video mismatch
    const lastResult = this.lastAcquisitionResults.primary;
    if (lastResult && !lastResult.success && lastResult.diagnosis?.gateReasonCounts) {
      const counts = lastResult.diagnosis.gateReasonCounts;
      if ((counts['cache-key-video-mismatch'] || 0) > 0 ||
          (counts['evidence-video-mismatch'] || 0) > 0) {
        this.startPrimaryDiscovery();
      }
    }
  }

  /**
   * 正式啟動 primary discovery 狀態機
   */
  startPrimaryDiscovery() {
    // 防禦性清理：確保替換 primaryDiscovery 前沒有殘留的 timer/observer，
    // 避免舊資源在 replacement 後持續運作造成干擾
    this.cleanupPrimaryDiscoveryRuntimeResources('start-primary-discovery');

    const context = this.getCurrentPlaybackContext();
    this.primaryDiscovery = {
      state: 'started',
      startedAt: Date.now(),
      sampleCount: 0,
      matchAttemptCount: 0,
      lastSample: null,
      selectedCacheKey: null,
      selectedScore: null,
      lastFailureReason: null,
      toastShown: false,
      _startedContext: { videoId: context.videoId, epoch: context.epoch },
      _domSampleEventFired: false
    };

    this.recordDebugEvent('PRIMARY_DISCOVERY_STARTED', {
      videoId: context.videoId,
      epoch: context.epoch,
      missingReason: this.lastSubtitleMissingReasons.primary ||
        this.computeSubtitleMissingReason('primary', this.primaryLanguage, context)
    });

    // lazy 初始化 matcher
    if (!this.domOverlapMatcher) {
      this.domOverlapMatcher = new DOMOverlapMatcher({
        debug: this.debug,
        readRawPool: (...args) => this.getTtmlAcquisitionIngress().readRawPool(...args)
      });
    }

    // 啟動 MutationObserver 反應式比對（若尚未啟動）
    const watchingStarted = this.domOverlapMatcher.startWatching(
      this.primaryLanguage,
      (result) => this.handleDomMatchResult(result)
    );
    if (!watchingStarted) {
      this.log('DOM overlap matcher already watching, skip startWatching');
    }

    // 立即嘗試第一次 match
    this.tryPrimaryDiscoveryMatch().catch(error => {
      this.log('Primary discovery initial match error:', error.message);
    });
  }

  /**
   * 中止 discovery，清理計時器
   */
  abortPrimaryDiscovery(reason) {
    if (this.primaryDiscovery.state === 'idle' || this.primaryDiscovery.state === 'aborted' || this.primaryDiscovery.state === 'timed-out') {
      return;
    }

    const previousState = this.primaryDiscovery.state;

    if (this.primaryDiscoveryTimer) {
      clearTimeout(this.primaryDiscoveryTimer);
      this.primaryDiscoveryTimer = null;
    }

    // 停止 DOM 反應式比對 observer
    this.domOverlapMatcher?.stopWatching();

    // 記錄中止或超時事件
    if (reason === 'timeout') {
      this.primaryDiscovery.state = 'timed-out';
      this.recordDebugEvent('PRIMARY_DISCOVERY_TIMEOUT', {
        durationMs: Date.now() - (this.primaryDiscovery.startedAt || Date.now()),
        sampleCount: this.primaryDiscovery.sampleCount,
        matchAttemptCount: this.primaryDiscovery.matchAttemptCount,
        lastFailureReason: this.primaryDiscovery.lastFailureReason
      });
    } else if (reason === 'primary-ready') {
      this.primaryDiscovery.state = 'aborted';
      this.recordDebugEvent('PRIMARY_READY', {
        source: 'discovery-abort',
        previousState,
        sampleCount: this.primaryDiscovery.sampleCount
      });
    } else {
      this.primaryDiscovery.state = 'aborted';
      this.recordDebugEvent('PRIMARY_DISCOVERY_ABORTED', {
        reason,
        previousState,
        sampleCount: this.primaryDiscovery.sampleCount,
        matchAttemptCount: this.primaryDiscovery.matchAttemptCount
      });
    }
  }

  /**
   * 清理 primary discovery 的執行時期資源（計時器、DOM observer），
   * 不修改 primaryDiscovery state（由呼叫端負責）。
   * 用於 context-change reset 或 startPrimaryDiscovery 前的防禦性清理。
   */
  cleanupPrimaryDiscoveryRuntimeResources(reason) {
    if (this.primaryDiscoveryTimer) {
      clearTimeout(this.primaryDiscoveryTimer);
      this.primaryDiscoveryTimer = null;
    }
    this.domOverlapMatcher?.stopWatching();
    this.recordDebugEvent('PRIMARY_DISCOVERY_RUNTIME_CLEANUP', { reason });
  }

  /**
   * 安排下一次 DOM sample 收集
   */
  scheduleNextDiscoverySample() {
    // 清除舊計時器
    if (this.primaryDiscoveryTimer) {
      clearTimeout(this.primaryDiscoveryTimer);
      this.primaryDiscoveryTimer = null;
    }

    // 檢查 stop condition
    if (this.checkDiscoveryStopConditions()) {
      return;
    }

    // 間隔 1 秒後再取樣（作為 observer 的 fallback）
    this.primaryDiscoveryTimer = setTimeout(() => {
      this.primaryDiscoveryTimer = null;
      this.tryPrimaryDiscoveryMatch().catch(error => {
        this.log('Primary discovery match error:', error.message);
      });
    }, 1000);
  }

  /**
   * ★ B: 判斷 primary discovery 是否處於早期窗口（前幾秒）。
   * 若 primary slot 未就緒且 discovery 剛啟動，應暫緩 secondary track switching 避免閃爍。
   * @returns {boolean}
   */
  isPrimaryDiscoveryEarlyWindowActive() {
    if (this.isLanguageSlotReady(this.primaryLanguage, 'primary')) return false;

    const ds = this.primaryDiscovery;
    if (ds.state !== 'started' && ds.state !== 'collecting') return false;
    if (!ds.startedAt) return false;

    const earlyWindowMs = 3000; // 3 秒 early window
    return (Date.now() - ds.startedAt) < earlyWindowMs;
  }

  /**
   * 檢查 primary slot 是否已可靠 lock-in 到目前 videoId。
   * 當 lock-in 達成時，可以安全停止 DOM observer，不需要再 reactive match。
   */
  isPrimarySlotLockedToCurrentVideo() {
    const meta = this.primarySubtitleMeta;
    const context = this.getCurrentPlaybackContext();
    if (!meta || !context?.videoId) return false;
    return meta.lockedVideoId === context.videoId
      && meta.lockConfidence === 'high'
      && !meta.isProvisional;
  }

  /**
   * 檢查 discovery 是否應停止（ready / context change / timeout）
   * @returns {boolean} true 表示已停止
   */
  checkDiscoveryStopConditions() {
    if (this.primaryDiscovery.state === 'idle' || this.primaryDiscovery.state === 'aborted' || this.primaryDiscovery.state === 'timed-out') {
      return true;
    }

    // Stop condition: primary slot locked-in to current video → can stop observer
    if (this.isPrimarySlotLockedToCurrentVideo()) {
      this.domOverlapMatcher?.stopWatching();
      this.abortPrimaryDiscovery('primary-ready');
      return true;
    }

    // Stop condition 1: primary slot ready
    if (this.isLanguageSlotReady(this.primaryLanguage, 'primary')) {
      this.abortPrimaryDiscovery('primary-ready');
      return true;
    }

    // Stop condition 2: PlaybackContext videoId 或 epoch 改變（但 transitioning 不終止 discovery）
    const context = this.getCurrentPlaybackContext();
    if (context.state === 'transitioning') {
      this.primaryDiscovery.lastFailureReason = 'playback-context-transitioning';
      this.recordDebugEvent('PRIMARY_DISCOVERY_TRANSITIONING', {
        state: this.primaryDiscovery.state,
        sampleCount: this.primaryDiscovery.sampleCount,
        matchAttemptCount: this.primaryDiscovery.matchAttemptCount,
        videoId: context.videoId,
        epoch: context.epoch
      });
      // Keep discovery alive; retry on next cycle when context becomes ready
      return false;
    }
    if (!context.videoId || context.videoId === 'unknown') {
      this.abortPrimaryDiscovery('missing-video-id');
      return true;
    }

    const startedContext = this.primaryDiscovery._startedContext;
    if (startedContext && (startedContext.videoId !== context.videoId || startedContext.epoch !== context.epoch)) {
      this.abortPrimaryDiscovery('context-changed');
      return true;
    }

    // Stop condition 3: 超過 240 秒
    if (this.primaryDiscovery.startedAt && (Date.now() - this.primaryDiscovery.startedAt) > 240000) {
      this.abortPrimaryDiscovery('timeout');
      return true;
    }

    return false;
  }

  /**
   * 執行一次 DOM sample 收集與 match 嘗試
   */
  async tryPrimaryDiscoveryMatch() {
    if (this.primaryDiscovery.state !== 'started' && this.primaryDiscovery.state !== 'collecting') {
      return;
    }

    // 先檢查 stop condition（避免已 ready 還繼續收集）
    if (this.checkDiscoveryStopConditions()) {
      return;
    }

    // runMatchOnce() 內部已有 isMatching lock，此處不再重複檢查；
    // 由 runMatchOnce 作為 lock 單一權威，避免同時多路徑重複比對。

    // 若 context 仍在 transitioning，gate 會拒絕 DOM match，跳過此輪並等待 ready
    const discoveryContext = this.getCurrentPlaybackContext();
    if (discoveryContext.state === 'transitioning') {
      this.primaryDiscovery.lastFailureReason = 'playback-context-transitioning';
      this.recordDebugEvent('PRIMARY_DISCOVERY_TRANSITIONING', {
        state: this.primaryDiscovery.state,
        sampleCount: this.primaryDiscovery.sampleCount,
        matchAttemptCount: this.primaryDiscovery.matchAttemptCount,
        videoId: discoveryContext.videoId,
        epoch: discoveryContext.epoch
      });
      this.scheduleNextDiscoverySample();
      return;
    }

    this.primaryDiscovery.state = 'collecting';

    // 確保 matcher 已初始化
    if (!this.domOverlapMatcher) {
      this.domOverlapMatcher = new DOMOverlapMatcher({
        debug: this.debug,
        readRawPool: (...args) => this.getTtmlAcquisitionIngress().readRawPool(...args)
      });
    }

    // 收集 DOM sample（只收集一次，傳給 findBestMatch 避免重複 collect）
    const sample = this.domOverlapMatcher.collectDOMSample();
    if (sample) {
      this.primaryDiscovery.lastSample = sample;
      this.primaryDiscovery.sampleCount++;

      // 觸發 DOM sample 檢測事件（每個 discovery context 只觸發一次），
      // 供 UI 層判斷啟動 long recovery 逾時
      if (!this.primaryDiscovery._domSampleEventFired) {
        this.primaryDiscovery._domSampleEventFired = true;
        const eventContext = this.getCurrentPlaybackContext();
        dispatchInternalEvent({
          type: 'PRIMARY_DISCOVERY_DOM_SAMPLE_DETECTED',
          source: 'subtitle-interceptor',
          videoId: eventContext.videoId,
          epoch: eventContext.epoch,
          sampleCount: this.primaryDiscovery.sampleCount,
          timestamp: Date.now()
        });
      }

      this.recordDebugEvent('PRIMARY_DISCOVERY_DOM_SAMPLE', {
        sampleCount: this.primaryDiscovery.sampleCount,
        textLength: sample.text.length,
        normalizedLength: sample.normalizedText.length,
        timestamp: sample.timestamp
      });
    }

    // 執行 match
    this.primaryDiscovery.matchAttemptCount++;
    this.recordDebugEvent('PRIMARY_DISCOVERY_MATCH_ATTEMPT', {
      attempt: this.primaryDiscovery.matchAttemptCount,
      sampleCount: this.primaryDiscovery.sampleCount
    });

    // 使用 runMatchOnce 並傳入已收集的 sample，避免 findBestMatch 內部重複 collect
    const result = await this.domOverlapMatcher.runMatchOnce(this.primaryLanguage, {
      domSample: sample,
      source: 'polling'
    });

    if (result.matched) {
      const matchResult = result.result;
      const context = this.getCurrentPlaybackContext();
      const parsedKey = this.parseCacheKey(matchResult.cacheKey);

      // 1. 記錄 MATCHED event（含 attribution 欄位供除錯）
      this.recordDebugEvent('PRIMARY_DISCOVERY_MATCHED', {
        cacheKey: matchResult.cacheKey,
        score: Math.round(matchResult.score * 1000) / 1000,
        matchedUnits: matchResult.matchedUnits,
        totalDomUnits: matchResult.totalDomUnits,
        attributedVideoId: context.videoId,
        originalParsedVideoId: parsedKey?.videoId || null,
        domTextPreview: (matchResult.domText || '').substring(0, 80),
        cueTextPreview: (matchResult.cueText || '').substring(0, 80)
      });

      // 2. 建立 enriched requestInfo（native-dom-match attribution）
      const enrichedRequestInfo = {
        ...matchResult.requestInfo,
        attributionReason: 'native-dom-match',
        attributedVideoId: context.videoId,
        originalCacheKey: matchResult.cacheKey,
        originalParsedVideoId: parsedKey?.videoId || null,
        overlapScore: matchResult.score,
        overlapSample: {
          domText: matchResult.domText || '',
          ttmlText: matchResult.cueText || '',
          timestamp: this.primaryDiscovery.lastSample?.timestamp ?? getCurrentTimestamp()
        },
        matchedAt: Date.now()
      };

      try {
        this.captureRawTTMLEvidence({
          cacheKey: matchResult.cacheKey,
          rawContent: matchResult.rawContent,
          requestInfo: enrichedRequestInfo,
          language: matchResult.language,
          rawMetadata: matchResult.rawMetadata
        });

        // 4. 檢查 recovery 是否成功（直接檢查 slot，避免 isLanguageSlotReady 觸發 clear）
        const primaryMeta = this.primarySubtitleMeta;
        const primaryMetaLanguage = this.parseCacheKey(primaryMeta?.cacheKey || '')?.language;
        const recoveryLanguageMatches = this.matchesLanguageForAcquisition(
          primaryMetaLanguage || matchResult.language,
          this.primaryLanguage,
          { allowGenericFallback: enrichedRequestInfo.attributionReason === 'native-dom-match' }
        );
        const recoveryApplied = Array.isArray(this.primarySubtitles) &&
          this.primarySubtitles.length > 0 &&
          !!primaryMeta &&
          primaryMeta.cacheKey === matchResult.cacheKey &&
          this.isSubtitleSlotMetaCurrent(primaryMeta) &&
          recoveryLanguageMatches;

        if (recoveryApplied) {
          this.primaryDiscovery.state = 'matched';
          this.primaryDiscovery.selectedCacheKey = matchResult.cacheKey;
          this.primaryDiscovery.selectedScore = matchResult.score;
          this.primaryDiscovery.lastFailureReason = null;

          this.recordDebugEvent('PRIMARY_READY', {
            source: 'recovery',
            cacheKey: matchResult.cacheKey,
            score: Math.round(matchResult.score * 1000) / 1000,
            attributedVideoId: context.videoId,
            originalParsedVideoId: parsedKey?.videoId || null
          });

          // ★ C: primary recovery 成功後立即觸發 secondary acquisition（idempotent，不 await）
          if (this.dualSubtitleEnabled && !this.isLanguageSlotReady(this.secondaryLanguage, 'secondary')) {
            this.ensureSecondaryLanguageAvailableOnce('primary-dom-recovery-ready').catch(error => {
              this.log('Secondary acquisition triggered by primary recovery failed:', error.message);
            });
          }
        } else {
          // Recovery 執行但 slot 未就緒（gate/promotion 拒絕，或語言不符）
          this.primaryDiscovery.selectedCacheKey = matchResult.cacheKey;
          this.primaryDiscovery.selectedScore = matchResult.score;
          this.primaryDiscovery.lastFailureReason = 'recovery-not-ready';

          this.recordDebugEvent('PRIMARY_DISCOVERY_RECOVERY_FAILED', {
            cacheKey: matchResult.cacheKey,
            score: Math.round(matchResult.score * 1000) / 1000,
            reason: 'primary-not-ready-after-handle',
            primarySubtitleCount: this.primarySubtitles.length,
            hasMeta: !!this.primarySubtitleMeta,
            activeCacheKey: this.primarySubtitleMeta?.cacheKey || null,
            cacheKeyMatches: this.primarySubtitleMeta?.cacheKey === matchResult.cacheKey,
            metaCurrent: this.primarySubtitleMeta ? this.isSubtitleSlotMetaCurrent(this.primarySubtitleMeta) : false,
            languageMatches: recoveryLanguageMatches,
            gateResult: this.evaluateSubtitleGate(matchResult.cacheKey, enrichedRequestInfo)
          });

          // Recovery 未成功時保持 discovery 可重試狀態，交由既有 stop condition / sampling cadence 控制下一輪
          if (this.primaryDiscovery.state === 'started' || this.primaryDiscovery.state === 'collecting') {
            this.scheduleNextDiscoverySample();
          }
        }
      } catch (error) {
        this.primaryDiscovery.lastFailureReason = 'recovery-error';
        this.recordDebugEvent('PRIMARY_DISCOVERY_RECOVERY_FAILED', {
          cacheKey: matchResult.cacheKey,
          error: error.message,
          reason: 'recovery-exception'
        });
        if (this.primaryDiscovery.state === 'started' || this.primaryDiscovery.state === 'collecting') {
          this.scheduleNextDiscoverySample();
        }
      }
      return;
    }

    // Match 失敗，記錄原因並安排下一次
    const failureReason = result.failureReason || 'match-failed';
    this.primaryDiscovery.lastFailureReason = failureReason;

    this.recordDebugEvent('PRIMARY_DISCOVERY_MATCH_FAILED', {
      attempt: this.primaryDiscovery.matchAttemptCount,
      failureReason,
      sampleCount: this.primaryDiscovery.sampleCount,
      candidateCount: result.allResults?.length || 0
    });

    // 若狀態仍是 collecting/started，繼續輪詢
    if (this.primaryDiscovery.state === 'started' || this.primaryDiscovery.state === 'collecting') {
      this.scheduleNextDiscoverySample();
    }
  }

  /**
   * 處理 DOM overlap matcher 的 match 結果（來自 MutationObserver 路徑）。
   * 邏輯與 tryPrimaryDiscoveryMatch 中的 recovery 區段相似，
   * 但省略輪詢排程（observer 會持續觸發），並加入 lock-in 停止條件檢查。
   */
  handleDomMatchResult(result) {
    // 先檢查 lock-in 條件，若已鎖定則停止 observer
    if (this.isPrimarySlotLockedToCurrentVideo()) {
      this.domOverlapMatcher?.stopWatching();
      return;
    }

    // ★ E: 累計 observer 路徑的 match 嘗試與 sample 資訊（source 為 mutation-observer）
    this.primaryDiscovery.matchAttemptCount++;
    if (result.result?.domText) {
      this.primaryDiscovery.lastSample = {
        text: result.result.domText,
        timestamp: getCurrentTimestamp(),
        source: 'mutation-observer'
      };
      this.primaryDiscovery.sampleCount++;

      // 觸發 DOM sample 檢測事件（每個 discovery context 只觸發一次），
      // 供 UI 層判斷啟動 long recovery 逾時
      if (!this.primaryDiscovery._domSampleEventFired) {
        this.primaryDiscovery._domSampleEventFired = true;
        const domEventContext = this.getCurrentPlaybackContext();
        dispatchInternalEvent({
          type: 'PRIMARY_DISCOVERY_DOM_SAMPLE_DETECTED',
          source: 'subtitle-interceptor',
          videoId: domEventContext.videoId,
          epoch: domEventContext.epoch,
          sampleCount: this.primaryDiscovery.sampleCount,
          timestamp: Date.now()
        });
      }
    }

    if (result.matched) {
      const matchResult = result.result;
      const context = this.getCurrentPlaybackContext();
      const parsedKey = this.parseCacheKey(matchResult.cacheKey);

      this.recordDebugEvent('PRIMARY_DISCOVERY_MATCHED', {
        cacheKey: matchResult.cacheKey,
        score: Math.round(matchResult.score * 1000) / 1000,
        matchedUnits: matchResult.matchedUnits,
        totalDomUnits: matchResult.totalDomUnits,
        attributedVideoId: context.videoId,
        originalParsedVideoId: parsedKey?.videoId || null,
        domTextPreview: (matchResult.domText || '').substring(0, 80),
        cueTextPreview: (matchResult.cueText || '').substring(0, 80),
        source: 'mutation-observer'
      });

      // 建立 enriched requestInfo（native-dom-match attribution）
      const enrichedRequestInfo = {
        ...matchResult.requestInfo,
        attributionReason: 'native-dom-match',
        attributedVideoId: context.videoId,
        originalCacheKey: matchResult.cacheKey,
        originalParsedVideoId: parsedKey?.videoId || null,
        overlapScore: matchResult.score,
        overlapSample: {
          domText: matchResult.domText || '',
          ttmlText: matchResult.cueText || '',
          timestamp: getCurrentTimestamp()
        },
        matchedAt: Date.now()
      };

      try {
        this.captureRawTTMLEvidence({
          cacheKey: matchResult.cacheKey,
          rawContent: matchResult.rawContent,
          requestInfo: enrichedRequestInfo,
          language: matchResult.language,
          rawMetadata: matchResult.rawMetadata
        });

        // 檢查 recovery 是否成功
        const primaryMeta = this.primarySubtitleMeta;
        const primaryMetaLanguage = this.parseCacheKey(primaryMeta?.cacheKey || '')?.language;
        const recoveryLanguageMatches = this.matchesLanguageForAcquisition(
          primaryMetaLanguage || matchResult.language,
          this.primaryLanguage,
          { allowGenericFallback: true }
        );
        const recoveryApplied = Array.isArray(this.primarySubtitles) &&
          this.primarySubtitles.length > 0 &&
          !!primaryMeta &&
          primaryMeta.cacheKey === matchResult.cacheKey &&
          this.isSubtitleSlotMetaCurrent(primaryMeta) &&
          recoveryLanguageMatches;

        if (recoveryApplied) {
          this.primaryDiscovery.state = 'matched';
          this.primaryDiscovery.selectedCacheKey = matchResult.cacheKey;
          this.primaryDiscovery.selectedScore = matchResult.score;
          this.primaryDiscovery.lastFailureReason = null;

          this.recordDebugEvent('PRIMARY_READY', {
            source: 'mutation-observer-recovery',
            cacheKey: matchResult.cacheKey,
            score: Math.round(matchResult.score * 1000) / 1000,
            attributedVideoId: context.videoId,
            originalParsedVideoId: parsedKey?.videoId || null
          });

          // Recovery 成功後檢查 lock-in → 停止 observer
          if (this.isPrimarySlotLockedToCurrentVideo()) {
            this.domOverlapMatcher?.stopWatching();
          }

          // ★ C: primary recovery 成功後立即觸發 secondary acquisition（idempotent，不 await）
          if (this.dualSubtitleEnabled && !this.isLanguageSlotReady(this.secondaryLanguage, 'secondary')) {
            this.ensureSecondaryLanguageAvailableOnce('primary-dom-recovery-ready').catch(error => {
              this.log('Secondary acquisition triggered by primary recovery failed:', error.message);
            });
          }
        } else {
          this.primaryDiscovery.selectedCacheKey = matchResult.cacheKey;
          this.primaryDiscovery.selectedScore = matchResult.score;
          this.primaryDiscovery.lastFailureReason = 'recovery-not-ready';

          this.recordDebugEvent('PRIMARY_DISCOVERY_RECOVERY_FAILED', {
            cacheKey: matchResult.cacheKey,
            score: Math.round(matchResult.score * 1000) / 1000,
            reason: 'primary-not-ready-after-handle',
            source: 'mutation-observer',
            primarySubtitleCount: this.primarySubtitles.length,
            hasMeta: !!this.primarySubtitleMeta,
            activeCacheKey: this.primarySubtitleMeta?.cacheKey || null,
            cacheKeyMatches: this.primarySubtitleMeta?.cacheKey === matchResult.cacheKey,
            metaCurrent: this.primarySubtitleMeta ? this.isSubtitleSlotMetaCurrent(this.primarySubtitleMeta) : false,
            languageMatches: recoveryLanguageMatches,
            gateResult: this.evaluateSubtitleGate(matchResult.cacheKey, enrichedRequestInfo)
          });

          // Recovery 未成功但 observer 仍在作用中，下次 DOM 變更會自動重試
        }
      } catch (error) {
        this.primaryDiscovery.lastFailureReason = 'recovery-error';
        this.recordDebugEvent('PRIMARY_DISCOVERY_RECOVERY_FAILED', {
          cacheKey: matchResult.cacheKey,
          error: error.message,
          reason: 'recovery-exception',
          source: 'mutation-observer'
        });
      }
    } else {
      const failureReason = result.failureReason || 'match-failed';
      this.primaryDiscovery.lastFailureReason = failureReason;

      this.recordDebugEvent('PRIMARY_DISCOVERY_MATCH_FAILED', {
        failureReason,
        source: 'mutation-observer',
        candidateCount: result.allResults?.length || 0
      });
    }
  }

  /**
   * 取得 primary discovery 相關 missing reason 摘要（供 debug event payload 使用）
   */
  getPrimaryMissingReasonsSummary() {
    return {
      computedMissingReason: this.computeSubtitleMissingReason('primary', this.primaryLanguage, this.getCurrentPlaybackContext()),
      lastAssignedMissingReason: this.lastSubtitleMissingReasons.primary,
      lastAcquisitionReason: this.lastAcquisitionResults.primary?.reason || null
    };
  }

  /**
   * 清理過期的 secondary recovery cooldown entries（超過 5 分鐘）
   */
  _cleanupSecondaryRecoveryCooldown() {
    if (!this._secondaryRecoveryCooldown || this._secondaryRecoveryCooldown.size === 0) return;
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;
    for (const [key, ts] of this._secondaryRecoveryCooldown) {
      if (now - ts > maxAge) {
        this._secondaryRecoveryCooldown.delete(key);
      }
    }
  }

  /**
   * 次要語言 DOM recovery（fallback-only）。
   * 當 secondary acquisition 因 polluted request evidence 失敗時，
   * 嘗試暫時切換 Netflix active track 到 secondaryLanguage，
   * 收集 DOM sample 並使用 DOMOverlapMatcher 比對 raw TTML pool 中的候選，
   *
   * 設計原則：
   * - 僅在 primary slot ready/locked、context ready、secondary slot 缺失時觸發
   * - 不強制顯示 Netflix 原生字幕（DOM sample 在 hide CSS 下可能不可取得）
   * - 含 per context (videoId|epoch|language) cooldown，避免重複切換
   * - 還原 starting track（若此 recovery 有切換 track）
   *
   * @param {string} reason - 觸發原因（用於 debug event）
   * @param {Object} [options] - 選項
   * @returns {Promise<boolean>} true 表示 recovery 成功
   */
  async trySecondaryDomRecovery(reason, options = {}) {
    // Idempotent guard
    if (this._secondaryRecoveryInFlight) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED', {
        reason,
        detail: 'already-in-flight'
      });
      return false;
    }

    this.recordDebugEvent('SECONDARY_DOM_RECOVERY_REQUESTED', { reason });

    // 清理過期 cooldown entries
    this._cleanupSecondaryRecoveryCooldown();

    // === Guard checks ===
    if (!this.dualSubtitleEnabled || !this.secondaryLanguage) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED', {
        reason,
        detail: !this.dualSubtitleEnabled ? 'dual-disabled' : 'no-secondary-language'
      });
      return false;
    }

    // Primary must be ready and locked to current video
    if (!this.isLanguageSlotReady(this.primaryLanguage, 'primary') || !this.isPrimarySlotLockedToCurrentVideo()) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED', {
        reason,
        detail: 'primary-not-ready-or-locked'
      });
      return false;
    }

    // Secondary slot must still be missing
    if (this.isLanguageSlotReady(this.secondaryLanguage, 'secondary')) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED', {
        reason,
        detail: 'secondary-already-ready'
      });
      return false;
    }

    const context = this.getCurrentPlaybackContext();
    if (context.state !== 'ready' || !context.videoId || context.videoId === 'unknown') {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED', {
        reason,
        detail: 'context-not-ready'
      });
      return false;
    }

    // Per-context cooldown guard
    const cooldownKey = `${context.videoId}|${context.epoch || 'null'}|${this.secondaryLanguage}`;
    const cooldownTs = this._secondaryRecoveryCooldown?.get(cooldownKey);
    if (cooldownTs && (Date.now() - cooldownTs) < 60000) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED', {
        reason,
        detail: 'cooldown-active',
        cooldownKey,
        remainingMs: 60000 - (Date.now() - cooldownTs)
      });
      return false;
    }

    // Netflix track list must contain secondaryLanguage
    const hasTrack = await this.hasAvailableNetflixLanguage(this.secondaryLanguage);
    if (!hasTrack) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED_NO_TRACK', {
        reason,
        secondaryLanguage: this.secondaryLanguage
      });
      return false;
    }

    // Raw TTML pool must have at least one candidate matching secondaryLanguage
    const hasRaw = await this.hasRawTTMLCandidateForLanguage(this.secondaryLanguage);
    if (!hasRaw) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED_NO_RAW_CANDIDATE', {
        reason,
        secondaryLanguage: this.secondaryLanguage
      });
      return false;
    }

    // DOM overlap matcher 不可在 primary watching 中（保守跳過）
    if (this.domOverlapMatcher?.isWatching()) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SKIPPED', {
        reason,
        detail: 'dom-overlap-matcher-busy'
      });
      return false;
    }

    // === Start recovery ===
    // 建構子已初始化 _secondaryRecoveryCooldown，此處直接使用
    // Set cooldown BEFORE attempting, to prevent repeated retry
    this._secondaryRecoveryCooldown.set(cooldownKey, Date.now());

    this._secondaryRecoveryInFlight = true;
    this.recordDebugEvent('SECONDARY_DOM_RECOVERY_STARTED', {
      reason,
      cooldownKey,
      secondaryLanguage: this.secondaryLanguage,
      context: { videoId: context.videoId, epoch: context.epoch }
    });

    // Capture start track for restore
    const startTrack = await this.captureCurrentNetflixTrack();
    let switchedAway = false;

    try {
      // If not already on secondaryLanguage, switch to it to let Netflix DOM update
      if (!startTrack || !this.matchesLanguageForAcquisition(startTrack.code, this.secondaryLanguage)) {
        try {
          await this.switchNetflixLanguage(this.secondaryLanguage, 'secondary-dom-recovery');
          switchedAway = true;
          // Wait briefly for Netflix DOM to update
          await this.sleep(1200);
        } catch (error) {
          this.recordDebugEvent('SECONDARY_DOM_RECOVERY_FAILED', {
            reason: 'switch-failed',
            error: error.message
          });
          this._secondaryRecoveryLastResult = { success: false, reason: 'switch-failed', error: error.message };
          return false;
        }
      }

      // Initialize matcher if needed (no startWatching — we do one-shot sampling)
      if (!this.domOverlapMatcher) {
        this.domOverlapMatcher = new DOMOverlapMatcher({
          debug: this.debug,
          readRawPool: (...args) => this.getTtmlAcquisitionIngress().readRawPool(...args)
        });
      }

      // Collect DOM sample
      const sample = this.domOverlapMatcher.collectDOMSample();
      if (!sample) {
        this.recordDebugEvent('SECONDARY_DOM_RECOVERY_FAILED', {
          reason: 'no-dom-sample',
          detail: 'DOM sample unavailable under existing hide CSS'
        });
        this._secondaryRecoveryLastResult = { success: false, reason: 'no-dom-sample' };
        return false;
      }

      // Run one-shot match for secondaryLanguage
      const matchResult = await this.domOverlapMatcher.runMatchOnce(this.secondaryLanguage, {
        domSample: sample,
        source: 'secondary-dom-recovery'
      });

      if (!matchResult.matched) {
        this.recordDebugEvent('SECONDARY_DOM_RECOVERY_FAILED', {
          reason: 'match-failed',
          failureReason: matchResult.failureReason,
          candidateCount: matchResult.allResults?.length || 0
        });
        this._secondaryRecoveryLastResult = {
          success: false,
          reason: 'match-failed',
          failureReason: matchResult.failureReason
        };
        return false;
      }

      const match = matchResult.result;
      const parsedKey = this.parseCacheKey(match.cacheKey);

      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_MATCHED', {
        cacheKey: match.cacheKey,
        score: Math.round(match.score * 1000) / 1000,
        matchedUnits: match.matchedUnits,
        totalDomUnits: match.totalDomUnits,
        secondaryLanguage: this.secondaryLanguage,
        videoId: context.videoId
      });

      // Build enriched requestInfo mirroring primary recovery
      const enrichedRequestInfo = {
        ...match.requestInfo,
        attributionReason: 'native-dom-match',
        attributedVideoId: context.videoId,
        originalCacheKey: match.cacheKey,
        originalParsedVideoId: parsedKey?.videoId || null,
        overlapScore: match.score,
        overlapSample: {
          domText: match.domText || '',
          ttmlText: match.cueText || '',
          timestamp: sample.timestamp
        },
        matchedAt: Date.now()
      };

      try {
        this.captureRawTTMLEvidence({
          cacheKey: match.cacheKey,
          rawContent: match.rawContent,
          requestInfo: enrichedRequestInfo,
          language: match.language,
          rawMetadata: match.rawMetadata
        });

        // Verify secondary slot became ready/current
        const secondaryReady = this.isLanguageSlotReady(this.secondaryLanguage, 'secondary');
        if (secondaryReady) {
          this._secondaryRecoveryLastResult = {
            success: true,
            cacheKey: match.cacheKey,
            score: Math.round(match.score * 1000) / 1000,
            timestamp: Date.now()
          };
          this.recordDebugEvent('SECONDARY_DOM_RECOVERY_SUCCEEDED', {
            cacheKey: match.cacheKey,
            score: Math.round(match.score * 1000) / 1000
          });
          return true;
        } else {
          this.recordDebugEvent('SECONDARY_DOM_RECOVERY_FAILED', {
            reason: 'secondary-not-ready-after-handle',
            cacheKey: match.cacheKey,
            secondarySubtitleCount: this.secondarySubtitles.length,
            hasMeta: !!this.secondarySubtitleMeta
          });
          this._secondaryRecoveryLastResult = {
            success: false,
            reason: 'secondary-not-ready-after-handle',
            cacheKey: match.cacheKey
          };
          return false;
        }
      } catch (error) {
        this.recordDebugEvent('SECONDARY_DOM_RECOVERY_FAILED', {
          reason: 'handle-raw-ttml-error',
          error: error.message
        });
        this._secondaryRecoveryLastResult = {
          success: false,
          reason: 'handle-raw-ttml-error',
          error: error.message
        };
        return false;
      }
    } catch (error) {
      this.recordDebugEvent('SECONDARY_DOM_RECOVERY_FAILED', {
        reason: 'unexpected-error',
        error: error.message
      });
      this._secondaryRecoveryLastResult = {
        success: false,
        reason: 'unexpected-error',
        error: error.message
      };
      return false;
    } finally {
      this._secondaryRecoveryInFlight = false;
      // Always restore start track if we switched
      if (switchedAway) {
        await this.restoreNetflixTrack(startTrack, options.defaultLanguage || this.primaryLanguage, 'secondary-dom-recovery-finally');
      }
    }
  }

  /**
   * Promotion Guard：判斷已解析的 TTML 是否應 promotion 到 active slot。
   * 避免 A 集末段 prefetch B 集字幕時覆蓋 A 集的 active slot。
   * 被拒絕的 TTML 仍保留在 interceptedSubtitles 中以供日後復原。
   *
   * @param {string} language - 語言代碼
   * @param {Array} subtitles - 解析後的字幕陣列
   * @param {Object} metadata - 包含 cacheKey、requestInfo、gate、playbackContext
   * @param {string} [role] - 'primary' 或 'secondary'，未指定時從 language 推導
   * @returns {{ promote: boolean, reason: string, existingSlotCacheKey: string|null }}
   */
  shouldPromoteParsedTTMLToActiveSlot(language, subtitles, metadata, role) {
    const currentContext = this.getCurrentPlaybackContext();

    // 若未指定 role，從 language 推導
    if (!role) {
      role = this.resolveLanguageRole(language);
    }

    const existingSubtitles = role === 'primary' ? this.primarySubtitles : this.secondarySubtitles;
    const existingMeta = role === 'primary' ? this.primarySubtitleMeta : this.secondarySubtitleMeta;

    const targetSlotReady = Array.isArray(existingSubtitles) && existingSubtitles.length > 0 && !!existingMeta;

    // 規則 1：若目標 slot 目前無 ready subtitle，允許 promotion
    if (!targetSlotReady) {
      return { promote: true, reason: 'slot-empty', existingSlotCacheKey: null };
    }

    const incomingCacheKey = metadata?.cacheKey;
    const existingCacheKey = existingMeta?.cacheKey || null;

    // 規則 2：若 target slot 已 ready，且 incoming cacheKey 等於現有 slot cacheKey，允許更新
    if (incomingCacheKey && existingCacheKey && incomingCacheKey === existingCacheKey) {
      return { promote: true, reason: 'same-cache-key-update', existingSlotCacheKey: existingCacheKey };
    }

    // 規則 4：允許 native-dom-match 歸屬的 entry 覆蓋已 ready slot
    if (metadata?.requestInfo?.attributionReason === 'native-dom-match' &&
        metadata?.requestInfo?.attributedVideoId === currentContext.videoId) {
      return { promote: true, reason: 'native-dom-match-attribution', existingSlotCacheKey: existingCacheKey };
    }

    // 規則 3：預設拒絕 promotion，保留 parsed cache
    return {
      promote: false,
      reason: 'active-slot-already-current',
      existingSlotCacheKey: existingCacheKey
    };
  }

  /**
   * 處理接收到的 raw TTML 數據 - 增加 videoID 驗證
   */
  captureTtmlEvidence(event, { resolveWaiters = false } = {}) {
    const { cacheKey, rawContent, requestInfo, language } = event;
    const rawMetadata = event.rawMetadata || event.metadata || requestInfo?.rawTtmlMetadata || null;
    const finish = (outcome) => {
      if (resolveWaiters) this.resolveAcquisitionWaiters(event);
      return outcome;
    };
    
    this.log(`接收到 raw TTML: ${language}, 緩存鍵: ${cacheKey}`);
    
    // 步驟1: 解析緩存鍵獲取 videoID
    const parsedKey = this.parseCacheKey(cacheKey);
    if (!parsedKey) {
      this.log(`無效的緩存鍵格式，跳過處理: ${cacheKey}`);
      return finish({ status: 'domain-rejected', category: 'gate', reason: 'invalid-cache-key' });
    }
    
    // 步驟2: 使用 PlaybackContext 與 request-time evidence 驗證字幕歸屬
    const gate = this.evaluateSubtitleGate(cacheKey, requestInfo);
    const currentVideoId = gate.currentVideoId;
    if (!currentVideoId) {
      this.log('無法獲取當前影片 ID，可能不在觀看頁面，跳過處理');
      this.recordDebugEvent('RAW_TTML_SKIPPED', {
        reason: 'missing-current-video-id',
        cacheKey,
        language
      });
      return finish({ status: 'domain-rejected', category: 'gate', reason: 'missing-current-video-id' });
    }

    if (!gate.accepted) {
      this.log('RAW TTML 不符合目前 PlaybackContext，丟棄避免覆蓋 UI:', gate);
      if (this.matchesLanguageForAcquisition(language, this.primaryLanguage)) {
        this.lastSubtitleMissingReasons.primary = `raw-ttml-gate-${gate.reason}`;
      }
      if (this.matchesLanguageForAcquisition(language, this.secondaryLanguage)) {
        this.lastSubtitleMissingReasons.secondary = `raw-ttml-gate-${gate.reason}`;
      }
      this.recordDebugEvent('RAW_TTML_REJECTED_BY_GATE', {
        cacheKey,
        language,
        rawMetadata,
        gate
      });
      this.dispatchSubtitleReadinessChanged('raw-ttml-rejected-by-gate', { cacheKey, language, gate });
      if (gate.reason === 'playback-context-transitioning') {
        this.scheduleReloadAfterContextReady('raw-ttml-gate-transitioning', this.getCurrentPlaybackContext());
        return finish({ status: 'stale-context', reason: 'playback-context-transitioning' });
      }
      return finish({ status: 'domain-rejected', category: 'gate', reason: gate.reason });
    }
    
    // 步驟3: 驗證是否為當前影片的字幕
    // DOM match 歸屬的 entry 即使 cacheKey videoId 不符，仍視為當前影片
    const isCurrentVideo = (parsedKey.videoId === currentVideoId) ||
      (gate.reason === 'accepted-native-dom-match');

    if (!isCurrentVideo) {
      this.log(`字幕屬於其他影片（可能是預載），僅緩存不立即處理:`, {
        緩存中的videoID: parsedKey.videoId,
        當前影片ID: currentVideoId,
        語言: language
      });
    } else {
      this.log(`✅ VideoID 驗證通過，處理當前影片字幕:`, {
        語言: language,
        videoID: currentVideoId,
        緩存鍵: cacheKey
      });
    }

    this.lastProcessedTTMLEvidence = {
      cacheKey,
      language,
      parsedVideoId: parsedKey.videoId,
      currentVideoId,
      isCurrentVideo,
      rawMetadata,
      playbackContext: this.getCurrentPlaybackContext(),
      gate,
      handledAt: Date.now()
    };

    this.recordDebugEvent('RAW_TTML_RECEIVED', this.lastProcessedTTMLEvidence);

    // 解析和儲存（無論是否為當前影片）
    try {
      const parseResult = parseSubtitle(rawContent);
      const { subtitles, regionConfigs } = parseResult;

      if (subtitles.length > 0) {
        const timeIndex = buildTimeIndex(subtitles);

        this.interceptedSubtitles.set(cacheKey, {
          subtitles: subtitles,
          requestInfo: requestInfo,
          rawMetadata,
          metadata: rawMetadata,
          language: language,
          timeIndex: timeIndex,
          regionConfigs: regionConfigs,
          playbackContext: this.getCurrentPlaybackContext(),
          gate,
          timestamp: Date.now()
        });

        this.log(`TTML解析完成: ${language}, 共 ${subtitles.length} 條字幕, ${Object.keys(regionConfigs).length} 個 region 配置`);

        // 只有當前影片才觸發即時處理
        if (isCurrentVideo) {
          // native-dom-match entries 允許 base-code language fallback（如 zh 匹配 zh-Hant）
          const domMatchLangOpts = (requestInfo?.attributionReason === 'native-dom-match' &&
            requestInfo?.attributedVideoId === currentVideoId) ?
            { allowGenericFallback: true } : {};

          if (this.matchesLanguageForAcquisition(language, this.primaryLanguage, domMatchLangOpts) && Object.keys(regionConfigs).length > 0) {
            this.log(`更新 netflix-player-adapter 的 region 配置 (主要語言: ${language})`);
            setRegionConfigs(regionConfigs);
          }

          // Promotion Guard：避免非當前影片的 TTML 覆蓋已 ready 的 active slot
          // 僅針對目標語言（primary/secondary）執行 guard；非目標語言不應產生誤判事件
          if (this.matchesLanguageForAcquisition(language, this.primaryLanguage, domMatchLangOpts) ||
              (this.matchesLanguageForAcquisition(language, this.secondaryLanguage, domMatchLangOpts) && this.dualSubtitleEnabled)) {
            const promotionRole = this.resolveLanguageRole(language);
            const promotion = this.shouldPromoteParsedTTMLToActiveSlot(language, subtitles, {
              cacheKey,
              requestInfo,
              gate,
              playbackContext: this.getCurrentPlaybackContext(),
              rawMetadata
            }, promotionRole);

            if (!promotion.promote) {
              this.recordDebugEvent('RAW_TTML_STORED_NOT_PROMOTED', {
                cacheKey,
                language,
                role: promotionRole,
                existingSlotCacheKey: promotion.existingSlotCacheKey,
                reason: promotion.reason,
                gate,
                currentTime: getCurrentTimestamp(),
                playbackContext: this.getCurrentPlaybackContext()
              });
              // 保留 parsed cache 在 interceptedSubtitles 中供日後復原用
              return finish({ status: 'retained', role: promotionRole });
            }

            this.checkAndProcessLanguage(language, subtitles, {
              cacheKey,
              timeIndex,
              playbackContext: this.getCurrentPlaybackContext(),
              gate,
              requestInfo,
              rawMetadata
            });
            return finish({ status: 'promoted', role: promotionRole });
          }
        }
        return finish({ status: 'retained' });
      } else {
        if (this.matchesLanguageForAcquisition(language, this.primaryLanguage)) {
          this.lastSubtitleMissingReasons.primary = 'parse-empty';
        }
        if (this.matchesLanguageForAcquisition(language, this.secondaryLanguage)) {
          this.lastSubtitleMissingReasons.secondary = 'parse-empty';
        }
        this.dispatchSubtitleReadinessChanged('raw-ttml-parse-empty', { cacheKey, language });
        this.recordDebugEvent('RAW_TTML_PARSE_EMPTY', {
          cacheKey,
          language,
          rawMetadata,
          rawLength: rawContent?.length || 0,
          gate
        });
        return finish({ status: 'domain-rejected', category: 'parse', reason: 'empty' });
      }
    } catch (error) {
      console.error('解析 TTML 失敗');
      if (this.matchesLanguageForAcquisition(language, this.primaryLanguage)) {
        this.lastSubtitleMissingReasons.primary = 'parse-error';
      }
      if (this.matchesLanguageForAcquisition(language, this.secondaryLanguage)) {
        this.lastSubtitleMissingReasons.secondary = 'parse-error';
      }
      this.dispatchSubtitleReadinessChanged('raw-ttml-parse-error', { cacheKey, language, reason: 'parse-error' });
      this.recordDebugEvent('RAW_TTML_PARSE_ERROR', {
        cacheKey,
        language,
        rawMetadata,
        rawLength: rawContent?.length || 0,
        reason: 'parse-error',
        gate
      });
      return finish({ status: 'domain-rejected', category: 'parse', reason: 'error' });
    }
  }

  /**
   * 檢查並處理語言數據
   */
  checkAndProcessLanguage(language, subtitles, metadata = {}) {
    // native-dom-match entries 允許 base-code language fallback（如 zh 匹配 zh-Hant）
    const isDomMatchEntry = metadata?.requestInfo?.attributionReason === 'native-dom-match' &&
      metadata?.requestInfo?.attributedVideoId === this.getCurrentPlaybackContext()?.videoId;
    const langMatchOpts = isDomMatchEntry ? { allowGenericFallback: true } : {};

    // Promotion Guard (入口防禦)：避免其他路徑繞過既有歸屬檢查。
    if (this.matchesLanguageForAcquisition(language, this.primaryLanguage, langMatchOpts) ||
        (this.matchesLanguageForAcquisition(language, this.secondaryLanguage, langMatchOpts) && this.dualSubtitleEnabled)) {
      const promotionRole = this.resolveLanguageRole(language);
      const promotion = this.shouldPromoteParsedTTMLToActiveSlot(language, subtitles, metadata, promotionRole);
      if (!promotion.promote) {
        this.recordDebugEvent('RAW_TTML_STORED_NOT_PROMOTED', {
          cacheKey: metadata.cacheKey,
          language,
          role: promotionRole,
          existingSlotCacheKey: promotion.existingSlotCacheKey,
          reason: promotion.reason,
          gate: metadata.gate,
          currentTime: getCurrentTimestamp(),
          playbackContext: metadata.playbackContext || this.getCurrentPlaybackContext()
        });
        return;
      }
    }

    // 檢查是否是我們需要的語言（支援 base-code fallback）
    if (this.matchesLanguageForAcquisition(language, this.primaryLanguage, langMatchOpts)) {
      this.primarySubtitles = subtitles;
      this.primaryTimeIndex = metadata.timeIndex || this.primaryTimeIndex;
      // 改用 createSubtitleSlotMeta 確保 attribution 欄位被記錄
      this.primarySubtitleMeta = this.createSubtitleSlotMeta(metadata.cacheKey, {
        requestInfo: metadata.requestInfo,
        rawMetadata: metadata.rawMetadata
      });
      this.lastSubtitleMissingReasons.primary = null;
      this.dispatchSubtitleReadinessChanged('primary-slot-updated', {
        cacheKey: metadata.cacheKey || null,
        language
      });
      this.log(`主要語言字幕已更新: ${language} (目標: ${this.primaryLanguage})`);

      if (this.dualSubtitleEnabled && !this.isLanguageSlotReady(this.secondaryLanguage, 'secondary')) {
        this.recordDebugEvent('SECONDARY_ACQUISITION_TRIGGERED_AFTER_PRIMARY_READY', {
          language: this.secondaryLanguage,
          primaryLanguage: this.primaryLanguage
        });
        this.ensureSecondaryLanguageAvailableOnce('primary-ready-trigger', {
          defaultLanguage: this.primaryLanguage
        }).catch(error => {
          this.log('Secondary acquisition triggered after primary ready failed:', error.message);
        });
      }
    } else if (this.matchesLanguageForAcquisition(language, this.secondaryLanguage, langMatchOpts) && this.dualSubtitleEnabled) {
      this.secondarySubtitles = subtitles;
      this.secondaryTimeIndex = metadata.timeIndex || this.secondaryTimeIndex;
      // 改用 createSubtitleSlotMeta 確保 attribution 欄位被記錄
      this.secondarySubtitleMeta = this.createSubtitleSlotMeta(metadata.cacheKey, {
        requestInfo: metadata.requestInfo,
        rawMetadata: metadata.rawMetadata
      });
      this.lastSubtitleMissingReasons.secondary = null;
      this.dispatchSubtitleReadinessChanged('secondary-slot-updated', {
        cacheKey: metadata.cacheKey || null,
        language
      });
      this.log(`次要語言字幕已更新: ${language} (目標: ${this.secondaryLanguage})`);
    } else if (isDomMatchEntry) {
      // DOM match entry 但語言仍無法匹配 — 記錄診斷事件以利除錯
      this.primaryDiscovery.lastFailureReason = 'language-mismatch';
      this.recordDebugEvent('PRIMARY_DISCOVERY_LANGUAGE_MISMATCH', {
        language,
        primaryLanguage: this.primaryLanguage,
        secondaryLanguage: this.secondaryLanguage,
        cacheKey: metadata.cacheKey
      });
    }
  }

  /**
   * 清理舊影片的緩存數據
   */
  cleanupOldVideoCache(currentVideoId) {
    if (!currentVideoId) {
      this.log('無法清理緩存：當前影片 ID 為空');
      return;
    }
    
    let cleanedCount = 0;
    let preservedDomMatchCount = 0;
    const keysToDelete = [];
    
    // 遍歷所有緩存，找出不屬於當前影片的數據
    for (const [cacheKey, data] of this.interceptedSubtitles) {
      const parsedKey = this.parseCacheKey(cacheKey);
      if (parsedKey && parsedKey.videoId !== currentVideoId) {
        // DOM match 歸屬且 attributedVideoId 為目前影片者應保留
        const requestInfo = data?.requestInfo || {};
        if (requestInfo.attributionReason === 'native-dom-match' &&
            requestInfo.attributedVideoId === currentVideoId) {
          preservedDomMatchCount++;
          this.recordDebugEvent('CACHE_DOM_MATCH_PRESERVED', {
            cacheKey,
            attributedVideoId: requestInfo.attributedVideoId,
            cacheKeyVideoId: parsedKey.videoId,
            currentVideoId,
            language: data?.language || null
          });
          continue; // 保留此 entry
        }
        keysToDelete.push(cacheKey);
        cleanedCount++;
      }
    }
    
    // 刪除舊數據
    keysToDelete.forEach(key => {
      this.interceptedSubtitles.delete(key);
      this.log(`清理舊影片緩存: ${key}`);
    });
    
    if (cleanedCount > 0 || preservedDomMatchCount > 0) {
      this.log(`✅ 已清理 ${cleanedCount} 個舊影片的緩存數據，保留了 ${preservedDomMatchCount} 個 DOM match 歸屬的緩存`);
      
      // 清理後重置當前字幕數據（如果它們不屬於當前影片）
      this.validateCurrentSubtitles(currentVideoId);
    } else {
      this.log('無需清理緩存，所有數據都屬於當前影片');
    }
  }

  /**
   * 驗證當前字幕數據是否屬於當前影片
   */
  validateCurrentSubtitles(currentVideoId) {
    // 檢查主要語言字幕
    if (this.primarySubtitles.length > 0) {
      const isValid = this.isSubtitlesValidForVideo(this.primaryLanguage, currentVideoId);
      if (!isValid) {
        this.log(`主要語言字幕不屬於當前影片，清空: ${this.primaryLanguage}`);
        this.primarySubtitles = [];
        this.primaryTimeIndex = null;
        this.primarySubtitleMeta = null;
      }
    }
    
    // 檢查次要語言字幕
    if (this.secondarySubtitles.length > 0) {
      const isValid = this.isSubtitlesValidForVideo(this.secondaryLanguage, currentVideoId);
      if (!isValid) {
        this.log(`次要語言字幕不屬於當前影片，清空: ${this.secondaryLanguage}`);
        this.secondarySubtitles = [];
        this.secondaryTimeIndex = null;
        this.secondarySubtitleMeta = null;
      }
    }
  }

  /**
   * 檢查指定語言的字幕是否屬於當前影片
   */
  isSubtitlesValidForVideo(language, currentVideoId) {
    for (const [cacheKey, data] of this.interceptedSubtitles) {
      const parsedKey = this.parseCacheKey(cacheKey);
      if (!parsedKey) continue;

      // DOM match 歸屬的 entry 即使 cacheKey videoId 不同仍視為有效
      const requestInfo = data?.requestInfo || {};
      const isDomMatch = requestInfo.attributionReason === 'native-dom-match' &&
        requestInfo.attributedVideoId === currentVideoId;
      const videoIdMatch = parsedKey.videoId === currentVideoId || isDomMatch;

      if (videoIdMatch &&
          this.matchesLanguageForAcquisition(parsedKey.language, language) &&
          this.isSubtitleEntryCurrent(cacheKey, data)) {
        return true;
      }
    }
    return false;
  }

  // 設置事件處理器
  setupEventHandlers() {
    this.disposeInternalEventHandlers();

    // 監聽影片 ID 變化事件
    this._internalEventDisposers.push(registerInternalEventHandler('VIDEO_ID_CHANGED', async (event) => {
      const newVideoId = event.newVideoId || event.videoId;
      const oldVideoId = event.oldVideoId;

      this.log(`檢測到影片切換: ${oldVideoId} -> ${newVideoId}`);

      // 步驟1: 清理舊影片的緩存數據
      this.cleanupOldVideoCache(newVideoId);
      this.clearAcquisitionWaiters('video-id-changed');
      this._secondaryAcquisitionInFlight = null;
      this.lastSubtitleMissingReasons.primary = 'video-id-changed-primary-not-ready';
      this.lastSubtitleMissingReasons.secondary = 'video-id-changed-secondary-not-ready';
      this.dispatchSubtitleReadinessChanged('video-id-changed', { oldVideoId, newVideoId });

      // 步驟2: 重新載入字幕數據（覆用現有邏輯）
      // loadInterceptedSubtitles() 已包含完整的緩存檢查、分析和載入流程
      if (this.isActive) {
        this.log('重新載入字幕數據以確保使用正確的字幕檔...');
        await this.loadInterceptedSubtitles();

        // VIDEO_ID_CHANGED 後 primary 仍未就緒，嘗試啟動 discovery
        if (!this.isLanguageSlotReady(this.primaryLanguage, 'primary')) {
          this.tryStartPrimaryDiscovery('video-id-changed');
        }
      }
    }));

    // PlaybackContext 可能在 TTML 回來後才從 transitioning 變成 ready。
    // ready 後重新掃 page script raw TTML cache，避免已攔到的字幕被早期 gate 永久錯過。
    this._internalEventDisposers.push(registerInternalEventHandler('PLAYBACK_CONTEXT_CHANGED', (event) => {
      const context = event.context;
      if (!this.isActive || context?.state !== 'ready' || !context.videoId) {
        return;
      }

      // ★ A: context ready 時立即嘗試啟動 primary discovery，不等 scheduleReload 的漫長流程
      this.tryStartPrimaryDiscovery('early-context-ready');

      this.scheduleReloadAfterContextReady(event.reason, context);
    }));

    this._internalEventDisposers.push(registerInternalEventHandler('PLAYER_STATE_CHANGED', (event) => {
      const currentVideoId = getVideoId();
      if (!this.isActive || event.state !== 'seeked' || event.videoId !== currentVideoId) {
        return;
      }

      this._renderGeneration += 1;
      dispatchInternalEvent({
        type: 'SUBTITLE_RENDER_RESET',
        renderGeneration: this._renderGeneration,
        videoId: currentVideoId,
        targetTimestamp: event.timestamp,
        reason: 'seeked'
      });
      this.lastRenderedSubtitle = null;
      this.updateSubtitleDisplay();
    }));
  }

  disposeInternalEventHandlers() {
    for (const dispose of this._internalEventDisposers) {
      dispose();
    }
    this._internalEventDisposers = [];
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleInterceptor] ${message}`, ...args);
    }
  }
}

export { SubtitleInterceptor };
