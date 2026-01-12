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

class SubtitleCoordinator {
  constructor() {
    this.modeDetector = null;
    this.domMonitor = null;
    this.interceptor = null;
    this.currentMode = null;
    this.uiManager = null;
    this.isInitialized = false;
    this.backgroundRetryTimer = null; // 背景重試計時器
    this.eventCallbacks = {
      onSubtitleDetected: null,
      onModeChanged: null,
      onError: null
    };
    
    // 調試模式（從 ConfigBridge 讀取）
    this.debug = false;
    this.lastSubtitleData = null;
  }

  async initialize(uiManager) {
    this.log('字幕協調器初始化中...');
    this.uiManager = uiManager;

    try {
      // 獲取 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取 debugMode 配置
      this.debug = configBridge.get('debugMode');
      this.log(`調試模式: ${this.debug}`);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log('調試模式已更新:', newValue);
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
        console.warn('攔截器初始化失敗，將使用 DOM 監聽模式:', error.message);
        this.interceptor = null; // 標記為不可用
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
      // 如果攔截器不可用，直接使用 DOM 模式
      if (!this.interceptor) {
        this.log('攔截器不可用，直接使用 DOM 監聽模式');
        await this.setMode('dom');
        return;
      }
      
      // 使用模式檢測器決定最佳模式
      const optimalMode = await this.modeDetector.detectOptimalMode();
      this.log(`檢測到最佳模式: ${optimalMode}`);
      
      // 設置模式並啟動
      await this.setMode(optimalMode);
      
    } catch (error) {
      console.error('模式選擇失敗，使用安全後備模式:', error);
      await this.setMode('dom'); // 安全後備到 DOM 監聽模式
    }
  }

  async setMode(mode) {
    if (this.currentMode === mode) {
      this.log(`模式 ${mode} 已經是當前模式，跳過切換`);
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
    const normalized = {
      // 基本字幕信息
      text: subtitleData.text || '',
      htmlContent: subtitleData.htmlContent || subtitleData.text || '',
      
      // 位置信息
      position: subtitleData.position || { top: 0, left: 0, width: 0, height: 0 },
      
      // 時間信息
      timestamp: subtitleData.timestamp || Date.now(),
      
      // 模式信息
      mode: mode,
      
      // 視頻信息
      videoId: subtitleData.videoId || getVideoId(),
      
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
      this.log('攔截模式失效，自動降級到 DOM 監聽模式');
      await this.setMode('dom');
      
      // 通知用戶模式已降級
      if (this.uiManager && this.uiManager.toastManager) {
        this.uiManager.toastManager.show('攔截模式不可用，已切換到穩定模式', 'warning');
      }
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
      isInitialized: this.isInitialized,
      availableModes: ['dom', 'intercept'],
      lastCheck: new Date().toISOString(),
      lastSubtitle: this.lastSubtitleData ? {
        text: this.lastSubtitleData.text.substring(0, 50) + '...',
        timestamp: this.lastSubtitleData.timestamp,
        mode: this.lastSubtitleData.mode
      } : null
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
        // 攔截器不可用，自動降級
        this.log('攔截器不可用，自動降級到 DOM 監聽模式');
        await this.setMode('dom');
        return;
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
  startBackgroundUpgrade() {
    if (this.backgroundRetryTimer) {
      clearInterval(this.backgroundRetryTimer);
    }

    this.log('啟動背景攔截器重試...');
    
    const RETRY_INTERVAL = 1000;    // 每秒重試
    const MAX_RETRY_TIME = 30000;   // 30秒後停止
    const MAX_ATTEMPTS = 30;        // 最多30次
    
    let attempts = 0;
    const startTime = Date.now();
    
    this.backgroundRetryTimer = setInterval(async () => {
      attempts++;
      const elapsed = Date.now() - startTime;
      
      // 超時或達到最大次數則停止
      if (elapsed > MAX_RETRY_TIME || attempts > MAX_ATTEMPTS) {
        clearInterval(this.backgroundRetryTimer);
        this.backgroundRetryTimer = null;
        this.log('背景重試已停止，繼續使用DOM模式');
        return;
      }
      
      try {
        if (await this.checkPlayerReady()) {
          clearInterval(this.backgroundRetryTimer);
          this.backgroundRetryTimer = null;
          this.log('播放器準備就緒，開始靜默升級');
          await this.silentUpgradeToInterceptor();
        }
      } catch (error) {
        // 靜默處理錯誤，不打擾用戶
      }
    }, RETRY_INTERVAL);
  }

  /**
   * 檢查播放器是否準備就緒
   */
  async checkPlayerReady() {
    const { sendMessageToPageScript } = await import('../system/messaging.js');
    
    const result = await sendMessageToPageScript({
      type: 'GET_AVAILABLE_LANGUAGES'
    });
    
    const languages = result?.languages || [];
    return languages.length > 0;  // 有語言列表 = 可以攔截字幕
  }

  /**
   * 靜默升級到攔截器模式
   */
  async silentUpgradeToInterceptor() {
    try {
      this.log('開始靜默升級到攔截器模式...');
      
      // 動態導入攔截器
      const { SubtitleInterceptor } = await import('./subtitle-interceptor.js');
      this.interceptor = new SubtitleInterceptor();
      
      // 初始化攔截器
      await this.interceptor.initialize();
      
      // 重要：連接字幕檢測回調
      if (this.eventCallbacks.onSubtitleDetected) {
        this.interceptor.onSubtitleDetected((subtitleData) => {
          if (this.currentMode === 'intercept' && this.eventCallbacks.onSubtitleDetected) {
            const normalizedData = this.normalizeSubtitleData(subtitleData, 'intercept');
            this.lastSubtitleData = normalizedData;
            this.eventCallbacks.onSubtitleDetected(normalizedData);
          }
        });
      }
      
      // 載入字幕數據
      await this.interceptor.loadInterceptedSubtitles();
      
      // 檢查是否真的準備好了
      if (this.interceptor.primarySubtitles && this.interceptor.primarySubtitles.length > 0) {
        // 無縫切換到攔截器模式
        await this.setMode('intercept');
        this.log('靜默升級完成！現在支援雙語字幕');
      } else {
        throw new Error('攔截器字幕數據無效');
      }
      
    } catch (error) {
      this.log('靜默升級失敗，繼續使用DOM模式:', error.message);
      // 清理失敗的攔截器
      this.interceptor = null;
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