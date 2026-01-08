/**
 * SubPal 主入口文件 - 統一初始化管理版本
 * 
 * 設計理念：
 * 1. 統一的初始化流程管理
 * 2. 確保所有依賴項按正確順序準備就緒
 * 3. 解決 Page Script 注入和 Netflix API 可用性問題
 * 4. 提供完善的錯誤處理和降級機制
 */

import { initializationManager } from './system/initialization-manager.js';

class SubPalApp {
  constructor() {
    this.isInitialized = false;
    this.initializationManager = initializationManager;
    this.components = {};
    this.debug = false; // 將由 ConfigBridge 設置
  }

  async initialize() {
    this.log('SubPal 應用初始化中...');

    try {
      // 檢查環境
      if (!this.checkEnvironment()) {
        throw new Error('環境檢查失敗');
      }

      // 使用統一初始化管理器（已包含 ConfigBridge 初始化）
      const success = await this.initializationManager.initialize();

      if (!success) {
        throw new Error('統一初始化流程失敗');
      }

      // 獲取初始化的組件
      this.components = this.initializationManager.getComponents();

      // 從 ConfigBridge 讀取 debug mode
      // ConfigBridge 已經在 initialization-manager 中初始化
      const { configBridge } = await import('./system/config/config-bridge.js');
      this.debug = configBridge.get('debugMode');
      this.log(`調試模式設置為: ${this.debug}`);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (key, newValue, oldValue) => {
        this.debug = newValue;
        this.log(`調試模式已更新: ${oldValue} -> ${newValue}`);
      });

      this.isInitialized = true;
      this.log('SubPal 應用初始化完成');

      return true;

    } catch (error) {
      console.error('SubPal 應用初始化失敗:', error);
      this.handleInitializationError(error);
      throw error;
    }
  }

  // 檢查環境
  checkEnvironment() {
    this.log('檢查運行環境...');
    
    // 檢查是否在 Netflix 頁面
    if (!window.location.hostname.includes('netflix.com')) {
      console.warn('不在 Netflix 頁面上，SubPal 可能無法正常工作');
      return false;
    }
    
    // 檢查必要的 API
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      console.error('缺少必要的瀏覽器 API');
      return false;
    }
    
    this.log('環境檢查通過');
    return true;
  }

  // 獲取應用狀態
  getStatus() {
    const initState = this.initializationManager.getInitializationState();
    
    return {
      isInitialized: this.isInitialized,
      initializationState: initState,
      components: {
        uiManager: this.components.uiManager?.getStatus(),
        subtitleCoordinator: this.components.subtitleCoordinator?.getStatus(),
        dualSubtitleConfig: this.components.dualSubtitleConfig?.getStatus()
      }
    };
  }

  // 處理初始化錯誤
  handleInitializationError(error) {
    console.error('SubPal 初始化失敗:', error);
    
    // 獲取詳細的初始化狀態
    const initState = this.initializationManager.getInitializationState();
    console.log('初始化狀態:', initState);
    
    // 提供更詳細的錯誤信息
    if (initState.currentStepName) {
      console.log(`失敗於步驟: ${initState.currentStepName} (${initState.currentStep + 1}/${initState.totalSteps})`);
    }
    
    console.log('SubPal 將嘗試降級模式運行');
  }

  // 暫停應用
  pause() {
    this.log('暫停 SubPal 應用');
    
    if (this.components.uiManager) {
      this.components.uiManager.hideSubtitle();
    }
  }

  // 恢復應用
  resume() {
    this.log('恢復 SubPal 應用');
    
    // 可以重新啟動字幕協調器
    if (this.components.subtitleCoordinator) {
      this.components.subtitleCoordinator.selectOptimalMode();
    }
  }

  // 清理資源
  async cleanup() {
    this.log('清理 SubPal 應用資源...');
    
    // 使用初始化管理器的清理方法
    await this.initializationManager.cleanup();
    
    this.isInitialized = false;
    this.components = {};
    
    this.log('SubPal 應用資源清理完成');
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubPalApp] ${message}`, ...args);
    }
  }
}

// 創建全局應用實例
let subpalApp = null;

// 初始化函數
async function initializeSubPal() {
  if (subpalApp) {
    console.log('SubPal 已經初始化');
    return subpalApp;
  }
  
  try {
    subpalApp = new SubPalApp();
    await subpalApp.initialize();
    
    // 將應用實例掛載到全局（調試用）
    if (typeof window !== 'undefined') {
      window.subpalApp = subpalApp;
    }
    
    return subpalApp;
  } catch (error) {
    console.error('SubPal 初始化失敗:', error);
    subpalApp = null;
    throw error;
  }
}

// 主執行邏輯
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initializeSubPal, 1000); // 延遲1秒確保頁面加載完成
  });
} else {
  // 頁面已加載完成，延遲初始化
  setTimeout(initializeSubPal, 500);
}

// 導出供其他模塊使用
export { SubPalApp, initializeSubPal, subpalApp };