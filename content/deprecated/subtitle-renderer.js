/**
 * 字幕渲染器 - 負責渲染和時間同步
 * 
 * 此模組負責：
 * 1. 管理攔截的字幕數據
 * 2. 監聽播放時間變化
 * 3. 查找當前時間的字幕
 * 4. 渲染雙語字幕到 UI
 * 5. 處理字幕切換和同步
 */

import { parseSubtitle, findSubtitleByTime, buildTimeIndex, findSubtitleByTimeIndex } from './subtitle-parser.js';
import { sendMessageToPageScript } from './messaging.js';
import { getCurrentTimestamp } from './video-info.js';

// 調試模式
let debugMode = true;

function debugLog(...args) {
  if (debugMode) {
    console.log('[SubtitleRenderer]', ...args);
  }
}

/**
 * 字幕渲染器類
 */
class SubtitleRenderer {
  constructor() {
    this.isInitialized = false;
    this.isActive = false;
    
    // 語言設置
    this.primaryLanguage = 'zh-Hant';
    this.secondaryLanguage = 'en';
    
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
    
    // UI 元素
    this.primaryContainer = null;
    this.secondaryContainer = null;
    
    // 回調函數
    this.onSubtitleReady = null;
    this.onSubtitleChange = null;
    this.onError = null;
  }

  /**
   * 初始化渲染器
   */
  async initialize() {
    debugLog('初始化字幕渲染器...');
    
    try {
      // 創建 UI 容器
      this.createUIContainers();
      
      // 等待播放器準備就緒
      await this.waitForPlayerReady();
      
      // 載入攔截的字幕數據
      await this.loadInterceptedSubtitles();
      
      // 開始渲染循環
      this.startRenderLoop();
      
      this.isInitialized = true;
      debugLog('字幕渲染器初始化完成');
      
      return true;
    } catch (error) {
      console.error('初始化字幕渲染器失敗:', error);
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * 等待播放器準備就緒
   */
  async waitForPlayerReady() {
    debugLog('等待播放器準備就緒...');
    
    const maxWaitTime = 10000; // 最多等待10秒
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        // 檢查是否可以獲取到可用語言列表
        const result = await sendMessageToPageScript({
          type: 'GET_AVAILABLE_LANGUAGES'
        });
        
        if (result && result.success && result.languages && result.languages.length > 0) {
          debugLog('播放器準備就緒，可用語言:', result.languages.map(l => l.code));
          return true;
        }
        
        debugLog('播放器尚未準備就緒，等待中...');
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        debugLog('檢查播放器狀態時出錯:', error);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    debugLog('等待播放器準備就緒超時，將嘗試繼續初始化');
    return false;
  }

  /**
   * 創建 UI 容器
   */
  createUIContainers() {
    debugLog('創建 UI 容器');
    
    // 主要語言容器
    this.primaryContainer = document.createElement('div');
    this.primaryContainer.id = 'subpal-primary-subtitle';
    this.primaryContainer.style.cssText = `
      position: fixed;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10200;
      pointer-events: none;
      text-align: center;
      font-size: 24px;
      font-weight: bold;
      color: white;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
      background: rgba(0,0,0,0.7);
      padding: 8px 16px;
      border-radius: 4px;
      max-width: 80%;
      display: none;
      white-space: pre-line;
    `;
    
    // 次要語言容器
    this.secondaryContainer = document.createElement('div');
    this.secondaryContainer.id = 'subpal-secondary-subtitle';
    this.secondaryContainer.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10300;
      pointer-events: none;
      text-align: center;
      font-size: 18px;
      font-weight: normal;
      color: #ffff00;
      text-shadow: 1px 1px 2px rgba(0,0,0,0.6);
      background: rgba(0,0,0,0.5);
      padding: 6px 12px;
      border-radius: 4px;
      max-width: 80%;
      display: none;
      white-space: pre-line;
    `;
    
    // 添加到頁面
    document.body.appendChild(this.primaryContainer);
    document.body.appendChild(this.secondaryContainer);
    
    debugLog('UI 容器創建完成');
  }

  /**
   * 載入攔截的字幕數據
   */
  async loadInterceptedSubtitles() {
    debugLog('載入攔截的字幕數據...');
    
    try {
      // 先嘗試獲取現有的攔截字幕
      const result = await sendMessageToPageScript({
        type: 'GET_ALL_INTERCEPTED_SUBTITLES'
      });
      
      if (result && result.success && result.allSubtitles) {
        debugLog('獲取到攔截的字幕數據:', Object.keys(result.allSubtitles));
        
        // 處理每個語言的字幕
        for (const [cacheKey, subtitleData] of Object.entries(result.allSubtitles)) {
          if (subtitleData && subtitleData.subtitles) {
            this.processInterceptedSubtitle(cacheKey, subtitleData);
          }
        }
      }
      
      // 如果沒有所需語言的字幕，嘗試切換語言來觸發攔截
      if (!this.hasRequiredLanguages()) {
        debugLog('缺少所需語言的字幕，嘗試切換語言觸發攔截');
        await this.triggerLanguageSwitchForInterception();
      }
      
      // 檢查是否有所需語言的字幕
      this.checkRequiredLanguages();
      
      return true;
    } catch (error) {
      console.error('載入攔截字幕數據失敗:', error);
      return false;
    }
  }

  /**
   * 處理攔截的字幕數據
   */
  processInterceptedSubtitle(cacheKey, subtitleData) {
    debugLog('處理攔截的字幕:', cacheKey);
    
    // 從 cacheKey 提取語言信息
    const languageCode = cacheKey.split('_')[0];
    
    // 獲取原始字幕內容
    const rawContent = subtitleData.rawContent || '';
    
    if (!rawContent) {
      debugLog('字幕數據無原始內容，嘗試使用已解析的字幕:', cacheKey);
      
      // 如果沒有原始內容，嘗試使用已解析的字幕數據
      if (subtitleData.subtitles && subtitleData.subtitles.length > 0) {
        this.interceptedSubtitles.set(languageCode, {
          cacheKey,
          subtitles: subtitleData.subtitles,
          rawContent: '',
          requestInfo: subtitleData.requestInfo
        });
        debugLog(`語言 ${languageCode} 使用已解析字幕，共 ${subtitleData.subtitles.length} 個條目`);
      } else {
        debugLog('字幕數據無內容:', cacheKey);
      }
      return;
    }
    
    // 解析字幕內容
    const parsedSubtitles = parseSubtitle(rawContent);
    
    if (parsedSubtitles.length === 0) {
      debugLog('字幕解析失敗:', cacheKey);
      return;
    }
    
    // 儲存到對應語言
    this.interceptedSubtitles.set(languageCode, {
      cacheKey,
      subtitles: parsedSubtitles,
      rawContent,
      requestInfo: subtitleData.requestInfo
    });
    
    debugLog(`語言 ${languageCode} 字幕處理完成，共 ${parsedSubtitles.length} 個條目`);
  }

  /**
   * 檢查是否有所需語言的字幕
   */
  hasRequiredLanguages() {
    return this.interceptedSubtitles.has(this.primaryLanguage) && 
           this.interceptedSubtitles.has(this.secondaryLanguage);
  }

  /**
   * 切換語言觸發攔截
   */
  async triggerLanguageSwitchForInterception() {
    debugLog('開始切換語言觸發攔截...');
    
    try {
      // 獲取可用語言列表
      const availableLanguages = await sendMessageToPageScript({
        type: 'GET_AVAILABLE_LANGUAGES'
      });
      
      if (!availableLanguages || !availableLanguages.success) {
        debugLog('獲取可用語言失敗');
        return;
      }
      
      const languages = availableLanguages.languages || [];
      debugLog('可用語言:', languages.map(l => l.code));
      
      // 切換到主要語言
      const primaryLang = languages.find(l => l.code === this.primaryLanguage);
      if (primaryLang) {
        debugLog('切換到主要語言:', this.primaryLanguage);
        await sendMessageToPageScript({
          type: 'SWITCH_LANGUAGE',
          languageCode: this.primaryLanguage
        });
        await this.waitForSubtitleLoad();
      }
      
      // 切換到次要語言
      const secondaryLang = languages.find(l => l.code === this.secondaryLanguage);
      if (secondaryLang) {
        debugLog('切換到次要語言:', this.secondaryLanguage);
        await sendMessageToPageScript({
          type: 'SWITCH_LANGUAGE',
          languageCode: this.secondaryLanguage
        });
        await this.waitForSubtitleLoad();
      }
      
      // 重新獲取攔截的字幕
      await this.reloadInterceptedSubtitles();
      
    } catch (error) {
      console.error('切換語言觸發攔截失敗:', error);
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
   * 重新載入攔截的字幕
   */
  async reloadInterceptedSubtitles() {
    debugLog('重新載入攔截的字幕...');
    
    try {
      const result = await sendMessageToPageScript({
        type: 'GET_ALL_INTERCEPTED_SUBTITLES'
      });
      
      if (result && result.success && result.allSubtitles) {
        // 處理新攔截的字幕
        for (const [cacheKey, subtitleData] of Object.entries(result.allSubtitles)) {
          if (subtitleData && subtitleData.subtitles) {
            this.processInterceptedSubtitle(cacheKey, subtitleData);
          }
        }
      }
    } catch (error) {
      console.error('重新載入攔截字幕失敗:', error);
    }
  }

  /**
   * 檢查所需語言的字幕是否可用
   */
  checkRequiredLanguages() {
    debugLog('檢查所需語言字幕可用性...');
    
    // 檢查主要語言
    if (this.interceptedSubtitles.has(this.primaryLanguage)) {
      const primaryData = this.interceptedSubtitles.get(this.primaryLanguage);
      this.primarySubtitles = primaryData.subtitles;
      
      // 安全地建立時間索引
      try {
        this.primaryTimeIndex = buildTimeIndex(this.primarySubtitles);
        debugLog(`主要語言 ${this.primaryLanguage} 可用，共 ${this.primarySubtitles.length} 個字幕`);
      } catch (error) {
        debugLog(`主要語言 ${this.primaryLanguage} 時間索引建立失敗，將使用線性查找:`, error);
        this.primaryTimeIndex = null;
      }
    } else {
      debugLog(`主要語言 ${this.primaryLanguage} 不可用`);
    }
    
    // 檢查次要語言
    if (this.interceptedSubtitles.has(this.secondaryLanguage)) {
      const secondaryData = this.interceptedSubtitles.get(this.secondaryLanguage);
      this.secondarySubtitles = secondaryData.subtitles;
      
      // 安全地建立時間索引
      try {
        this.secondaryTimeIndex = buildTimeIndex(this.secondarySubtitles);
        debugLog(`次要語言 ${this.secondaryLanguage} 可用，共 ${this.secondarySubtitles.length} 個字幕`);
      } catch (error) {
        debugLog(`次要語言 ${this.secondaryLanguage} 時間索引建立失敗，將使用線性查找:`, error);
        this.secondaryTimeIndex = null;
      }
    } else {
      debugLog(`次要語言 ${this.secondaryLanguage} 不可用`);
    }
    
    // 檢查是否可以啟用雙語字幕
    if (this.primarySubtitles.length > 0 && this.secondarySubtitles.length > 0) {
      debugLog('雙語字幕數據就緒');
      this.isActive = true;
      
      if (this.onSubtitleReady) {
        this.onSubtitleReady();
      }
    } else {
      debugLog('雙語字幕數據不完整');
      this.isActive = false;
    }
  }

  /**
   * 開始渲染循環
   */
  startRenderLoop() {
    debugLog('開始渲染循環');
    
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
    }
    
    this.renderInterval = setInterval(() => {
      this.renderCurrentSubtitle();
    }, 100); // 每 100ms 檢查一次
  }

  /**
   * 停止渲染循環
   */
  stopRenderLoop() {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
  }

  /**
   * 渲染當前時間的字幕
   */
  renderCurrentSubtitle() {
    if (!this.isActive) return;
    
    // 獲取當前播放時間
    const currentTime = getCurrentTimestamp();
    if (currentTime === null) return;
    
    this.currentTimestamp = currentTime;
    
    // 查找當前時間的字幕（優先使用時間索引，失敗時使用線性查找）
    let primarySubtitle = null;
    let secondarySubtitle = null;
    
    try {
      primarySubtitle = this.primaryTimeIndex ? 
        findSubtitleByTimeIndex(this.primaryTimeIndex, currentTime) :
        findSubtitleByTime(this.primarySubtitles, currentTime);
    } catch (error) {
      debugLog('主要語言時間索引查找失敗，使用線性查找:', error);
      primarySubtitle = findSubtitleByTime(this.primarySubtitles, currentTime);
    }
    
    try {
      secondarySubtitle = this.secondaryTimeIndex ?
        findSubtitleByTimeIndex(this.secondaryTimeIndex, currentTime) :
        findSubtitleByTime(this.secondarySubtitles, currentTime);
    } catch (error) {
      debugLog('次要語言時間索引查找失敗，使用線性查找:', error);
      secondarySubtitle = findSubtitleByTime(this.secondarySubtitles, currentTime);
    }
    
    // 構建雙語字幕對象
    const dualSubtitle = this.buildDualSubtitle(primarySubtitle, secondarySubtitle);
    
    // 檢查是否需要更新顯示
    if (this.shouldUpdateDisplay(dualSubtitle)) {
      this.updateSubtitleDisplay(dualSubtitle);
      this.lastRenderedSubtitle = dualSubtitle;
      
      if (this.onSubtitleChange) {
        this.onSubtitleChange(dualSubtitle);
      }
    }
  }

  /**
   * 構建雙語字幕對象
   */
  buildDualSubtitle(primarySubtitle, secondarySubtitle) {
    const dualSubtitle = {
      timestamp: this.currentTimestamp,
      primaryText: primarySubtitle ? primarySubtitle.text : '',
      secondaryText: secondarySubtitle ? secondarySubtitle.text : '',
      primaryLanguage: this.primaryLanguage,
      secondaryLanguage: this.secondaryLanguage,
      hasContent: false
    };
    
    // 檢查是否有內容
    dualSubtitle.hasContent = !!(dualSubtitle.primaryText || dualSubtitle.secondaryText);
    
    return dualSubtitle;
  }

  /**
   * 檢查是否需要更新顯示
   */
  shouldUpdateDisplay(dualSubtitle) {
    if (!this.lastRenderedSubtitle) return true;
    
    return (
      this.lastRenderedSubtitle.primaryText !== dualSubtitle.primaryText ||
      this.lastRenderedSubtitle.secondaryText !== dualSubtitle.secondaryText
    );
  }

  /**
   * 更新字幕顯示
   */
  updateSubtitleDisplay(dualSubtitle) {
    // 更新主要語言字幕
    if (dualSubtitle.primaryText) {
      this.primaryContainer.textContent = dualSubtitle.primaryText;
      this.primaryContainer.style.display = 'block';
    } else {
      this.primaryContainer.style.display = 'none';
    }
    
    // 更新次要語言字幕
    if (dualSubtitle.secondaryText) {
      this.secondaryContainer.textContent = dualSubtitle.secondaryText;
      this.secondaryContainer.style.display = 'block';
    } else {
      this.secondaryContainer.style.display = 'none';
    }
    
    debugLog('字幕顯示已更新:', {
      primary: dualSubtitle.primaryText,
      secondary: dualSubtitle.secondaryText
    });
  }

  /**
   * 設置語言
   */
  setLanguages(primaryLanguage, secondaryLanguage) {
    debugLog('設置語言:', { primaryLanguage, secondaryLanguage });
    
    this.primaryLanguage = primaryLanguage;
    this.secondaryLanguage = secondaryLanguage;
    
    // 重新檢查語言可用性
    this.checkRequiredLanguages();
  }

  /**
   * 刷新攔截的字幕數據
   */
  async refreshInterceptedSubtitles() {
    debugLog('刷新攔截的字幕數據');
    
    // 清除舊數據
    this.interceptedSubtitles.clear();
    this.primarySubtitles = [];
    this.secondarySubtitles = [];
    this.primaryTimeIndex = null;
    this.secondaryTimeIndex = null;
    
    // 等待播放器準備就緒（如果需要）
    await this.waitForPlayerReady();
    
    // 重新載入
    await this.loadInterceptedSubtitles();
  }

  /**
   * 隱藏所有字幕
   */
  hideAllSubtitles() {
    if (this.primaryContainer) {
      this.primaryContainer.style.display = 'none';
    }
    if (this.secondaryContainer) {
      this.secondaryContainer.style.display = 'none';
    }
  }

  /**
   * 設置回調函數
   */
  setCallbacks(callbacks) {
    this.onSubtitleReady = callbacks.onSubtitleReady;
    this.onSubtitleChange = callbacks.onSubtitleChange;
    this.onError = callbacks.onError;
  }

  /**
   * 獲取狀態
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isActive: this.isActive,
      primaryLanguage: this.primaryLanguage,
      secondaryLanguage: this.secondaryLanguage,
      primarySubtitlesCount: this.primarySubtitles.length,
      secondarySubtitlesCount: this.secondarySubtitles.length,
      interceptedLanguages: Array.from(this.interceptedSubtitles.keys()),
      currentTimestamp: this.currentTimestamp
    };
  }

  /**
   * 設置調試模式
   */
  setDebugMode(enabled) {
    debugMode = enabled;
  }

  /**
   * 清理資源
   */
  cleanup() {
    debugLog('清理資源');
    
    this.stopRenderLoop();
    this.hideAllSubtitles();
    
    if (this.primaryContainer) {
      this.primaryContainer.remove();
      this.primaryContainer = null;
    }
    
    if (this.secondaryContainer) {
      this.secondaryContainer.remove();
      this.secondaryContainer = null;
    }
    
    this.isInitialized = false;
    this.isActive = false;
  }
}

// 創建單例實例
const subtitleRenderer = new SubtitleRenderer();

/**
 * 初始化字幕渲染器
 */
export async function initSubtitleRenderer() {
  return await subtitleRenderer.initialize();
}

/**
 * 設置語言
 */
export function setSubtitleLanguages(primaryLanguage, secondaryLanguage) {
  subtitleRenderer.setLanguages(primaryLanguage, secondaryLanguage);
}

/**
 * 刷新攔截的字幕數據
 */
export async function refreshSubtitleData() {
  return await subtitleRenderer.refreshInterceptedSubtitles();
}

/**
 * 隱藏所有字幕
 */
export function hideSubtitles() {
  subtitleRenderer.hideAllSubtitles();
}

/**
 * 設置回調函數
 */
export function setSubtitleRendererCallbacks(callbacks) {
  subtitleRenderer.setCallbacks(callbacks);
}

/**
 * 獲取渲染器狀態
 */
export function getSubtitleRendererStatus() {
  return subtitleRenderer.getStatus();
}

/**
 * 設置調試模式
 */
export function setSubtitleRendererDebugMode(enabled) {
  subtitleRenderer.setDebugMode(enabled);
}

/**
 * 獲取渲染器實例
 */
export function getSubtitleRenderer() {
  return subtitleRenderer;
}

/**
 * 清理資源
 */
export function cleanupSubtitleRenderer() {
  subtitleRenderer.cleanup();
}

debugLog('字幕渲染器模組已載入');