/**
 * 模式檢測器 - 智能檢測並選擇最佳字幕模式
 * 
 * 設計理念：
 * 1. 攔截模式優先：功能更豐富，支持雙語字幕
 * 2. 自動降級：攔截模式失效時自動切換到 DOM 監聽模式
 * 3. 智能檢測：全面檢測 Netflix API 和頁面腳本可用性
 * 4. 健壯性：多重檢查確保模式選擇的可靠性
 */

import { sendMessageToPageScript, sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class ModeDetector {
  constructor() {
    this.debug = false; // 從 ConfigBridge 讀取
    this.apiCheckTimeout = 5000; // 5秒超時
    this.retryCount = 0;
    this.maxRetries = 3;
    this.lastCheckResult = null;
    this.checkHistory = [];
    this.maxHistory = 20;
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

    const result = await this.detectInterceptModeStatus();
    return result.mode;
  }

  /**
   * 檢測攔截模式狀態，並區分短暫未就緒與真正不可用。
   *
   * status:
   * - ready: 攔截模式可啟動
   * - soft_not_ready: Netflix SPA / 播放器 / 字幕資料仍在 warming up，應保持攔截重試
   * - hard_fail: Page script 或基本通訊不可用，才允許進入 DOM emergency
   */
  async detectInterceptModeStatus() {
    this.log('開始檢測攔截模式狀態...');

    const checks = {};

    try {
      if (!this.isNetflixPage()) {
        return this.recordCheckResult({
          status: 'hard_fail',
          mode: 'dom',
          reason: 'not-netflix-page',
          checks
        });
      }

      const scriptInjected = await this.ensurePageScriptInjected();
      checks.pageScriptInjected = scriptInjected;
      if (!scriptInjected) {
        return this.recordCheckResult({
          status: 'hard_fail',
          mode: 'dom',
          reason: 'page-script-unavailable',
          checks
        });
      }

      const apiAvailable = await this.checkNetflixAPIAvailability();
      checks.netflixAPIAvailable = apiAvailable;
      if (!apiAvailable) {
        return this.recordCheckResult({
          status: 'soft_not_ready',
          mode: 'intercept',
          reason: 'netflix-api-not-ready',
          checks
        });
      }

      const playerReady = await this.checkPlayerReadiness();
      checks.playerReady = playerReady;
      if (!playerReady) {
        return this.recordCheckResult({
          status: 'soft_not_ready',
          mode: 'intercept',
          reason: 'player-not-ready',
          checks
        });
      }

      const interceptStatus = await this.checkSubtitleInterceptCapabilityStatus();
      checks.subtitleIntercept = interceptStatus;
      if (interceptStatus.status !== 'ready') {
        return this.recordCheckResult({
          status: interceptStatus.status,
          mode: interceptStatus.status === 'hard_fail' ? 'dom' : 'intercept',
          reason: interceptStatus.reason,
          checks
        });
      }

      return this.recordCheckResult({
        status: 'ready',
        mode: 'intercept',
        reason: 'intercept-ready',
        checks
      });

    } catch (error) {
      console.warn('模式檢測過程出錯，視為攔截模式暫時未就緒:', error);
      return this.recordCheckResult({
        status: 'soft_not_ready',
        mode: 'intercept',
        reason: 'detector-error',
        error: error.message,
        checks
      });
    }
  }

  /**
   * 檢測攔截模式可用性
   * @returns {Promise<boolean>}
   */
  async checkInterceptModeAvailability() {
    const result = await this.detectInterceptModeStatus();
    return result.status === 'ready';
  }

  /**
   * 以 PING 確認頁面腳本就緒
   */
  async ensurePageScriptInjected() {
    this.log('確認頁面腳本是否就緒...');
    
    const result = await this.sendToPageScript({ type: 'PING' }, 1000);
    if (result && result.success) {
      this.log('頁面腳本已就緒');
      return true;
    }

    this.log('頁面腳本尚未就緒');
    return false;
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
    const result = await this.checkSubtitleInterceptCapabilityStatus();
    return result.status === 'ready';
  }

  async checkSubtitleInterceptCapabilityStatus() {
    this.log('檢測字幕攔截功能...');

    try {
      const languagesResult = await this.sendToPageScript({
        type: 'GET_AVAILABLE_LANGUAGES'
      });

      if (!languagesResult || !languagesResult.success) {
        this.log('可用語言列表暫時不可讀:', languagesResult?.error);
        return {
          status: 'soft_not_ready',
          reason: 'languages-unavailable',
          languagesCount: 0,
          error: languagesResult?.error || null
        };
      }

      const languages = languagesResult.languages || [];
      if (languages.length === 0) {
        this.log('可用語言列表為空，播放器可能仍在切換');
        return {
          status: 'soft_not_ready',
          reason: 'languages-empty',
          languagesCount: 0
        };
      }

      this.log(`檢測到 ${languages.length} 種可用語言`);

      const subtitleTest = await this.sendToPageScript({
        type: 'TEST_SUBTITLE_FETCH'
      });

      if (subtitleTest && subtitleTest.success) {
        this.log('字幕攔截功能正常');
        return {
          status: 'ready',
          reason: 'interceptor-active',
          languagesCount: languages.length,
          interceptorActive: !!subtitleTest.interceptorActive
        };
      }

      this.log('字幕攔截功能測試暫時未通過:', subtitleTest?.error);
      return {
        status: 'soft_not_ready',
        reason: 'interceptor-not-active',
        languagesCount: languages.length,
        error: subtitleTest?.error || null
      };

    } catch (error) {
      console.error('檢測字幕攔截功能時出錯:', error);
      return {
        status: 'soft_not_ready',
        reason: 'intercept-capability-error',
        error: error.message
      };
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
      history: this.checkHistory.slice(-this.maxHistory),
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

  recordCheckResult(result) {
    const normalized = {
      ...result,
      timestamp: Date.now()
    };

    this.lastCheckResult = normalized;
    this.checkHistory.push(normalized);
    if (this.checkHistory.length > this.maxHistory) {
      this.checkHistory.splice(0, this.checkHistory.length - this.maxHistory);
    }

    this.log('攔截模式檢測結果:', normalized);
    return normalized;
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
