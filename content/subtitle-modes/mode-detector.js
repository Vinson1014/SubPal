/**
 * 模式檢測器 - 智能檢測並選擇最佳字幕模式
 * 
 * 設計理念：
 * 1. 攔截模式優先：功能更豐富，支持雙語字幕
 * 2. 自動降級：攔截模式失效時自動切換到 DOM 監聽模式
 * 3. 智能檢測：全面檢測 Netflix API 和頁面腳本可用性
 * 4. 健壯性：多重檢查確保模式選擇的可靠性
 */

import { waitForPageScript } from '../system/messaging.js';
import { playbackContextManager as defaultPlaybackContextManager } from '../core/playback-context-manager.js';

class ModeDetector {
  constructor({ playbackContextManager = defaultPlaybackContextManager, playback } = {}) {
    this.debug = false; // 從 ConfigBridge 讀取
    this.playbackContextManager = playbackContextManager;
    this.playback = playback || null;
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

      const pageScriptReady = await this.isPageScriptReady();
      checks.pageScriptReady = pageScriptReady;
      if (!pageScriptReady) {
        return this.recordCheckResult({
          status: 'hard_fail',
          mode: 'dom',
          reason: 'page-script-unavailable',
          checks
        });
      }

      const context = this.playbackContextManager.getCurrentContext();
      checks.playbackContext = context?.state || 'missing';
      if (context?.state !== 'ready') {
        return this.recordCheckResult({
          status: 'soft_not_ready',
          mode: 'intercept',
          reason: 'playback-context-not-ready',
          checks
        });
      }

      if (!context.videoId || !context.sessionId || !Number.isInteger(context.epoch)) {
        return this.recordCheckResult({
          status: 'soft_not_ready',
          mode: 'intercept',
          reason: 'playback-context-invalid',
          checks
        });
      }

      const languagesResult = await this.getPlayback().perform({
        variant: 'available-languages',
        payload: {},
        expected: {
          videoId: context.videoId,
          sessionId: context.sessionId,
          epoch: context.epoch
        }
      });
      if (!languagesResult?.ok || languagesResult.value?.variant !== 'available-languages') {
        return this.recordCheckResult({
          status: 'soft_not_ready',
          mode: 'intercept',
          reason: languagesResult?.error?.code || 'languages-unavailable',
          checks
        });
      }

      const languages = languagesResult.value.languages;
      checks.availableLanguages = Array.isArray(languages) ? languages.length : null;
      if (!Array.isArray(languages) || languages.length === 0) {
        return this.recordCheckResult({
          status: 'soft_not_ready',
          mode: 'intercept',
          reason: 'languages-empty',
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

  async isPageScriptReady() {
    try {
      await waitForPageScript(5000);
      return true;
    } catch {
      return false;
    }
  }

  getPlayback() {
    return this.playback || this.playbackContextManager.getPlayback();
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
   * 獲取檢測歷史
   */
  getDetectionHistory() {
    return {
      lastCheck: this.lastCheckResult,
      history: this.checkHistory.slice(-this.maxHistory),
      currentRetryCount: this.retryCount,
      maxRetries: this.maxRetries,
      settings: {
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
