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
import { sendMessageToPageScript, sendMessage, registerInternalEventHandler, dispatchInternalEvent } from '../system/messaging.js';
import { getCurrentTimestamp, getVideoId } from '../core/video-info.js';
import { playbackContextManager } from '../core/playback-context-manager.js';
import { getPlayerAdapter, setRegionConfigs } from '../ui/netflix-player-adapter.js';

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
    
    this.log('啟動字幕攔截模式...');
    this.isActive = true;
    this.dispatchSubtitleReadinessChanged('interceptor-started-primary-not-ready');
    
    // 載入攔截的字幕數據
    this.loadInterceptedSubtitles();
    this.scheduleReloadAfterContextReady('interceptor-start', this.getCurrentPlaybackContext());
    
    // 開始渲染循環
    this.startRenderLoop();
    
    this.log('字幕攔截模式已啟動');
  }

  stop() {
    if (!this.isActive) {
      this.log('字幕攔截已經停止，跳過');
      return;
    }
    
    this.log('停止字幕攔截模式...');
    this.isActive = false;
    
    // 停止渲染循環
    this.stopRenderLoop();
    this.clearAcquisitionWaiters('interceptor-stopped');

    if (this.contextReloadTimer) {
      clearTimeout(this.contextReloadTimer);
      this.contextReloadTimer = null;
    }
    
    // 清理狀態
    this.currentTimestamp = 0;
    this.lastRenderedSubtitle = null;
    this.dispatchSubtitleReadinessChanged('interceptor-stopped');
    
    this.log('字幕攔截模式已停止');
  }

  onSubtitleDetected(callback) {
    this.callback = callback;
    this.log('字幕檢測回調已註冊');
  }

  // 等待播放器準備就緒（簡化版本，假設播放器助手已在 initialization-manager 中初始化）
  async waitForPlayerReady() {
    this.log('檢查播放器準備狀態...');
    
    try {
      // 簡單檢查是否可以獲取到可用語言列表
      const result = await sendMessageToPageScript({
        type: 'GET_AVAILABLE_LANGUAGES'
      });
      
      if (result && result.success && result.languages && result.languages.length > 0) {
        this.log('播放器已準備就緒，可用語言:', result.languages.map(l => l.code));
        return true;
      } else {
        const reason = result?.error || '播放器未準備就緒';
        this.log('播放器暫時未準備就緒:', reason);
        this.recordDebugEvent('PLAYER_SOFT_NOT_READY', {
          reason,
          languagesCount: result?.languages?.length || 0
        });
        return false;
      }
      
    } catch (error) {
      this.log('檢查播放器狀態時出錯，視為暫時未就緒:', error.message);
      this.recordDebugEvent('PLAYER_SOFT_NOT_READY', {
        reason: error.message
      });
      return false;
    }
  }

  // 載入攔截的字幕數據（優化流程：緩存檢查優先 -> 智能語言切換 -> 恢復設定）
  async loadInterceptedSubtitles() {
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
        await this.ensureLanguageAvailable(this.secondaryLanguage, 'secondary', { defaultLanguage });
      }

      // 階段4: 切回預設語言
      await this.restoreDefaultLanguage(defaultLanguage);
      
      this.log('字幕數據載入完成，已恢復用戶原始設定');
      
    } catch (error) {
      console.error('載入字幕數據失敗:', error);
      throw error;
    } finally {
      this.isLoadingInterceptedSubtitles = false;
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
    const existingTTMLs = await sendMessageToPageScript({
      type: 'GET_ALL_INTERCEPTED_TTML'
    });
    
    if (existingTTMLs && existingTTMLs.success) {
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
      
      Object.entries(existingTTMLs.allTTMLs).forEach(([cacheKey, ttmlData]) => {
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
        this.handleRawTTMLIntercepted({
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
    
    return new Map();
  }

  /**
   * 診斷 page script raw TTML cache：逐筆檢查 gate 與 parse 結果。
   * 可在 Netflix console 執行：
   * await window.subpalApp?.components?.subtitleCoordinator?.interceptor?.debugRawTTMLCache()
   */
  async debugRawTTMLCache() {
    const response = await sendMessageToPageScript({
      type: 'GET_ALL_INTERCEPTED_TTML'
    });

    if (!response?.success) {
      const result = {
        success: false,
        error: response?.error || 'GET_ALL_INTERCEPTED_TTML failed'
      };
      this.recordDebugEvent('RAW_TTML_CACHE_DIAGNOSTIC_FAILED', result);
      return result;
    }

    const context = this.getCurrentPlaybackContext();
    const entries = Object.entries(response.allTTMLs || {}).map(([cacheKey, data]) => {
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
            endTime: subtitles[0].endTime,
            text: subtitles[0].text?.substring(0, 80) || ''
          } : null,
          lastSubtitle: subtitles.length > 0 ? {
            startTime: subtitles[subtitles.length - 1].startTime,
            endTime: subtitles[subtitles.length - 1].endTime,
            text: subtitles[subtitles.length - 1].text?.substring(0, 80) || ''
          } : null,
          error: null
        };
      } catch (error) {
        parse = {
          ...parse,
          error: error.message
        };
      }

      return {
        cacheKey,
        language: data?.language || null,
        rawMetadata: data?.rawMetadata || data?.metadata || data?.requestInfo?.rawTtmlMetadata || null,
        rawLength: rawContent.length,
        rawStart: rawContent.substring(0, 160),
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
          derivedSubtitleVideo: requestInfo.derivedSubtitleVideo || null
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
    const defaultLanguageResult = await sendMessageToPageScript({
      type: 'GET_CURRENT_LANGUAGE'
    });
    
    const defaultLanguage = defaultLanguageResult?.language?.code;
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

      candidates.push({
        cacheKey,
        data,
        hasCurrentSubtitle: !!subtitleAtCurrentTime,
        subtitleCount: subtitles.length,
        requestTime: data?.requestInfo?.requestTime || data?.timestamp || 0
      });
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
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
      candidates: candidates.map(candidate => ({
        cacheKey: candidate.cacheKey,
        hasCurrentSubtitle: candidate.hasCurrentSubtitle,
        subtitleCount: candidate.subtitleCount,
        requestTime: candidate.requestTime
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
    try {
      const result = await sendMessageToPageScript({
        type: 'GET_CURRENT_LANGUAGE'
      });
      return result?.language || null;
    } catch (error) {
      this.recordDebugEvent('LANGUAGE_ACQUISITION_CURRENT_LANGUAGE_FAILED', {
        error: error.message
      });
      return null;
    }
  }

  async getAvailableNetflixLanguages() {
    try {
      const result = await sendMessageToPageScript({
        type: 'GET_AVAILABLE_LANGUAGES'
      });
      return Array.isArray(result?.languages) ? result.languages : [];
    } catch (error) {
      this.recordDebugEvent('LANGUAGE_ACQUISITION_AVAILABLE_LANGUAGES_FAILED', {
        error: error.message
      });
      return [];
    }
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

    const switchResult = await sendMessageToPageScript({
      type: 'SWITCH_LANGUAGE',
      languageCode
    });

    if (!switchResult?.success) {
      throw new Error(switchResult?.error || `switch-language-failed-${languageCode}`);
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
    try {
      const response = await sendMessageToPageScript({
        type: 'GET_ALL_INTERCEPTED_TTML'
      });
      rawEntries = Object.entries(response?.allTTMLs || {})
        .filter(([cacheKey, data]) => {
          const parsedKey = this.parseCacheKey(cacheKey);
          return this.matchesLanguageForAcquisition(data?.language || parsedKey?.language, languageCode);
        })
        .map(([cacheKey, data]) => ({
          cacheKey,
          language: data?.language || null,
          gate: this.evaluateSubtitleGate(cacheKey, data?.requestInfo),
          rawMetadata: data?.rawMetadata || data?.metadata || data?.requestInfo?.rawTtmlMetadata || null
        }));
    } catch (error) {
      rawError = error.message;
    }

    let recentNonTTMLCandidateCount = 0;
    try {
      const debugResponse = await sendMessageToPageScript({
        type: 'GET_SUBPAL_DEBUG_SNAPSHOT'
      });
      recentNonTTMLCandidateCount = (debugResponse?.debugSnapshot?.recentEvents || [])
        .filter(event => event.type === 'CDN_RESPONSE_CANDIDATE' && event.classification?.isTTML === false)
        .length;
    } catch (error) {
      // Debug snapshot 失敗只影響診斷摘要，不影響 acquisition 流程。
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
        await sendMessageToPageScript({
          type: 'SWITCH_LANGUAGE',
          languageCode: defaultLanguage
        });
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
      // 使用 ConfigBridge 設置配置（會自動更新緩存並通知訂閱者）
      await this.configBridge.setMultiple({
        'subtitle.primaryLanguage': primaryLanguage,
        'subtitle.secondaryLanguage': secondaryLanguage
      });

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
      // 使用 ConfigBridge 設置配置（會自動更新緩存並通知訂閱者）
      await this.configBridge.set('subtitle.dualModeEnabled', enabled);

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
      rawTTMLMetadata: Array.from(this.interceptedSubtitles.entries()).map(([cacheKey, data]) => ({
        cacheKey,
        language: data?.language || null,
        rawMetadata: data?.rawMetadata || data?.metadata || data?.requestInfo?.rawTtmlMetadata || null,
        gate: data?.gate || null,
        subtitleCount: Array.isArray(data?.subtitles) ? data.subtitles.length : 0,
        playbackContext: data?.playbackContext || null
      })),
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
    const canHideNativeSubtitles = this.isActive && playbackContextReady && primaryReady;
    let nativeHideReason = 'intercept-primary-ready';
    if (!canHideNativeSubtitles) {
      if (!this.isActive) {
        nativeHideReason = 'intercept-mode-inactive';
      } else if (!playbackContextReady) {
        nativeHideReason = 'playback-context-not-ready';
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
   * Phase 3 acquisition 使用嚴格語言匹配，避免 zh-Hant / zh-Hans / generic zh 互相污染。
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
   * 依 PlaybackContext 與 request-time evidence 判斷字幕是否可進入 content 端處理流程。
   */
  evaluateSubtitleGate(cacheKey, requestInfo = null) {
    const parsedKey = this.parseCacheKey(cacheKey);
    const context = this.getCurrentPlaybackContext();
    const currentVideoId = context.videoId;
    const derived = requestInfo?.derivedSubtitleVideo || null;
    const derivedVideoId = derived?.videoId ? String(derived.videoId) : null;
    const parsedVideoId = parsedKey?.videoId ? String(parsedKey.videoId) : null;
    const requestSessionId = requestInfo?.sessionIdAtRequest ||
      requestInfo?.playbackSnapshot?.sessionId ||
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

    if (contextSessionId &&
        requestSessionId &&
        this.isWatchSession(contextSessionId) &&
        this.isWatchSession(requestSessionId) &&
        requestSessionId !== contextSessionId) {
      return { ...baseResult, reason: 'request-session-mismatch' };
    }

    if (derived?.confidence === 'none') {
      return { ...baseResult, reason: `evidence-${derived.confidence}` };
    }

    if (derivedVideoId && derivedVideoId !== currentVideoId) {
      return { ...baseResult, reason: 'evidence-video-mismatch' };
    }

    // cache key 仍是目前字幕資料的 videoId 來源；即使 evidence 存在，也不能讓錯 key 進入顯示流程。
    if (parsedVideoId !== currentVideoId) {
      return { ...baseResult, reason: 'cache-key-video-mismatch' };
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

    return {
      cacheKey,
      videoId: gate.currentVideoId,
      parsedVideoId: gate.parsedVideoId,
      contextEpoch: context.epoch,
      contextState: context.state,
      gate,
      rawMetadata: data?.rawMetadata || data?.metadata || data?.requestInfo?.rawTtmlMetadata || null,
      assignedAt: Date.now()
    };
  }

  isSubtitleSlotMetaCurrent(meta) {
    if (!meta) {
      return false;
    }

    const context = this.getCurrentPlaybackContext();
    if (!context.videoId || context.videoId === 'unknown') {
      return false;
    }

    if (context.state === 'transitioning') {
      return false;
    }

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

  /**
   * 處理接收到的 raw TTML 數據 - 增加 videoID 驗證
   */
  handleRawTTMLIntercepted(event) {
    const { cacheKey, rawContent, requestInfo, language } = event;
    const rawMetadata = event.rawMetadata || event.metadata || requestInfo?.rawTtmlMetadata || null;
    
    this.log(`接收到 raw TTML: ${language}, 緩存鍵: ${cacheKey}`);
    
    // 步驟1: 解析緩存鍵獲取 videoID
    const parsedKey = this.parseCacheKey(cacheKey);
    if (!parsedKey) {
      this.log(`無效的緩存鍵格式，跳過處理: ${cacheKey}`);
      return;
    }
    
    // 步驟2: 使用 PlaybackContext 與 request-time evidence 驗證字幕歸屬
    const gate = this.evaluateSubtitleGate(cacheKey, requestInfo);
    const currentVideoId = gate.currentVideoId;
    if (!currentVideoId) {
      this.log('無法獲取當前影片 ID，可能不在觀看頁面，跳過處理');
      this.recordDebugEvent('RAW_TTML_SKIPPED', {
        reason: 'missing-current-video-id',
        cacheKey,
        language,
        requestInfo
      });
      return;
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
        requestInfo,
        rawMetadata,
        gate
      });
      this.dispatchSubtitleReadinessChanged('raw-ttml-rejected-by-gate', { cacheKey, language, gate });
      if (gate.reason === 'playback-context-transitioning') {
        this.scheduleReloadAfterContextReady('raw-ttml-gate-transitioning', this.getCurrentPlaybackContext());
      }
      return;
    }
    
    // 步驟3: 驗證是否為當前影片的字幕
    const isCurrentVideo = (parsedKey.videoId === currentVideoId);

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
      requestInfo,
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
          if (this.matchesLanguageForAcquisition(language, this.primaryLanguage) && Object.keys(regionConfigs).length > 0) {
            this.log(`更新 netflix-player-adapter 的 region 配置 (主要語言: ${language})`);
            setRegionConfigs(regionConfigs);
          }

          this.checkAndProcessLanguage(language, subtitles, {
            cacheKey,
            timeIndex,
            playbackContext: this.getCurrentPlaybackContext(),
            gate,
            requestInfo,
            rawMetadata
          });
        }
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
          rawStart: rawContent?.substring(0, 160) || '',
          gate
        });
      }
    } catch (error) {
      console.error(`解析 ${language} TTML 失敗:`, error);
      if (this.matchesLanguageForAcquisition(language, this.primaryLanguage)) {
        this.lastSubtitleMissingReasons.primary = 'parse-error';
      }
      if (this.matchesLanguageForAcquisition(language, this.secondaryLanguage)) {
        this.lastSubtitleMissingReasons.secondary = 'parse-error';
      }
      this.dispatchSubtitleReadinessChanged('raw-ttml-parse-error', { cacheKey, language, error: error.message });
      this.recordDebugEvent('RAW_TTML_PARSE_ERROR', {
        cacheKey,
        language,
        rawMetadata,
        rawLength: rawContent?.length || 0,
        rawStart: rawContent?.substring(0, 160) || '',
        error: error.message,
        gate
      });
    }
  }

  /**
   * 檢查並處理語言數據
   */
  checkAndProcessLanguage(language, subtitles, metadata = {}) {
    // 檢查是否是我們需要的語言（支援 base-code fallback）
    if (this.matchesLanguageForAcquisition(language, this.primaryLanguage)) {
      this.primarySubtitles = subtitles;
      this.primaryTimeIndex = metadata.timeIndex || this.primaryTimeIndex;
      this.primarySubtitleMeta = {
        cacheKey: metadata.cacheKey || null,
        videoId: metadata.gate?.currentVideoId || metadata.playbackContext?.videoId || null,
        parsedVideoId: metadata.gate?.parsedVideoId || null,
        contextEpoch: metadata.playbackContext?.epoch ?? null,
        contextState: metadata.playbackContext?.state || null,
        gate: metadata.gate || null,
        rawMetadata: metadata.rawMetadata || metadata.requestInfo?.rawTtmlMetadata || null,
        assignedAt: Date.now()
      };
      this.lastSubtitleMissingReasons.primary = null;
      this.dispatchSubtitleReadinessChanged('primary-slot-updated', {
        cacheKey: metadata.cacheKey || null,
        language
      });
      this.log(`主要語言字幕已更新: ${language} (目標: ${this.primaryLanguage})`);
    } else if (this.matchesLanguageForAcquisition(language, this.secondaryLanguage) && this.dualSubtitleEnabled) {
      this.secondarySubtitles = subtitles;
      this.secondaryTimeIndex = metadata.timeIndex || this.secondaryTimeIndex;
      this.secondarySubtitleMeta = {
        cacheKey: metadata.cacheKey || null,
        videoId: metadata.gate?.currentVideoId || metadata.playbackContext?.videoId || null,
        parsedVideoId: metadata.gate?.parsedVideoId || null,
        contextEpoch: metadata.playbackContext?.epoch ?? null,
        contextState: metadata.playbackContext?.state || null,
        gate: metadata.gate || null,
        rawMetadata: metadata.rawMetadata || metadata.requestInfo?.rawTtmlMetadata || null,
        assignedAt: Date.now()
      };
      this.lastSubtitleMissingReasons.secondary = null;
      this.dispatchSubtitleReadinessChanged('secondary-slot-updated', {
        cacheKey: metadata.cacheKey || null,
        language
      });
      this.log(`次要語言字幕已更新: ${language} (目標: ${this.secondaryLanguage})`);
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
    const keysToDelete = [];
    
    // 遍歷所有緩存，找出不屬於當前影片的數據
    for (const [cacheKey] of this.interceptedSubtitles) {
      const parsedKey = this.parseCacheKey(cacheKey);
      if (parsedKey && parsedKey.videoId !== currentVideoId) {
        keysToDelete.push(cacheKey);
        cleanedCount++;
      }
    }
    
    // 刪除舊數據
    keysToDelete.forEach(key => {
      this.interceptedSubtitles.delete(key);
      this.log(`清理舊影片緩存: ${key}`);
    });
    
    if (cleanedCount > 0) {
      this.log(`✅ 已清理 ${cleanedCount} 個舊影片的緩存數據`);
      
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
      if (parsedKey &&
          this.matchesLanguageForAcquisition(parsedKey.language, language) &&
          parsedKey.videoId === currentVideoId &&
          this.isSubtitleEntryCurrent(cacheKey, data)) {
        return true;
      }
    }
    return false;
  }

  // 設置事件處理器
  setupEventHandlers() {
    // 監聽 raw TTML 攔截事件
    registerInternalEventHandler('RAW_TTML_INTERCEPTED', (event) => {
      this.handleRawTTMLIntercepted(event);
      this.resolveAcquisitionWaiters(event);
    });

    // 監聽影片 ID 變化事件
    registerInternalEventHandler('VIDEO_ID_CHANGED', async (event) => {
      const newVideoId = event.newVideoId || event.videoId;
      const oldVideoId = event.oldVideoId;

      this.log(`檢測到影片切換: ${oldVideoId} -> ${newVideoId}`);

      // 步驟1: 清理舊影片的緩存數據
      this.cleanupOldVideoCache(newVideoId);
      this.clearAcquisitionWaiters('video-id-changed');
      this.lastSubtitleMissingReasons.primary = 'video-id-changed-primary-not-ready';
      this.lastSubtitleMissingReasons.secondary = 'video-id-changed-secondary-not-ready';
      this.dispatchSubtitleReadinessChanged('video-id-changed', { oldVideoId, newVideoId });

      // 步驟2: 重新載入字幕數據（覆用現有邏輯）
      // loadInterceptedSubtitles() 已包含完整的緩存檢查、分析和載入流程
      if (this.isActive) {
        this.log('重新載入字幕數據以確保使用正確的字幕檔...');
        await this.loadInterceptedSubtitles();
      }
    });

    // PlaybackContext 可能在 TTML 回來後才從 transitioning 變成 ready。
    // ready 後重新掃 page script raw TTML cache，避免已攔到的字幕被早期 gate 永久錯過。
    registerInternalEventHandler('PLAYBACK_CONTEXT_CHANGED', (event) => {
      const context = event.context;
      if (!this.isActive || context?.state !== 'ready' || !context.videoId) {
        return;
      }

      this.scheduleReloadAfterContextReady(event.reason, context);
    });
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleInterceptor] ${message}`, ...args);
    }
  }
}

export { SubtitleInterceptor };
