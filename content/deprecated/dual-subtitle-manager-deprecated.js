/**
 * 雙語字幕管理器 - 雙語字幕系統的核心組件
 * 
 * 此模組負責：
 * 1. 管理兩種語言的字幕數據
 * 2. 協調Netflix API橋接器
 * 3. 整合字幕對齊引擎
 * 4. 管理字幕緩存
 * 5. 處理錯誤和fallback機制
 * 6. 與現有字幕替換系統集成
 */

import { 
  getNetflixAPIBridge, 
  isNetflixAPIAvailable,
  getAvailableSubtitleLanguages,
  switchSubtitleLanguage,
  getCurrentSubtitleLanguage,
  getSubtitleContent,
  reinitializeNetflixAPI
} from './netflix-api-bridge.js';

import { sendMessage, registerInternalEventHandler, sendMessageToPageScript } from './messaging.js';

// 調試模式
let debugMode = false;

function debugLog(...args) {
  if (debugMode) {
    console.log('[DualSubtitleManager]', ...args);
  }
}

/**
 * 雙語字幕管理器類
 */
class DualSubtitleManager {
  constructor() {
    this.isInitialized = false;
    this.isDualSubtitleEnabled = true;  // 預設啟用雙語字幕進行測試
    this.isAPIMode = false;
    this.isFallbackMode = false;
    this.isLoading = false;  // 防止重複載入
    
    // 語言設置 (預設值用於測試)
    this.primaryLanguage = 'zh-Hant';   // 繁體中文
    this.secondaryLanguage = 'en';      // 英文
    this.originalLanguage = null;
    
    // 字幕數據
    this.primarySubtitles = [];
    this.secondarySubtitles = [];
    this.alignedSubtitles = [];
    
    // 緩存和狀態
    this.subtitleCache = new Map();
    this.currentVideoId = null;
    this.lastProcessedTimestamp = 0;
    
    // 配置
    this.alignmentTolerance = 0.5; // 字幕對齊容差（秒）
    this.cacheTimeout = 300000; // 5分鐘緩存過期時間
    this.retryAttempts = 3;
    
    // 回調函數
    this.onDualSubtitleReady = null;
    this.onFallbackMode = null;
    this.onError = null;
  }

  /**
   * 初始化雙語字幕管理器
   */
  async initialize() {
    debugLog('初始化雙語字幕管理器...');
    
    try {
      // 載入設置
      await this.loadSettings();
      
      // 檢查Netflix API可用性
      if (isNetflixAPIAvailable()) {
        debugLog('Netflix API可用，使用API模式');
        this.isAPIMode = true;
        this.isFallbackMode = false;
      } else {
        debugLog('Netflix API不可用，使用Fallback模式');
        this.isAPIMode = false;
        this.isFallbackMode = true;
      }
      
      // 設置事件監聽
      this.setupEventListeners();
      
      this.isInitialized = true;
      debugLog('雙語字幕管理器初始化完成');
      
      // 如果雙語字幕已啟用，等待字幕軌道準備就緒後載入
      if (this.isDualSubtitleEnabled) {
        debugLog('等待字幕軌道準備就緒...');
        this.waitForSubtitleTracksReady();
      }
      
      return true;
    } catch (error) {
      console.error('初始化雙語字幕管理器失敗:', error);
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * 載入設置
   */
  async loadSettings() {
    try {
      const settings = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['debugMode', 'dualSubtitleEnabled', 'primaryLanguage', 'secondaryLanguage']
      });
      
      if (settings) {
        debugMode = settings.debugMode || false;
        // 為了測試，如果設置中沒有值就使用預設的 true
        this.isDualSubtitleEnabled = settings.dualSubtitleEnabled !== undefined ? settings.dualSubtitleEnabled : true;
        this.primaryLanguage = settings.primaryLanguage || 'zh-Hant';
        this.secondaryLanguage = settings.secondaryLanguage || 'en';
      }
      
      debugLog('設置已載入:', {
        debugMode,
        isDualSubtitleEnabled: this.isDualSubtitleEnabled,
        primaryLanguage: this.primaryLanguage,
        secondaryLanguage: this.secondaryLanguage
      });
    } catch (error) {
      console.error('載入設置失敗:', error);
    }
  }

  /**
   * 設置事件監聽器
   */
  setupEventListeners() {
    // 監聽調試模式變更
    registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
      debugMode = message.debugMode;
      debugLog('調試模式已更新:', debugMode);
    });
    
    // 監聽雙語字幕設置變更
    registerInternalEventHandler('DUAL_SUBTITLE_SETTINGS_CHANGED', (message) => {
      this.isDualSubtitleEnabled = message.enabled;
      this.primaryLanguage = message.primaryLanguage;
      this.secondaryLanguage = message.secondaryLanguage;
      debugLog('雙語字幕設置已更新:', message);
      
      // 重新載入字幕
      if (this.isDualSubtitleEnabled) {
        this.loadDualSubtitles();
      }
    });
    
    // 監聽視頻變更
    registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => {
      const oldVideoId = this.currentVideoId;
      this.currentVideoId = message.newVideoId;
      debugLog('視頻ID已變更:', this.currentVideoId, '(舊ID:', oldVideoId, ')');
      
      // 只有在真正的視頻切換時才清除緩存 (避免初始化時的誤觸發)
      if (oldVideoId !== null && oldVideoId !== message.newVideoId) {
        debugLog('確認視頻切換，清除緩存');
        this.clearCache();
        if (this.isDualSubtitleEnabled) {
          this.loadDualSubtitles();
        }
      } else if (oldVideoId === null) {
        debugLog('初始化視頻ID，不清除緩存');
      }
    });

    // 監聽字幕準備就緒事件 (來自 netflix-page-script)
    registerInternalEventHandler('SUBTITLE_READY', (message) => {
      debugLog('收到字幕準備就緒事件:', message);
      this.handleSubtitleReady(message.cacheKey, message.subtitles);
    });
  }

  /**
   * 啟用雙語字幕
   */
  async enableDualSubtitle(primaryLang, secondaryLang) {
    debugLog('啟用雙語字幕:', { primaryLang, secondaryLang });
    
    try {
      this.primaryLanguage = primaryLang;
      this.secondaryLanguage = secondaryLang;
      this.isDualSubtitleEnabled = true;
      
      // 保存設置
      await this.saveSettings();
      
      // 載入雙語字幕
      return await this.loadDualSubtitles();
    } catch (error) {
      console.error('啟用雙語字幕失敗:', error);
      if (this.onError) {
        this.onError(error);
      }
      return false;
    }
  }

  /**
   * 停用雙語字幕
   */
  async disableDualSubtitle() {
    debugLog('停用雙語字幕');
    
    try {
      this.isDualSubtitleEnabled = false;
      
      // 清除數據
      this.primarySubtitles = [];
      this.secondarySubtitles = [];
      this.alignedSubtitles = [];
      
      // 恢復原始語言
      if (this.originalLanguage && this.isAPIMode) {
        await this.restoreOriginalLanguage();
      }
      
      // 保存設置
      await this.saveSettings();
      
      // 切換到fallback模式
      this.switchToFallbackMode();
      
      return true;
    } catch (error) {
      console.error('停用雙語字幕失敗:', error);
      return false;
    }
  }

  /**
   * 載入雙語字幕
   */
  async loadDualSubtitles() {
    if (!this.isDualSubtitleEnabled) {
      debugLog('雙語字幕未啟用');
      return false;
    }
    
    if (this.isLoading) {
      debugLog('正在載入雙語字幕，跳過重複請求');
      return false;
    }
    
    this.isLoading = true;
    debugLog('載入雙語字幕...');
    
    try {
      let result;
      if (this.isAPIMode) {
        result = await this.loadDualSubtitlesViaAPI();
      } else {
        result = await this.loadDualSubtitlesViaFallback();
      }
      return result;
    } catch (error) {
      console.error('載入雙語字幕失敗:', error);
      
      // 嘗試切換到fallback模式
      if (this.isAPIMode) {
        debugLog('API模式失敗，切換到fallback模式');
        this.switchToFallbackMode();
        const result = await this.loadDualSubtitlesViaFallback();
        return result;
      }
      
      return false;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 通過API載入雙語字幕
   */
  async loadDualSubtitlesViaAPI() {
    debugLog('通過API載入雙語字幕...');
    
    try {
      // 獲取可用語言
      const availableLanguages = await getAvailableSubtitleLanguages();
      debugLog('可用語言:', availableLanguages);
      
      // 檢查所需語言是否可用
      const primaryLangAvailable = availableLanguages.find(lang => lang.code === this.primaryLanguage);
      const secondaryLangAvailable = availableLanguages.find(lang => lang.code === this.secondaryLanguage);
      
      if (!primaryLangAvailable || !secondaryLangAvailable) {
        throw new Error(`所需語言不可用: ${this.primaryLanguage}, ${this.secondaryLanguage}`);
      }
      
      // 獲取原始語言
      this.originalLanguage = await getCurrentSubtitleLanguage();
      debugLog('原始語言:', this.originalLanguage);
      
      // 載入主要語言字幕
      debugLog('載入主要語言字幕:', this.primaryLanguage);
      
      // 檢查當前語言是否就是主要語言
      if (this.originalLanguage && this.originalLanguage.code === this.primaryLanguage) {
        debugLog('當前語言就是主要語言，檢查現有緩存...');
        // 當前語言就是主要語言，檢查已攔截的字幕緩存
        this.primarySubtitles = await this.getExistingSubtitleFromInterceptor(this.primaryLanguage);
        
        if (this.primarySubtitles.length === 0) {
          debugLog('未找到已攔截的主要語言字幕，嘗試切換觸發攔截');
          // 先切換到其他語言再切回來，觸發字幕攔截
          const tempLanguage = this.secondaryLanguage;
          await switchSubtitleLanguage(tempLanguage);
          await this.waitForSubtitleLoad();
          await switchSubtitleLanguage(this.primaryLanguage);
          await this.waitForSubtitleLoad();
          this.primarySubtitles = await this.getSubtitleFromCache(this.primaryLanguage);
        }
      } else {
        debugLog('切換到主要語言以觸發攔截:', this.primaryLanguage);
        await switchSubtitleLanguage(this.primaryLanguage);
        await this.waitForSubtitleLoad();
        this.primarySubtitles = await this.getSubtitleFromCache(this.primaryLanguage);
      }
      
      // 載入次要語言字幕
      debugLog('載入次要語言字幕:', this.secondaryLanguage);
      await switchSubtitleLanguage(this.secondaryLanguage);
      await this.waitForSubtitleLoad();
      this.secondarySubtitles = await this.getSubtitleFromCache(this.secondaryLanguage);
      
      // 恢復到用戶的初始預設語言（Netflix 預設語言）
      if (this.originalLanguage) {
        debugLog('恢復到用戶初始預設語言:', this.originalLanguage.code);
        await switchSubtitleLanguage(this.originalLanguage.code);
        debugLog('已恢復到用戶初始預設語言');
      }
      
      // 對齊字幕
      this.alignedSubtitles = await this.alignSubtitles();
      
      debugLog('雙語字幕載入完成:', {
        primary: this.primarySubtitles.length,
        secondary: this.secondarySubtitles.length,
        aligned: this.alignedSubtitles.length
      });
      
      // 通知字幕準備就緒
      if (this.onDualSubtitleReady) {
        this.onDualSubtitleReady(this.alignedSubtitles);
      }
      
      return true;
    } catch (error) {
      console.error('通過API載入雙語字幕失敗:', error);
      throw error;
    }
  }

  /**
   * 通過Fallback模式載入雙語字幕
   */
  async loadDualSubtitlesViaFallback() {
    debugLog('通過Fallback模式載入雙語字幕...');
    
    // 在fallback模式下，我們只能使用當前的DOM字幕
    // 無法獲取多語言字幕，所以只能使用單語言模式
    this.switchToFallbackMode();
    
    return false;
  }

  /**
   * 等待字幕軌道準備就緒
   */
  async waitForSubtitleTracksReady() {
    debugLog('開始等待字幕軌道準備就緒...');
    
    return new Promise((resolve) => {
      const checkTracks = async () => {
        try {
          // 先檢查 Netflix API 橋接器是否已初始化
          if (!isNetflixAPIAvailable()) {
            debugLog('Netflix API橋接器尚未初始化，500ms 後重試...');
            setTimeout(checkTracks, 500);
            return;
          }
          
          debugLog('檢查字幕軌道狀態...');
          const languages = await getAvailableSubtitleLanguages();
          
          if (languages && languages.length > 0) {
            debugLog(`字幕軌道已準備就緒！找到 ${languages.length} 種語言`);
            debugLog('可用語言:', languages.map(l => l.code));
            
            // 開始載入雙語字幕
            this.loadDualSubtitles();
            resolve(true);
          } else {
            debugLog('字幕軌道尚未準備就緒，500ms 後重試...');
            // 500ms 後再次檢查
            setTimeout(checkTracks, 500);
          }
        } catch (error) {
          debugLog('檢查字幕軌道時出錯，500ms 後重試:', error.message);
          // 發生錯誤時也重試
          setTimeout(checkTracks, 500);
        }
      };
      
      checkTracks();
    });
  }

  /**
   * 從攔截器獲取已有的字幕數據
   */
  async getExistingSubtitleFromInterceptor(languageCode) {
    debugLog('嘗試從攔截器獲取已有字幕:', languageCode);
    
    try {
      // 直接請求 page script 提供所有已攔截的字幕
      const result = await sendMessageToPageScript({
        type: 'GET_ALL_INTERCEPTED_SUBTITLES'
      });
      
      if (result && result.success && result.allSubtitles) {
        debugLog('獲取到所有攔截的字幕:', Object.keys(result.allSubtitles));
        
        // 查找匹配當前語言的字幕
        for (const [cacheKey, subtitleData] of Object.entries(result.allSubtitles)) {
          if (subtitleData && subtitleData.subtitles && subtitleData.subtitles.length > 0) {
            debugLog(`找到攔截字幕 ${cacheKey}，數量: ${subtitleData.subtitles.length}`);
            // 假設當前顯示的就是主要語言的字幕
            return subtitleData.subtitles;
          }
        }
      }
      
      debugLog('未在攔截器中找到匹配的字幕');
      return [];
    } catch (error) {
      debugLog('從攔截器獲取字幕失敗:', error.message);
      return [];
    }
  }

  /**
   * 等待字幕載入
   */
  async waitForSubtitleLoad() {
    return new Promise((resolve) => {
      setTimeout(resolve, 2000); // 等待2秒讓字幕載入
    });
  }

  /**
   * 處理來自 netflix-page-script 的字幕準備就緒事件
   */
  handleSubtitleReady(cacheKey, subtitles) {
    debugLog('處理字幕準備就緒事件:', { cacheKey, subtitleCount: subtitles.length });
    
    // 緩存字幕數據
    this.subtitleCache.set(cacheKey, {
      subtitles: subtitles,
      timestamp: Date.now()
    });
    
    debugLog('字幕已緩存:', cacheKey);
    
    // 不要在這裡觸發重新載入，避免無限循環
    // 字幕載入過程中的等待機制會自動檢測到新的緩存並繼續
    debugLog('字幕緩存已更新，等待載入過程自動檢測');
  }

  /**
   * 從緩存獲取字幕
   */
  async getSubtitleFromCache(languageCode) {
    // 新的緩存鍵格式: ${currentLanguage}_${o}_${v}_${e}
    // 需要搜索所有以該語言開頭的緩存鍵
    let cachedData = this.findCachedSubtitleByLanguage(languageCode);
    
    if (cachedData && this.isCacheValid(cachedData)) {
      debugLog('從緩存獲取字幕:', languageCode);
      return cachedData.subtitles;
    }
    
    debugLog('字幕緩存未命中，等待字幕到達:', languageCode);
    
    // 等待一段時間看字幕是否會到達
    await this.waitForSubtitleCacheByLanguage(languageCode);
    
    // 再次嘗試獲取
    cachedData = this.findCachedSubtitleByLanguage(languageCode);
    if (cachedData && this.isCacheValid(cachedData)) {
      debugLog('等待後從緩存獲取字幕:', languageCode);
      return cachedData.subtitles;
    }
    
    debugLog('等待超時，字幕緩存仍未命中:', languageCode);
    return [];
  }

  /**
   * 根據語言代碼查找緩存的字幕
   */
  findCachedSubtitleByLanguage(languageCode) {
    for (const [cacheKey, cachedData] of this.subtitleCache.entries()) {
      if (cacheKey.startsWith(`${languageCode}_`)) {
        debugLog('找到匹配的緩存鍵:', cacheKey);
        return cachedData;
      }
    }
    return null;
  }

  /**
   * 等待字幕緩存（按語言）
   */
  async waitForSubtitleCacheByLanguage(languageCode, maxWaitTime = 5000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      if (this.findCachedSubtitleByLanguage(languageCode)) {
        debugLog('字幕緩存已到達:', languageCode);
        return true;
      }
      
      // 等待100ms後再檢查
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    debugLog('等待字幕緩存超時:', languageCode);
    return false;
  }

  /**
   * 等待字幕緩存
   */
  async waitForSubtitleCache(cacheKey, maxWaitTime = 5000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      if (this.subtitleCache.has(cacheKey)) {
        debugLog('字幕緩存已到達:', cacheKey);
        return true;
      }
      
      // 等待100ms後再檢查
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    debugLog('等待字幕緩存超時:', cacheKey);
    return false;
  }

  /**
   * 對齊字幕
   */
  async alignSubtitles() {
    debugLog('對齊字幕...');
    
    if (this.primarySubtitles.length === 0 || this.secondarySubtitles.length === 0) {
      debugLog('字幕數據不足，無法對齊');
      return [];
    }
    
    const aligned = [];
    
    // 基於時間軸對齊
    for (const primarySub of this.primarySubtitles) {
      const matchingSecondary = this.findMatchingSubtitle(primarySub, this.secondarySubtitles);
      
      if (matchingSecondary) {
        // 調試：檢查對齊的字幕是否包含換行符
        if (primarySub.text.includes('\n') || matchingSecondary.text.includes('\n')) {
          debugLog('對齊分行字幕:', {
            主要語言: {
              文本: primarySub.text,
              包含換行: primarySub.text.includes('\n'),
              換行數量: (primarySub.text.match(/\n/g) || []).length
            },
            次要語言: {
              文本: matchingSecondary.text,
              包含換行: matchingSecondary.text.includes('\n'),
              換行數量: (matchingSecondary.text.match(/\n/g) || []).length
            }
          });
        }
        
        aligned.push({
          startTime: Math.min(primarySub.startTime, matchingSecondary.startTime),
          endTime: Math.max(primarySub.endTime, matchingSecondary.endTime),
          primaryText: primarySub.text,
          secondaryText: matchingSecondary.text,
          primaryLang: this.primaryLanguage,
          secondaryLang: this.secondaryLanguage
        });
      } else {
        // 沒有匹配的次要語言字幕，只顯示主要語言
        aligned.push({
          startTime: primarySub.startTime,
          endTime: primarySub.endTime,
          primaryText: primarySub.text,
          secondaryText: '',
          primaryLang: this.primaryLanguage,
          secondaryLang: this.secondaryLanguage
        });
      }
    }
    
    // 添加只有次要語言的字幕
    for (const secondarySub of this.secondarySubtitles) {
      const hasMatch = this.primarySubtitles.some(primarySub => 
        this.isTimeOverlap(primarySub, secondarySub)
      );
      
      if (!hasMatch) {
        aligned.push({
          startTime: secondarySub.startTime,
          endTime: secondarySub.endTime,
          primaryText: '',
          secondaryText: secondarySub.text,
          primaryLang: this.primaryLanguage,
          secondaryLang: this.secondaryLanguage
        });
      }
    }
    
    // 按時間排序
    aligned.sort((a, b) => a.startTime - b.startTime);
    
    debugLog('字幕對齊完成，共', aligned.length, '個條目');
    
    // 顯示前5個對齊結果用於調試
    if (aligned.length > 0) {
      debugLog('前5個對齊字幕:');
      aligned.slice(0, 5).forEach((sub, index) => {
        debugLog(`  ${index + 1}. ${sub.startTime/10000000}s-${sub.endTime/10000000}s: "${sub.primaryText}" / "${sub.secondaryText}"`);
      });
    }
    
    return aligned;
  }

  /**
   * 尋找匹配的字幕
   */
  findMatchingSubtitle(primarySub, secondarySubtitles) {
    for (const secondarySub of secondarySubtitles) {
      if (this.isTimeOverlap(primarySub, secondarySub)) {
        return secondarySub;
      }
    }
    return null;
  }

  /**
   * 檢查時間重疊
   */
  isTimeOverlap(sub1, sub2) {
    const tolerance = this.alignmentTolerance;
    return (
      (sub1.startTime <= sub2.endTime + tolerance) &&
      (sub2.startTime <= sub1.endTime + tolerance)
    );
  }

  /**
   * 獲取當前時間的字幕
   */
  getCurrentSubtitles(timestamp) {
    if (!this.isDualSubtitleEnabled || this.alignedSubtitles.length === 0) {
      debugLog('雙語字幕未啟用或無對齊字幕數據');
      return null;
    }
    
    // 將播放器時間戳（秒）轉換為Netflix內部時間戳
    // Netflix使用的時間單位是100納秒（1秒 = 10,000,000 個時間單位）
    const netflixTimestamp = timestamp * 10000000;
    
    // 增加調試信息
    debugLog(`查找時間戳 ${timestamp}s (Netflix: ${netflixTimestamp}) 的字幕，共有 ${this.alignedSubtitles.length} 個對齊字幕`);
    
    // 增加時間容差來處理精度問題和語言差異 (0.3秒的容差)
    const timeTolerance = 0.3 * 10000000; // 0.3秒轉換為Netflix時間單位
    
    const currentSub = this.alignedSubtitles.find(sub => 
      netflixTimestamp >= (sub.startTime - timeTolerance) && 
      netflixTimestamp <= (sub.endTime + timeTolerance)
    );
    
    if (currentSub) {
      this.lastProcessedTimestamp = timestamp;
      debugLog(`找到匹配字幕: "${currentSub.primaryText}" / "${currentSub.secondaryText}"`);
      return currentSub;
    }
    
    // 如果沒找到，嘗試找最接近的字幕用於調試
    const nearestSub = this.alignedSubtitles.reduce((nearest, sub) => {
      const currentDistance = Math.min(
        Math.abs(netflixTimestamp - sub.startTime),
        Math.abs(netflixTimestamp - sub.endTime)
      );
      const nearestDistance = Math.min(
        Math.abs(netflixTimestamp - nearest.startTime),
        Math.abs(netflixTimestamp - nearest.endTime)
      );
      return currentDistance < nearestDistance ? sub : nearest;
    }, this.alignedSubtitles[0]);
    
    debugLog(`未找到匹配字幕，最接近的是: "${nearestSub.primaryText}" (${nearestSub.startTime/10000000}s - ${nearestSub.endTime/10000000}s)`);
    
    return null;
  }

  /**
   * 切換到Fallback模式
   */
  switchToFallbackMode() {
    debugLog('切換到Fallback模式');
    
    this.isAPIMode = false;
    this.isFallbackMode = true;
    
    if (this.onFallbackMode) {
      this.onFallbackMode();
    }
  }

  /**
   * 恢復原始語言
   */
  async restoreOriginalLanguage() {
    if (this.originalLanguage && this.isAPIMode) {
      try {
        await switchSubtitleLanguage(this.originalLanguage.code);
        debugLog('已恢復原始語言:', this.originalLanguage.code);
      } catch (error) {
        console.error('恢復原始語言失敗:', error);
      }
    }
  }

  /**
   * 檢查緩存有效性
   */
  isCacheValid(cachedData) {
    const now = Date.now();
    return (now - cachedData.timestamp) < this.cacheTimeout;
  }

  /**
   * 清除緩存
   */
  clearCache() {
    this.subtitleCache.clear();
    this.primarySubtitles = [];
    this.secondarySubtitles = [];
    this.alignedSubtitles = [];
    debugLog('緩存已清除');
  }

  /**
   * 保存設置
   */
  async saveSettings() {
    try {
      await sendMessage({
        type: 'SAVE_SETTINGS',
        settings: {
          dualSubtitleEnabled: this.isDualSubtitleEnabled,
          primaryLanguage: this.primaryLanguage,
          secondaryLanguage: this.secondaryLanguage
        }
      });
      debugLog('設置已保存');
    } catch (error) {
      console.error('保存設置失敗:', error);
    }
  }

  /**
   * 獲取狀態
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isDualSubtitleEnabled: this.isDualSubtitleEnabled,
      isAPIMode: this.isAPIMode,
      isFallbackMode: this.isFallbackMode,
      primaryLanguage: this.primaryLanguage,
      secondaryLanguage: this.secondaryLanguage,
      primarySubtitlesCount: this.primarySubtitles.length,
      secondarySubtitlesCount: this.secondarySubtitles.length,
      alignedSubtitlesCount: this.alignedSubtitles.length
    };
  }

  /**
   * 重新初始化
   */
  async reinitialize() {
    debugLog('重新初始化雙語字幕管理器...');
    
    // 清除狀態
    this.isInitialized = false;
    this.clearCache();
    
    // 重新初始化
    return await this.initialize();
  }

  /**
   * 設置回調函數
   */
  setCallbacks(callbacks) {
    this.onDualSubtitleReady = callbacks.onDualSubtitleReady;
    this.onFallbackMode = callbacks.onFallbackMode;
    this.onError = callbacks.onError;
  }
}

// 創建單例實例
const dualSubtitleManager = new DualSubtitleManager();

/**
 * 初始化雙語字幕管理器
 */
export async function initDualSubtitleManager() {
  debugLog('開始初始化雙語字幕管理器...');
  
  try {
    const success = await dualSubtitleManager.initialize();
    if (success) {
      debugLog('雙語字幕管理器初始化成功');
    } else {
      debugLog('雙語字幕管理器初始化失敗');
    }
    return success;
  } catch (error) {
    console.error('初始化雙語字幕管理器時出錯:', error);
    return false;
  }
}

/**
 * 獲取雙語字幕管理器實例
 */
export function getDualSubtitleManager() {
  return dualSubtitleManager;
}

/**
 * 啟用雙語字幕
 */
export async function enableDualSubtitle(primaryLang, secondaryLang) {
  return await dualSubtitleManager.enableDualSubtitle(primaryLang, secondaryLang);
}

/**
 * 停用雙語字幕
 */
export async function disableDualSubtitle() {
  return await dualSubtitleManager.disableDualSubtitle();
}

/**
 * 獲取當前字幕
 */
export function getCurrentDualSubtitles(timestamp) {
  return dualSubtitleManager.getCurrentSubtitles(timestamp);
}

/**
 * 檢查是否啟用雙語字幕
 */
export function isDualSubtitleEnabled() {
  return dualSubtitleManager.isDualSubtitleEnabled;
}

/**
 * 獲取雙語字幕狀態
 */
export function getDualSubtitleStatus() {
  return dualSubtitleManager.getStatus();
}

/**
 * 設置雙語字幕回調
 */
export function setDualSubtitleCallbacks(callbacks) {
  dualSubtitleManager.setCallbacks(callbacks);
}

/**
 * 重新初始化雙語字幕管理器
 */
export async function reinitializeDualSubtitleManager() {
  return await dualSubtitleManager.reinitialize();
}

debugLog('雙語字幕管理器模組已載入');