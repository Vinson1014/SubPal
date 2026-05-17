/**
 * 字幕協調器 - 智能管理字幕模式和統一字幕處理
 * 
 * 設計理念：
 * 1. 攔截模式優先，自動降級到 DOM 監聽模式
 * 2. 統一兩種模式的字幕數據格式
 * 3. 提供統一的字幕事件接口
 * 4. 智能的錯誤處理和模式切換
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';
import { getVideoId } from '../core/video-info.js';
import { toAPILanguageCode } from '../utils/language-code.js';
import { buildSlotKey } from '../utils/slot-key.js';

class SubtitleCoordinator {
  constructor() {
    this.modeDetector = null;
    this.domMonitor = null;
    this.interceptor = null;
    this.currentMode = null;
    this.uiManager = null;
    this.isInitialized = false;
    this.backgroundRetryTimer = null; // 背景重試計時器
    this.backgroundRetryInFlight = false;
    this.backgroundUpgradeState = {
      active: false,
      attempts: 0,
      reason: null,
      startedAt: null,
      lastResult: null
    };
    this.modeHealth = 'intercept_warming_up';
    this.lastModeDecision = null;
    this.lastSoftFailureReason = null;
    this.lastDomEmergencyReason = null;
    this.interceptFailureCount = 0;
    this.maxInterceptFailuresBeforeDom = 3;
    this.eventCallbacks = {
      onSubtitleDetected: null,
      onModeChanged: null,
      onError: null
    };
    
    // 調試模式（從 ConfigBridge 讀取）
    this.debug = false;
    this.lastSubtitleData = null;
    this.primaryLanguage = 'zh-Hant';
  }

  async initialize(uiManager) {
    this.log('字幕協調器初始化中...');
    this.uiManager = uiManager;

    try {
      // 獲取 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取 debugMode 配置
      this.debug = configBridge.get('debugMode');
      this.primaryLanguage = configBridge.get('subtitle.primaryLanguage');
      this.log(`調試模式: ${this.debug}`);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log('調試模式已更新:', newValue);
      });

      configBridge.subscribe('subtitle.primaryLanguage', (newValue) => {
        this.primaryLanguage = newValue;
        this.log('主要語言已更新:', newValue);
      });

      // 設置事件處理器
      this.setupEventHandlers();
      
      // 動態導入模式檢測器
      const { ModeDetector } = await import('./mode-detector.js');
      this.modeDetector = new ModeDetector();
      await this.modeDetector.initialize();
      
      // 動態導入兩種模式
      const { DOMMonitor } = await import('./dom-monitor.js');
      const { SubtitleInterceptor } = await import('./subtitle-interceptor.js');
      
      this.domMonitor = new DOMMonitor();
      this.interceptor = new SubtitleInterceptor();
      
      // 初始化各模式（允許部分失敗）
      await this.domMonitor.initialize();
      
      // 攔截器初始化可能失敗，不影響整體
      try {
        await this.interceptor.initialize();
        this.log('攔截器初始化成功');
      } catch (error) {
        console.warn('攔截器初始化暫時未就緒，將進入 warming/retry:', error.message);
        this.modeHealth = 'intercept_warming_up';
        this.lastSoftFailureReason = error.message;
      }
      
      // 智能選擇最佳模式
      await this.selectOptimalMode();
      
      this.isInitialized = true;
      this.log(`字幕協調器初始化完成，使用模式: ${this.currentMode}`);
      
      // 通知 UI 管理器模式已選定
      if (this.uiManager && this.uiManager.onModeSelected) {
        this.uiManager.onModeSelected(this.currentMode);
      }
      
    } catch (error) {
      console.error('字幕協調器初始化失敗:', error);
      throw error;
    }
  }

  async selectOptimalMode() {
    try {
      const decision = await this.modeDetector.detectInterceptModeStatus();
      this.lastModeDecision = decision;
      this.log('模式檢測結果:', decision);

      if (decision.status === 'hard_fail') {
        await this.enterDomEmergency(decision.reason);
        return;
      }

      await this.ensureInterceptorInitialized();

      if (decision.status === 'ready') {
        this.modeHealth = 'intercept_ready';
        this.interceptFailureCount = 0;
        this.stopBackgroundUpgrade('intercept-ready');
      } else {
        this.modeHealth = 'intercept_warming_up';
        this.lastSoftFailureReason = decision.reason;
        this.startBackgroundUpgrade({ reason: decision.reason });
      }

      await this.setMode('intercept');

    } catch (error) {
      console.warn('模式選擇暫時失敗，先維持攔截重試:', error);
      await this.handleModeFailure(error);
    }
  }

  async setMode(mode) {
    if (this.currentMode === mode) {
      this.log(`模式 ${mode} 已經是當前模式，跳過切換`);
      if (mode === 'intercept' && this.interceptor && !this.interceptor.isActive) {
        await this.startCurrentMode();
      } else if (mode === 'dom' && this.domMonitor && !this.domMonitor.isActive) {
        await this.startCurrentMode();
      }
      return;
    }
    
    this.log(`準備切換到模式: ${mode}`);
    
    // 停用當前模式
    if (this.currentMode) {
      await this.stopCurrentMode();
    }
    
    // 啟用新模式
    this.currentMode = mode;
    await this.startCurrentMode();
    
    this.log(`字幕模式已切換至: ${mode}`);
    
    // 觸發模式變更回調
    if (this.eventCallbacks.onModeChanged) {
      this.eventCallbacks.onModeChanged(mode);
    }
  }

  // 統一的字幕處理接口
  onSubtitleDetected(callback) {
    this.eventCallbacks.onSubtitleDetected = callback;
    
    // 為兩種模式註冊回調，但只有活躍模式會觸發
    if (this.domMonitor) {
      this.domMonitor.onSubtitleDetected((subtitleData) => {
        if (this.currentMode === 'dom' && callback) {
          const normalizedData = this.normalizeSubtitleData(subtitleData, 'dom');
          this.lastSubtitleData = normalizedData;
          callback(normalizedData);
        }
      });
    }
    
    if (this.interceptor) {
      this.interceptor.onSubtitleDetected((subtitleData) => {
        if (this.currentMode === 'intercept' && callback) {
          const normalizedData = this.normalizeSubtitleData(subtitleData, 'intercept');
          this.lastSubtitleData = normalizedData;
          callback(normalizedData);
        }
      });
    }
  }

  // 統一字幕數據格式
  normalizeSubtitleData(subtitleData, mode) {
    const primaryLanguageCode = mode === 'intercept' && subtitleData.dualSubtitle?.primaryLanguage
      ? subtitleData.dualSubtitle.primaryLanguage
      : this.primaryLanguage;
    const apiLanguageCode = toAPILanguageCode(primaryLanguageCode);
    const originalSubtitle = subtitleData.original || subtitleData.text || '';
    const videoId = subtitleData.videoId || getVideoId();
    const timestamp = subtitleData.timestamp ?? Date.now();
    const slotKey = buildSlotKey({
      videoID: videoId,
      originalSubtitle,
      languageCode: apiLanguageCode,
      timestamp
    });

    const normalized = {
      // 基本字幕信息
      text: subtitleData.text || '',
      htmlContent: subtitleData.htmlContent || subtitleData.text || '',
      
      // 位置信息
      position: subtitleData.position || { top: 0, left: 0, width: 0, height: 0 },
      
      // 時間信息
      timestamp,
      
      // 模式信息
      mode: mode,
      
      // 視頻信息
      videoId,

      // slot 識別資訊
      original: originalSubtitle,
      languageCode: apiLanguageCode,
      slotKey: slotKey,
      
      // 雙語字幕數據（僅攔截模式支持）
      isDualSubtitle: mode === 'intercept' && subtitleData.dualSubtitle,
      dualSubtitleData: mode === 'intercept' ? subtitleData.dualSubtitle : null,
      
      // 原始數據（調試用）
      originalData: this.debug ? subtitleData : null
    };
    
    this.log('標準化字幕數據:', normalized);
    return normalized;
  }

  // 模式錯誤處理和自動降級
  async handleModeFailure(error) {
    console.warn(`當前模式 ${this.currentMode} 出現錯誤:`, error);
    
    if (this.currentMode === 'intercept') {
      this.interceptFailureCount++;
      this.modeHealth = 'intercept_degraded_retrying';
      this.lastSoftFailureReason = error?.message || String(error);
      this.startBackgroundUpgrade({ reason: this.lastSoftFailureReason });

      if (this.interceptFailureCount >= this.maxInterceptFailuresBeforeDom) {
        await this.enterDomEmergency(`intercept-failed-${this.interceptFailureCount}-times`, error);
      }
    } else if (!this.currentMode) {
      this.interceptFailureCount++;
      this.modeHealth = 'intercept_degraded_retrying';
      this.lastSoftFailureReason = error?.message || String(error);
      await this.enterDomEmergency('initial-intercept-unavailable', error);
    } else {
      console.error('DOM 監聽模式也失效，這是嚴重錯誤');
      
      // 觸發錯誤回調
      if (this.eventCallbacks.onError) {
        this.eventCallbacks.onError(error);
      }
    }
  }

  // 手動模式切換（供調試用）
  async switchMode(targetMode) {
    if (!['dom', 'intercept'].includes(targetMode)) {
      throw new Error(`不支持的模式: ${targetMode}`);
    }
    
    this.log(`手動切換到模式: ${targetMode}`);
    await this.setMode(targetMode);
  }

  // 獲取當前狀態
  getStatus() {
    return {
      currentMode: this.currentMode,
      modeHealth: this.modeHealth,
      isInitialized: this.isInitialized,
      availableModes: ['dom', 'intercept'],
      lastCheck: new Date().toISOString(),
      lastModeDecision: this.lastModeDecision,
      lastSoftFailureReason: this.lastSoftFailureReason,
      lastDomEmergencyReason: this.lastDomEmergencyReason,
      interceptFailureCount: this.interceptFailureCount,
      backgroundUpgrade: { ...this.backgroundUpgradeState },
      lastSubtitle: this.lastSubtitleData ? {
        text: this.lastSubtitleData.text.substring(0, 50) + '...',
        timestamp: this.lastSubtitleData.timestamp,
        mode: this.lastSubtitleData.mode
      } : null,
      interceptor: this.interceptor?.getStatus ? this.interceptor.getStatus() : null
    };
  }

  // 註冊事件回調
  onModeChanged(callback) {
    this.eventCallbacks.onModeChanged = callback;
  }

  onError(callback) {
    this.eventCallbacks.onError = callback;
  }

  // 清理資源
  async cleanup() {
    this.log('清理字幕協調器資源...');

    this.stopBackgroundUpgrade('cleanup');
    
    if (this.currentMode) {
      await this.stopCurrentMode();
    }
    
    if (this.domMonitor) {
      this.domMonitor.cleanup();
    }
    
    if (this.interceptor) {
      this.interceptor.cleanup();
    }
    
    this.isInitialized = false;
    this.currentMode = null;
    this.eventCallbacks = {};
    
    this.log('字幕協調器資源清理完成');
  }

  // 私有方法
  async stopCurrentMode() {
    this.log(`停用模式: ${this.currentMode}`);
    
    try {
      if (this.currentMode === 'dom' && this.domMonitor) {
        this.domMonitor.stop();
      } else if (this.currentMode === 'intercept' && this.interceptor) {
        this.interceptor.stop();
      }
    } catch (error) {
      console.warn(`停用模式 ${this.currentMode} 時出錯:`, error);
    }
  }

  async startCurrentMode() {
    this.log(`啟用模式: ${this.currentMode}`);
    
    try {
      if (this.currentMode === 'dom' && this.domMonitor) {
        this.domMonitor.start();
      } else if (this.currentMode === 'intercept' && this.interceptor) {
        this.interceptor.start();
      } else if (this.currentMode === 'intercept' && !this.interceptor) {
        throw new Error('攔截器尚未初始化');
      }
    } catch (error) {
      console.error(`啟用模式 ${this.currentMode} 失敗:`, error);
      
      // 如果啟用失敗，嘗試自動降級
      if (this.currentMode === 'intercept') {
        await this.handleModeFailure(error);
      } else {
        throw error; // DOM 模式失敗是致命錯誤
      }
    }
  }


  /**
   * 啟動背景攔截器升級重試
   */
  startBackgroundUpgrade(options = {}) {
    if (this.backgroundRetryTimer) {
      clearInterval(this.backgroundRetryTimer);
    }

    this.log('啟動背景攔截器重試...', options.reason);
    
    const RETRY_INTERVAL = 2000;    // 避免 SPA 切換期間重疊打 Netflix API
    const MAX_RETRY_TIME = 120000;  // DOM emergency 期間持續嘗試 2 分鐘
    const MAX_ATTEMPTS = 60;
    
    let attempts = 0;
    const startTime = Date.now();
    this.backgroundUpgradeState = {
      active: true,
      attempts: 0,
      reason: options.reason || null,
      startedAt: startTime,
      lastResult: null
    };
    
    this.backgroundRetryTimer = setInterval(async () => {
      if (this.backgroundRetryInFlight) {
        return;
      }

      attempts++;
      const elapsed = Date.now() - startTime;
      this.backgroundUpgradeState.attempts = attempts;
      
      // 超時或達到最大次數則停止
      if (elapsed > MAX_RETRY_TIME || attempts > MAX_ATTEMPTS) {
        this.stopBackgroundUpgrade('retry-timeout');
        this.modeHealth = this.currentMode === 'dom' ? 'dom_emergency' : 'intercept_degraded_retrying';
        this.log('背景重試已停止，繼續使用DOM模式');
        return;
      }
      
      try {
        this.backgroundRetryInFlight = true;
        const result = await this.tryRecoverInterceptMode();
        this.backgroundUpgradeState.lastResult = result;
      } catch (error) {
        this.backgroundUpgradeState.lastResult = {
          success: false,
          reason: 'retry-error',
          error: error.message,
          timestamp: Date.now()
        };
        // 靜默處理錯誤，不打擾用戶
      } finally {
        this.backgroundRetryInFlight = false;
      }
    }, RETRY_INTERVAL);
  }

  stopBackgroundUpgrade(reason = 'stopped') {
    if (this.backgroundRetryTimer) {
      clearInterval(this.backgroundRetryTimer);
      this.backgroundRetryTimer = null;
    }

    this.backgroundRetryInFlight = false;
    this.backgroundUpgradeState = {
      ...this.backgroundUpgradeState,
      active: false,
      stoppedAt: Date.now(),
      stopReason: reason
    };
  }

  /**
   * 檢查播放器是否準備就緒
   */
  async checkPlayerReady() {
    const decision = await this.modeDetector.detectInterceptModeStatus();
    this.lastModeDecision = decision;
    return decision.status === 'ready';
  }

  async tryRecoverInterceptMode() {
    const decision = await this.modeDetector.detectInterceptModeStatus();
    this.lastModeDecision = decision;

    if (decision.status === 'hard_fail') {
      this.modeHealth = this.currentMode === 'dom' ? 'dom_emergency' : 'intercept_degraded_retrying';
      return {
        success: false,
        reason: decision.reason,
        status: decision.status,
        timestamp: Date.now()
      };
    }

    if (decision.status === 'soft_not_ready') {
      this.modeHealth = this.currentMode === 'dom' ? 'dom_emergency' : 'intercept_warming_up';
      this.lastSoftFailureReason = decision.reason;
      return {
        success: false,
        reason: decision.reason,
        status: decision.status,
        timestamp: Date.now()
      };
    }

    await this.silentUpgradeToInterceptor();
    return {
      success: this.currentMode === 'intercept',
      reason: 'intercept-ready',
      status: decision.status,
      timestamp: Date.now()
    };
  }

  /**
   * 靜默升級到攔截器模式
   */
  async silentUpgradeToInterceptor() {
    try {
      this.log('開始靜默升級到攔截器模式...');

      await this.ensureInterceptorInitialized();
      
      // 載入字幕數據
      await this.interceptor.loadInterceptedSubtitles();

      this.modeHealth = 'intercept_ready';
      this.interceptFailureCount = 0;
      this.lastDomEmergencyReason = null;
      this.stopBackgroundUpgrade('intercept-recovered');
      await this.setMode('intercept');
      this.log('靜默升級完成，已回到攔截模式');
      
    } catch (error) {
      this.modeHealth = this.currentMode === 'dom' ? 'dom_emergency' : 'intercept_degraded_retrying';
      this.lastSoftFailureReason = error.message;
      this.log('靜默升級失敗，繼續等待下一輪重試:', error.message);
      throw error;
    }
  }

  async ensureInterceptorInitialized() {
    if (!this.interceptor) {
      const { SubtitleInterceptor } = await import('./subtitle-interceptor.js');
      this.interceptor = new SubtitleInterceptor();
    }

    if (!this.interceptor.isInitialized) {
      await this.interceptor.initialize();
    }

    this.attachInterceptorCallback();
  }

  attachInterceptorCallback() {
    if (!this.interceptor || !this.eventCallbacks.onSubtitleDetected) {
      return;
    }

    this.interceptor.onSubtitleDetected((subtitleData) => {
      if (this.currentMode === 'intercept' && this.eventCallbacks.onSubtitleDetected) {
        const normalizedData = this.normalizeSubtitleData(subtitleData, 'intercept');
        this.lastSubtitleData = normalizedData;
        this.eventCallbacks.onSubtitleDetected(normalizedData);
      }
    });
  }

  async enterDomEmergency(reason, error = null) {
    this.modeHealth = 'dom_emergency';
    this.lastDomEmergencyReason = reason;
    this.lastSoftFailureReason = error?.message || this.lastSoftFailureReason;
    this.startBackgroundUpgrade({ reason });

    await this.setMode('dom');

    if (this.uiManager && this.uiManager.toastManager) {
      this.uiManager.toastManager.show('攔截模式暫時不可用，已啟用緊急字幕模式並持續重試', 'warning');
    }
  }

  // 設置事件處理器
  setupEventHandlers() {
    // 事件處理器（預留給未來擴展）
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleCoordinator] ${message}`, ...args);
    }
  }
}

// 導出類
export { SubtitleCoordinator };
