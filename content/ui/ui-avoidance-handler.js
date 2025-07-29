/**
 * UI 閃避處理器組件 - 專責處理 Netflix 控制欄閃避邏輯
 * 
 * 設計理念：
 * 1. 專責化：只負責 UI 閃避邏輯
 * 2. 智能檢測：自動檢測 Netflix 控制欄狀態
 * 3. 平滑動畫：提供自然的閃避和恢復動畫
 * 4. 可配置性：支持自訂閃避參數
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class UIAvoidanceHandler {
  constructor(options = {}) {
    this.isInitialized = false;
    this.controlBarSelector = null;  // 只保存選擇器，不保存元素引用
    this.observer = null;
    this.isAvoiding = false;
    this.avoidanceTimer = null;
    this.mouseTimer = null;
    this.lastState = null;
    
    // 回調函數配置
    this.callbacks = {
      onPositionChange: options.onPositionChange || null
    };
    
    // 目標元素選擇器
    this.targetSelector = '#subpal-region-container';
    
    // 重試機制
    this.retryTimer = null;
    this.retryCount = 0;
    this.maxRetries = 30;        // 最大重試次數（30次 = 30秒）
    this.retryInterval = 1000;   // 重試間隔（1秒）
    
    // 配置參數
    this.config = {
      avoidanceDelay: 100,        // 閃避觸發延遲 (ms)
      restoreDelay: 0,         // 恢復延遲 (ms)
      animationDuration: 200,     // 閃避動畫時間 (ms)
      bufferDistance: 30,         // 閃避緩衝距離 (px)
      opacityThreshold: 0.3,      // 控制欄透明度閾值
      enabled: true               // 是否啟用閃避功能
    };
    
    // 控制欄選擇器（按優先級排序）
    this.controlBarSelectors = [
      '.watch-video--bottom-controls-container',
      '.PlayerControlsNeo__bottom-controls',
      '.bottom-controls',
      '.player-controls-wrapper',
      '.PlayerControlsNeo__all-controls',
      '[data-uia="controls-standard"]',
      '.watch-video--player-view [class*="controls"]'
    ];
    
    // 調試模式
    this.debug = false;
  }

  async initialize() {
    this.log('UI 閃避處理器初始化中...');
    
    try {
      // 載入調試模式設置
      await this.loadDebugMode();
      
      // 載入配置
      await this.loadConfig();
      
      // 設置事件處理器
      this.setupEventHandlers();
      
      this.isInitialized = true;
      this.log('UI 閃避處理器初始化完成');
      
      // 單獨啟動控制欄搜尋
      this.startControlBarSearch();
      
    } catch (error) {
      console.error('UI 閃避處理器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 獲取當前的目標元素
   * @returns {HTMLElement|null} 當前存在的 regionContainer 元素
   */
  getTargetElement() {
    return document.querySelector(this.targetSelector);
  }

  /**
   * 動態獲取當前的控制欄元素
   * @returns {HTMLElement|null} 當前存在的控制欄元素
   */
  getCurrentControlBar() {
    if (!this.controlBarSelector) return null;
    return document.querySelector(this.controlBarSelector);
  }

  /**
   * 開始查找控制欄（使用重試機制）
   */
  startControlBarSearch() {
    this.log('開始查找控制欄...');
    this.retryCount = 0;
    this.searchControlBar();
  }

  /**
   * 查找控制欄（支持重試）
   */
  searchControlBar() {
    this.controlBarSelector = this.findControlBar();
    
    if (this.controlBarSelector) {
      this.log(`✅ 找到控制欄！(第 ${this.retryCount + 1} 次嘗試)`);
      
      // 立即啟動監聽
      this.start();
      
      return true;
    }
    
    // 未找到控制欄，準備重試
    this.retryCount++;
    
    if (this.retryCount < this.maxRetries) {
      this.log(`⏳ 未找到控制欄，準備第 ${this.retryCount + 1} 次重試... (${this.retryCount}/${this.maxRetries})`);
      
      this.retryTimer = setTimeout(() => {
        this.searchControlBar();
      }, this.retryInterval);
    } else {
      this.log(`❌ 達到最大重試次數 (${this.maxRetries})，UI 閃避功能將禁用`);
      this.config.enabled = false;
    }
    
    return false;
  }

  /**
   * 停止控制欄搜尋
   */
  stopControlBarSearch() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.log('已停止控制欄搜尋');
    }
  }

  /**
   * 開始監聽控制欄
   */
  start() {
    if (!this.isInitialized) {
      console.error('UI 閃避處理器未初始化');
      return false;
    }
    
    if (!this.config.enabled) {
      this.log('UI 閃避功能已禁用');
      return false;
    }
    
    if (!this.controlBarSelector) {
      this.log('未找到控制欄，無法啟動 UI 閃避');
      return false;
    }
    
    this.log('開始監聽控制欄變化...');
    
    // 設置 MutationObserver
    this.observer = new MutationObserver(() => {
      this.handleControlBarChange();
    });
    
    // 使用增強版 MutationObserver 配置（基於測試結果優化）
    // 測試顯示：增強版觸發 20 次 vs 基本版 0 次，大幅改善檢測效果
    const controlBarElement = this.getCurrentControlBar();
    if (controlBarElement) {
      this.observer.observe(controlBarElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-shown', 'aria-hidden', 'hidden'],
        subtree: true,        // 監聽子元素變化（關鍵！）
        childList: true       // 監聽子元素增刪（關鍵！）
      });
      
      // 監聽播放器容器
      const playerContainer = controlBarElement.closest('.watch-video');
      if (playerContainer) {
        this.observer.observe(playerContainer, {
          attributes: true,
          attributeFilter: ['class', 'style'],
          subtree: true
        });
      }
    }
    
    // 設置滑鼠監聽器
    this.setupMouseListeners();
    
    this.log('UI 閃避監聽器已啟動');
    return true;
  }

  /**
   * 停止監聽控制欄
   */
  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    
    if (this.avoidanceTimer) {
      clearTimeout(this.avoidanceTimer);
      this.avoidanceTimer = null;
    }
    
    if (this.mouseTimer) {
      clearTimeout(this.mouseTimer);
      this.mouseTimer = null;
    }
    
    // 恢復目標元素
    if (this.isAvoiding) {
      this.restoreTargetElement();
    }
    
    this.isAvoiding = false;
    this.log('UI 閃避監聽器已停止');
  }

  /**
   * 查找控制欄元素（方案A：只返回選擇器）
   */
  findControlBar() {
    for (const selector of this.controlBarSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        this.log(`找到控制欄: ${selector}`);
        return selector;  // 只返回選擇器，不保存元素引用
      }
    }
    this.log('未找到控制欄');
    return null;
  }

  /**
   * 檢測控制欄狀態（方案A：動態查找）
   */
  detectControlBarState() {
    const element = this.getCurrentControlBar();
    
    // 如果找不到元素，返回隱藏狀態
    if (!element || !element.isConnected) {
      return {
        visible: false,
        opacity: 0,
        position: { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
        classes: [],
        elementMissing: true
      };
    }
    
    const computedStyle = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const opacity = parseFloat(computedStyle.opacity);
    
    // 檢查是否有異常值，但不要誤判隱藏的元素為丟失
    const isHiddenByCSS = computedStyle.display === 'none' || 
                          computedStyle.visibility === 'hidden' ||
                          (rect.width === 0 && rect.height === 0);
    
    if (isNaN(opacity)) {
      this.log('⚠️ 控制欄 opacity 值異常:', {
        opacity: opacity,
        display: computedStyle.display,
        visibility: computedStyle.visibility
      });
    }
    
    return {
      visible: !isHiddenByCSS && computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden',
      opacity: isNaN(opacity) ? 0 : opacity,
      position: rect,
      classes: Array.from(element.classList),
      elementMissing: false  // 只要元素在 DOM 中就不算丟失
    };
  }

  /**
   * 設置滑鼠監聽器
   */
  setupMouseListeners() {
    const playerElement = document.querySelector('.watch-video');
    if (!playerElement) return;
    
    playerElement.addEventListener('mousemove', () => {
      this.handleMouseMove();
    });
    
    playerElement.addEventListener('mouseleave', () => {
      this.handleMouseLeave();
    });
  }

  /**
   * 處理控制欄變化
   */
  handleControlBarChange() {
    if (!this.controlBarSelector) return;
    
    const currentState = this.detectControlBarState();
    
    // 方案 A：完全動態查找，不需要處理元素丟失
    // 每次都重新查找，確保使用最新的元素
    this.log('控制欄狀態變更:', {
      currentState: currentState,
      wasAvoiding: this.isAvoiding
    });
    
    this.processStateChange(currentState);
    this.lastState = currentState;
  }

  /**
   * 處理滑鼠移動
   */
  handleMouseMove() {
    clearTimeout(this.mouseTimer);
    this.mouseTimer = setTimeout(() => {
      if (this.controlBarSelector) {
        const currentState = this.detectControlBarState();
        this.processStateChange(currentState);
      }
    }, this.config.avoidanceDelay);
  }

  /**
   * 處理滑鼠離開
   */
  handleMouseLeave() {
    this.log('滑鼠離開播放器');
    
    // 延遲檢查控制欄狀態
    setTimeout(() => {
      if (this.controlBarSelector) {
        const currentState = this.detectControlBarState();
        if (!currentState.visible || currentState.opacity < this.config.opacityThreshold) {
          this.log('滑鼠離開後：控制欄隱藏');
          this.triggerRestore();
        }
      }
    }, this.config.restoreDelay);
  }

  /**
   * 處理狀態變化
   */
  processStateChange(currentState) {
    const shouldAvoid = currentState.visible && currentState.opacity > this.config.opacityThreshold;
    
    if (shouldAvoid && !this.isAvoiding) {
      this.triggerAvoidance(currentState.position);
    } else if (!shouldAvoid && this.isAvoiding) {
      this.triggerRestore();
    }
  }

  /**
   * 觸發閃避
   */
  triggerAvoidance(controlBarPosition) {
    // 清除之前的恢復定時器
    if (this.avoidanceTimer) {
      clearTimeout(this.avoidanceTimer);
      this.avoidanceTimer = null;
    }
    
    this.log('觸發 UI 閃避');
    this.isAvoiding = true;
    
    // 動態查找當前的 regionContainer
    const targetElement = this.getTargetElement();
    if (!targetElement) {
      this.log('未找到目標元素，跳過閃避');
      return;
    }
    
    const avoidanceOffset = this.calculateAvoidanceOffset(targetElement, controlBarPosition);
    
    if (avoidanceOffset !== 0) {
      // 設置動畫
      targetElement.style.transition = `transform ${this.config.animationDuration}ms ease-out`;
      targetElement.style.transform = `translateY(${avoidanceOffset}px)`;
      targetElement.setAttribute('data-avoiding', 'true');
      
      this.log(`regionContainer 閃避中，偏移: ${avoidanceOffset}px`);
      
      // 通知位置變化（閃避）
      this.notifyPositionChange(true, avoidanceOffset);
    }
  }

  /**
   * 觸發恢復
   */
  triggerRestore() {
    if (!this.isAvoiding) return;
    
    // 添加延遲，確保控制欄動畫完成
    if (this.avoidanceTimer) {
      clearTimeout(this.avoidanceTimer);
    }
    
    this.avoidanceTimer = setTimeout(() => {
      this.log('恢復 UI 正常位置');
      this.isAvoiding = false;
      
      this.restoreTargetElement();
      
      // 通知位置變化（恢復）
      this.notifyPositionChange(false, 0);
      
      // 清理定時器
      this.avoidanceTimer = null;
    }, this.config.restoreDelay);
  }

  /**
   * 恢復目標元素
   */
  restoreTargetElement() {
    const targetElement = this.getTargetElement();
    if (!targetElement) {
      this.log('未找到目標元素，跳過恢復');
      return;
    }
    
    // 設置恢復動畫
    targetElement.style.transition = `transform ${this.config.animationDuration}ms ease-out`;
    targetElement.style.transform = '';
    targetElement.removeAttribute('data-avoiding');
    
    this.log('regionContainer 恢復正常位置');
  }

  /**
   * 計算閃避偏移量
   */
  calculateAvoidanceOffset(element, controlBarPosition) {
    if (!element || !controlBarPosition) {
      this.log('calculateAvoidanceOffset: 缺少必要參數');
      return 0;
    }
    
    const elementRect = element.getBoundingClientRect();
    const controlBarRect = controlBarPosition;
    
    this.log(`元素位置: top=${elementRect.top}, bottom=${elementRect.bottom}`);
    this.log(`控制欄位置: top=${controlBarRect.top}, bottom=${controlBarRect.bottom}`);
    
    // 檢查是否在垂直方向與控制欄重疊（只檢查 Y 軸）
    // 字幕通常在中央，控制欄在底部，所以主要關注垂直重疊
    const isOverlapping = (
      elementRect.bottom > controlBarRect.top &&
      elementRect.top < controlBarRect.bottom
    );
    
    this.log(`重疊檢測結果: ${isOverlapping}`);
    
    if (isOverlapping) {
      // 計算需要向上移動的距離
      const overlap = elementRect.bottom - controlBarRect.top;
      const offset = -(overlap + this.config.bufferDistance);
      this.log(`計算偏移量: overlap=${overlap}, bufferDistance=${this.config.bufferDistance}, offset=${offset}`);
      return offset;
    }
    
    return 0;
  }

  /**
   * 通知位置變化
   * @param {boolean} isAvoiding - 是否正在閃避
   * @param {number} offset - 偏移量（px）
   */
  notifyPositionChange(isAvoiding, offset) {
    if (this.callbacks.onPositionChange) {
      this.log(`通知位置變化: isAvoiding=${isAvoiding}, offset=${offset}px`);
      try {
        this.callbacks.onPositionChange(isAvoiding, offset);
      } catch (error) {
        console.error('UI 閃避回調函數執行失敗:', error);
      }
    }
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.log('配置已更新:', this.config);
  }

  /**
   * 獲取狀態
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      enabled: this.config.enabled,
      isAvoiding: this.isAvoiding,
      controlBarFound: !!this.controlBarSelector,
      hasTargetElement: !!this.getTargetElement(),
      config: this.config,
      lastState: this.lastState
    };
  }

  /**
   * 清理資源
   */
  cleanup() {
    this.log('清理 UI 閃避處理器資源...');
    
    this.stop();
    this.stopControlBarSearch();
    // 註：移除了 managedElements 清理，因為改用動態查找
    this.controlBar = null;
    this.lastState = null;
    
    this.isInitialized = false;
    this.log('UI 閃避處理器資源清理完成');
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
   * 載入配置
   */
  async loadConfig() {
    try {
      const result = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['uiAvoidanceConfig']
      });
      
      if (result && result.uiAvoidanceConfig) {
        this.config = { ...this.config, ...result.uiAvoidanceConfig };
        this.log('配置已載入:', this.config);
      }
    } catch (error) {
      console.error('載入 UI 閃避配置時出錯:', error);
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
    
    // 監聽配置變更
    registerInternalEventHandler('UI_AVOIDANCE_CONFIG_CHANGED', (message) => {
      this.updateConfig(message.config);
      
      // 如果功能被禁用，停止監聽
      if (!this.config.enabled) {
        this.stop();
      } else if (this.isInitialized && !this.observer) {
        this.start();
      }
    });
    
    // VIDEO_ID_CHANGED 事件現在由 UI Manager 統一處理，這裡不再需要單獨處理
  }

  /**
   * 調試日誌
   */
  log(message, ...args) {
    if (this.debug) {
      console.log(`[UIAvoidanceHandler] ${message}`, ...args);
    }
  }
}

export { UIAvoidanceHandler };