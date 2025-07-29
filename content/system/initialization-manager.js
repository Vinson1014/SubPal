/**
 * 初始化管理器
 * 
 * 統一管理 SubPal 的初始化流程，確保所有依賴項按正確順序準備就緒
 * 解決 Page Script 注入、Netflix API 可用性、模式選擇等問題
 */

import { sendMessage, registerInternalEventHandler, requestPageScriptInjection, waitForPageScript } from './messaging.js';
import { getVideoId } from '../core/video-info.js';

class InitializationManager {
  constructor() {
    this.isInitialized = false;
    this.initializationSteps = [];
    this.currentStep = 0;
    this.debug = true;
    
    // 初始化狀態
    this.state = {
      messagingReady: false,
      pageScriptInjected: false,
      netflixAPIAvailable: false,
      configLoaded: false,
      componentsReady: false
    };
    
    // 組件實例
    this.components = {
      uiManager: null,
      subtitleStyleManager: null,
      subtitleCoordinator: null,
      dualSubtitleConfig: null
    };
    
    // 初始化步驟定義
    this.defineInitializationSteps();
  }

  /**
   * 定義初始化步驟
   */
  defineInitializationSteps() {
    this.initializationSteps = [
      {
        name: 'messaging',
        description: '初始化消息傳遞系統',
        handler: this.initializeMessaging.bind(this),
        timeout: 2000,
        retryable: true
      },
      {
        name: 'pageScript',
        description: '注入和初始化 Page Script',
        handler: this.initializePageScript.bind(this),
        timeout: 5000,
        retryable: true
      },
      {
        name: 'waitForPlayback',
        description: '等待用戶進入播放頁面',
        handler: this.waitForPlaybackPage.bind(this),
        timeout: 0, // 無限等待
        retryable: false
      },
      {
        name: 'netflixAPI',
        description: '檢查 Netflix API、初始化播放器助手並立即啟動攔截器',
        handler: this.checkNetflixAPI.bind(this),
        timeout: 8000,
        retryable: true
      },
      {
        name: 'configuration',
        description: '載入配置和設置',
        handler: this.loadConfiguration.bind(this),
        timeout: 2000,
        retryable: true
      },
      {
        name: 'components',
        description: '初始化核心組件',
        handler: this.initializeComponents.bind(this),
        timeout: 5000,
        retryable: false
      },
      {
        name: 'integration',
        description: '整合和啟動系統',
        handler: this.integrateAndStart.bind(this),
        timeout: 2000,
        retryable: false
      }
    ];
  }

  /**
   * 開始初始化流程（並行優化版）
   */
  async initialize() {
    if (this.isInitialized) {
      this.log('初始化管理器已初始化');
      return true;
    }

    this.log('開始並行初始化流程...');
    
    try {
      // 階段 1: 初始化消息傳遞系統（必須先完成）
      this.log('階段 1: 初始化消息傳遞系統');
      const messagingStep = this.initializationSteps[0];
      const messagingSuccess = await this.executeStep(messagingStep);
      if (!messagingSuccess) {
        throw new Error('消息傳遞系統初始化失敗');
      }
      
      // 階段 2: 並行執行 pageScript 和 configuration
      this.log('階段 2: 並行執行 pageScript 和 configuration');
      const pageScriptStep = this.initializationSteps[1];
      const configStep = this.initializationSteps[4]; // configuration 現在是第5步
      
      const [pageScriptSuccess, configSuccess] = await Promise.all([
        this.executeStep(pageScriptStep),
        this.executeStep(configStep)
      ]);
      
      if (!pageScriptSuccess) {
        throw new Error('Page Script 初始化失敗');
      }
      if (!configSuccess) {
        throw new Error('配置載入失敗');
      }
      
      // 階段 3: 等待播放頁面（依賴 netflixAPI）
      this.log('階段 3: 等待播放頁面');
      const waitForPlaybackStep = this.initializationSteps[2];
      const waitForPlaybackSuccess = await this.executeStep(waitForPlaybackStep);
      if (!waitForPlaybackSuccess) {
        throw new Error('等待播放頁面失敗');
      }

      // 階段 4: 檢查 Netflix API（依賴 pageScript）
      this.log('階段 4: 檢查 Netflix API');
      const netflixAPIStep = this.initializationSteps[3];
      const netflixAPISuccess = await this.executeStep(netflixAPIStep);
      if (!netflixAPISuccess) {
        throw new Error('Netflix API 初始化失敗');
      }
      
      // 階段 5: 初始化組件（依賴 waitForPlayback 和 configuration）
      this.log('階段 5: 初始化組件');
      const componentsStep = this.initializationSteps[5];
      const componentsSuccess = await this.executeStep(componentsStep);
      if (!componentsSuccess) {
        throw new Error('組件初始化失敗');
      }
      
      // 階段 6: 整合和啟動（依賴 components）
      this.log('階段 6: 整合和啟動');
      const integrationStep = this.initializationSteps[6];
      const integrationSuccess = await this.executeStep(integrationStep);
      if (!integrationSuccess) {
        throw new Error('系統整合失敗');
      }
      
      this.isInitialized = true;
      this.log('並行初始化流程完成');
      return true;
      
    } catch (error) {
      console.error('並行初始化流程失敗:', error);
      this.handleInitializationFailure(error);
      return false;
    }
  }

  /**
   * 執行單個初始化步驟（優化重試策略）
   */
  async executeStep(step) {
    const maxRetries = step.retryable ? 2 : 1;  // 減少重試次數
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          this.log(`步驟 ${step.name} 重試 ${attempt}/${maxRetries}`);
        }
        
        // 使用 Promise.race 實現超時控制（除非 timeout 為 0）
        let result;
        if (step.timeout === 0) {
          // 無限等待，不設置超時
          result = await step.handler();
        } else {
          result = await Promise.race([
            step.handler(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('步驟超時')), step.timeout)
            )
          ]);
        }
        
        if (result) {
          this.log(`步驟 ${step.name} 成功`);
          return true;
        }
        
      } catch (error) {
        this.log(`步驟 ${step.name} 嘗試 ${attempt} 失敗:`, error.message);
        
        if (attempt === maxRetries) {
          throw error;
        }
        
        // 等待後重試
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
    
    return false;
  }

  /**
   * 步驟1: 初始化消息傳遞系統
   */
  async initializeMessaging() {
    this.log('初始化消息傳遞系統...');
    
    try {
      // 動態導入 messaging 模塊
      const messagingModule = await import('./messaging.js');
      
      // 初始化 messaging 系統
      if (messagingModule.initMessaging) {
        messagingModule.initMessaging();
      }
      
      // 等待調試模式設置載入
      await this.waitForDebugMode();
      
      this.state.messagingReady = true;
      return true;
      
    } catch (error) {
      console.error('初始化消息傳遞系統失敗:', error);
      throw error;
    }
  }

  /**
   * 步驟2: 注入和初始化 Page Script
   */
  async initializePageScript() {
    this.log('注入和初始化 Page Script...');
    
    try {
      // 請求注入 Page Script
      await requestPageScriptInjection();
      
      // 等待 Page Script 可用
      await waitForPageScript(5000);
      
      // 檢查 Page Script 是否正確注入
      if (!window.subpalPageScript) {
        throw new Error('Page Script 注入失敗');
      }
      
      this.log('Page Script 注入成功');
      this.state.pageScriptInjected = true;
      return true;
      
    } catch (error) {
      console.error('Page Script 初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 步驟3: 檢查 Netflix API 可用性並初始化播放器助手
   */
  async checkNetflixAPI() {
    this.log('檢查 Netflix API 可用性並初始化播放器助手...');
    
    try {
      // 動態導入 sendMessageToPageScript
      const { sendMessageToPageScript } = await import('./messaging.js');
      
      // 檢查 Netflix API 可用性
      const apiResult = await sendMessageToPageScript({
        type: 'CHECK_API_AVAILABILITY'
      });
      
      if (!apiResult.success || !apiResult.available) {
        throw new Error('Netflix API 不可用');
      }
      
      this.log('Netflix API 可用性檢查通過');
      
      // 初始化播放器助手
      this.log('初始化播放器助手...');
      const playerResult = await sendMessageToPageScript({
        type: 'INITIALIZE_PLAYER_HELPER'
      });
      
      if (!playerResult.success) {
        throw new Error(playerResult.error || '播放器助手初始化失敗');
      }
      
      this.log('播放器助手初始化成功');
      
      // 立即啟動字幕攔截器（在攔截預設字幕之前）
      this.log('立即啟動字幕攔截器...');
      const interceptorResult = await sendMessageToPageScript({
        type: 'INITIALIZE_SUBTITLE_INTERCEPTOR'
      });
      
      if (!interceptorResult.success) {
        console.warn('字幕攔截器啟動失敗:', interceptorResult.error);
        // 不拋出錯誤，因為字幕攔截器不是必需的
      } else {
        this.log('字幕攔截器已啟動，開始攔截所有Netflix CDN請求');
      }
      
      this.state.netflixAPIAvailable = true;
      return true;
      
    } catch (error) {
      console.error('Netflix API 和播放器助手初始化失敗:', error);
      
      // 等待頁面加載完成後重試
      if (error.message.includes('不可用') || error.message.includes('未初始化')) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        throw new Error('Netflix API 仍不可用，請重試');
      }
      
      throw error;
    }
  }

  /**
   * 步驟4: 等待用戶進入播放頁面
   */
  async waitForPlaybackPage() {
    // 設置視頻監控
    this.setupVideoMonitoring();
    
    this.log('等待用戶進入播放頁面...');
    this.log('💡 您可以繼續瀏覽Netflix，當您開始播放影片時，SubPal將自動啟動');
    
    return new Promise((resolve) => {
      const checkVideoId = () => {
        const videoId = getVideoId();
        if (videoId && videoId !== 'unknown') {
          this.log(`✅ 檢測到有效 videoID: ${videoId}，繼續初始化`);
          this.log('🎬 SubPal 正在為您準備字幕功能...');
          resolve(videoId);
        } else {
          // 每秒檢查一次
          setTimeout(checkVideoId, 1000);
        }
      };
      checkVideoId();
    });
  }

  /**
   * 步驟5: 載入配置和設置
   */
  async loadConfiguration() {
    this.log('載入配置和設置...');
    
    try {
      // 載入調試模式設置
      await this.loadDebugMode();
      
      // 初始化雙語字幕配置
      const { dualSubtitleConfig } = await import('../config/dual-subtitle-config.js');
      await dualSubtitleConfig.initialize();
      this.components.dualSubtitleConfig = dualSubtitleConfig;
      
      this.log('配置載入完成');
      this.state.configLoaded = true;
      return true;
      
    } catch (error) {
      console.error('配置載入失敗:', error);
      throw error;
    }
  }

  /**
   * 步驟6: 初始化核心組件
   */
  async initializeComponents() {
    this.log('初始化核心組件...');
    
    try {
      // 初始化 UI 管理器
      const { UIManager } = await import('../ui/ui-manager-new.js');
      this.components.uiManager = new UIManager();
      await this.components.uiManager.initialize();
      
      // 初始化字幕樣式管理器
      await this.initializeSubtitleStyleManager();
      
      // 初始化字幕協調器
      const { SubtitleCoordinator } = await import('../subtitle-modes/subtitle-coordinator.js');
      this.components.subtitleCoordinator = new SubtitleCoordinator();
      
      // 使用新的安全初始化方法
      await this.initializeSubtitleCoordinatorSafely();
      
      this.log('核心組件初始化完成');
      this.state.componentsReady = true;
      return true;
      
    } catch (error) {
      console.error('核心組件初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 初始化字幕樣式管理器
   */
  async initializeSubtitleStyleManager() {
    this.log('初始化字幕樣式管理器...');
    
    try {
      const { SubtitleStyleManager } = await import('../ui/subtitle-style-manager.js');
      this.components.subtitleStyleManager = new SubtitleStyleManager();
      
      // 使用依賴注入模式，傳入現有的 UIManager 實例
      await this.components.subtitleStyleManager.initialize(this.components.uiManager);
      
      this.log('字幕樣式管理器初始化完成');
      
    } catch (error) {
      console.error('字幕樣式管理器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 安全初始化字幕協調器
   */
  async initializeSubtitleCoordinatorSafely() {
    this.log('安全初始化字幕協調器...');
    
    const coordinator = this.components.subtitleCoordinator;
    
    // 設置基本狀態
    coordinator.uiManager = this.components.uiManager;
    
    // 載入調試模式設置
    await coordinator.loadDebugMode();
    
    // 設置事件處理器
    coordinator.setupEventHandlers();
    
    // 動態導入模式檢測器
    const { ModeDetector } = await import('../subtitle-modes/mode-detector.js');
    coordinator.modeDetector = new ModeDetector();
    await coordinator.modeDetector.initialize();
    
    // 動態導入兩種模式
    const { DOMMonitor } = await import('../subtitle-modes/dom-monitor.js');
    const { SubtitleInterceptor } = await import('../subtitle-modes/subtitle-interceptor.js');
    
    coordinator.domMonitor = new DOMMonitor();
    coordinator.interceptor = new SubtitleInterceptor();
    
    // 初始化 DOM 監聽模式（總是可用）
    await coordinator.domMonitor.initialize();
    
    // 快速檢查攔截器可用性（不超過3秒）
    try {
      const interceptorReady = await this.quickInterceptorCheck();
      if (interceptorReady) {
        await coordinator.interceptor.initialize();
        this.log('攔截器快速檢查成功，初始化完成');
        await coordinator.selectOptimalMode();
      } else {
        throw new Error('播放器未準備就緒');
      }
    } catch (error) {
      this.log('攔截器快速檢查失敗，使用DOM模式並啟動背景重試:', error.message);
      coordinator.interceptor = null;
      
      // 立即啟動 DOM 模式
      await coordinator.setMode('dom');
      
      // 啟動背景攔截器重試
      coordinator.startBackgroundUpgrade();
    }
    
    coordinator.isInitialized = true;
    this.log(`字幕協調器初始化完成，使用模式: ${coordinator.currentMode}`);
    
    // 通知 UI 管理器模式已選定
    if (this.components.uiManager && this.components.uiManager.onModeSelected) {
      this.components.uiManager.onModeSelected(coordinator.currentMode);
    }
  }

  /**
   * 步驟7: 整合和啟動系統
   */
  async integrateAndStart() {
    this.log('整合和啟動系統...');
    
    try {
      // 設置組件間的事件流
      this.setupEventFlow();
      
      
      // 通知初始化完成
      this.notifyInitializationComplete();
      
      this.log('系統整合和啟動完成');
      return true;
      
    } catch (error) {
      console.error('系統整合失敗:', error);
      throw error;
    }
  }

  /**
   * 設置組件間的事件流
   */
  setupEventFlow() {
    this.log('設置組件間事件流...');
    
    const { uiManager, subtitleCoordinator } = this.components;
    
    // 字幕檢測事件流
    subtitleCoordinator.onSubtitleDetected(async (subtitleData) => {
      try {
        // 處理字幕替換（如果需要）
        const processedSubtitle = await this.processSubtitleReplacement(subtitleData);
        
        // 顯示字幕
        if (processedSubtitle && processedSubtitle.text) {
          uiManager.showSubtitle(processedSubtitle);
        } else {
          uiManager.hideSubtitle();
        }
        
      } catch (error) {
        console.error('處理字幕時出錯:', error);
        
        // 降級顯示原始字幕
        if (subtitleData && subtitleData.text) {
          uiManager.showSubtitle(subtitleData);
        }
      }
    });
    
    // 模式變更事件流
    subtitleCoordinator.onModeChanged((mode) => {
      this.log(`字幕模式已變更: ${mode}`);
      uiManager.onModeSelected(mode);
    });
    
    // 錯誤處理事件流
    subtitleCoordinator.onError((error) => {
      console.error('字幕協調器錯誤:', error);
      this.handleSubtitleError(error);
    });
  }

  /**
   * 設置視頻監控
   */
  setupVideoMonitoring() {
    this.log('設置視頻監控...');
    
    // 導入視頻信息模塊
    import('../core/video-info.js').then(async ({ getVideoId, initVideoInfo }) => {
      await initVideoInfo();
      
      let currentVideoId = getVideoId();
      
      // 定期檢查視頻 ID 變化
      setInterval(() => {
        const newVideoId = getVideoId();
        if (newVideoId && newVideoId !== currentVideoId) {
          this.log(`視頻切換: ${currentVideoId} -> ${newVideoId}`);
          currentVideoId = newVideoId;
          this.handleVideoChange(newVideoId);
        }
      }, 3000);
    });
  }

  /**
   * 處理字幕替換
   */
  async processSubtitleReplacement(subtitleData) {
    // 簡化版本，如果需要可以重新實現
    return subtitleData;
  }

  /**
   * 處理視頻切換
   */
  handleVideoChange(newVideoId) {
    this.log(`處理視頻切換: ${newVideoId}`);
    
    // 清理當前字幕顯示
    this.components.uiManager.hideSubtitle();
    
    // 通知字幕協調器重新選擇模式
    if (this.components.subtitleCoordinator) {
      this.components.subtitleCoordinator.selectOptimalMode();
    }
  }

  /**
   * 處理字幕錯誤
   */
  handleSubtitleError(error) {
    console.error('字幕處理錯誤:', error);
    // 可以實現錯誤恢復邏輯
  }

  /**
   * 通知初始化完成
   */
  notifyInitializationComplete() {
    sendMessage({
      type: 'CONTENT_SCRIPT_READY',
      timestamp: Date.now(),
      features: {
        subtitleReplacement: true,
        dualSubtitle: true,
        vote: true,
        translation: true
      }
    }).catch(error => {
      console.warn('通知後台初始化完成失敗:', error);
    });
  }

  /**
   * 等待調試模式設置
   */
  async waitForDebugMode() {
    try {
      const result = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['debugMode']
      });
      
      if (result && result.debugMode !== undefined) {
        this.debug = result.debugMode;
        this.log(`調試模式: ${this.debug}`);
      }
    } catch (error) {
      console.error('載入調試模式設置失敗:', error);
    }
  }

  /**
   * 載入調試模式設置
   */
  async loadDebugMode() {
    await this.waitForDebugMode();
  }

  /**
   * 處理初始化失敗
   */
  handleInitializationFailure(error) {
    console.error('初始化失敗，進入降級模式:', error);
    
    // 可以實現降級邏輯，比如只使用基本功能
    this.log('嘗試降級模式初始化...');
    
    // 至少嘗試初始化 DOM 監聽模式
    this.initializeFallbackMode().catch(fallbackError => {
      console.error('降級模式初始化也失敗:', fallbackError);
    });
  }

  /**
   * 初始化降級模式
   */
  async initializeFallbackMode() {
    this.log('初始化降級模式...');
    
    try {
      // 只初始化最基本的 DOM 監聽功能
      if (this.state.messagingReady) {
        const { DOMMonitor } = await import('../subtitle-modes/dom-monitor.js');
        const domMonitor = new DOMMonitor();
        await domMonitor.initialize();
        
        // 簡單的字幕顯示
        domMonitor.onSubtitleDetected((subtitleData) => {
          console.log('降級模式字幕:', subtitleData.text);
        });
        
        domMonitor.start();
        this.log('降級模式初始化成功');
      }
    } catch (error) {
      console.error('降級模式初始化失敗:', error);
    }
  }

  /**
   * 獲取初始化狀態
   */
  getInitializationState() {
    return {
      isInitialized: this.isInitialized,
      currentStep: this.currentStep,
      totalSteps: this.initializationSteps.length,
      currentStepName: this.initializationSteps[this.currentStep]?.name,
      state: { ...this.state },
      components: {
        uiManager: !!this.components.uiManager,
        subtitleStyleManager: !!this.components.subtitleStyleManager,
        subtitleCoordinator: !!this.components.subtitleCoordinator,
        dualSubtitleConfig: !!this.components.dualSubtitleConfig
      }
    };
  }

  /**
   * 獲取組件實例
   */
  getComponents() {
    return { ...this.components };
  }

  /**
   * 清理資源
   */
  async cleanup() {
    this.log('清理初始化管理器資源...');
    
    if (this.components.uiManager) {
      this.components.uiManager.cleanup();
    }
    
    if (this.components.subtitleStyleManager) {
      this.components.subtitleStyleManager.cleanup();
    }
    
    if (this.components.subtitleCoordinator) {
      await this.components.subtitleCoordinator.cleanup();
    }
    
    this.isInitialized = false;
    this.components = {};
    this.state = {};
    
    this.log('初始化管理器資源清理完成');
  }

  /**
   * 快速檢查攔截器是否可用（3秒內）
   */
  async quickInterceptorCheck() {
    try {
      // 3秒快速檢查
      const timeout = 3000;
      
      const checkPromise = this.checkPlayerReady();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('快速檢查超時')), timeout)
      );
      
      return await Promise.race([checkPromise, timeoutPromise]);
    } catch (error) {
      this.log('快速檢查失敗:', error.message);
      return false;
    }
  }

  /**
   * 檢查播放器是否準備就緒（簡化版）
   */
  async checkPlayerReady() {
    const { sendMessageToPageScript } = await import('./messaging.js');
    
    const result = await sendMessageToPageScript({
      type: 'GET_AVAILABLE_LANGUAGES'
    });
    
    const languages = result?.languages || [];
    return languages.length > 0;  // 有語言列表 = 可以攔截字幕
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[InitializationManager] ${message}`, ...args);
    }
  }
}

// 創建全局實例
const initializationManager = new InitializationManager();

// 導出
export { InitializationManager, initializationManager };