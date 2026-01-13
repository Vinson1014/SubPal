/**
 * Netflix API 橋接器 - 與Netflix內部API通信
 * 
 * 此模組負責：
 * 1. 檢測Netflix API可用性
 * 2. 封裝Netflix播放器API調用
 * 3. 提供字幕相關功能
 * 4. 處理錯誤和重試機制
 */

import { sendMessage, registerInternalEventHandler, sendMessageToPageScript, requestPageScriptInjection } from './messaging.js';

// 調試模式
let debugMode = false;

function debugLog(...args) {
  if (debugMode) {
    console.log('[NetflixAPIBridge]', ...args);
  }
}

/**
 * Netflix API 橋接器類
 */
class NetflixAPIBridge {
  constructor() {
    this.isInitialized = false;
    this.isAPIAvailable = false;
    this.playerHelper = null;
    this.subtitleInterceptor = null;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.pageScriptInjected = false;
    this.debug = false; // 將由 ConfigBridge 設置
  }

  /**
   * 初始化API橋接器
   */
  async initialize() {
    debugLog('初始化Netflix API橋接器...');

    try {
      // 初始化 ConfigBridge 並讀取配置
      const { configBridge } = await import('./config/config-bridge.js');

      // 讀取 debugMode
      this.debug = configBridge.get('debugMode');
      debugMode = this.debug; // 同步更新全局變數
      debugLog('調試模式設置已載入:', debugMode);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        debugMode = newValue; // 同步更新全局變數
        debugLog('調試模式已更新:', debugMode);
      });

      this.configBridge = configBridge;

      // 注入page script
      await this.injectPageScript();

      // 檢測Netflix API可用性
      this.isAPIAvailable = await this.checkAPIAvailability();

      if (this.isAPIAvailable) {
        // 初始化播放器助手
        await this.initializePlayerHelper();

        // 初始化字幕攔截器
        await this.initializeSubtitleInterceptor();

        this.isInitialized = true;
        debugLog('Netflix API橋接器初始化成功');
        return true;
      } else {
        debugLog('Netflix API不可用，將使用fallback模式');
        return false;
      }
    } catch (error) {
      console.error('Netflix API橋接器初始化失敗:', error);
      return false;
    }
  }

  /**
   * 注入page script到頁面context
   */
  async injectPageScript() {
    if (this.pageScriptInjected) {
      debugLog('Page script已注入，跳過');
      return;
    }

    try {
      // 檢查是否在Netflix頁面
      if (!window.location.hostname.includes('netflix.com')) {
        throw new Error('不在Netflix頁面上');
      }

      // 使用 messaging.js 的統一接口請求注入 page script
      debugLog('使用messaging.js請求注入page script...');
      await requestPageScriptInjection();
      
      this.pageScriptInjected = true;
      debugLog('Page script注入成功');
    } catch (error) {
      console.error('Page script注入失敗:', error);
      throw error;
    }
  }

  /**
   * 檢測Netflix API可用性
   */
  async checkAPIAvailability() {
    debugLog('檢測Netflix API可用性...');
    
    try {
      // 通過messaging.js發送到page script
      const result = await sendMessageToPageScript({
        type: 'CHECK_API_AVAILABILITY'
      });
      
      if (result && result.success) {
        debugLog('Netflix API可用性檢測結果:', result.available);
        return result.available;
      } else {
        debugLog('Netflix API可用性檢測失敗:', result?.error);
        return false;
      }
    } catch (error) {
      console.error('檢測Netflix API可用性時出錯:', error);
      return false;
    }
  }

  /**
   * 初始化播放器助手
   */
  async initializePlayerHelper() {
    debugLog('初始化播放器助手...');
    
    try {
      const result = await sendMessageToPageScript({
        type: 'INITIALIZE_PLAYER_HELPER'
      });
      
      if (result && result.success) {
        debugLog('播放器助手初始化成功');
        this.playerHelper = true;
      } else {
        throw new Error(result?.error || '播放器助手初始化失敗');
      }
    } catch (error) {
      console.error('初始化播放器助手失敗:', error);
      throw error;
    }
  }

  /**
   * 初始化字幕攔截器
   */
  async initializeSubtitleInterceptor() {
    debugLog('初始化字幕攔截器...');
    
    try {
      const result = await sendMessageToPageScript({
        type: 'INITIALIZE_SUBTITLE_INTERCEPTOR'
      });
      
      if (result && result.success) {
        debugLog('字幕攔截器初始化成功');
        this.subtitleInterceptor = true;
      } else {
        throw new Error(result?.error || '字幕攔截器初始化失敗');
      }
    } catch (error) {
      console.error('初始化字幕攔截器失敗:', error);
      throw error;
    }
  }

  /**
   * 獲取可用的字幕語言列表
   */
  async getAvailableLanguages() {
    if (!this.isInitialized) {
      throw new Error('API橋接器未初始化');
    }
    
    debugLog('獲取可用字幕語言列表...');
    
    try {
      const result = await sendMessageToPageScript({
        type: 'GET_AVAILABLE_LANGUAGES'
      });
      
      if (result && result.success) {
        debugLog('獲取到可用語言:', result.languages);
        return result.languages;
      } else {
        throw new Error(result?.error || '獲取可用語言失敗');
      }
    } catch (error) {
      console.error('獲取可用語言時出錯:', error);
      throw error;
    }
  }

  /**
   * 切換字幕語言
   */
  async switchLanguage(languageCode) {
    if (!this.isInitialized) {
      throw new Error('API橋接器未初始化');
    }
    
    debugLog('切換字幕語言到:', languageCode);
    
    try {
      const result = await sendMessageToPageScript({
        type: 'SWITCH_LANGUAGE',
        languageCode: languageCode
      });
      
      if (result && result.success) {
        debugLog('字幕語言切換成功');
        return true;
      } else {
        throw new Error(result?.error || '字幕語言切換失敗');
      }
    } catch (error) {
      console.error('切換字幕語言時出錯:', error);
      throw error;
    }
  }

  /**
   * 獲取當前字幕語言
   */
  async getCurrentLanguage() {
    if (!this.isInitialized) {
      throw new Error('API橋接器未初始化');
    }
    
    debugLog('獲取當前字幕語言...');
    
    try {
      const result = await sendMessageToPageScript({
        type: 'GET_CURRENT_LANGUAGE'
      });
      
      if (result && result.success) {
        debugLog('當前字幕語言:', result.language);
        return result.language;
      } else {
        throw new Error(result?.error || '獲取當前字幕語言失敗');
      }
    } catch (error) {
      console.error('獲取當前字幕語言時出錯:', error);
      throw error;
    }
  }

  /**
   * 獲取字幕內容
   */
  async getSubtitleContent(languageCode) {
    if (!this.isInitialized) {
      throw new Error('API橋接器未初始化');
    }
    
    debugLog('獲取字幕內容:', languageCode);
    
    try {
      const result = await sendMessageToPageScript({
        type: 'GET_SUBTITLE_CONTENT',
        languageCode: languageCode
      });
      
      if (result && result.success) {
        debugLog('字幕內容獲取成功，條目數:', result.subtitles?.length || 0);
        return result.subtitles;
      } else {
        throw new Error(result?.error || '獲取字幕內容失敗');
      }
    } catch (error) {
      console.error('獲取字幕內容時出錯:', error);
      throw error;
    }
  }


  /**
   * 獲取API狀態
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isAPIAvailable: this.isAPIAvailable,
      playerHelper: this.playerHelper,
      subtitleInterceptor: this.subtitleInterceptor,
      pageScriptInjected: this.pageScriptInjected
    };
  }

  /**
   * 重新初始化（用於錯誤恢復）
   */
  async reinitialize() {
    debugLog('重新初始化Netflix API橋接器...');
    
    this.isInitialized = false;
    this.isAPIAvailable = false;
    this.playerHelper = null;
    this.subtitleInterceptor = null;
    this.retryCount = 0;
    this.pageScriptInjected = false;
    
    return await this.initialize();
  }
}

// 創建單例實例
const netflixAPIBridge = new NetflixAPIBridge();

/**
 * 初始化Netflix API橋接器
 */
export async function initNetflixAPIBridge() {
  debugLog('開始初始化Netflix API橋接器...');
  
  try {
    const success = await netflixAPIBridge.initialize();
    if (success) {
      debugLog('Netflix API橋接器初始化成功');
    } else {
      debugLog('Netflix API橋接器初始化失敗，將使用fallback模式');
    }
    return success;
  } catch (error) {
    console.error('初始化Netflix API橋接器時出錯:', error);
    return false;
  }
}

/**
 * 獲取Netflix API橋接器實例
 */
export function getNetflixAPIBridge() {
  return netflixAPIBridge;
}

/**
 * 檢查Netflix API是否可用
 */
export function isNetflixAPIAvailable() {
  return netflixAPIBridge.isAPIAvailable;
}

/**
 * 獲取可用字幕語言列表
 */
export async function getAvailableSubtitleLanguages() {
  if (!netflixAPIBridge.isInitialized) {
    throw new Error('Netflix API橋接器未初始化');
  }
  
  return await netflixAPIBridge.getAvailableLanguages();
}

/**
 * 切換字幕語言
 */
export async function switchSubtitleLanguage(languageCode) {
  if (!netflixAPIBridge.isInitialized) {
    throw new Error('Netflix API橋接器未初始化');
  }
  
  return await netflixAPIBridge.switchLanguage(languageCode);
}

/**
 * 獲取當前字幕語言
 */
export async function getCurrentSubtitleLanguage() {
  if (!netflixAPIBridge.isInitialized) {
    throw new Error('Netflix API橋接器未初始化');
  }
  
  return await netflixAPIBridge.getCurrentLanguage();
}

/**
 * 獲取字幕內容
 */
export async function getSubtitleContent(languageCode) {
  if (!netflixAPIBridge.isInitialized) {
    throw new Error('Netflix API橋接器未初始化');
  }
  
  return await netflixAPIBridge.getSubtitleContent(languageCode);
}

/**
 * 獲取Netflix API狀態
 */
export function getNetflixAPIStatus() {
  return netflixAPIBridge.getStatus();
}

/**
 * 重新初始化Netflix API橋接器
 */
export async function reinitializeNetflixAPI() {
  return await netflixAPIBridge.reinitialize();
}

debugLog('Netflix API橋接器模組已載入');