/**
 * Netflix Page Script - 注入到Netflix頁面context中
 *
 * 此腳本運行在Netflix頁面的context中，能夠直接訪問Netflix的內部API
 * 負責：
 * 1. 直接訪問 window.netflix
 * 2. 播放器實例管理
 * 3. 字幕軌道控制
 * 4. 字幕內容攔截
 * 5. 與content script通信
 */

(function() {
  'use strict';

  const PAGE_SCRIPT_READY_EVENT = 'subpal-page-script-ready';
  const PAGE_SCRIPT_READY_REQUEST_EVENT = 'subpal-request-page-script-ready';
  const TTML_ACQUISITION_CAPTURED_EVENT = 'subpal-ttml-acquisition-captured';
  const HISTORY_VIDEO_ID_CHANGE_WRAPPED = '__subpalVideoIdChangeWrapped';

  if (history[HISTORY_VIDEO_ID_CHANGE_WRAPPED] !== true) {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function(...args) {
        const oldVideoId = location.href.match(/\/watch\/(\d+)/)?.[1] || null;
        const result = original.apply(this, args);
        const newVideoId = location.href.match(/\/watch\/(\d+)/)?.[1] || null;

        if (oldVideoId !== newVideoId) {
          window.dispatchEvent(new CustomEvent('messageToContentScript', {
            detail: {
              messageId: `video-route-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              message: {
                type: 'VIDEO_ID_CHANGED',
                oldVideoId,
                newVideoId,
                source: 'netflix-page-script'
              }
            }
          }));
        }

        return result;
      };
    }
    Object.defineProperty(history, HISTORY_VIDEO_ID_CHANGE_WRAPPED, { value: true });
  }

  if (window.subpalPageScript?.ready === true) {
    return;
  }

  // 調試模式
  let debugMode = true;

  function debugLog(...args) {
    if (debugMode) {
      console.log('[NetflixPageScript]', ...args);
    }
  }

  function isWatchSessionId(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('watch-');
  }

  function isLikelyPreviewSessionId(sessionId) {
    return typeof sessionId === 'string' && /preview|billboard|browse|details|trailer/i.test(sessionId);
  }

  function isReasonablePlaybackState(session) {
    return typeof session.currentTime === 'number' &&
      typeof session.duration === 'number' &&
      session.duration > 0 &&
      session.currentTime >= 0 &&
      session.currentTime <= session.duration + 60;
  }

  function getPlaybackReasonablenessScore(session) {
    if (!session || session.isLikelyPreview || !session.hasReasonablePlaybackState) {
      return 0;
    }

    let score = 100;
    if (session.duration > 60) score += 30;
    if (session.duration > 300) score += 20;
    if (session.currentTime > 0) score += 20;
    if (session.currentTime < session.duration - 5) score += 10;
    if (session.currentTrack) score += 10;
    return score;
  }

  function getNetflixPlayerAPI() {
    try {
      return window.netflix?.appContext?.state?.playerApp?.getAPI?.() || null;
    } catch (error) {
      debugLog('取得 Netflix player API 失敗:', error.message);
      return null;
    }
  }

  function buildPlaybackSessionDetails(api) {
    let sessions = [];
    try {
      sessions = api?.getOpenPlaybackSessions?.() || [];
    } catch (error) {
      debugLog('取得 open playback sessions 失敗:', error.message);
    }

    return sessions.map(session => {
      const sessionId = session?.sessionId || null;
      const detail = {
        sessionId,
        videoId: session?.videoId ? String(session.videoId) : null,
        playerApiVideoId: null,
        movieId: null,
        currentTime: null,
        duration: null,
        isWatchSession: isWatchSessionId(sessionId),
        isLikelyPreview: isLikelyPreviewSessionId(sessionId),
        errors: {}
      };

      if (sessionId && typeof api?.getVideoIdBySessionId === 'function') {
        try {
          const videoId = api.getVideoIdBySessionId(sessionId);
          detail.playerApiVideoId = videoId ? String(videoId) : null;
        } catch (error) {
          detail.errors.playerApiVideoId = error.message;
        }
      }

      let videoPlayer = null;
      if (sessionId) {
        try {
          videoPlayer = api?.videoPlayer?.getVideoPlayerBySessionId?.(sessionId) || null;
        } catch (error) {
          detail.errors.videoPlayer = error.message;
        }
      }

      if (videoPlayer) {
        try {
          const movieId = videoPlayer.getMovieId?.();
          detail.movieId = movieId ? String(movieId) : null;
        } catch (error) {
          detail.errors.movieId = error.message;
        }

        try {
          const currentTime = videoPlayer.getCurrentTime?.();
          detail.currentTime = typeof currentTime === 'number' ? currentTime : null;
        } catch (error) {
          detail.errors.currentTime = error.message;
        }

        try {
          const duration = videoPlayer.getDuration?.();
          detail.duration = typeof duration === 'number' ? duration : null;
        } catch (error) {
          detail.errors.duration = error.message;
        }

        try {
          const currentTrack = videoPlayer.getTimedTextTrack?.();
          detail.currentTrack = currentTrack ? {
            code: currentTrack.bcp47,
            name: currentTrack.displayName,
            trackId: currentTrack.trackId,
            trackType: currentTrack.trackType,
            rawTrackType: currentTrack.rawTrackType
          } : null;
        } catch (error) {
          detail.errors.currentTrack = error.message;
        }
      }

      detail.hasReasonablePlaybackState = isReasonablePlaybackState(detail);
      detail.playbackReasonablenessScore = getPlaybackReasonablenessScore(detail);
      return detail;
    });
  }

  function selectActivePlaybackSession(api, pageUrlVideoId, fallbackSessionId = null) {
    const openSessions = buildPlaybackSessionDetails(api);
    const watchSessions = openSessions.filter(session => session.isWatchSession);
    const select = (session, reason, confidence) => ({
      selectedSessionId: session?.sessionId || null,
      selectedSessionReason: reason,
      sessionSelectionConfidence: confidence,
      selectedSession: session || null,
      openSessions
    });

    if (pageUrlVideoId) {
      const playerApiMatch = watchSessions.find(session => session.playerApiVideoId === pageUrlVideoId);
      if (playerApiMatch) {
        return select(playerApiMatch, 'watch-player-api-video-id-match', 'high');
      }

      const movieIdMatch = watchSessions.find(session => session.movieId === pageUrlVideoId);
      if (movieIdMatch) {
        return select(movieIdMatch, 'watch-movie-id-match', 'high');
      }
    }

    const reasonableWatchSessions = watchSessions
      .filter(session => session.playbackReasonablenessScore > 0)
      .sort((a, b) => b.playbackReasonablenessScore - a.playbackReasonablenessScore);
    const reasonableWatch = reasonableWatchSessions[0] || null;
    const nextReasonableWatch = reasonableWatchSessions[1] || null;
    if (reasonableWatch && (!nextReasonableWatch ||
        reasonableWatch.playbackReasonablenessScore > nextReasonableWatch.playbackReasonablenessScore)) {
      return select(reasonableWatch, 'watch-reasonable-playback-state', 'medium');
    }

    const helperFallback = openSessions.find(session => session.sessionId === fallbackSessionId);
    if (helperFallback) {
      return select(helperFallback, 'player-helper-session-fallback', 'low');
    }

    if (openSessions[0]) {
      return select(openSessions[0], 'first-open-session-fallback', 'low');
    }

    return select(null, 'no-open-playback-session', 'none');
  }

  /**
   * Netflix播放器助手類
   */
  class NetflixPlayerHelper {
    constructor() {
      this.playerAPI = null;
      this.videoPlayer = null;
      this.sessionId = null;
      this.isInitialized = false;
    }

    /**
     * 初始化播放器助手
     */
    async initialize() {
      debugLog('初始化Netflix播放器助手...');

      try {
        // 檢查Netflix API是否可用
        if (!window.netflix || !window.netflix.appContext) {
          throw new Error('Netflix API不可用');
        }

        const playerApp = window.netflix.appContext.state.playerApp;
        if (!playerApp) {
          throw new Error('Netflix播放器應用不可用');
        }

        this.playerAPI = playerApp.getAPI();
        if (!this.playerAPI) {
          throw new Error('Netflix播放器API不可用');
        }

        // 獲取播放會話
        const pageUrlVideoId = subtitleInterceptor?.extractVideoIdFromUrl?.(location.href) || null;
        const selection = selectActivePlaybackSession(this.playerAPI, pageUrlVideoId, this.sessionId);
        if (!selection.selectedSessionId) {
          throw new Error('沒有找到播放會話');
        }

        this.sessionId = selection.selectedSessionId;
        try {
          this.videoPlayer = this.playerAPI.videoPlayer?.getVideoPlayerBySessionId?.(this.sessionId) || null;
        } catch (error) {
          throw new Error(`無法獲取視頻播放器實例: ${error.message}`);
        }

        if (!this.videoPlayer) {
          throw new Error('無法獲取視頻播放器實例');
        }

        this.isInitialized = true;
        debugLog('Netflix播放器助手初始化成功', {
          selectedSessionId: selection.selectedSessionId,
          reason: selection.selectedSessionReason,
          confidence: selection.sessionSelectionConfidence
        });
        return true;
      } catch (error) {
        console.error('初始化Netflix播放器助手失敗:', error);
        this.isInitialized = false;
        return false;
      }
    }

    /**
     * 獲取可用的字幕語言列表
     */
    getAvailableLanguages() {
      if (!this.isInitialized) {
        throw new Error('播放器助手未初始化');
      }

      try {
        const trackList = this.videoPlayer.getTimedTextTrackList();
        const languages = trackList.map(track => ({
          code: track.bcp47,
          name: track.displayName,
          trackId: track.trackId,
          isNone: track.isNoneTrack || false,
          trackType: track.trackType,
          rawTrackType: track.rawTrackType
        })).filter(lang => !lang.isNone);

        debugLog('可用字幕語言 (詳細):', languages);
        return languages;
      } catch (error) {
        console.error('獲取可用語言時出錯:', error);
        throw error;
      }
    }

    /**
     * 切換到指定語言 - 增強版，包含狀態檢查和自動重新初始化
     */
    async switchToLanguage(languageCode) {
      debugLog('準備切換字幕語言到:', languageCode);

      // 步驟1: 檢查基本初始化狀態
      if (!this.isInitialized) {
        debugLog('播放器助手未初始化，嘗試初始化...');
        const initResult = await this.initialize();
        if (!initResult) {
          throw new Error('播放器助手初始化失敗');
        }
      }

      // 步驟2: 檢查播放器會話有效性
      if (true) {
        debugLog('播放器會話無效，重新初始化...');
        const reinitResult = await this.reinitialize();
        if (!reinitResult) {
          throw new Error('播放器助手重新初始化失敗');
        }
      }

      // 步驟3: 執行語言切換
      try {
        const trackList = this.videoPlayer.getTimedTextTrackList();
        if (!trackList || trackList.length === 0) {
          throw new Error('無法獲取字幕軌道列表');
        }

        // 找出所有匹配語言的軌道
        const matchingTracks = trackList.filter(track => track.bcp47 === languageCode);

        if (matchingTracks.length === 0) {
          debugLog('可用語言軌道:', trackList.map(t => ({
            code: t.bcp47,
            name: t.displayName,
            trackType: t.trackType,
            rawTrackType: t.rawTrackType
          })));
          throw new Error(`找不到語言: ${languageCode}`);
        }

        // 智能選擇字幕軌道
        const targetTrack = this.selectBestSubtitleTrack(matchingTracks, languageCode);

        await this.videoPlayer.setTimedTextTrack(targetTrack);
        debugLog(`✅ 成功切換到 ${languageCode}`, {
          selectedTrack: targetTrack.displayName,
          trackType: targetTrack.trackType,
          rawTrackType: targetTrack.rawTrackType,
          trackId: targetTrack.trackId
        });
        return true;

      } catch (error) {
        console.error(`切換到 ${languageCode} 失敗:`, error);

        // 如果切換失敗，嘗試一次重新初始化後再試
        debugLog('語言切換失敗，嘗試重新初始化後重試...');
        try {
          await this.reinitialize();
          const trackList = this.videoPlayer.getTimedTextTrackList();
          const targetTrack = trackList.find(track => track.bcp47 === languageCode);

          if (targetTrack) {
            await this.videoPlayer.setTimedTextTrack(targetTrack);
            debugLog(`✅ 重試成功切換到 ${languageCode}`);
            return true;
          }
        } catch (retryError) {
          debugLog('重試也失敗:', retryError);
        }

        throw error;
      }
    }

    /**
     * 選擇最佳字幕軌道
     * 策略：
     * 1. 優先選擇 PRIMARY 且 name 不為 '關閉' 的軌道（乾淨字幕）
     * 2. 若無，選擇任何 name 不為 '關閉' 的軌道
     * 3. 若都是 '關閉'，fallback 到第一個
     */
    selectBestSubtitleTrack(matchingTracks, languageCode) {
      if (matchingTracks.length === 1) {
        debugLog(`✅ 只有一個 ${languageCode} 軌道，直接使用: ${matchingTracks[0].displayName}`);
        return matchingTracks[0];
      }

      debugLog(`發現 ${matchingTracks.length} 個 ${languageCode} 軌道:`,
        matchingTracks.map(t => ({
          name: t.displayName,
          trackType: t.trackType
        }))
      );

      // 步驟 1：優先選擇 PRIMARY 且不是 '關閉' 的軌道
      const primaryCleanTrack = matchingTracks.find(
        track => track.trackType === 'PRIMARY' && track.displayName !== '關閉'
      );

      if (primaryCleanTrack) {
        debugLog(`✅ 選擇 PRIMARY 乾淨字幕: ${primaryCleanTrack.displayName}`);
        return primaryCleanTrack;
      }

      // 步驟 2：尋找任何不是 '關閉' 的軌道
      const anyCleanTrack = matchingTracks.find(
        track => track.displayName !== '關閉'
      );

      if (anyCleanTrack) {
        debugLog(`✅ 選擇乾淨字幕: ${anyCleanTrack.displayName} (${anyCleanTrack.trackType})`);
        return anyCleanTrack;
      }

      // 步驟 3：Fallback，所有軌道都是 '關閉'，選第一個
      debugLog(`⚠️ 所有軌道都標記為'關閉'，使用第一個: ${matchingTracks[0].displayName}`);
      return matchingTracks[0];
    }

    /**
     * 獲取當前字幕語言
     */
    getCurrentLanguage() {
      if (!this.isInitialized) {
        throw new Error('播放器助手未初始化');
      }

      try {
        const currentTrack = this.videoPlayer.getTimedTextTrack();
        if (!currentTrack) {
          return null;
        }

        return {
          code: currentTrack.bcp47,
          name: currentTrack.displayName,
          trackId: currentTrack.trackId,
          trackType: currentTrack.trackType,
          rawTrackType: currentTrack.rawTrackType
        };
      } catch (error) {
        console.error('獲取當前字幕語言時出錯:', error);
        throw error;
      }
    }

    /**
     * 切換到指定 trackId 的字幕軌道（精確恢復用）
     * @param {number|string} trackId - Netflix timed text track ID
     */
    async switchToTrack(trackId) {
      debugLog('準備切換字幕到 trackId:', trackId);

      if (!this.isInitialized) {
        debugLog('播放器助手未初始化，嘗試初始化...');
        const initResult = await this.initialize();
        if (!initResult) {
          throw new Error('播放器助手初始化失敗');
        }
      }

      // 重新初始化確保 session 有效
      if (!this.hasActiveSession()) {
        debugLog('播放器會話無效，重新初始化...');
        const reinitResult = await this.reinitialize();
        if (!reinitResult) {
          throw new Error('播放器助手重新初始化失敗');
        }
      }

      try {
        const trackList = this.videoPlayer.getTimedTextTrackList();
        const targetTrack = trackList.find(track => track.trackId === trackId);
        if (!targetTrack) {
          debugLog('可用軌道:', trackList.map(t => ({
            trackId: t.trackId,
            code: t.bcp47,
            name: t.displayName
          })));
          throw new Error(`找不到 trackId: ${trackId}`);
        }

        await this.videoPlayer.setTimedTextTrack(targetTrack);
        debugLog(`✅ 成功切換到 trackId ${trackId}`, {
          displayName: targetTrack.displayName,
          code: targetTrack.bcp47,
          trackType: targetTrack.trackType
        });
        return true;
      } catch (error) {
        console.error(`切換到 trackId ${trackId} 失敗:`, error);
        throw error;
      }
    }

    /**
     * 檢查是否有可用的播放會話
     */
    hasActiveSession() {
      try {
        if (!this.playerAPI) return false;
        const pageUrlVideoId = subtitleInterceptor?.extractVideoIdFromUrl?.(location.href) || null;
        const selection = selectActivePlaybackSession(this.playerAPI, pageUrlVideoId, this.sessionId);
        return !!selection.selectedSessionId &&
          isWatchSessionId(selection.selectedSessionId) &&
          ['high', 'medium'].includes(selection.sessionSelectionConfidence);
      } catch (error) {
        return false;
      }
    }

    /**
     * 重新初始化（當播放會話變化時）
     */
    async reinitialize() {
      debugLog('重新初始化播放器助手...');
      this.isInitialized = false;
      this.playerAPI = null;
      this.videoPlayer = null;
      this.sessionId = null;

      return await this.initialize();
    }
  }

  /**
   * 字幕攔截器類
   */
  class SubtitleInterceptor {
    constructor() {
      this.isActive = false;
      this.interceptedSubtitles = new Map();
      this.interceptedTTMLs = new Map(); // 新增：緩存 raw TTML 數據
      this.originalXHRSend = null;
      this.originalXHROpen = null;
      this.originalFetch = null;
      this.lastRequestTime = 0;
      this.requestCache = new Map();
      this.latestManifestVideoId = null; // 從 licensedmanifest 追蹤的真實 videoId（僅供 legacy 診斷用）
      this.latestManifestEvidence = null; // 診斷用，記錄最新 licensedmanifest encrypted wrapper 證據，含 manifestEncrypted/mappingAvailable 狀態
      this.debugEvents = [];
      this.maxDebugEvents = 50;
      this.nextRequestId = 1;
    }

    /**
     * 記錄診斷事件（固定長度 ring buffer）
     */
    recordDebugEvent(type, data = {}) {
      this.debugEvents.push({
        type,
        timestamp: Date.now(),
        pageUrl: location.href,
        ...data
      });

      if (this.debugEvents.length > this.maxDebugEvents) {
        this.debugEvents.splice(0, this.debugEvents.length - this.maxDebugEvents);
      }
    }

    /**
     * 從 URL 提取視頻 ID
     * @param {string} [pageUrl] - 頁面 URL，預設為 location.href
     */
    extractVideoIdFromUrl(pageUrl) {
      const url = pageUrl || location.href;
      const urlMatch = url.match(/netflix\.com\/watch\/(\d+)/);
      if (urlMatch && urlMatch[1]) {
        debugLog('從 URL 提取視頻 ID:', urlMatch[1]);
        return urlMatch[1];
      }
      return null;
    }

    /**
     * 取得目前 Netflix player 狀態快照（僅診斷，不影響字幕邏輯）
     */
    getActivePlaybackSnapshot({ preferFreshApi = false } = {}) {
      const snapshot = {
        pageUrl: location.href,
        pageUrlVideoId: this.extractVideoIdFromUrl(location.href),
        latestManifestVideoId: this.latestManifestVideoId, // legacy 診斷用
        latestManifestEvidence: this.latestManifestEvidence, // manifest encrypted wrapper 狀態
        playerHelperInitialized: !!playerHelper?.isInitialized,
        sessionId: null,
        selectedSessionId: null,
        selectedSessionReason: null,
        sessionSelectionConfidence: 'none',
        playerApiVideoId: null,
        movieId: null,
        currentTime: null,
        duration: null,
        currentTrack: null,
        openSessions: [],
        error: null,
        timestamp: Date.now()
      };

      try {
        let api = preferFreshApi ? getNetflixPlayerAPI() : playerHelper?.playerAPI || getNetflixPlayerAPI();

        if (!api) {
          snapshot.error = 'Netflix player API unavailable';
          return snapshot;
        }

        const selection = selectActivePlaybackSession(api, snapshot.pageUrlVideoId, playerHelper?.sessionId || null);
        const sessionId = selection.selectedSessionId;
        snapshot.selectedSessionId = sessionId;
        snapshot.sessionId = sessionId; // legacy alias
        snapshot.selectedSessionReason = selection.selectedSessionReason;
        snapshot.sessionSelectionConfidence = selection.sessionSelectionConfidence;
        snapshot.openSessions = selection.openSessions;

        if (selection.selectedSession) {
          snapshot.playerApiVideoId = selection.selectedSession.playerApiVideoId;
          snapshot.movieId = selection.selectedSession.movieId;
          snapshot.currentTime = selection.selectedSession.currentTime;
          snapshot.duration = selection.selectedSession.duration;
        }

        let videoPlayer = null;
        if (sessionId) {
          try {
            videoPlayer = api.videoPlayer?.getVideoPlayerBySessionId?.(sessionId) || null;
          } catch (error) {
            snapshot.videoPlayerError = error.message;
          }
        }

        if (videoPlayer) {
          try {
            const currentTrack = videoPlayer.getTimedTextTrack?.();
            snapshot.currentTrack = currentTrack ? {
              code: currentTrack.bcp47,
              name: currentTrack.displayName,
              trackId: currentTrack.trackId,
              trackType: currentTrack.trackType,
              rawTrackType: currentTrack.rawTrackType
            } : null;
          } catch (error) {
            snapshot.currentTrackError = error.message;
          }
        }
      } catch (error) {
        snapshot.error = error.message;
      }

      return snapshot;
    }

    /**
     * 依 request-time evidence 推導字幕可能歸屬的 videoId（僅記錄，不改變現有 cache key 行為）
     */
    deriveSubtitleVideoId(evidence) {
      // 優先使用可信的 active player videoId，不再依賴全域 manifest state。
      // manifestVideoIdAtRequest 已設為 null，encrypted manifest 證據僅供診斷。
      const activePlayerVideoId = evidence.activePlayerVideoIdAtRequest;
      const pageUrlVideoId = evidence.pageUrlVideoIdAtRequest;
      const manifestEvidence = evidence.manifestEvidenceAtRequest;

      if (activePlayerVideoId) {
        return {
          videoId: activePlayerVideoId,
          confidence: 'high',
          reason: 'active-player-only'
        };
      }

      if (pageUrlVideoId) {
        return {
          videoId: pageUrlVideoId,
          confidence: 'low',
          reason: 'page-url-only'
        };
      }

      return {
        videoId: null,
        confidence: 'none',
        reason: 'no-video-id-evidence'
      };
    }

    /**
     * 建立字幕 request-time metadata。保留舊欄位，並追加 evidence 供後續 gate 使用。
     */
    createSubtitleRequestInfo({ url, method = null, pageUrl = location.href, source }) {
      const playbackSnapshot = this.getActivePlaybackSnapshot();
      const selectedSessionId = playbackSnapshot.selectedSessionId || null;
      const hasTrustedWatchSelection = isWatchSessionId(selectedSessionId) &&
        ['high', 'medium'].includes(playbackSnapshot.sessionSelectionConfidence);
      const activePlayerVideoId = hasTrustedWatchSelection ?
        (playbackSnapshot.playerApiVideoId || playbackSnapshot.movieId || null) :
        null;
      const sessionIdAtRequest = hasTrustedWatchSelection ? selectedSessionId : null;
      const requestTime = Date.now();
      const requestId = `${source || 'netflix'}-${requestTime}-${this.nextRequestId++}`;

      const evidence = {
        requestId,
        ttmlLanguage: null,
        manifestVideoIdAtRequest: null, // 不再從全域 manifest state 回填；使用 playback snapshot 為主要證據
        activePlayerVideoIdAtRequest: activePlayerVideoId,
        pageUrlVideoIdAtRequest: playbackSnapshot.pageUrlVideoId,
        currentTrackAtRequest: playbackSnapshot.currentTrack,
        sessionIdAtRequest,
        selectedSessionReasonAtRequest: playbackSnapshot.selectedSessionReason,
        sessionSelectionConfidenceAtRequest: playbackSnapshot.sessionSelectionConfidence,
        latestManifestVideoIdAtRequest: this.latestManifestVideoId, // legacy 診斷用
        manifestEvidenceAtRequest: this.latestManifestEvidence, // encrypted wrapper 證據
        requestUrl: url,
        requestTime,
        source,
        playbackSnapshot
      };

      const derivedSubtitleVideo = this.deriveSubtitleVideoId(evidence);

      return {
        url,
        method,
        pageUrl,
        timestamp: evidence.requestTime,
        type: source,
        ...evidence,
        derivedSubtitleVideo
      };
    }

    /**
     * 建立 request/response debug event 共用摘要，避免 candidate 事件被誤認為已確認 TTML。
     */
    createNetworkDebugPayload(requestInfo, extra = {}) {
      return {
        requestId: requestInfo.requestId,
        source: requestInfo.source || requestInfo.type,
        url: requestInfo.url,
        manifestVideoId: null, // 不再使用全域 manifest state
        manifestEvidenceAtRequest: requestInfo.manifestEvidenceAtRequest || null,
        activePlayerVideoId: requestInfo.activePlayerVideoIdAtRequest,
        pageUrlVideoId: requestInfo.pageUrlVideoIdAtRequest,
        sessionId: requestInfo.sessionIdAtRequest,
        selectedSessionReason: requestInfo.selectedSessionReasonAtRequest,
        sessionSelectionConfidence: requestInfo.sessionSelectionConfidenceAtRequest,
        currentTrack: requestInfo.currentTrackAtRequest,
        derivedSubtitleVideo: requestInfo.derivedSubtitleVideo,
        pageUrl: requestInfo.pageUrl,
        ...extra
      };
    }

    /**
     * 記錄 response-time evidence。這只補診斷資料，不改變既有 cache key 行為。
     */
    attachResponseEvidence(requestInfo, responseInfo = {}) {
      const responseTime = Date.now();
      const responseTimeEvidence = {
        responseTime,
        playbackSnapshot: this.getActivePlaybackSnapshot()
      };

      requestInfo.responseTime = responseTime;
      requestInfo.responseTimeEvidence = responseTimeEvidence;
      requestInfo.responseInfo = {
        status: responseInfo.status ?? null,
        contentType: responseInfo.contentType || null,
        contentLength: responseInfo.contentLength || null,
        responseType: responseInfo.responseType || null,
        bodySkipped: !!responseInfo.bodySkipped,
        skipReason: responseInfo.skipReason || null
      };

      return responseTimeEvidence;
    }

    /**
     * 開始攔截字幕請求
     */
    start() {
      if (this.isActive) {
        debugLog('字幕攔截器已啟動');
        return;
      }

      debugLog('啟動字幕攔截器...');
      this.isActive = true;

      // 攔截XMLHttpRequest
      this.originalXHRSend = XMLHttpRequest.prototype.send;
      this.originalXHROpen = XMLHttpRequest.prototype.open;

      const self = this;

      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this._interceptorUrl = url;
        this._interceptorMethod = method;
        this._interceptorPageUrl = location.href;  // 記錄 request-time URL
        return self.originalXHROpen.apply(this, [method, url, ...args]);
      };

      XMLHttpRequest.prototype.send = function(body) {
        if (this._interceptorUrl) {
          // 攔截 licensedmanifest 請求，記錄 encrypted wrapper 證據（不解析 payload 作為字幕 mapping）
          if (this._interceptorUrl.includes('licensedmanifest')) {
            const manifestVideoId = self.extractManifestVideoId(this._interceptorUrl);
            const manifestEvidence = {
              videoId: manifestVideoId,
              url: this._interceptorUrl,
              requestId: `licensedmanifest-${Date.now()}-${self.nextRequestId++}`,
              requestTime: Date.now(),
              source: 'xhr-licensedmanifest',
              manifestEncrypted: true,
              mappingAvailable: false,
              mappingReason: 'msl-wrapper-encrypted'
            };
            self.latestManifestEvidence = manifestEvidence;
            // 僅保留 legacy 診斷用 videoId，不作為字幕所有權判斷依據
            if (manifestVideoId) {
              self.latestManifestVideoId = manifestVideoId;
            }
            self.recordDebugEvent('licensedmanifest', {
              manifestVideoId,
              url: this._interceptorUrl,
              manifestEvidence
            });
            debugLog('licensedmanifest encrypted wrapper 證據:', manifestEvidence);
          }

          // 只記錄 Netflix 相關的請求
          if (debugMode && this._interceptorUrl.includes('nflxvideo.net')) {
            // debugLog('攔截到 Netflix 請求:', this._interceptorUrl);
          }

          if (self.isCdnRequestCandidate(this._interceptorUrl)) {
            this._interceptorRequestInfo = self.createSubtitleRequestInfo({
              url: this._interceptorUrl,
              method: this._interceptorMethod,
              pageUrl: this._interceptorPageUrl,
              source: 'xhr'
            });
            self.recordDebugEvent('CDN_REQUEST_CANDIDATE',
              self.createNetworkDebugPayload(this._interceptorRequestInfo, {
                classification: 'oca-cdn-candidate'
              }));
            self.handleXHRRequest(this);
          }
        }
        return self.originalXHRSend.apply(this, arguments);
      };

      // 攔截Fetch
      this.originalFetch = window.fetch;
      window.fetch = function(...args) {
        const [url] = args;
        if (typeof url === 'string') {

          if (self.isCdnRequestCandidate(url)) {
            // debugLog('識別為 Netflix CDN candidate:', url);
            const requestInfo = self.createSubtitleRequestInfo({
              url,
              pageUrl: location.href,
              source: 'fetch'
            });
            self.recordDebugEvent('CDN_REQUEST_CANDIDATE',
              self.createNetworkDebugPayload(requestInfo, {
                classification: 'oca-cdn-candidate'
              }));
            const fetchPromise = self.originalFetch.apply(this, args);
            self.handleFetchRequest(fetchPromise, requestInfo);
            return fetchPromise;
          }
        }
        return self.originalFetch.apply(this, args);
      };

      debugLog('字幕攔截器啟動成功');
    }

    /**
     * 停止攔截字幕請求
     */
    stop() {
      if (!this.isActive) {
        return;
      }

      debugLog('停止字幕攔截器...');
      this.isActive = false;

      // 恢復原始方法
      if (this.originalXHRSend) {
        XMLHttpRequest.prototype.send = this.originalXHRSend;
      }
      if (this.originalXHROpen) {
        XMLHttpRequest.prototype.open = this.originalXHROpen;
      }
      if (this.originalFetch) {
        window.fetch = this.originalFetch;
      }

      debugLog('字幕攔截器已停止');
    }

    /**
     * 從 licensedmanifest URL 提取 mainContentViewableId（真實 videoId）
     */
    extractManifestVideoId(url) {
      const match = url.match(/mainContentViewableId=(\d+)/);
      return match ? match[1] : null;
    }

    /**
     * 檢查是否為 Netflix CDN response candidate。
     * 這裡只代表「值得在 response 階段分類」，不代表已確認是字幕。
     */
    isCdnRequestCandidate(url) {
      return typeof url === 'string' && url.includes('oca.nflxvideo.net');
    }

    /**
     * 處理XMLHttpRequest字幕請求
     */
    handleXHRRequest(xhr) {
      const requestInfo = xhr._interceptorRequestInfo || this.createSubtitleRequestInfo({
        url: xhr._interceptorUrl,
        method: xhr._interceptorMethod,
        pageUrl: xhr._interceptorPageUrl,
        source: 'xhr'
      });

      // debugLog('攔截到字幕請求:', requestInfo.url);

      xhr.addEventListener('load', () => {
        const responseInfo = {
          status: xhr.status,
          contentType: xhr.getResponseHeader('content-type'),
          contentLength: xhr.getResponseHeader('content-length'),
          responseType: xhr.responseType || 'text'
        };

        if (xhr.status === 200) {
          try {
            const readResult = this.readXHRTextCandidate(xhr, responseInfo);
            this.processSubtitleContent(readResult.content || '', requestInfo, {
              ...responseInfo,
              bodySkipped: !!readResult.skipped,
              skipReason: readResult.skipReason || null
            });
          } catch (error) {
            console.error('處理字幕響應失敗:', error);
          }
        } else {
          this.processSubtitleContent('', requestInfo, {
            ...responseInfo,
            bodySkipped: true,
            skipReason: `http-status-${xhr.status}`
          });
        }
      });

      xhr.addEventListener('error', () => {
        console.error('字幕請求失敗:', requestInfo);
      });
    }

    /**
     * 處理Fetch字幕請求
     */
    async handleFetchRequest(fetchPromise, requestInfo) {
      try {
        const response = await fetchPromise;
        const responseInfo = {
          status: response.status,
          contentType: response.headers.get('content-type'),
          contentLength: response.headers.get('content-length'),
          responseType: 'fetch'
        };

        if (response.ok) {
          const readResult = await this.readFetchTextCandidate(response, responseInfo);
          this.processSubtitleContent(readResult.content || '', requestInfo, {
            ...responseInfo,
            bodySkipped: !!readResult.skipped,
            skipReason: readResult.skipReason || null
          });
        } else {
          this.processSubtitleContent('', requestInfo, {
            ...responseInfo,
            bodySkipped: true,
            skipReason: `http-status-${response.status}`
          });
        }
      } catch (error) {
        console.error('處理Fetch字幕請求失敗:', error);
      }
    }

    normalizeContentType(contentType) {
      return (contentType || '').toLowerCase();
    }

    isLikelyBinaryContentType(contentType) {
      const normalized = this.normalizeContentType(contentType);
      return normalized.includes('application/octet-stream') ||
        normalized.includes('video/') ||
        normalized.includes('audio/');
    }

    isLikelyXmlContentType(contentType) {
      const normalized = this.normalizeContentType(contentType);
      return normalized.includes('text/xml') ||
        normalized.includes('application/xml') ||
        normalized.includes('+xml');
    }

    shouldSkipBodyRead(responseInfo = {}) {
      return this.isLikelyBinaryContentType(responseInfo.contentType) &&
        !this.isLikelyXmlContentType(responseInfo.contentType);
    }

    async readFetchTextCandidate(response, responseInfo) {
      if (this.shouldSkipBodyRead(responseInfo)) {
        const arrayBuffer = await response.clone().arrayBuffer();
        const prefix = this.decodeArrayBufferPrefix(arrayBuffer);
        if (!this.looksLikeTTMLPrefix(prefix)) {
          return {
            content: '',
            skipped: true,
            skipReason: 'binary-content-type'
          };
        }

        return {
          content: this.decodeArrayBufferText(arrayBuffer),
          skipped: false
        };
      }

      return {
        content: await response.clone().text(),
        skipped: false
      };
    }

    decodeArrayBufferPrefix(arrayBuffer, length = 512) {
      if (!arrayBuffer) {
        return '';
      }

      try {
        const prefix = arrayBuffer.slice(0, Math.min(arrayBuffer.byteLength, length));
        return new TextDecoder('utf-8').decode(prefix);
      } catch (error) {
        return '';
      }
    }

    decodeArrayBufferText(arrayBuffer) {
      const uint8Array = new Uint8Array(arrayBuffer);
      try {
        return new TextDecoder('utf-8').decode(uint8Array);
      } catch (error) {
        return new TextDecoder('latin1').decode(uint8Array);
      }
    }

    looksLikeTTMLPrefix(content) {
      const prefix = (content || '').trimStart().slice(0, 1024);
      return prefix.startsWith('<?xml') || prefix.startsWith('<tt') || prefix.includes('<tt ');
    }

    readXHRTextCandidate(xhr, responseInfo) {
      const responseType = xhr.responseType || '';
      const contentType = responseInfo?.contentType || '';
      const binaryContentType = this.isLikelyBinaryContentType(contentType) &&
        !this.isLikelyXmlContentType(contentType);

      if (responseType === 'arraybuffer') {
        const arrayBuffer = xhr.response;
        const prefix = this.decodeArrayBufferPrefix(arrayBuffer);
        if (binaryContentType && !this.looksLikeTTMLPrefix(prefix)) {
          return {
            content: '',
            skipped: true,
            skipReason: 'binary-content-type'
          };
        }

        return {
          content: this.decodeArrayBufferText(arrayBuffer),
          skipped: false
        };
      }

      if (responseType === '' || responseType === 'text') {
        const content = xhr.responseText || '';
        if (binaryContentType && !this.looksLikeTTMLPrefix(content)) {
          return {
            content: '',
            skipped: true,
            skipReason: 'binary-content-type'
          };
        }

        return {
          content,
          skipped: false
        };
      }

      if (typeof xhr.response === 'string') {
        return {
          content: xhr.response,
          skipped: false
        };
      }

      return {
        content: '',
        skipped: true,
        skipReason: `unsupported-response-type-${responseType || 'unknown'}`
      };
    }

    /**
     * 從 TTML 內容解析語言
     */
    parseTTMLLanguage(ttmlContent) {
      try {
        const langMatch = ttmlContent.match(/xml:lang="([^"]+)"/);
        return langMatch ? langMatch[1] : 'unknown';
      } catch (error) {
        debugLog('解析TTML語言失敗:', error);
        return 'unknown';
      }
    }

    parseTTMLTimeToMs(value) {
      if (!value || typeof value !== 'string') {
        return null;
      }

      const trimmed = value.trim();
      const clockMatch = trimmed.match(/^(\d+):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?/);
      if (clockMatch) {
        const hours = Number(clockMatch[1]);
        const minutes = Number(clockMatch[2]);
        const seconds = Number(clockMatch[3]);
        const fraction = clockMatch[4] ? Number(clockMatch[4].padEnd(3, '0').slice(0, 3)) : 0;
        return ((hours * 3600) + (minutes * 60) + seconds) * 1000 + fraction;
      }

      const secondsMatch = trimmed.match(/^([\d.]+)s$/);
      if (secondsMatch) {
        return Math.round(Number(secondsMatch[1]) * 1000);
      }

      const msMatch = trimmed.match(/^([\d.]+)ms$/);
      if (msMatch) {
        return Math.round(Number(msMatch[1]));
      }

      return null;
    }

    createBodyHash(content) {
      // 診斷用短 hash，避免 debug snapshot 直接依賴完整 TTML body。
      let hash = 0x811c9dc5;
      for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    createUrlKey(url) {
      try {
        const urlObj = new URL(url);
        const params = new URLSearchParams(urlObj.search);
        const stableParams = ['o', 'v', 'e', 't']
          .map(name => {
            const value = params.get(name);
            return value ? `${name}=${value}` : null;
          })
          .filter(Boolean)
          .join('&');
        return `${urlObj.hostname}${urlObj.pathname}${stableParams ? `?${stableParams}` : ''}`;
      } catch (error) {
        return url || null;
      }
    }

    classifyTTMLResponse(content, responseInfo = {}) {
      const text = content || '';
      const trimmedStart = text.trimStart().slice(0, 2048);
      const contentType = responseInfo.contentType || null;
      const hasXmlDeclaration = trimmedStart.startsWith('<?xml');
      const hasTTElement = /<tt(?:\s|>)/i.test(trimmedStart) || /<tt(?:\s|>)/i.test(text);
      const hasTTMLNamespace = /xmlns(?::\w+)?=["'][^"']*ttml/i.test(text);
      const hasParagraphBegin = /<p\b[^>]*\bbegin=/i.test(text);
      const xmlLang = this.parseTTMLLanguage(text);
      const isTTML = !!text &&
        (this.isLikelyXmlContentType(contentType) || hasXmlDeclaration || hasTTElement) &&
        hasTTElement &&
        (hasTTMLNamespace || hasParagraphBegin);

      let reason = 'confirmed-ttml';
      if (!isTTML) {
        if (responseInfo.bodySkipped) {
          reason = responseInfo.skipReason || 'body-skipped';
        } else if (!text) {
          reason = 'empty-body';
        } else if (!hasTTElement) {
          reason = 'missing-tt-element';
        } else if (!hasTTMLNamespace && !hasParagraphBegin) {
          reason = 'missing-ttml-markers';
        } else {
          reason = 'not-ttml';
        }
      }

      return {
        isTTML,
        reason,
        contentType,
        hasXmlDeclaration,
        hasTTElement,
        hasTTMLNamespace,
        hasParagraphBegin,
        xmlLang
      };
    }

    extractRawTTMLMetadata(content, requestInfo, responseInfo = {}, classification = {}) {
      const cueMatches = Array.from(content.matchAll(/<p\b[^>]*>/gi));
      const cueTimes = cueMatches.map(match => {
        const tag = match[0];
        const begin = tag.match(/\bbegin="([^"]+)"/i)?.[1] || null;
        const end = tag.match(/\bend="([^"]+)"/i)?.[1] || null;
        return {
          beginMs: this.parseTTMLTimeToMs(begin),
          endMs: this.parseTTMLTimeToMs(end)
        };
      });

      const firstCueMs = cueTimes.find(time => time.beginMs !== null)?.beginMs ?? null;
      const latestCueMs = cueTimes.reduce((latest, time) => {
        const candidate = time.endMs ?? time.beginMs;
        return candidate !== null && candidate > latest ? candidate : latest;
      }, -1);
      const lastCueMs = latestCueMs >= 0 ? latestCueMs : null;

      return {
        bodyHash: this.createBodyHash(content),
        xmlLang: classification.xmlLang || this.parseTTMLLanguage(content),
        nttmUuid: content.match(/nttm:uuid="([^"]+)"/i)?.[1] || null,
        cueCount: cueMatches.length,
        firstCueMs,
        lastCueMs,
        contentLength: Number(responseInfo.contentLength) || content.length,
        urlKey: this.createUrlKey(requestInfo.url),
        requestId: requestInfo.requestId,
        requestTime: requestInfo.requestTime,
        responseTime: requestInfo.responseTime || null,
        requestTimeEvidence: {
          source: requestInfo.source || requestInfo.type || null,
          manifestVideoIdAtRequest: requestInfo.manifestVideoIdAtRequest || null,
          activePlayerVideoIdAtRequest: requestInfo.activePlayerVideoIdAtRequest || null,
          pageUrlVideoIdAtRequest: requestInfo.pageUrlVideoIdAtRequest || null,
          sessionIdAtRequest: requestInfo.sessionIdAtRequest || null,
          selectedSessionReasonAtRequest: requestInfo.selectedSessionReasonAtRequest || null,
          sessionSelectionConfidenceAtRequest: requestInfo.sessionSelectionConfidenceAtRequest || null,
          currentTrackAtRequest: requestInfo.currentTrackAtRequest || null,
          playbackSnapshot: requestInfo.playbackSnapshot || null,
          derivedSubtitleVideo: requestInfo.derivedSubtitleVideo || null,
          manifestEvidenceAtRequest: requestInfo.manifestEvidenceAtRequest || null
        },
        responseTimeEvidence: requestInfo.responseTimeEvidence || null,
        classification
      };
    }

    /**
     * 生成包含語言和視頻 ID 的緩存鍵
     */
    generateCacheKeyWithLanguage(url, language, pageUrl, resolvedVideoId) {
      // 使用 request-level 解析的 videoId（來自 playback snapshot），
      // 不再依賴全域 latestManifestVideoId。降級使用 URL 中的 videoId。
      const videoId = resolvedVideoId || this.extractVideoIdFromUrl(pageUrl);
      if (!videoId) {
        debugLog('無法獲取 videoID，跳過緩存 - 可能是預覽影片');
        return null; // 返回 null 表示不應該緩存
      }

      const urlObj = new URL(url);
      const params = new URLSearchParams(urlObj.search);

      // 格式: {language}_{videoID}_{其他參數}
      const cacheKey = `${language}_${videoId}_${params.get('o')}_${params.get('v')}_${params.get('e')}`;
      debugLog('生成緩存鍵:', cacheKey);
      return cacheKey;
    }

    /**
     * 處理字幕內容
     */
    processSubtitleContent(content, requestInfo, responseInfo = {}) {
      const responseTimeEvidence = this.attachResponseEvidence(requestInfo, responseInfo);
      const classification = this.classifyTTMLResponse(content, responseInfo);

      this.recordDebugEvent('CDN_RESPONSE_CANDIDATE',
        this.createNetworkDebugPayload(requestInfo, {
          status: responseInfo.status ?? null,
          contentType: responseInfo.contentType || null,
          contentLength: responseInfo.contentLength || null,
          responseType: responseInfo.responseType || null,
          bodySkipped: !!responseInfo.bodySkipped,
          skipReason: responseInfo.skipReason || null,
          classification
        }));

      if (!classification.isTTML) {
        return;
      }

      const language = classification.xmlLang || this.parseTTMLLanguage(content);
      const rawMetadata = this.extractRawTTMLMetadata(content, requestInfo, responseInfo, classification);
      requestInfo.ttmlLanguage = language;
      requestInfo.rawTtmlMetadata = rawMetadata;
      requestInfo.responseTimeEvidence = responseTimeEvidence;

      // 生成包含正確語言的 cacheKey（使用 request-level 解析的 videoId 或 URL）
      const resolvedVideoId = requestInfo.derivedSubtitleVideo?.videoId || null;
      const cacheKey = this.generateCacheKeyWithLanguage(requestInfo.url, language, requestInfo.pageUrl, resolvedVideoId);

      // 如果無法生成有效的緩存鍵（例如預覽影片），則跳過緩存
      if (!cacheKey) {
        debugLog(`跳過緩存 - 無法生成有效緩存鍵，語言: ${language}`);
        return;
      }

      debugLog(`TTML攔截成功: ${language}, 緩存鍵: ${cacheKey}`);
      this.recordDebugEvent('TTML_RESPONSE_DETECTED',
        this.createNetworkDebugPayload(requestInfo, {
          language,
          cacheKey,
          rawMetadata
        }));
      this.recordDebugEvent('TTML_RESPONSE', {
        requestId: requestInfo.requestId,
        source: requestInfo.type,
        language,
        cacheKey,
        manifestVideoId: null, // 不再使用全域 manifest state 為字幕所有權證據
        manifestEvidenceAtRequest: requestInfo.manifestEvidenceAtRequest || null,
        activePlayerVideoId: requestInfo.activePlayerVideoIdAtRequest,
        pageUrlVideoId: requestInfo.pageUrlVideoIdAtRequest,
        sessionId: requestInfo.sessionIdAtRequest,
        selectedSessionReason: requestInfo.selectedSessionReasonAtRequest,
        sessionSelectionConfidence: requestInfo.sessionSelectionConfidenceAtRequest,
        currentTrack: requestInfo.currentTrackAtRequest,
        derivedSubtitleVideo: requestInfo.derivedSubtitleVideo,
        rawMetadata,
        requestUrl: requestInfo.url,
        pageUrl: requestInfo.pageUrl
      });

      // 緩存 raw TTML（混合策略：既緩存又通知）
      if (!this.interceptedTTMLs.has(cacheKey)) {
        this.evictOldTTMLEntries(1);
      }
      this.interceptedTTMLs.set(cacheKey, {
        rawContent: content,
        requestInfo: requestInfo,
        rawMetadata,
        metadata: rawMetadata,
        language: language,
        timestamp: Date.now()
      });
      if (!this.interceptedTTMLs.has(cacheKey)) return;

      // 通知後續模組（即使沒人接收也沒關係）
      this.notifyRawTTMLIntercepted({
        cacheKey: cacheKey,
        rawContent: content,
        requestInfo: requestInfo,
        rawMetadata,
        metadata: rawMetadata,
        language: language
      });
    }

    // TTML 解析邏輯已移至 subtitle-parser.js

    // WebVTT 解析邏輯已移至 subtitle-parser.js

    // 通用格式解析邏輯已移至 subtitle-parser.js

    // 時間解析邏輯已移至 subtitle-parser.js

    /**
     * 生成緩存鍵
     */
    generateCacheKey(url) {
      const urlObj = new URL(url);
      const params = new URLSearchParams(urlObj.search);

      // 獲取當前語言作為 key 的一部分
      let currentLanguage = 'unknown';
      try {
        if (playerHelper && playerHelper.isInitialized) {
          const currentTrack = playerHelper.getCurrentLanguage();
          currentLanguage = currentTrack ? currentTrack.code : 'unknown';
        }
      } catch (error) {
        debugLog('獲取當前語言失敗，使用 unknown:', error.message);
      }

      // 包含語言信息避免覆蓋
      return `${currentLanguage}_${params.get('o')}_${params.get('v')}_${params.get('e')}`;
    }

    /**
     * 通知 raw TTML 攔截完成
     */
    notifyRawTTMLIntercepted(data) {
      debugLog('發送 raw TTML 攔截消息:', { cacheKey: data.cacheKey, language: data.language });
      this.recordDebugEvent('RAW_TTML_INTERCEPTED', {
        cacheKey: data.cacheKey,
        language: data.language,
        manifestVideoId: null, // 不再使用全域 manifest state
        manifestEvidenceAtRequest: data.requestInfo?.manifestEvidenceAtRequest || null,
        activePlayerVideoId: data.requestInfo?.activePlayerVideoIdAtRequest,
        pageUrlVideoId: data.requestInfo?.pageUrlVideoIdAtRequest,
        sessionId: data.requestInfo?.sessionIdAtRequest,
        selectedSessionReason: data.requestInfo?.selectedSessionReasonAtRequest,
        sessionSelectionConfidence: data.requestInfo?.sessionSelectionConfidenceAtRequest,
        currentTrack: data.requestInfo?.currentTrackAtRequest,
        derivedSubtitleVideo: data.requestInfo?.derivedSubtitleVideo,
        rawMetadata: data.rawMetadata || data.metadata || data.requestInfo?.rawTtmlMetadata || null,
        requestUrl: data.requestInfo?.url
      });

      window.dispatchEvent(new CustomEvent(TTML_ACQUISITION_CAPTURED_EVENT, {
        detail: {
          protocolVersion: 1,
          evidence: {
            cacheKey: data.cacheKey,
            rawContent: data.rawContent,
            language: data.language,
            requestInfo: data.requestInfo,
            rawMetadata: data.rawMetadata,
            metadata: data.metadata,
            source: 'netflix-page-script'
          }
        }
      }));
    }

    /**
     * 通知content script字幕準備就緒
     * 使用SubPal消息傳遞系統
     */
    notifySubtitleReady(cacheKey, subtitles) {
      // 使用SubPal的CustomEvent消息傳遞機制
      const messageId = this.generateMessageId();

      debugLog('發送字幕準備就緒消息:', { messageId, cacheKey, subtitleCount: subtitles.length });

      // 觸發 messageToContentScript 事件，符合 SubPal 架構
      window.dispatchEvent(new CustomEvent('messageToContentScript', {
        detail: {
          messageId: messageId,
          message: {
            type: 'SUBTITLE_READY',
            cacheKey: cacheKey,
            subtitles: subtitles,
            source: 'netflix-page-script'
          }
        }
      }));
    }

    /**
     * 生成唯一的消息ID
     */
    generateMessageId() {
      return `netflix-page-script-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * 獲取攔截到的字幕
     */
    getInterceptedSubtitles(cacheKey) {
      return this.interceptedSubtitles.get(cacheKey);
    }

    /**
     * 獲取所有攔截的字幕
     */
    getAllInterceptedSubtitles() {
      const result = {};
      for (const [key, value] of this.interceptedSubtitles.entries()) {
        result[key] = value;
      }
      return result;
    }

    /**
     * 獲取所有攔截的 raw TTML
     */
    getAllInterceptedTTML() {
      const result = {};
      for (const [key, value] of this.interceptedTTMLs.entries()) {
        result[key] = value;
      }
      return result;
    }

    /**
     * 獲取字幕攔截診斷快照
     */
    getDebugSnapshot() {
      const rawTTMLMetadata = Array.from(this.interceptedTTMLs.entries()).map(([cacheKey, value]) => ({
        cacheKey,
        language: value.language || null,
        rawMetadata: value.rawMetadata || value.metadata || value.requestInfo?.rawTtmlMetadata || null,
        requestInfo: {
          requestId: value.requestInfo?.requestId || null,
          source: value.requestInfo?.source || value.requestInfo?.type || null,
          requestTime: value.requestInfo?.requestTime || value.requestInfo?.timestamp || null,
          responseTime: value.requestInfo?.responseTime || null,
          manifestVideoIdAtRequest: null, // 不再使用全域 manifest state
          manifestEvidenceAtRequest: value.requestInfo?.manifestEvidenceAtRequest || null,
          activePlayerVideoIdAtRequest: value.requestInfo?.activePlayerVideoIdAtRequest || null,
          pageUrlVideoIdAtRequest: value.requestInfo?.pageUrlVideoIdAtRequest || null,
          sessionIdAtRequest: value.requestInfo?.sessionIdAtRequest || null,
          selectedSessionReasonAtRequest: value.requestInfo?.selectedSessionReasonAtRequest || null,
          sessionSelectionConfidenceAtRequest: value.requestInfo?.sessionSelectionConfidenceAtRequest || null,
          currentTrackAtRequest: value.requestInfo?.currentTrackAtRequest || null,
          derivedSubtitleVideo: value.requestInfo?.derivedSubtitleVideo || null
        }
      }));

      return {
        playback: this.getActivePlaybackSnapshot(),
        latestManifestVideoId: this.latestManifestVideoId, // legacy 診斷用
        latestManifestEvidence: this.latestManifestEvidence, // manifest encrypted wrapper 狀態
        manifestMappingAvailable: !!(this.latestManifestEvidence && this.latestManifestEvidence.mappingAvailable),
        manifestEncrypted: !!(this.latestManifestEvidence && this.latestManifestEvidence.manifestEncrypted),
        interceptedTTMLCacheKeys: Array.from(this.interceptedTTMLs.keys()),
        interceptedSubtitleCacheKeys: Array.from(this.interceptedSubtitles.keys()),
        interceptedTTMLCount: this.interceptedTTMLs.size,
        interceptedSubtitleCount: this.interceptedSubtitles.size,
        rawTTMLMetadata,
        recentEvents: this.debugEvents.slice(-20)
      };
    }

    /**
     * 只以容量限制 raw TTML 快取，避免尚可歸屬的舊證據被時間刪除。
     */
    evictOldTTMLEntries(reserve = 0) {
      const MAX_SIZE = 50;

      if (this.interceptedTTMLs.size + reserve > MAX_SIZE) {
        const entries = Array.from(this.interceptedTTMLs.entries()).map(([key, value], index) => ({ key, value, index }));
        entries.sort((a, b) => a.value.timestamp - b.value.timestamp || a.index - b.index);
        const toDelete = entries.slice(0, this.interceptedTTMLs.size + reserve - MAX_SIZE);
        for (const entry of toDelete) {
          this.interceptedTTMLs.delete(entry.key);
        }
      }
    }

    /**
     * 清除字幕快取（含 raw TTML 快取）
     */
    clearCache() {
      this.interceptedSubtitles.clear();
      this.interceptedTTMLs.clear();
      debugLog('字幕快取已清除');
    }
  }

  // 創建實例
  const playerHelper = new NetflixPlayerHelper();
  const subtitleInterceptor = new SubtitleInterceptor();
  subtitleInterceptor.start();
  document?.addEventListener?.('click', recordTrustedTimecodeClick, true);

  /**
   * 檢查Netflix API可用性
   */
  function checkAPIAvailability() {
    try {
      const hasNetflixAPI = !!(window.netflix && window.netflix.appContext);
      const hasPlayerApp = !!(hasNetflixAPI && window.netflix.appContext.state.playerApp);

      debugLog('Netflix API可用性檢查:', {
        hasNetflixAPI,
        hasPlayerApp,
        available: hasNetflixAPI && hasPlayerApp
      });

      return hasNetflixAPI && hasPlayerApp;
    } catch (error) {
      console.error('檢查API可用性時出錯:', error);
      return false;
    }
  }

  const JUMP_LATCH_TTL_MS = 1000;
  const MAX_JUMP_CLICK_LATCHES = 32;
  const JUMP_POST_CHECK_INTERVAL_MS = 25;
  const JUMP_POST_CHECK_TIMEOUT_MS = 500;
  const JUMP_PLAYER_UI_RESTORE_INTERVAL_MS = 25;
  const JUMP_PLAYER_UI_RESTORE_TIMEOUT_MS = 500;
  const jumpClickLatches = new Map();

  function createPageRequestId() {
    if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
    return `jump-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function createJumpFailure(reason, error = '目前無法跳轉至字幕時間點，請繼續觀看。', request = {}) {
    return {
      success: false,
      status: 'error',
      action: 'jump-to-timecode',
      reason,
      error,
      requestId: request.requestId || null,
      controlId: request.controlId || null,
      issuedAt: request.issuedAt ?? null,
      expected: request.expected || null,
      targetTimestamp: request.expected?.targetTimestamp ?? null
    };
  }

  function readJumpExpectedFromControl(control) {
    const expected = {
      videoId: control?.getAttribute?.('data-subpal-jump-video-id'),
      sessionId: control?.getAttribute?.('data-subpal-jump-session-id'),
      epoch: Number(control?.getAttribute?.('data-subpal-jump-epoch')),
      targetTimestamp: Number(control?.getAttribute?.('data-subpal-jump-target-timestamp'))
    };
    return validateJumpExpected(expected) ? null : expected;
  }

  function purgeJumpClickLatches(now = Date.now()) {
    for (const [requestId, latch] of jumpClickLatches) {
      if (now - latch.issuedAt > JUMP_LATCH_TTL_MS || now < latch.issuedAt) {
        jumpClickLatches.delete(requestId);
      }
    }
    while (jumpClickLatches.size >= MAX_JUMP_CLICK_LATCHES) {
      jumpClickLatches.delete(jumpClickLatches.keys().next().value);
    }
  }

  function recordTrustedTimecodeClick(event) {
    if (event?.isTrusted !== true || window.navigator?.userActivation?.isActive !== true) return;
    const control = event.target?.closest?.('.subpal-endscreen-timecode');
    const controlId = control?.getAttribute?.('data-control-id');
    const expected = readJumpExpectedFromControl(control);
    if (!control || !controlId || !expected) return;
    const requestId = createPageRequestId();
    const issuedAt = Date.now();
    purgeJumpClickLatches(issuedAt);
    jumpClickLatches.set(requestId, { requestId, control, controlId, issuedAt, expected, action: 'jump-to-timecode', type: 'JUMP_TO_TIMECODE' });
    control.setAttribute('data-subpal-jump-request-id', requestId);
    control.setAttribute('data-subpal-jump-issued-at', String(issuedAt));
  }

  function validateJumpExpected(expected) {
    const expectedKeys = ['epoch', 'sessionId', 'targetTimestamp', 'videoId'];
    if (!expected || typeof expected !== 'object' || Object.keys(expected).sort().join('|') !== expectedKeys.join('|')) {
      return createJumpFailure('invalid-expected-context', '跳轉資料無效，請再試一次。');
    }
    if (!Number.isInteger(expected.epoch) || expected.epoch < 0 ||
        typeof expected.videoId !== 'string' || !expected.videoId ||
        typeof expected.sessionId !== 'string' || !expected.sessionId) {
      return createJumpFailure('invalid-expected-context', '跳轉資料無效，請再試一次。');
    }
    if (!Number.isFinite(expected.targetTimestamp) || expected.targetTimestamp < 0) {
      return createJumpFailure('invalid-target-timestamp', '時間點資料無效，請再試一次。');
    }
    return null;
  }

  function validateJumpRequest(request) {
    const expectedError = validateJumpExpected(request?.expected);
    if (expectedError) return expectedError;
    if (typeof request.controlId !== 'string' || !request.controlId || typeof request.requestId !== 'string' || !request.requestId || !Number.isFinite(request.issuedAt)) {
      return createJumpFailure('trusted-click-required', '請由字幕時間點按鈕重新操作。', request);
    }
    const latch = jumpClickLatches.get(request.requestId);
    if (!latch) return createJumpFailure('click-latch-missing', '請由字幕時間點按鈕重新操作。', request);
    jumpClickLatches.delete(request.requestId);
    const age = Date.now() - latch.issuedAt;
    if (age < 0 || age > JUMP_LATCH_TTL_MS) {
      return createJumpFailure('click-latch-expired', '請由字幕時間點按鈕重新操作。', request);
    }
    const expectedMatches = latch.expected.videoId === request.expected.videoId &&
      latch.expected.sessionId === request.expected.sessionId &&
      latch.expected.epoch === request.expected.epoch &&
      latch.expected.targetTimestamp === request.expected.targetTimestamp;
    if (latch.controlId !== request.controlId || latch.issuedAt !== request.issuedAt ||
        latch.action !== request.intent || latch.type !== request.type || !expectedMatches) {
      return createJumpFailure('click-latch-mismatch', '請由字幕時間點按鈕重新操作。', request);
    }
    return null;
  }

  function validateJumpSnapshot(snapshot, expected, request = {}) {
    if (!snapshot || snapshot.error === 'Netflix player API unavailable') {
      return createJumpFailure('player-api-unavailable', undefined, request);
    }
    if (snapshot.sessionSelectionConfidence !== 'high' ||
        snapshot.selectedSessionReason !== 'watch-player-api-video-id-match' ||
        !isWatchSessionId(snapshot.selectedSessionId)) {
      return createJumpFailure('untrusted-session', undefined, request);
    }
    if (!Number.isFinite(snapshot.duration) || snapshot.duration <= 0) {
      return createJumpFailure('duration-unavailable', undefined, request);
    }
    const reasonableWatchSessions = Array.isArray(snapshot.openSessions)
      ? snapshot.openSessions.filter((session) => session?.isWatchSession && session.hasReasonablePlaybackState)
      : [];
    if (reasonableWatchSessions.length !== 1) {
      return createJumpFailure('ambiguous-watch-session', undefined, request);
    }
    const activeWatchSession = reasonableWatchSessions[0];
    if (activeWatchSession.sessionId !== expected.sessionId) {
      return createJumpFailure('session-mismatch', undefined, request);
    }
    if (snapshot.playerApiVideoId !== expected.videoId || activeWatchSession.playerApiVideoId !== expected.videoId) {
      return createJumpFailure('video-mismatch', undefined, request);
    }
    if (snapshot.movieId !== expected.videoId || activeWatchSession.movieId !== expected.videoId) {
      return createJumpFailure('movie-mismatch', undefined, request);
    }
    if (snapshot.selectedSessionId !== expected.sessionId) {
      return createJumpFailure('session-mismatch', undefined, request);
    }
    return null;
  }

  function isConnectedAndVisible(element) {
    if (!element || element.isConnected !== true || typeof element.getClientRects !== 'function' || element.getClientRects().length === 0) {
      return false;
    }
    const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(element) : null;
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
  }

  function queryWithin(wrapper, selector) {
    if (typeof wrapper?.querySelectorAll === 'function') return Array.from(wrapper.querySelectorAll(selector));
    const element = wrapper?.querySelector?.(selector) || null;
    return element ? [element] : [];
  }

  function findExpectedPlayer(expected) {
    return Array.from(document.querySelectorAll?.('[data-uia="player"]') || [])
      .filter(player => player?.isConnected === true && player.getAttribute?.('data-videoid') === expected.videoId);
  }

  function isOwnedConnectedControl(control, expectedPlayer) {
    return control?.isConnected === true && control.closest?.('[data-uia="player"]') === expectedPlayer;
  }

  function isDisabledControl(control) {
    return control?.disabled === true || control?.getAttribute?.('aria-disabled') === 'true' || control?.matches?.(':disabled') === true;
  }

  function captureTypeANextEpisodePlayer(expected) {
    const players = findExpectedPlayer(expected);
    if (players.length !== 1) return null;
    const expectedPlayer = players[0];
    const liveCredits = queryWithin(expectedPlayer, 'button[data-uia="watch-credits-seamless-button"]')
      .filter(control => isConnectedAndVisible(control) && !isDisabledControl(control) && isOwnedConnectedControl(control, expectedPlayer));
    const liveNextEpisode = queryWithin(expectedPlayer, 'button[data-uia="next-episode-seamless-button"]')
      .filter(control => isConnectedAndVisible(control) && isOwnedConnectedControl(control, expectedPlayer));
    if (liveCredits.length !== 1 || liveNextEpisode.length !== 1) return null;
    return { player: expectedPlayer };
  }

  function hasTypeANextEpisodeCta(expectedPlayer, selector) {
    return queryWithin(expectedPlayer, selector).some(control => isConnectedAndVisible(control) && isOwnedConnectedControl(control, expectedPlayer));
  }

  async function restoreTypeANextEpisodePlayerUi(expected, request, typeANextEpisodeCapture) {
    const creditsSelector = 'button[data-uia="watch-credits-seamless-button"]';
    const nextEpisodeSelector = 'button[data-uia="next-episode-seamless-button"]';
    const controlsStandardSelector = '[data-uia="controls-standard"]';
    const timelineSelector = '[data-uia="timeline"]';
    const playPauseSelectors = ['[data-uia="control-play-pause"]', '[data-uia="control-play-pause-play"]', '[data-uia="control-play"]', '[data-uia="control-pause"]'];
    const maxChecks = Math.max(1, Math.ceil(JUMP_PLAYER_UI_RESTORE_TIMEOUT_MS / JUMP_PLAYER_UI_RESTORE_INTERVAL_MS));
    const startedAt = Date.now();
    let activated = false;
    let pendingReason = 'player-ui-restore-control-missing';

    for (let checks = 0; checks < maxChecks; checks += 1) {
      const identitySnapshot = subtitleInterceptor.getActivePlaybackSnapshot({ preferFreshApi: true });
      if (validateJumpSnapshot(identitySnapshot, expected, request)) {
        return { success: false, status: 'failed', reason: 'player-ui-restore-identity-changed', activated };
      }

      const players = findExpectedPlayer(expected);
      if (players.length !== 1) {
        pendingReason = players.length === 0 ? 'player-ui-restore-ownership-missing' : 'player-ui-restore-ownership-ambiguous';
      } else {
        const expectedPlayer = players[0];
        const creditsLive = hasTypeANextEpisodeCta(expectedPlayer, creditsSelector);
        const nextEpisodeLive = hasTypeANextEpisodeCta(expectedPlayer, nextEpisodeSelector);
        if (creditsLive || nextEpisodeLive) {
          if (creditsLive && !activated) {
            const creditsControls = queryWithin(expectedPlayer, creditsSelector)
              .filter(control => isConnectedAndVisible(control) && !isDisabledControl(control) &&
                typeof control.click === 'function' && isOwnedConnectedControl(control, expectedPlayer));
            if (creditsControls.length === 1) {
              try {
                creditsControls[0].click();
                activated = true;
              } catch {
                return { success: false, status: 'failed', reason: 'player-ui-restore-activation-failed', activated };
              }
            } else {
              pendingReason = 'player-ui-restore-control-unusable';
            }
          } else {
            pendingReason = 'player-ui-restore-type-a-next-episode-cta-live';
          }
        } else {
          const media = queryWithin(expectedPlayer, 'video').filter(element => element?.isConnected === true);
          if (media.length !== 1 || !isConnectedAndVisible(media[0]) || media[0].ended !== false) {
            pendingReason = 'player-ui-restore-media-unusable';
          } else {
            const controlsStandard = queryWithin(expectedPlayer, controlsStandardSelector).some(control => isOwnedConnectedControl(control, expectedPlayer));
            const timeline = queryWithin(expectedPlayer, timelineSelector).some(control => isOwnedConnectedControl(control, expectedPlayer));
            const playPause = playPauseSelectors.some(selector => queryWithin(expectedPlayer, selector)
              .some(control => isOwnedConnectedControl(control, expectedPlayer)));
            const legacyControls = queryWithin(expectedPlayer, '[data-uia="player-controls"]')
              .some(control => isConnectedAndVisible(control) && isOwnedConnectedControl(control, expectedPlayer));
            if ((controlsStandard && timeline && playPause) || legacyControls) {
              return { success: true, status: 'restored', reason: 'player-ui-restored', activated };
            }
            pendingReason = 'player-ui-restore-control-missing';
          }
        }
      }

      if (checks + 1 >= maxChecks || Date.now() - startedAt >= JUMP_PLAYER_UI_RESTORE_TIMEOUT_MS) {
        return { success: false, status: 'failed', reason: pendingReason, activated };
      }
      await new Promise(resolve => setTimeout(resolve, JUMP_PLAYER_UI_RESTORE_INTERVAL_MS));
    }

    return { success: false, status: 'failed', reason: pendingReason, activated };
  }

  async function restorePlayerUiAfterVerifiedJump(expected, request, typeANextEpisodeCapture = null) {
    if (typeANextEpisodeCapture) return restoreTypeANextEpisodePlayerUi(expected, request, typeANextEpisodeCapture);
    const minimizedSelector = '[data-uia="watch-video-player-view-minimized"]';
    const creditsSelector = 'button[data-uia="watch-credits-seamless-button"]';
    const findExpectedPlayers = () => findExpectedPlayer(expected);
    const findRelatedMinimizedMarker = (expectedPlayer) => {
      const markers = Array.from(document.querySelectorAll?.(minimizedSelector) || []);
      if (markers.length === 0) return { marker: null, reason: null };
      if (markers.length > 1) return { marker: null, reason: 'player-ui-restore-marker-ownership-ambiguous' };
      const marker = markers[0];
      const isRelated = marker?.isConnected === true && (
        expectedPlayer.contains?.(marker) === true || marker.contains?.(expectedPlayer) === true
      );
      return isRelated
        ? { marker, reason: null }
        : { marker: null, reason: 'player-ui-restore-marker-ownership-invalid' };
    };
    const ownershipReason = (players) => players.length === 0
      ? 'player-ui-restore-ownership-missing'
      : 'player-ui-restore-ownership-ambiguous';
    const maxChecks = Math.max(1, Math.ceil(JUMP_PLAYER_UI_RESTORE_TIMEOUT_MS / JUMP_PLAYER_UI_RESTORE_INTERVAL_MS));
    const startedAt = Date.now();
    let pendingReason = 'player-ui-restore-control-missing';

    for (let checks = 0; checks < maxChecks; checks += 1) {
      const identitySnapshot = subtitleInterceptor.getActivePlaybackSnapshot({ preferFreshApi: true });
      if (validateJumpSnapshot(identitySnapshot, expected, request)) {
        return { success: false, status: 'failed', reason: 'player-ui-restore-identity-changed', activated: false };
      }

      const players = findExpectedPlayers();
      if (players.length !== 1) {
        pendingReason = ownershipReason(players);
      } else {
        const expectedPlayer = players[0];
        const minimized = findRelatedMinimizedMarker(expectedPlayer);
        if (minimized.reason) {
          pendingReason = minimized.reason;
        } else if (!isConnectedAndVisible(minimized.marker)) {
          return { success: true, status: 'not-needed', reason: 'player-ui-restore-not-needed', activated: false };
        } else {
          const creditsControls = queryWithin(expectedPlayer, creditsSelector);
          if (creditsControls.length === 0) {
            const media = queryWithin(expectedPlayer, 'video').filter(element => element?.isConnected === true);
            if (media.length !== 1 || !isConnectedAndVisible(media[0]) || media[0].ended !== false) {
              return { success: false, status: 'failed', reason: 'player-ui-restore-media-unusable', activated: false };
            }
            const playerControlsVisible = queryWithin(expectedPlayer, '[data-uia="player-controls"]').some(isConnectedAndVisible);
            if (playerControlsVisible) {
              return { success: true, status: 'restored', reason: 'player-ui-restored', activated: false };
            }
            pendingReason = 'player-ui-restore-control-missing';
          } else if (creditsControls.length > 1) {
            return { success: false, status: 'failed', reason: 'player-ui-restore-control-unavailable', activated: false };
          } else {
            const creditsButton = creditsControls[0];
            const isDisabled = creditsButton.disabled === true ||
              creditsButton.getAttribute?.('aria-disabled') === 'true' || creditsButton.matches?.(':disabled') === true;
            if (!isConnectedAndVisible(creditsButton) || isDisabled || typeof creditsButton.click !== 'function') {
              pendingReason = 'player-ui-restore-control-unusable';
            } else if (creditsButton.closest?.('[data-uia="player"]') !== expectedPlayer) {
              pendingReason = 'player-ui-restore-control-wrong-player';
            } else {
              const media = queryWithin(expectedPlayer, 'video').filter(element => element?.isConnected === true);
              if (media.length !== 1 || media[0].ended !== false) {
                return { success: false, status: 'failed', reason: 'player-ui-restore-media-unusable', activated: false };
              }

              try {
                creditsButton.click();
                break;
              } catch {
                return { success: false, status: 'failed', reason: 'player-ui-restore-activation-failed', activated: false };
              }
            }
          }
        }
      }

      if (checks + 1 >= maxChecks || Date.now() - startedAt >= JUMP_PLAYER_UI_RESTORE_TIMEOUT_MS) {
        return {
          success: false,
          status: pendingReason === 'player-ui-restore-control-missing' ? 'unavailable' : 'failed',
          reason: pendingReason,
          activated: false
        };
      }
      await new Promise(resolve => setTimeout(resolve, JUMP_PLAYER_UI_RESTORE_INTERVAL_MS));
    }

    const verificationStartedAt = Date.now();
    pendingReason = 'player-ui-restore-timeout';
    for (let checks = 0; checks < maxChecks; checks += 1) {
      const snapshot = subtitleInterceptor.getActivePlaybackSnapshot({ preferFreshApi: true });
      if (validateJumpSnapshot(snapshot, expected, request)) {
        return { success: false, status: 'failed', reason: 'player-ui-restore-identity-changed', activated: true };
      }

      const players = findExpectedPlayers();
      if (players.length !== 1) {
        pendingReason = ownershipReason(players);
      } else {
        const currentPlayer = players[0];
        const minimized = findRelatedMinimizedMarker(currentPlayer);
        const minimizedVisible = isConnectedAndVisible(minimized.marker);
        const creditsVisible = queryWithin(currentPlayer, creditsSelector).some(isConnectedAndVisible);
        const playerControlsVisible = queryWithin(currentPlayer, '[data-uia="player-controls"]').some(isConnectedAndVisible);
        if (!minimized.reason && (!minimizedVisible && !creditsVisible || playerControlsVisible)) {
          return { success: true, status: 'restored', reason: 'player-ui-restored', activated: true };
        }
        pendingReason = minimized.reason || 'player-ui-restore-timeout';
      }
      if (checks + 1 >= maxChecks || Date.now() - verificationStartedAt >= JUMP_PLAYER_UI_RESTORE_TIMEOUT_MS) break;
      await new Promise(resolve => setTimeout(resolve, JUMP_PLAYER_UI_RESTORE_INTERVAL_MS));
    }
    return { success: false, status: 'failed', reason: pendingReason, activated: true };
  }

  async function handleJumpToTimecode(request) {
    const requestError = validateJumpRequest(request);
    if (requestError) return requestError;
    const { expected } = request;

    const initialSnapshot = subtitleInterceptor.getActivePlaybackSnapshot({ preferFreshApi: true });
    const initialError = validateJumpSnapshot(initialSnapshot, expected, request);
    if (initialError) return initialError;

    const api = getNetflixPlayerAPI();
    if (!api) return createJumpFailure('player-api-unavailable', undefined, request);

    let videoPlayer = null;
    try {
      videoPlayer = api.videoPlayer?.getVideoPlayerBySessionId?.(expected.sessionId) || null;
    } catch (error) {
      debugLog('取得跳轉播放器失敗:', error.message);
    }
    if (!videoPlayer || typeof videoPlayer.seek !== 'function') {
      return createJumpFailure('player-unavailable', undefined, request);
    }

    if (typeof videoPlayer.getMovieId === 'function') {
      const movieId = videoPlayer.getMovieId();
      if (movieId !== null && movieId !== undefined && String(movieId) !== expected.videoId) {
        return createJumpFailure('video-mismatch', undefined, request);
      }
    }

    // 在取得 player 後再次確認，避免 session 在 dispatch 與 seek 之間切換。
    const beforeSeekSnapshot = subtitleInterceptor.getActivePlaybackSnapshot({ preferFreshApi: true });
    const beforeSeekError = validateJumpSnapshot(beforeSeekSnapshot, expected, request);
    if (beforeSeekError) return beforeSeekError;

    const targetMilliseconds = Math.min(
      Math.max(expected.targetTimestamp * 1000, 0),
      beforeSeekSnapshot.duration
    );
    if (!Number.isFinite(targetMilliseconds)) {
      return createJumpFailure('invalid-target-timestamp', '時間點資料無效，請再試一次。', request);
    }

    const typeANextEpisodeCapture = captureTypeANextEpisodePlayer(expected);
    try {
      await Promise.resolve(videoPlayer.seek(targetMilliseconds));
    } catch (error) {
      return createJumpFailure('seek-failed', undefined, request);
    }

    const startedAt = Date.now();
    const maxPostSeekChecks = Math.max(1, Math.ceil(JUMP_POST_CHECK_TIMEOUT_MS / JUMP_POST_CHECK_INTERVAL_MS));
    let postSeekChecks = 0;
    while (true) {
      postSeekChecks += 1;
      const afterSeekSnapshot = subtitleInterceptor.getActivePlaybackSnapshot({ preferFreshApi: true });
      const afterSeekIdentityError = validateJumpSnapshot(afterSeekSnapshot, expected, request);
      if (afterSeekIdentityError) return createJumpFailure('post-identity-mismatch', undefined, request);
      const postApi = getNetflixPlayerAPI();
      const postPlayer = postApi?.videoPlayer?.getVideoPlayerBySessionId?.(expected.sessionId) || null;
      const postTime = typeof postPlayer?.getCurrentTime === 'function' ? postPlayer.getCurrentTime() : afterSeekSnapshot.currentTime;
      if (Number.isFinite(postTime) && Math.abs(postTime - targetMilliseconds) <= 1000) {
        const playerUiRestore = await restorePlayerUiAfterVerifiedJump(expected, request, typeANextEpisodeCapture);
        const verifiedSnapshot = {
          videoId: afterSeekSnapshot.playerApiVideoId,
          sessionId: afterSeekSnapshot.selectedSessionId,
          currentTime: postTime,
          duration: afterSeekSnapshot.duration
        };
        const isVerifiedSeekWithUnavailableRestore = playerUiRestore.status === 'unavailable' &&
          playerUiRestore.reason === 'player-ui-restore-control-missing' &&
          playerUiRestore.activated === false;
        if (!playerUiRestore.success && !isVerifiedSeekWithUnavailableRestore) {
          return {
            ...createJumpFailure(playerUiRestore.reason, '已跳轉至字幕時間點，但無法安全還原播放器介面，請使用 Netflix 原生控制。', request),
            status: 'partial',
            partial: true,
            targetMilliseconds,
            snapshot: verifiedSnapshot,
            playerUiRestore
          };
        }
        return {
          success: true,
          status: 'success',
          action: 'jump-to-timecode',
          reason: 'seeked',
          requestId: request.requestId,
          controlId: request.controlId,
          issuedAt: request.issuedAt,
          expected,
          targetTimestamp: expected.targetTimestamp,
          targetMilliseconds,
          snapshot: verifiedSnapshot,
          playerUiRestore
        };
      }
      if (postSeekChecks >= maxPostSeekChecks || Date.now() - startedAt >= JUMP_POST_CHECK_TIMEOUT_MS) {
        return createJumpFailure('post-seek-mismatch', undefined, request);
      }
      await new Promise(resolve => setTimeout(resolve, JUMP_POST_CHECK_INTERVAL_MS));
    }
  }

  /**
   * 消息處理器
   */
  function handleMessage(event) {
    if (!event?.data || event.source !== window ||
        event.data.source !== 'subpal-content-script' ||
        event.data.target !== 'subpal-page-script') {
      return;
    }

    const { type, messageId } = event.data;
    debugLog('收到消息:', type, messageId);

    let response = {
      source: 'subpal-page-script',
      messageId: messageId,
      success: false,
      error: null
    };

    try {
      switch (type) {
        case 'PING':
          response.success = true;
          break;

        case 'CHECK_API_AVAILABILITY':
          response.success = true;
          response.available = checkAPIAvailability();
          break;

        case 'JUMP_TO_TIMECODE':
          if (event.data.intent !== 'jump-to-timecode') {
            response = { ...response, ...createJumpFailure('invalid-command-intent', '不支援的跳轉命令。') };
            break;
          }
          handleJumpToTimecode(event.data).then(result => {
            window.postMessage({ ...response, ...result }, '*');
          }).catch(error => {
            debugLog('跳轉命令處理失敗:', error.message);
            window.postMessage({ ...response, ...createJumpFailure('command-failed', error.message) }, '*');
          });
          return;

        case 'CHECK_PLAYER_READY':
          response.success = true;
          response.ready = playerHelper.isInitialized && playerHelper.hasActiveSession();
          break;

        case 'INITIALIZE_PLAYER_HELPER':
          playerHelper.initialize().then(success => {
            response.success = success;
            if (!success) {
              response.error = '播放器助手初始化失敗';
            }
            window.postMessage(response, '*');
          }).catch(error => {
            response.error = error.message;
            window.postMessage(response, '*');
          });
          return; // 異步處理，直接返回

        case 'INITIALIZE_SUBTITLE_INTERCEPTOR':
          subtitleInterceptor.start();
          response.success = true;
          break;

        case 'GET_AVAILABLE_LANGUAGES':
          response.languages = playerHelper.getAvailableLanguages();
          response.success = true;
          break;

        case 'SWITCH_LANGUAGE':
          playerHelper.switchToLanguage(event.data.languageCode).then(success => {
            response.success = success;
            if (!success) {
              response.error = '語言切換失敗';
            }
            window.postMessage(response, '*');
          }).catch(error => {
            response.error = error.message;
            window.postMessage(response, '*');
          });
          return; // 異步處理，直接返回

        case 'SWITCH_TRACK':
          playerHelper.switchToTrack(event.data.trackId).then(success => {
            response.success = success;
            if (!success) {
              response.error = 'trackId 切換失敗';
            }
            window.postMessage(response, '*');
          }).catch(error => {
            response.error = error.message;
            window.postMessage(response, '*');
          });
          return; // 異步處理，直接返回

        case 'GET_CURRENT_LANGUAGE':
          response.language = playerHelper.getCurrentLanguage();
          response.success = true;
          break;

        case 'GET_SUBTITLE_CONTENT':
          const cacheKey = event.data.cacheKey;
          const cachedData = subtitleInterceptor.getInterceptedSubtitles(cacheKey);
          if (cachedData) {
            response.subtitles = cachedData.subtitles;
            response.success = true;
          } else {
            response.error = '未找到字幕內容';
          }
          break;

        case 'GET_ALL_INTERCEPTED_SUBTITLES':
          response.allSubtitles = subtitleInterceptor.getAllInterceptedSubtitles();
          response.success = true;
          debugLog('返回所有攔截的字幕，數量:', Object.keys(response.allSubtitles).length);
          break;

        case 'GET_ALL_INTERCEPTED_TTML':
          response.allTTMLs = subtitleInterceptor.getAllInterceptedTTML();
          response.success = true;
          debugLog('返回所有攔截的 raw TTML，數量:', Object.keys(response.allTTMLs).length);
          break;

        case 'GET_SUBPAL_DEBUG_SNAPSHOT':
          response.debugSnapshot = subtitleInterceptor.getDebugSnapshot();
          response.success = true;
          debugLog('返回 SubPal 診斷快照');
          break;

        case 'CHECK_INTERCEPTOR_STATUS':
          response.active = subtitleInterceptor.isActive;
          response.success = true;
          break;

        case 'TEST_SUBTITLE_FETCH':
          response.success = subtitleInterceptor.isActive;
          response.interceptorActive = subtitleInterceptor.isActive;
          break;

        case 'GET_SUBTITLE_TRACKS':
          const languageCode = event.data.languageCode;
          if (!languageCode) {
            response.error = '缺少語言代碼參數';
            break;
          }

          try {
            // 獲取指定語言的攔截字幕數據
            const allSubtitles = subtitleInterceptor.getAllInterceptedSubtitles();

            // 由於緩存鍵格式是 "語言代碼_參數"，需要按語言代碼查找
            let languageSubtitles = null;
            for (const [cacheKey, subtitleData] of Object.entries(allSubtitles)) {
              if (cacheKey.startsWith(languageCode + '_')) {
                languageSubtitles = subtitleData;
                break;
              }
            }

            if (languageSubtitles && languageSubtitles.subtitles) {
              response.subtitles = languageSubtitles.subtitles;
              response.success = true;
              debugLog(`找到 ${languageCode} 字幕數據，共 ${languageSubtitles.subtitles.length} 條`);
            } else {
              debugLog(`未找到 ${languageCode} 的字幕數據，可用的鍵:`, Object.keys(allSubtitles));
              response.error = `未找到語言 ${languageCode} 的字幕數據`;
            }
          } catch (error) {
            response.error = `獲取字幕軌道失敗: ${error.message}`;
          }
          break;

        default:
          response.error = '未知的消息類型';
      }
    } catch (error) {
      response.error = error.message;
      console.error('處理消息時出錯:', error);
    }

    // 發送響應
    window.postMessage(response, '*');
  }

  // 監聽消息
  window.addEventListener('message', handleMessage);

  // 監聽內部事件 - 檢測影片切換並重新初始化播放器助手
  window.addEventListener('messageToContentScript', (event) => {
    if (event.detail?.message?.type === 'VIDEO_ID_CHANGED') {
      const { oldVideoId, newVideoId } = event.detail.message;
      subtitleInterceptor.recordDebugEvent('VIDEO_ID_CHANGED', {
        oldVideoId,
        newVideoId
      });
      debugLog(`檢測到影片切換 (${oldVideoId} -> ${newVideoId})，重新初始化播放器助手`);

      // 使用重試機制等待播放會話就緒
      retryPlayerInitialization(5, 1000).then(() => {
        debugLog('播放器助手重新初始化完成');
      }).catch(error => {
        console.error('播放器助手重新初始化最終失敗:', error);
      });
    }
  });

  /**
   * 重試播放器初始化，等待播放會話就緒
   * @param {number} maxRetries - 最大重試次數
   * @param {number} delay - 重試間隔 (ms)
   */
  async function retryPlayerInitialization(maxRetries = 5, delay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        debugLog(`播放器助手初始化嘗試 ${attempt}/${maxRetries}...`);

        // 檢查播放會話是否可用
        if (!checkAPIAvailability()) {
          throw new Error('Netflix API不可用');
        }

        const playerApp = window.netflix.appContext.state.playerApp;
        const playerAPI = playerApp.getAPI();
        const sessions = playerAPI.getOpenPlaybackSessions();

        if (!sessions || sessions.length === 0) {
          throw new Error('沒有找到播放會話');
        }

        // 播放會話可用，開始重新初始化
        await playerHelper.reinitialize();
        debugLog(`✅ 播放器助手在第 ${attempt} 次嘗試中成功初始化`);
        return;

      } catch (error) {
        debugLog(`❌ 第 ${attempt} 次初始化失敗: ${error.message}`);

        if (attempt === maxRetries) {
          throw new Error(`播放器助手初始化在 ${maxRetries} 次嘗試後仍然失敗: ${error.message}`);
        }

        // 等待後重試
        debugLog(`⏳ 等待 ${delay}ms 後重試...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // 初始化
  debugLog('Netflix Page Script 已載入');

  // 檢查API可用性
  if (checkAPIAvailability()) {
    debugLog('Netflix API可用，準備就緒');
  } else {
    debugLog('Netflix API不可用，等待頁面加載完成');

    // 等待頁面加載完成後再次檢查
    setTimeout(() => {
      if (checkAPIAvailability()) {
        debugLog('Netflix API現在可用');
      } else {
        debugLog('Netflix API仍不可用');
      }
    }, 3000);
  }

  // 導出到全局範圍（用於調試）
  window.subpalPageScript = {
    ready: true,
    checkAPIAvailability,
    getDebugSnapshot: () => subtitleInterceptor.getDebugSnapshot(),
    debugMode: () => debugMode,
    setDebugMode: (enabled) => {
      debugMode = enabled;
      debugLog('調試模式已', enabled ? '啟用' : '停用');
    }
  };

  window.addEventListener(PAGE_SCRIPT_READY_REQUEST_EVENT, (event) => {
    const { attemptId, probeId, deadline } = event.detail || {};
    if (typeof attemptId !== 'string' || typeof probeId !== 'string' || !Number.isFinite(deadline)) return;
    window.dispatchEvent(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
      detail: { attemptId, probeId, deadline, readyAt: Date.now() }
    }));
  });

  debugLog('Netflix Page Script 初始化完成');
})();
