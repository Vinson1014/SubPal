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
import { sendMessageToPageScript, sendMessage, registerInternalEventHandler } from '../system/messaging.js';
import { getCurrentTimestamp, getVideoId } from '../core/video-info.js';
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
    
    // 攔截的原始字幕數據
    this.interceptedSubtitles = new Map();
    
    // 渲染狀態
    this.currentTimestamp = 0;
    this.lastRenderedSubtitle = null;
    this.renderInterval = null;
    
    // 調試模式（從 ConfigBridge 讀取）
    this.debug = false;
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

      // 等待播放器準備就緒
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
    
    // 載入攔截的字幕數據
    this.loadInterceptedSubtitles();
    
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
    
    // 清理狀態
    this.currentTimestamp = 0;
    this.lastRenderedSubtitle = null;
    
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
        this.log('播放器未準備就緒:', result?.error || '未知錯誤');
        throw new Error(result?.error || '播放器未準備就緒');
      }
      
    } catch (error) {
      this.log('檢查播放器狀態時出錯:', error.message);
      throw error;
    }
  }

  // 載入攔截的字幕數據（優化流程：緩存檢查優先 -> 智能語言切換 -> 恢復設定）
  async loadInterceptedSubtitles() {
    this.log('載入攔截的字幕數據...');
    
    try {
      // 階段1: 緩存檢查與分析
      const existingCache = await this.checkExistingCache();
      const cacheStatus = this.analyzeCacheStatus(existingCache);
      
      // 階段2: 記錄 Netflix 預設語言
      const defaultLanguage = await this.recordDefaultLanguage();
      
      // 階段3: 根據緩存狀態決定策略
      const strategy = this.determineStrategy(cacheStatus);
      this.log('執行策略:', strategy);
      
      // 階段4: 執行字幕獲取策略
      await this.executeStrategy(strategy, defaultLanguage);
      
      // 階段5: 切回預設語言
      await this.restoreDefaultLanguage(defaultLanguage);
      
      this.log('字幕數據載入完成，已恢復用戶原始設定');
      
    } catch (error) {
      console.error('載入字幕數據失敗:', error);
      throw error;
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
      const currentVideoId = getVideoId();
      if (!currentVideoId) {
        this.log('無法獲取當前影片 ID，跳過緩存檢查');
        return new Map();
      }
      
      const needsProcessing = [];
      const validCacheData = new Map();
      let skippedWrongVideo = 0;
      let skippedAlreadyProcessed = 0;
      
      Object.entries(existingTTMLs.allTTMLs).forEach(([cacheKey, ttmlData]) => {
        // 步驟1: 解析緩存鍵驗證 videoID  
        const parsedKey = this.parseCacheKey(cacheKey);
        if (!parsedKey) {
          this.log(`跳過無效緩存鍵: ${cacheKey}`);
          return;
        }
        
        // 步驟2: 檢查是否屬於當前影片
        if (parsedKey.videoId !== currentVideoId) {
          this.log(`跳過其他影片的緩存: ${cacheKey} (緩存=${parsedKey.videoId}, 當前=${currentVideoId})`);
          skippedWrongVideo++;
          return;
        }
        
        // 步驟3: 檢查是否已經處理過
        if (this.interceptedSubtitles.has(cacheKey)) {
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
          language: ttmlData.language
        });
      });
      
      this.log(`✅ 緩存檢查完成:`, {
        處理新數據: needsProcessing.length,
        跳過已處理: skippedAlreadyProcessed,
        跳過其他影片: skippedWrongVideo,
        當前影片ID: currentVideoId,
        有效語言: Array.from(validCacheData.keys())
      });
      
      return validCacheData;
    }
    
    return new Map();
  }

  /**
   * 分析緩存狀態
   */
  analyzeCacheStatus(existingCache) {
    const hasPrimary = existingCache.has(this.primaryLanguage);
    const hasSecondary = existingCache.has(this.secondaryLanguage);
    
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
    } else {
      this.log(`切換到 ${languageCode}`);
      await this.loadSubtitleForLanguage(languageCode, 'auto');
    }
  }

  /**
   * 等待攔截事件
   */
  async waitForInterception(languageCode) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.log(`等待 ${languageCode} 攔截事件超時`);
        resolve();
      }, 3000);
      
      const handleInterception = (event) => {
        if (event.language === languageCode) {
          clearTimeout(timeout);
          this.log(`收到 ${languageCode} 攔截事件`);
          resolve();
        }
      };
      
      registerInternalEventHandler('RAW_TTML_INTERCEPTED', handleInterception);
    });
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
    
    try {
      // 步驟0: 確保攔截器已準備就緒
      const interceptorStatus = await sendMessageToPageScript({
        type: 'TEST_SUBTITLE_FETCH'
      });
      
      if (!interceptorStatus || !interceptorStatus.success || !interceptorStatus.interceptorActive) {
        this.log('攔截器未準備就緒，等待...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // 不檢查當前語言，直接切換 - 這樣可以觸發重新請求
      // 即使當前已經是目標語言，Netflix 也會響應切換指令並可能重新發送字幕
      this.log(`準備切換到 ${languageCode} `);
      
      // 檢查當前語言僅用於調試
      try {
        const currentLangResult = await sendMessageToPageScript({
          type: 'GET_CURRENT_LANGUAGE'
        });
        const currentLanguage = currentLangResult?.language?.code;
        this.log(`當前語言: ${currentLanguage}, 目標語言: ${languageCode}`);
      } catch (error) {
        this.log('無法獲取當前語言，繼續切換流程');
      }
      
      // 步驟1: 監聽字幕攔截成功事件
      const subtitleReadyPromise = new Promise((resolve, reject) => {
        let isResolved = false;
        
        const timeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            reject(new Error(`等待 ${languageCode} 字幕攔截超時`));
          }
        }, 10000); // 10秒超時
        
        const handler = (event) => {
          const { cacheKey } = event;
          this.log(`收到字幕準備就緒事件: ${cacheKey}`);
          
          // 檢查是否是我們等待的語言
          if (cacheKey.startsWith(languageCode + '_') && !isResolved) {
            this.log(`匹配到 ${languageCode} 的字幕攔截事件`);
            isResolved = true;
            clearTimeout(timeout);
            resolve(cacheKey);
          }
        };
        
        // 註冊一次性事件監聽器
        registerInternalEventHandler('RAW_TTML_INTERCEPTED', handler);
      });
      
      // 步驟2: 切換到指定語言軌，觸發 Netflix 發送 TTML 字幕請求
      this.log(`切換到 ${languageCode} 語言軌...`);
      const switchResult = await sendMessageToPageScript({
        type: 'SWITCH_LANGUAGE',
        languageCode: languageCode
      });
      
      if (!switchResult || !switchResult.success) {
        this.log(`切換到 ${languageCode} 失敗:`, switchResult?.error);
        return;
      }
      
      this.log(`成功切換到 ${languageCode}，等待字幕攔截事件...`);
      
      // 步驟3: 等待字幕攔截完成
      try {
        const cacheKey = await subtitleReadyPromise;
        this.log(`${languageCode} 字幕攔截完成，緩存鍵: ${cacheKey}`);
      } catch (error) {
        this.log(`等待 ${languageCode} 字幕攔截超時，檢查現有數據...`);
      }
      
      // 步驟4: 檢查本地已解析的字幕緩存
      this.log(`檢查 ${languageCode} 的本地緩存...`);
      
      // 查找匹配語言代碼的數據
      let matchedKey = null;
      for (const [cacheKey] of this.interceptedSubtitles.entries()) {
        if (cacheKey.startsWith(languageCode + '_')) {
          matchedKey = cacheKey;
          break;
        }
      }
      
      if (!matchedKey) {
        this.log(`未找到 ${languageCode} 的字幕數據，可用鍵:`, Array.from(this.interceptedSubtitles.keys()));
        return;
      }
      
      const languageData = this.interceptedSubtitles.get(matchedKey);
      if (!languageData || !languageData.subtitles) {
        this.log(`${languageCode} 字幕數據無效`);
        return;
      }
      
      const subtitles = languageData.subtitles;
      this.log(`從鍵 "${matchedKey}" 找到 ${languageCode} 的 ${subtitles.length} 個字幕條目`);
      
      if (subtitles.length > 0) {
        // 使用已建立的時間索引
        const timeIndex = languageData.timeIndex;
        this.log(`${languageCode} 時間索引大小:`, timeIndex?.size || 0);
        
        // 儲存到相應的屬性
        if (type === 'primary') {
          this.primarySubtitles = subtitles;
          this.primaryTimeIndex = timeIndex;
        } else if (type === 'secondary') {
          this.secondarySubtitles = subtitles;
          this.secondaryTimeIndex = timeIndex;
        }
        
        this.log(`${languageCode} ${type} 字幕載入完成`);
      }
      
    } catch (error) {
      console.error(`載入 ${languageCode} 字幕時出錯:`, error);
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
        timestamp: currentTime,
        primarySubtitle: primarySubtitle,
        secondarySubtitle: this.dualSubtitleEnabled ? secondarySubtitle : null,
        isDualModeEnabled: this.dualSubtitleEnabled
      };
      
      // 檢查是否需要更新（避免重複渲染）
      if (this.shouldUpdateSubtitle(dualSubtitleData)) {
        this.lastRenderedSubtitle = dualSubtitleData;
        
        // 通過回調發送字幕數據（不再直接操作UI）
        if (this.callback) {
          const subtitleData = this.convertToStandardFormat(dualSubtitleData);
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
    return {
      isActive: this.isActive,
      isInitialized: this.isInitialized,
      dualSubtitleEnabled: this.dualSubtitleEnabled,
      primaryLanguage: this.primaryLanguage,
      secondaryLanguage: this.secondaryLanguage,
      currentTimestamp: this.currentTimestamp,
      primarySubtitleCount: this.primarySubtitles.length,
      secondarySubtitleCount: this.secondarySubtitles.length,
      hasTimeIndex: {
        primary: !!this.primaryTimeIndex,
        secondary: !!this.secondaryTimeIndex
      },
      lastSubtitle: this.lastRenderedSubtitle ? {
        primaryText: this.lastRenderedSubtitle.primaryText.substring(0, 50) + '...',
        secondaryText: this.lastRenderedSubtitle.secondaryText.substring(0, 50) + '...',
        timestamp: this.lastRenderedSubtitle.timestamp
      } : null
    };
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
    this.interceptedSubtitles.clear();
    
    this.log('字幕攔截器資源清理完成');
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
   * 處理接收到的 raw TTML 數據 - 增加 videoID 驗證
   */
  handleRawTTMLIntercepted(event) {
    const { cacheKey, rawContent, requestInfo, language } = event;
    
    this.log(`接收到 raw TTML: ${language}, 緩存鍵: ${cacheKey}`);
    
    // 步驟1: 解析緩存鍵獲取 videoID
    const parsedKey = this.parseCacheKey(cacheKey);
    if (!parsedKey) {
      this.log(`無效的緩存鍵格式，跳過處理: ${cacheKey}`);
      return;
    }
    
    // 步驟2: 獲取當前影片 ID
    const currentVideoId = getVideoId();
    if (!currentVideoId) {
      this.log('無法獲取當前影片 ID，可能不在觀看頁面，跳過處理');
      return;
    }
    
    // 步驟3: 驗證是否為當前影片的字幕
    if (parsedKey.videoId !== currentVideoId) {
      this.log(`字幕不屬於當前影片，跳過處理:`, {
        緩存中的videoID: parsedKey.videoId,
        當前影片ID: currentVideoId,
        語言: language,
        緩存鍵: cacheKey
      });
      return;
    }
    
    this.log(`✅ VideoID 驗證通過，處理當前影片字幕:`, {
      語言: language,
      videoID: currentVideoId,
      緩存鍵: cacheKey
    });
    
    try {
      // 使用 subtitle-parser 解析 raw TTML（新格式返回 subtitles 和 regionConfigs）
      const parseResult = parseSubtitle(rawContent);
      const { subtitles, regionConfigs } = parseResult;
      
      if (subtitles.length > 0) {
        // 建立時間索引
        const timeIndex = buildTimeIndex(subtitles);
        
        // 儲存到攔截數據
        this.interceptedSubtitles.set(cacheKey, {
          subtitles: subtitles,
          requestInfo: requestInfo,
          language: language,
          timeIndex: timeIndex,
          regionConfigs: regionConfigs,  // 保存 region 配置
          timestamp: Date.now()
        });
        
        this.log(`TTML解析完成: ${language}, 共 ${subtitles.length} 條字幕, ${Object.keys(regionConfigs).length} 個 region 配置`);
        
        // 如果是主要語言，更新 netflix-player-adapter 的 region 配置
        if (language === this.primaryLanguage && Object.keys(regionConfigs).length > 0) {
          this.log(`更新 netflix-player-adapter 的 region 配置 (主要語言: ${language})`);
          setRegionConfigs(regionConfigs);
        }
        
        // 如果是當前需要的語言，立即處理
        this.checkAndProcessLanguage(language, subtitles);
      }
    } catch (error) {
      console.error(`解析 ${language} TTML 失敗:`, error);
    }
  }

  /**
   * 檢查並處理語言數據
   */
  checkAndProcessLanguage(language, subtitles) {
    // 檢查是否是我們需要的語言
    if (language === this.primaryLanguage) {
      this.primarySubtitles = subtitles;
      this.log(`主要語言字幕已更新: ${language}`);
    } else if (language === this.secondaryLanguage && this.dualSubtitleEnabled) {
      this.secondarySubtitles = subtitles;
      this.log(`次要語言字幕已更新: ${language}`);
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
      }
    }
    
    // 檢查次要語言字幕
    if (this.secondarySubtitles.length > 0) {
      const isValid = this.isSubtitlesValidForVideo(this.secondaryLanguage, currentVideoId);
      if (!isValid) {
        this.log(`次要語言字幕不屬於當前影片，清空: ${this.secondaryLanguage}`);
        this.secondarySubtitles = [];
        this.secondaryTimeIndex = null;
      }
    }
  }

  /**
   * 檢查指定語言的字幕是否屬於當前影片
   */
  isSubtitlesValidForVideo(language, currentVideoId) {
    for (const [cacheKey] of this.interceptedSubtitles) {
      const parsedKey = this.parseCacheKey(cacheKey);
      if (parsedKey && 
          parsedKey.language === language && 
          parsedKey.videoId === currentVideoId) {
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
    });

    // 監聽影片 ID 變化事件
    registerInternalEventHandler('VIDEO_ID_CHANGED', async (event) => {
      const newVideoId = event.newVideoId || event.videoId;
      const oldVideoId = event.oldVideoId;

      this.log(`檢測到影片切換: ${oldVideoId} -> ${newVideoId}`);

      // 步驟1: 清理舊影片的緩存數據
      this.cleanupOldVideoCache(newVideoId);

      // 步驟2: 重新載入字幕數據（覆用現有邏輯）
      // loadInterceptedSubtitles() 已包含完整的緩存檢查、分析和載入流程
      if (this.isActive) {
        this.log('重新載入字幕數據以確保使用正確的字幕檔...');
        await this.loadInterceptedSubtitles();
      }
    });
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleInterceptor] ${message}`, ...args);
    }
  }
}

export { SubtitleInterceptor };