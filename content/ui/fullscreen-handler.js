/**
 * 全螢幕處理器組件 - 專責處理全螢幕模式的 UI 顯示
 * 
 * 設計理念：
 * 1. 專責化：只負責全螢幕模式的檢測和處理
 * 2. UI 協調：確保所有 UI 元素在全螢幕模式下正常顯示
 * 3. 事件驅動：通過回調函數與其他組件協調
 * 4. 兼容性：支持多種瀏覽器的全螢幕事件
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class FullscreenHandler {
  constructor() {
    this.isInitialized = false;
    this.isFullscreen = false;
    this.uiComponents = new Map(); // 存儲需要處理的 UI 組件
    this.eventCallbacks = {
      onFullscreenChange: null,
      onEnterFullscreen: null,
      onExitFullscreen: null
    };
    
    // 全螢幕事件名稱（不同瀏覽器支持）
    this.fullscreenEvents = [
      'fullscreenchange',
      'webkitfullscreenchange', 
      'mozfullscreenchange',
      'MSFullscreenChange'
    ];
    
    // 播放器選擇器（按優先級排序，參考舊版程式成功經驗）
    // 重要：使用 .watch-video 而非 .watch-video--player-view 以避免 #top-layer 遮蔽問題
    this.playerSelectors = [
      '.watch-video',                   // 舊版程式成功使用的選擇器
      '.watch-video--player-view',      // 新版Netflix（可能有 #top-layer 問題）
      '.NFPlayer', 
      'video', 
      '.VideoContainer', 
      '.nf-player-container', 
      '[data-uia="video-player"]',
      '[data-uia="player"]'
    ];
    
    // 調試模式
    this.debug = false;
    
    // 延遲處理定時器
    this.delayedCheckTimer = null;
  }

  async initialize() {
    this.log('全螢幕處理器初始化中...');
    
    try {
      // 載入調試模式設置
      await this.loadDebugMode();
      
      // 設置事件處理器
      this.setupEventHandlers();
      
      // 監聽全螢幕事件
      this.setupFullscreenEventListeners();
      
      // 初始檢測全螢幕狀態
      this.checkFullscreenStatus();
      
      this.isInitialized = true;
      this.log('全螢幕處理器初始化完成');
      
    } catch (error) {
      console.error('全螢幕處理器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 註冊需要處理的 UI 組件
   * @param {string} name - 組件名稱
   * @param {Object} component - 組件實例
   */
  registerUIComponent(name, component) {
    if (!component) {
      this.log(`無效的 UI 組件: ${name}`);
      return;
    }
    
    this.uiComponents.set(name, component);
    this.log(`註冊 UI 組件: ${name}`);
    
    // 如果已經在全螢幕模式，立即處理這個組件
    if (this.isFullscreen) {
      this.handleComponentInFullscreen(name, component);
    }
  }

  /**
   * 取消註冊 UI 組件
   * @param {string} name - 組件名稱
   */
  unregisterUIComponent(name) {
    if (this.uiComponents.has(name)) {
      this.uiComponents.delete(name);
      this.log(`取消註冊 UI 組件: ${name}`);
    }
  }

  /**
   * 設置全螢幕事件監聽器
   */
  setupFullscreenEventListeners() {
    this.fullscreenEvents.forEach(eventName => {
      document.addEventListener(eventName, () => {
        this.handleFullscreenChange();
      });
    });
    
    this.log('全螢幕事件監聽器設置完成');
  }

  /**
   * 檢測當前全螢幕狀態
   */
  checkFullscreenStatus() {
    const isCurrentlyFullscreen = !!(
      document.fullscreenElement || 
      document.webkitFullscreenElement || 
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
    
    this.isFullscreen = isCurrentlyFullscreen;
    this.log(`當前全螢幕狀態: ${this.isFullscreen}`);
    
    return this.isFullscreen;
  }

  /**
   * 處理全螢幕模式變更
   */
  handleFullscreenChange() {
    const previousState = this.isFullscreen;
    this.checkFullscreenStatus();
    
    this.log(`全螢幕模式變更: ${previousState} -> ${this.isFullscreen}`);
    
    if (previousState !== this.isFullscreen) {
      // 清除之前的延遲檢查定時器
      if (this.delayedCheckTimer) {
        clearTimeout(this.delayedCheckTimer);
      }
      
      // 立即處理 UI 組件
      this.handleAllUIComponents();
      
      // 延遲檢查，確保 UI 元素正確顯示
      this.delayedCheckTimer = setTimeout(() => {
        this.log('執行延遲檢查，確保 UI 元素正確顯示');
        this.handleAllUIComponents();
        this.performDelayedUICheck();
      }, 500);
      
      // 觸發回調
      this.triggerCallback('onFullscreenChange', this.isFullscreen);
      
      if (this.isFullscreen) {
        this.triggerCallback('onEnterFullscreen');
      } else {
        this.triggerCallback('onExitFullscreen');
      }
    }
  }

  /**
   * 處理所有註冊的 UI 組件
   */
  handleAllUIComponents() {
    this.log(`處理 ${this.uiComponents.size} 個 UI 組件`);
    
    for (const [name, component] of this.uiComponents) {
      try {
        this.handleComponentInFullscreen(name, component);
      } catch (error) {
        console.error(`處理 UI 組件 ${name} 時出錯:`, error);
      }
    }
    
    // 額外處理所有 SubPal 元素（包括組件之外的元素）
    this.handleAdditionalSubPalElements();
  }

  /**
   * 處理額外的 SubPal 元素（不在組件註冊中的元素）
   */
  handleAdditionalSubPalElements() {
    // 查找所有 SubPal 相關的元素
    const additionalSelectors = [
      '#subpal-region-container',
      '#subpal-toast-container',
      '#subpal-debug-overlay'
    ];
    
    additionalSelectors.forEach(selector => {
      const element = document.querySelector(selector);
      if (element) {
        this.log(`發現額外的 SubPal 元素: ${selector}`);
        this.handleElementInFullscreen(element, selector);
      }
    });
  }

  /**
   * 處理單個元素在全螢幕模式下的顯示
   * @param {HTMLElement} element - 要處理的元素
   * @param {string} elementName - 元素名稱
   */
  handleElementInFullscreen(element, elementName) {
    this.log(`處理元素: ${elementName}`);
    
    // 確保元素可見
    if (element.style.display === 'none') {
      element.style.display = 'block';
      this.log(`強制顯示元素 ${elementName}`);
    }
    
    // 重新附加到播放器內部
    this.ensureAttachedToPlayer(element, elementName);
    
    // 保持原有的定位方式
    this.log(`保持元素 ${elementName} 的定位方式: ${element.style.position}`);
    this.log(`元素 ${elementName} 全螢幕處理完成`);
  }

  /**
   * 處理單個 UI 組件在全螢幕模式下的顯示
   * @param {string} name - 組件名稱
   * @param {Object} component - 組件實例
   */
  handleComponentInFullscreen(name, component) {
    this.log(`處理 UI 組件: ${name}`);
    
    // 檢查組件是否有容器元素
    const container = this.getComponentContainer(component);
    if (!container) {
      this.log(`組件 ${name} 沒有容器元素，跳過處理`);
      return;
    }
    
    // 使用統一的元素處理方法
    this.handleElementInFullscreen(container, name);
    
    // 如果組件有特定的全螢幕處理方法，調用它
    if (typeof component.handleFullscreenChange === 'function') {
      component.handleFullscreenChange(this.isFullscreen);
    }
    
    this.log(`組件 ${name} 全螢幕處理完成`);
  }

  /**
   * 獲取組件的容器元素
   * @param {Object} component - 組件實例
   * @returns {HTMLElement|null} 容器元素
   */
  getComponentContainer(component) {
    // 嘗試多種方式獲取容器
    if (component.container) {
      return component.container;
    }
    
    if (component.getContainer && typeof component.getContainer === 'function') {
      return component.getContainer();
    }
    
    if (component.element) {
      return component.element;
    }
    
    // 如果組件有特定的容器 ID
    if (component.containerId) {
      return document.getElementById(component.containerId);
    }
    
    return null;
  }

  /**
   * 確保元素附加到播放器內部
   * @param {HTMLElement} element - 要附加的元素
   * @param {string} componentName - 組件名稱
   */
  ensureAttachedToPlayer(element, componentName) {
    const player = this.getPlayerElement();
    
    if (!player) {
      this.log(`找不到播放器元素，無法重新附加組件 ${componentName}`);
      this.log(`嘗試過的選擇器:`, this.playerSelectors);
      return;
    }
    
    this.log(`找到播放器元素: ${this.getPlayerSelector(player)} (${componentName})`);
    
    // 檢查元素是否已經在播放器內部
    if (player.contains(element)) {
      this.log(`組件 ${componentName} 已在播放器內部`);
      return;
    }
    
    this.log(`組件 ${componentName} 當前父元素: ${element.parentElement?.tagName || 'null'}`);
    
    // 如果元素當前有父元素，先移除
    if (element.parentElement) {
      element.parentElement.removeChild(element);
    }
    
    // 重新附加到播放器
    player.appendChild(element);
    this.log(`組件 ${componentName} 已重新附加到播放器`);
    
    // 保持原有的定位方式（不強制改為 absolute）
    // 根據舊版程式的經驗，fixed 定位在全螢幕模式下也能正常工作
    this.log(`保持組件 ${componentName} 的定位方式: ${element.style.position}`);
  }

  /**
   * 獲取播放器元素
   * @returns {HTMLElement|null} 播放器元素
   */
  getPlayerElement() {
    for (const selector of this.playerSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        this.log(`找到播放器元素: ${selector}`);
        return element;
      }
    }
    
    this.log('未找到播放器元素');
    return null;
  }

  /**
   * 獲取播放器元素使用的選擇器
   * @param {HTMLElement} player - 播放器元素
   * @returns {string} 選擇器
   */
  getPlayerSelector(player) {
    for (const selector of this.playerSelectors) {
      if (player.matches(selector)) {
        return selector;
      }
    }
    return 'unknown';
  }

  /**
   * 執行延遲 UI 檢查
   */
  performDelayedUICheck() {
    for (const [name, component] of this.uiComponents) {
      const container = this.getComponentContainer(component);
      
      if (container) {
        // 檢查容器是否正確顯示
        if (container.style.display === 'none') {
          this.log(`延遲檢查發現組件 ${name} 未正確顯示，強制設置為可見`);
          container.style.display = 'block';
          
          // 重新處理該組件
          this.handleComponentInFullscreen(name, component);
        }
        
        // 檢查容器是否在播放器內部
        const player = this.getPlayerElement();
        if (player && !player.contains(container)) {
          this.log(`延遲檢查發現組件 ${name} 不在播放器內部，重新附加`);
          this.ensureAttachedToPlayer(container, name);
        }
      }
    }
  }

  /**
   * 獲取當前全螢幕狀態
   * @returns {boolean} 是否處於全螢幕模式
   */
  isInFullscreen() {
    return this.isFullscreen;
  }

  /**
   * 獲取播放器狀態信息
   * @returns {Object} 狀態信息
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isFullscreen: this.isFullscreen,
      registeredComponents: Array.from(this.uiComponents.keys()),
      playerElement: !!this.getPlayerElement(),
      hasDelayedCheck: !!this.delayedCheckTimer
    };
  }

  /**
   * 註冊事件回調
   */
  onFullscreenChange(callback) {
    this.eventCallbacks.onFullscreenChange = callback;
    this.log('全螢幕變更回調已註冊');
  }

  onEnterFullscreen(callback) {
    this.eventCallbacks.onEnterFullscreen = callback;
    this.log('進入全螢幕回調已註冊');
  }

  onExitFullscreen(callback) {
    this.eventCallbacks.onExitFullscreen = callback;
    this.log('退出全螢幕回調已註冊');
  }

  /**
   * 觸發回調
   * @param {string} callbackName - 回調名稱
   * @param {*} data - 回調數據
   */
  triggerCallback(callbackName, data = null) {
    const callback = this.eventCallbacks[callbackName];
    if (callback && typeof callback === 'function') {
      this.log(`觸發回調: ${callbackName}`);
      callback(data);
    }
  }

  /**
   * 清理資源
   */
  cleanup() {
    this.log('清理全螢幕處理器資源...');
    
    // 清除延遲檢查定時器
    if (this.delayedCheckTimer) {
      clearTimeout(this.delayedCheckTimer);
      this.delayedCheckTimer = null;
    }
    
    // 移除事件監聽器
    this.fullscreenEvents.forEach(eventName => {
      document.removeEventListener(eventName, this.handleFullscreenChange);
    });
    
    // 清理組件引用
    this.uiComponents.clear();
    
    // 清理回調
    this.eventCallbacks = {
      onFullscreenChange: null,
      onEnterFullscreen: null,
      onExitFullscreen: null
    };
    
    this.isInitialized = false;
    this.log('全螢幕處理器資源清理完成');
  }

  /**
   * 從存儲中載入調試模式設置
   */
  async loadDebugMode() {
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
      console.error('載入調試模式設置時出錯:', error);
    }
  }

  /**
   * 設置事件處理器
   */
  setupEventHandlers() {
    // 監聽調試模式變更
    registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
      this.debug = message.debugMode;
      this.log('調試模式設置已更新:', this.debug);
    });

    // 監聽容器創建事件，解決全螢幕模式下容器創建時序問題
    registerInternalEventHandler('SUBPAL_CONTAINER_CREATED', (event) => {
      this.handleContainerCreatedEvent(event);
    });

    // VIDEO_ID_CHANGED 事件現在由 UI Manager 統一處理，這裡不再需要單獨處理
  }

  /**
   * 處理容器創建事件
   * @param {Object} event - 容器創建事件
   */
  handleContainerCreatedEvent(event) {
    this.log(`收到容器創建事件: ${event.containerId}`, event);
    
    // 檢查是否處於全螢幕模式
    if (this.isFullscreen) {
      this.log('當前處於全螢幕模式，立即處理新創建的容器');
      
      // 立即處理新創建的容器
      this.handleAdditionalSubPalElements();
      
      // 延遲檢查確保處理完成
      setTimeout(() => {
        this.log('延遲檢查新創建的容器是否正確處理');
        this.handleAdditionalSubPalElements();
      }, 100);
    } else {
      this.log('當前不在全螢幕模式，無需處理容器');
    }
  }

  // handleVideoIdChangedEvent 方法已移除，因為 VIDEO_ID_CHANGED 現在由 UI Manager 統一處理

  /**
   * 調試日誌
   */
  log(message, ...args) {
    if (this.debug) {
      console.log(`[FullscreenHandler] ${message}`, ...args);
    }
  }
}

export { FullscreenHandler };