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

  // 調試模式
  let debugMode = true;
  
  function debugLog(...args) {
    if (debugMode) {
      console.log('[NetflixPageScript]', ...args);
    }
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
        const sessions = this.playerAPI.getOpenPlaybackSessions();
        if (!sessions || sessions.length === 0) {
          throw new Error('沒有找到播放會話');
        }

        this.sessionId = sessions[0].sessionId;
        this.videoPlayer = this.playerAPI.videoPlayer.getVideoPlayerBySessionId(this.sessionId);
        
        if (!this.videoPlayer) {
          throw new Error('無法獲取視頻播放器實例');
        }

        this.isInitialized = true;
        debugLog('Netflix播放器助手初始化成功');
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
     * 檢查是否有可用的播放會話
     */
    hasActiveSession() {
      try {
        if (!this.playerAPI) return false;
        const sessions = this.playerAPI.getOpenPlaybackSessions();
        return sessions && sessions.length > 0;
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
      this.latestManifestVideoId = null; // 從 licensedmanifest 追蹤的真實 videoId
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
        this._interceptorManifestVideoId = self.latestManifestVideoId;  // 快照當前 manifest videoId
        return self.originalXHROpen.apply(this, [method, url, ...args]);
      };

      XMLHttpRequest.prototype.send = function(body) {
        if (this._interceptorUrl) {
          // 攔截 licensedmanifest 請求，追蹤真實 videoId
          if (this._interceptorUrl.includes('licensedmanifest')) {
            const manifestVideoId = self.extractManifestVideoId(this._interceptorUrl);
            if (manifestVideoId) {
              self.latestManifestVideoId = manifestVideoId;
              debugLog('從 manifest 更新 videoId:', manifestVideoId);
            }
          }

          // 只記錄 Netflix 相關的請求
          if (debugMode && this._interceptorUrl.includes('nflxvideo.net')) {
            // debugLog('攔截到 Netflix 請求:', this._interceptorUrl);
          }

          if (self.isSubtitleRequest(this._interceptorUrl)) {
            // 在 send 時再次更新快照，確保捕獲到同步執行中最新的 manifest videoId
            this._interceptorManifestVideoId = self.latestManifestVideoId;
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

          if (self.isSubtitleRequest(url)) {
            // debugLog('識別為字幕請求:', url);
            const manifestVideoId = self.latestManifestVideoId;  // 快照當前 manifest videoId
            const fetchPromise = self.originalFetch.apply(this, args);
            self.handleFetchRequest(fetchPromise, url, manifestVideoId);
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
     * 檢查是否為字幕請求
     */
    isSubtitleRequest(url) {
      // 方案1：攔截所有 Netflix CDN 請求，在 response 時檢查是否為 TTML
      if (url.includes('oca.nflxvideo.net')) {
        return true;
      }
      
      return false;
    }

    /**
     * 處理XMLHttpRequest字幕請求
     */
    handleXHRRequest(xhr) {
      const requestInfo = {
        url: xhr._interceptorUrl,
        method: xhr._interceptorMethod,
        pageUrl: xhr._interceptorPageUrl,  // request-time 頁面 URL
        manifestVideoId: xhr._interceptorManifestVideoId,  // request-time manifest videoId
        timestamp: Date.now(),
        type: 'xhr'
      };

      // debugLog('攔截到字幕請求:', requestInfo.url);

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          try {
            const contentType = xhr.getResponseHeader('content-type');
            let content = '';
            
            // 根據 responseType 和 contentType 選擇正確的讀取方式
            if (xhr.responseType === 'arraybuffer' || contentType === 'application/octet-stream') {
              // debugLog('檢測到 arraybuffer 格式，進行解碼...');
              
              // 將 arraybuffer 轉換為文本
              const arrayBuffer = xhr.response;
              const uint8Array = new Uint8Array(arrayBuffer);
              
              // 嘗試 UTF-8 解碼
              try {
                content = new TextDecoder('utf-8').decode(uint8Array);
                // debugLog('UTF-8 解碼成功');
              } catch (e) {
                // 備用解碼方案
                content = new TextDecoder('latin1').decode(uint8Array);
                debugLog('Latin1 解碼成功');
              }
            } else if (xhr.responseType === '' || xhr.responseType === 'text') {
              // 只有在確定是文本格式時才使用 responseText
              content = xhr.responseText;
              // debugLog('使用 responseText 讀取');
            } else {
              // 嘗試直接使用response
              content = xhr.response;
              if (typeof content !== 'string') {
                // debugLog('未支持的responseType:', xhr.responseType);
                return;
              }
              // debugLog('使用 response 直接讀取');
            }
            
            this.processSubtitleContent(content, requestInfo);
          } catch (error) {
            console.error('處理字幕響應失敗:', error);
          }
        }
      });

      xhr.addEventListener('error', () => {
        console.error('字幕請求失敗:', requestInfo);
      });
    }

    /**
     * 處理Fetch字幕請求
     */
    async handleFetchRequest(fetchPromise, url, manifestVideoId) {
      try {
        const response = await fetchPromise;
        if (response.ok) {
          const content = await response.clone().text();
          this.processSubtitleContent(content, {
            url: url,
            manifestVideoId: manifestVideoId,  // request-time manifest videoId
            timestamp: Date.now(),
            type: 'fetch'
          });
        }
      } catch (error) {
        console.error('處理Fetch字幕請求失敗:', error);
      }
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
     * 生成包含語言和視頻 ID 的緩存鍵
     */
    generateCacheKeyWithLanguage(url, language, pageUrl, requestManifestVideoId) {
      // 優先使用 request-time 的 manifest videoId（每個請求獨立快照，避免被後續 manifest 覆蓋）
      // 降級使用全域 latestManifestVideoId，最後降級使用 URL 中的 videoId
      const videoId = requestManifestVideoId || this.latestManifestVideoId || this.extractVideoIdFromUrl(pageUrl);
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
    processSubtitleContent(content, requestInfo) {
      if (content.includes('<?xml') && content.includes('<tt')) {
        const language = this.parseTTMLLanguage(content);

        // 生成包含正確語言的 cacheKey（使用 request-time manifest videoId 或 URL）
        const cacheKey = this.generateCacheKeyWithLanguage(requestInfo.url, language, requestInfo.pageUrl, requestInfo.manifestVideoId);

        // 如果無法生成有效的緩存鍵（例如預覽影片），則跳過緩存
        if (!cacheKey) {
          debugLog(`跳過緩存 - 無法生成有效緩存鍵，語言: ${language}`);
          return;
        }

        debugLog(`TTML攔截成功: ${language}, 緩存鍵: ${cacheKey}`);

        // 緩存 raw TTML（混合策略：既緩存又通知）
        this.interceptedTTMLs.set(cacheKey, {
          rawContent: content,
          requestInfo: requestInfo,
          language: language,
          timestamp: Date.now()
        });

        // 通知後續模組（即使沒人接收也沒關係）
        this.notifyRawTTMLIntercepted({
          cacheKey: cacheKey,
          rawContent: content,
          requestInfo: requestInfo,
          language: language
        });
      }
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
      const messageId = this.generateMessageId();
      
      debugLog('發送 raw TTML 攔截消息:', { messageId, cacheKey: data.cacheKey, language: data.language });
      
      // 觸發 messageToContentScript 事件，符合 SubPal 架構
      window.dispatchEvent(new CustomEvent('messageToContentScript', {
        detail: {
          messageId: messageId,
          message: {
            type: 'RAW_TTML_INTERCEPTED',
            ...data,
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
     * 清除字幕緩存
     */
    clearCache() {
      this.interceptedSubtitles.clear();
      debugLog('字幕緩存已清除');
    }
  }

  // 創建實例
  const playerHelper = new NetflixPlayerHelper();
  const subtitleInterceptor = new SubtitleInterceptor();
  subtitleInterceptor.start();

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

  /**
   * 消息處理器
   */
  function handleMessage(event) {
    if (event.data.source !== 'subpal-content-script' || 
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
    playerHelper,
    subtitleInterceptor,
    checkAPIAvailability,
    debugMode: () => debugMode,
    setDebugMode: (enabled) => {
      debugMode = enabled;
      debugLog('調試模式已', enabled ? '啟用' : '停用');
    }
  };

  debugLog('Netflix Page Script 初始化完成');
})();