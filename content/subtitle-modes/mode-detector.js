/**
 * 模式檢測器 - 智能檢測並選擇最佳字幕模式
 * 
 * 設計理念：
 * 1. 攔截模式優先：功能更豐富，支持雙語字幕
 * 2. 自動降級：攔截模式失效時自動切換到 DOM 監聽模式
 * 3. 智能檢測：全面檢測 Netflix API 和頁面腳本可用性
 * 4. 健壯性：多重檢查確保模式選擇的可靠性
 */

import { sendMessageToPageScript, requestPageScriptInjection, sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class ModeDetector {
  constructor() {
    this.debug = false; // 從 ConfigBridge 讀取
    this.apiCheckTimeout = 5000; // 5秒超時
    this.retryCount = 0;
    this.maxRetries = 3;
    this.lastCheckResult = null;
    this.isInitialized = false;
  }

  async initialize() {
    this.log('模式檢測器初始化中...');

    try {
      // 獲取 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取 debugMode 配置
      this.debug = configBridge.get('debugMode');
      this.log(`調試模式: ${this.debug}`);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
      });

      this.isInitialized = true;
      this.log('模式檢測器初始化完成');

    } catch (error) {
      console.error('模式檢測器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 檢測最佳字幕模式
   * @returns {Promise<string>} 'intercept' 或 'dom'
   */
  async detectOptimalMode() {
    this.log('開始檢測最佳字幕模式...');
    
    try {
      // 1. 檢查基本環境
      if (!this.isNetflixPage()) {
        this.log('不在 Netflix 頁面，使用 DOM 監聽模式');
        return 'dom';
      }
      
      // 2. 嘗試攔截模式檢測
      const interceptAvailable = await this.checkInterceptModeAvailability();
      
      if (interceptAvailable) {
        this.log('攔截模式可用，優先使用');
        this.lastCheckResult = { mode: 'intercept', timestamp: Date.now() };
        return 'intercept';
      }
      
      // 3. 攔截模式不可用，降級到 DOM 監聽模式
      this.log('攔截模式不可用，降級到 DOM 監聽模式');
      this.lastCheckResult = { mode: 'dom', timestamp: Date.now() };
      return 'dom';
      
    } catch (error) {
      console.warn('模式檢測過程出錯，使用安全後備模式:', error);
      this.lastCheckResult = { mode: 'dom', error: error.message, timestamp: Date.now() };
      return 'dom';
    }
  }

  /**
   * 檢測攔截模式可用性
   * @returns {Promise<boolean>}
   */
  async checkInterceptModeAvailability() {
    this.log('檢測攔截模式可用性...');
    
    try {
      // 1. 確保頁面腳本已注入
      const scriptInjected = await this.ensurePageScriptInjected();
      if (!scriptInjected) {
        this.log('頁面腳本注入失敗');
        return false;
      }
      
      // 2. 檢測 Netflix API 可用性
      const apiAvailable = await this.checkNetflixAPIAvailability();
      if (!apiAvailable) {
        this.log('Netflix API 不可用');
        return false;
      }
      
      // 3. 檢測播放器準備狀態
      const playerReady = await this.checkPlayerReadiness();
      if (!playerReady) {
        this.log('播放器未準備就緒');
        return false;
      }
      
      // 4. 檢測字幕攔截功能
      const interceptWorking = await this.checkSubtitleInterceptCapability();
      if (!interceptWorking) {
        this.log('字幕攔截功能不可用');
        return false;
      }
      
      this.log('攔截模式所有檢測項目通過');
      return true;
      
    } catch (error) {
      console.error('檢測攔截模式可用性時出錯:', error);
      return false;
    }
  }

  /**
   * 確保頁面腳本已注入
   */
  async ensurePageScriptInjected() {
    this.log('確保頁面腳本已注入...');
    
    try {
      // 先檢查是否已經注入
      const testResult = await this.sendToPageScript({ type: 'PING' }, 1000);
      if (testResult && testResult.success) {
        this.log('頁面腳本已存在');
        return true;
      }
      
      // 需要注入頁面腳本
      this.log('注入頁面腳本...');
      await requestPageScriptInjection();
      
      // 等待注入完成並驗證
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const verifyResult = await this.sendToPageScript({ type: 'PING' }, 2000);
      if (verifyResult && verifyResult.success) {
        this.log('頁面腳本注入成功');
        return true;
      }
      
      this.log('頁面腳本注入後驗證失敗');
      return false;
      
    } catch (error) {
      console.error('頁面腳本注入過程出錯:', error);
      return false;
    }
  }

  /**
   * 檢測 Netflix API 可用性
   */
  async checkNetflixAPIAvailability() {
    this.log('檢測 Netflix API 可用性...');
    
    try {
      const result = await this.sendToPageScript({
        type: 'CHECK_API_AVAILABILITY'
      });
      
      if (result && result.success && result.available) {
        this.log('Netflix API 可用');
        return true;
      }
      
      this.log('Netflix API 不可用:', result?.error);
      return false;
      
    } catch (error) {
      console.error('檢測 Netflix API 可用性時出錯:', error);
      return false;
    }
  }

  /**
   * 檢測播放器準備狀態
   */
  async checkPlayerReadiness() {
    this.log('檢測播放器準備狀態...');
    
    try {
      const result = await this.sendToPageScript({
        type: 'CHECK_PLAYER_READY'
      });
      
      if (result && result.success && result.ready) {
        this.log('播放器已準備就緒');
        return true;
      }
      
      // 如果播放器未準備就緒，等待一段時間再檢查
      this.log('播放器未準備就緒，等待...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const retryResult = await this.sendToPageScript({
        type: 'CHECK_PLAYER_READY'
      });
      
      if (retryResult && retryResult.success && retryResult.ready) {
        this.log('播放器準備就緒（重試成功）');
        return true;
      }
      
      this.log('播放器準備檢測失敗');
      return false;
      
    } catch (error) {
      console.error('檢測播放器準備狀態時出錯:', error);
      return false;
    }
  }

  /**
   * 檢測字幕攔截功能
   */
  async checkSubtitleInterceptCapability() {
    this.log('檢測字幕攔截功能...');
    
    try {
      // 檢測可用語言
      const languagesResult = await this.sendToPageScript({
        type: 'GET_AVAILABLE_LANGUAGES'
      });
      
      if (!languagesResult || !languagesResult.success || !languagesResult.languages || languagesResult.languages.length === 0) {
        this.log('無法獲取可用語言列表');
        return false;
      }
      
      this.log(`檢測到 ${languagesResult.languages.length} 種可用語言`);
      
      // 嘗試基本的字幕獲取功能
      const subtitleTest = await this.sendToPageScript({
        type: 'TEST_SUBTITLE_FETCH'
      });
      
      if (subtitleTest && subtitleTest.success) {
        this.log('字幕攔截功能正常');
        return true;
      }
      
      this.log('字幕攔截功能測試失敗:', subtitleTest?.error);
      return false;
      
    } catch (error) {
      console.error('檢測字幕攔截功能時出錯:', error);
      return false;
    }
  }

  /**
   * 檢查是否在 Netflix 頁面
   */
  isNetflixPage() {
    const isNetflix = window.location.hostname.includes('netflix.com');
    this.log(`當前頁面: ${window.location.hostname}, 是否為 Netflix: ${isNetflix}`);
    return isNetflix;
  }

  /**
   * 向頁面腳本發送消息（帶超時）
   */
  async sendToPageScript(message, timeout = null) {
    const actualTimeout = timeout || this.apiCheckTimeout;
    
    try {
      return await Promise.race([
        sendMessageToPageScript(message),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('通信超時')), actualTimeout)
        )
      ]);
    } catch (error) {
      this.log(`頁面腳本通信失敗: ${error.message}`);
      return null;
    }
  }

  /**
   * 獲取檢測歷史
   */
  getDetectionHistory() {
    return {
      lastCheck: this.lastCheckResult,
      currentRetryCount: this.retryCount,
      maxRetries: this.maxRetries,
      settings: {
        apiCheckTimeout: this.apiCheckTimeout,
        debug: this.debug
      }
    };
  }

  /**
   * 重新檢測（供外部調用）
   */
  async redetect() {
    this.log('手動重新檢測模式...');
    this.retryCount++;
    return await this.detectOptimalMode();
  }

  /**
   * 設置檢測參數
   */
  configure(options = {}) {
    if (options.apiCheckTimeout) {
      this.apiCheckTimeout = options.apiCheckTimeout;
    }
    if (options.maxRetries !== undefined) {
      this.maxRetries = options.maxRetries;
    }
    if (options.debug !== undefined) {
      this.debug = options.debug;
    }
    
    this.log('模式檢測器配置已更新:', options);
  }


  log(message, ...args) {
    if (this.debug) {
      console.log(`[ModeDetector] ${message}`, ...args);
    }
  }
}

export { ModeDetector };