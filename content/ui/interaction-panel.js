/**
 * 交互面板組件 - 專責字幕交互按鈕管理
 * 
 * 設計理念：
 * 1. 專責化：只負責交互按鈕的顯示、隱藏和事件處理
 * 2. 智能顯示：懸停顯示，自動隱藏機制
 * 3. 位置跟隨：跟隨字幕位置動態調整
 * 4. 事件解耦：通過回調函數與外部業務邏輯解耦
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class InteractionPanel {
  constructor() {
    this.isInitialized = false;
    this.container = null;
    this.buttons = {};
    this.isVisible = false;
    this.hoverTimer = null;
    this.autoHideTimer = null;
    this.isInFullscreen = false; // 追蹤全螢幕狀態
    
    // 事件回調
    this.eventCallbacks = {
      onSubmitClick: null,
      onLikeClick: null,
      onDislikeClick: null
    };
    
    // 配置選項
    this.config = {
      autoHideDelay: 3000, // 3秒後自動隱藏
      hoverShowDelay: 500, // 懸停500ms後顯示
      position: 'bottom', // 'bottom' | 'top' | 'right'
      showVoteButtons: true,
      showSubmitButton: true
    };
    
    // 調試模式（將由 ConfigBridge 設置）
    this.debug = false;
  }

  async initialize() {
    this.log('交互面板組件初始化中...');

    try {
      // 導入 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 從 ConfigBridge 讀取配置
      this.debug = configBridge.get('debugMode');
      this.log(`調試模式設置為: ${this.debug}`);

      // 訂閱配置變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log(`調試模式已更新: ${newValue}`);
      });

      // 保存 ConfigBridge 實例
      this.configBridge = configBridge;

      // 設置事件處理器
      this.setupEventHandlers();
      
      // 創建交互面板
      this.createPanel();
      
      // 設置按鈕
      this.setupButtons();
      
      // 設置懸停邏輯
      this.setupHoverLogic();
      
      this.isInitialized = true;
      this.log('交互面板組件初始化完成');
      
    } catch (error) {
      console.error('交互面板組件初始化失敗:', error);
      throw error;
    }
  }

  // 顯示交互面板
  show(subtitleData) {
    if (!this.isInitialized || !subtitleData) {
      return;
    }

    // 檢查元素是否存在
    if (!this.container) {
      this.createPanel();
      this.setupButtons();
      this.setupHoverLogic();
    }
    
    this.log('顯示交互面板');
    
    // 更新位置
    this.updatePosition(subtitleData);
    
    // 顯示面板
    this.makeVisible();
    
    // 設置自動隱藏
    this.setupAutoHide();
  }

  // 隱藏交互面板
  hide() {
    this.log('隱藏交互面板');
    this.makeHidden();
    this.clearTimers();
  }

  // 創建交互面板（參考原有 ui-manager.js 的按鈕創建邏輯）
  createPanel() {
    this.log('創建交互面板');
    
    // 檢查是否已存在
    if (document.getElementById('subpal-interaction-panel')) {
      this.log('交互面板已存在，重用現有面板');
      this.container = document.getElementById('subpal-interaction-panel');
      this.findExistingButtons();
      return;
    }
    
    // 創建主容器
    this.container = document.createElement('div');
    this.container.id = 'subpal-interaction-panel';
    this.container.style.cssText = `
      position: fixed;
      z-index: 10001;
      display: none;
      background-color: rgba(0, 0, 0, 0.8);
      border-radius: 8px;
      padding: 8px;
      backdrop-filter: blur(5px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      transition: opacity 0.3s ease, transform 0.3s ease;
      pointer-events: auto;
    `;
    
    document.body.appendChild(this.container);
    this.log('交互面板創建完成');
  }

  // 設置按鈕
  setupButtons() {
    this.log('設置交互按鈕');
    
    // 清空現有按鈕
    this.container.innerHTML = '';
    this.buttons = {};
    
    // 創建按鈕容器
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `
      display: flex;
      gap: 8px;
      align-items: center;
    `;
    
    // 提交翻譯按鈕
    if (this.config.showSubmitButton) {
      this.buttons.submit = this.createButton({
        id: 'submit',
        text: '提交翻譯',
        icon: '✏️',
        color: '#4CAF50',
        hoverColor: '#45a049',
        callback: () => this.triggerCallback('onSubmitClick')
      });
      buttonContainer.appendChild(this.buttons.submit);
    }
    
    // 投票按鈕
    if (this.config.showVoteButtons) {
      this.buttons.like = this.createButton({
        id: 'like',
        text: '👍',
        color: '#2196F3',
        hoverColor: '#0b7dda',
        callback: () => this.triggerCallback('onLikeClick')
      });
      
      this.buttons.dislike = this.createButton({
        id: 'dislike',
        text: '👎',
        color: '#f44336',
        hoverColor: '#da190b',
        callback: () => this.triggerCallback('onDislikeClick')
      });
      
      buttonContainer.appendChild(this.buttons.like);
      buttonContainer.appendChild(this.buttons.dislike);
    }
    
    this.container.appendChild(buttonContainer);
    this.log('交互按鈕設置完成');
  }

  // 創建單個按鈕
  createButton(options) {
    const button = document.createElement('button');
    button.id = `subpal-${options.id}-btn`;
    button.innerHTML = options.icon ? `${options.icon} ${options.text}` : options.text;
    
    button.style.cssText = `
      background-color: ${options.color};
      color: white;
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
      transition: all 0.2s ease;
      white-space: nowrap;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    `;
    
    // 懸停效果
    button.addEventListener('mouseenter', () => {
      button.style.backgroundColor = options.hoverColor;
      button.style.transform = 'translateY(-1px)';
      button.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';
    });
    
    button.addEventListener('mouseleave', () => {
      button.style.backgroundColor = options.color;
      button.style.transform = 'translateY(0)';
      button.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
    });
    
    // 點擊事件
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.log(`按鈕 ${options.id} 被點擊`);
      
      // 按鈕點擊動畫
      button.style.transform = 'scale(0.95)';
      setTimeout(() => {
        button.style.transform = 'translateY(0)';
      }, 100);
      
      // 執行回調
      if (options.callback) {
        options.callback();
      }
    });
    
    return button;
  }

  // 查找現有按鈕（用於重用現有面板）
  findExistingButtons() {
    this.buttons.submit = this.container.querySelector('#subpal-submit-btn');
    this.buttons.like = this.container.querySelector('#subpal-like-btn');
    this.buttons.dislike = this.container.querySelector('#subpal-dislike-btn');
  }

  // 設置懸停邏輯（參考原有實現）
  setupHoverLogic() {
    // 懸停顯示邏輯
    this.container.addEventListener('mouseenter', () => {
      this.clearTimers();
      this.log('鼠標進入交互面板');
    });
    
    this.container.addEventListener('mouseleave', () => {
      this.log('鼠標離開交互面板');
      this.setupAutoHide();
    });
    
    // 防止點擊事件冒泡
    this.container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // 更新位置（按照舊版設計，右上角重疊）
  updatePosition(subtitleData) {
    if (!this.container) {
      return;
    }
    
    let targetPosition;
    
    // 在雙語模式下，使用主要字幕容器的實際位置
    if (subtitleData.isDualSubtitle && subtitleData.primaryContainer) {
      // 獲取主要字幕容器的實際位置
      const primaryRect = subtitleData.primaryContainer.getBoundingClientRect();
      targetPosition = {
        left: primaryRect.left,
        top: primaryRect.top,
        width: primaryRect.width,
        height: primaryRect.height
      };
      this.log('使用主要字幕容器位置 (雙語模式)', targetPosition);
    } else if (subtitleData.position) {
      // DOM 模式或單語模式：使用 subtitleData.position
      targetPosition = subtitleData.position;
      this.log('使用 subtitleData.position (DOM/單語模式)', targetPosition);
    } else {
      this.log('無法獲取有效的字幕位置信息');
      return;
    }
    
    const panelRect = this.container.getBoundingClientRect();
    const margin = 8; // 與字幕容器間距
    
    let left, top;
    
    // 按照舊版設計：右上角外側，與字幕有一定重疊
    // left = 字幕右邊 - 按鈕寬度的一半（實現部分重疊）
    // top = 字幕上方 - 按鈕高度 - 間距
    left = targetPosition.left + targetPosition.width - (panelRect.width * 0.5);
    top = targetPosition.top - panelRect.height - margin;
    
    // 邊界檢查
    const maxLeft = window.innerWidth - panelRect.width - 10;
    const maxTop = window.innerHeight - panelRect.height - 10;
    
    left = Math.max(10, Math.min(left, maxLeft));
    top = Math.max(10, Math.min(top, maxTop));
    
    // 應用位置
    this.container.style.left = `${left}px`;
    this.container.style.top = `${top}px`;
    
    this.log(`更新交互面板位置（右上角重疊）: left=${left}, top=${top}`);
  }

  // 顯示面板
  makeVisible() {
    if (this.isVisible) return;
    
    this.container.style.display = 'block';
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.9)';
    
    // 動畫顯示
    requestAnimationFrame(() => {
      this.container.style.opacity = '1';
      this.container.style.transform = 'scale(1)';
    });
    
    this.isVisible = true;
    this.log('交互面板已顯示');
  }

  // 為了定位而顯示面板（透明狀態）
  makeVisibleForPositioning() {
    if (this.isVisible) return;
    
    this.container.style.display = 'block';
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.9)';
    this.container.style.visibility = 'hidden'; // 隱藏但保持佔位
    
    // 等待一幀確保渲染完成
    requestAnimationFrame(() => {
      this.container.style.visibility = 'visible';
    });
  }

  // 顯示動畫
  showWithAnimation() {
    if (this.isVisible) return;
    
    // 動畫顯示
    requestAnimationFrame(() => {
      this.container.style.opacity = '1';
      this.container.style.transform = 'scale(1)';
    });
    
    this.isVisible = true;
    this.log('交互面板已顯示');
  }

  // 隱藏面板
  makeHidden() {
    if (!this.isVisible) return;
    
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.9)';
    
    setTimeout(() => {
      this.container.style.display = 'none';
    }, 300);
    
    this.isVisible = false;
    this.log('交互面板已隱藏');
  }

  // 設置自動隱藏
  setupAutoHide() {
    this.clearTimers();
    
    this.autoHideTimer = setTimeout(() => {
      this.hide();
    }, this.config.autoHideDelay);
  }

  // 清理定時器
  clearTimers() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
  }

  // 觸發回調
  triggerCallback(callbackName) {
    const callback = this.eventCallbacks[callbackName];
    if (callback && typeof callback === 'function') {
      this.log(`觸發回調: ${callbackName}`);
      callback();
    } else {
      this.log(`回調 ${callbackName} 未註冊或不是函數`);
    }
  }

  // 註冊事件回調
  onSubmitClick(callback) {
    this.eventCallbacks.onSubmitClick = callback;
    this.log('提交按鈕回調已註冊');
  }

  onLikeClick(callback) {
    this.eventCallbacks.onLikeClick = callback;
    this.log('讚按鈕回調已註冊');
  }

  onDislikeClick(callback) {
    this.eventCallbacks.onDislikeClick = callback;
    this.log('倒讚按鈕回調已註冊');
  }

  // 配置面板
  configure(options) {
    this.config = { ...this.config, ...options };
    this.log('交互面板配置已更新:', options);
    
    // 如果已初始化，重新設置按鈕
    if (this.isInitialized) {
      this.setupButtons();
    }
  }

  // 處理全螢幕模式變更（由 FullscreenHandler 調用）
  handleFullscreenChange(isFullscreen) {
    this.log(`處理全螢幕模式變更: ${isFullscreen}`);
    
    this.isInFullscreen = isFullscreen;
    
    // 進入/退出全螢幕模式：直接隱藏面板並標記為不可顯示
    this.log('進入全螢幕模式，隱藏交互面板');
    this.hide();
    
    // 立即設置 display: none，避免被 FullscreenHandler 重新顯示
    if (this.container) {
      this.container.style.display = 'none';
    }

  }

  // 獲取狀態
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isVisible: this.isVisible,
      hasContainer: !!this.container,
      buttonCount: Object.keys(this.buttons).length,
      config: this.config,
      callbacks: Object.keys(this.eventCallbacks).filter(key => 
        typeof this.eventCallbacks[key] === 'function'
      )
    };
  }

  // 獲取容器元素（用於懸停事件）
  getContainer() {
    return this.container;
  }

  // 懸停時顯示（用於滑鼠懸停觸發）
  showOnHover(subtitleData) {
    if (!this.isInitialized || !subtitleData) {
      return;
    }
    
    // 清除現有的隱藏定時器
    this.clearAutoHideTimer();
    
    // 如果已經顯示，不需要重新計算位置
    if (this.isVisible) {
      this.log('交互面板已顯示，只清除隱藏定時器');
      return;
    }
    
    this.log('懸停顯示交互面板');
    
    // 先顯示面板（但透明），這樣才能獲取正確的尺寸
    this.makeVisibleForPositioning();
    
    // 更新位置
    this.updatePosition(subtitleData);
    
    // 顯示面板動畫
    this.showWithAnimation();
  }

  // 懸停離開時隱藏（參考舊版實現，0.5秒延遲）
  hideOnHover() {
    this.log('懸停離開，準備隱藏交互面板');
    
    // 清除現有的隱藏定時器
    this.clearAutoHideTimer();
    
    // 設置0.5秒延遲隱藏
    this.autoHideTimer = setTimeout(() => {
      this.hide();
    }, 500);
  }

  // 清除自動隱藏定時器
  clearAutoHideTimer() {
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
  }

  // 清理資源
  cleanup() {
    this.log('清理交互面板組件資源...');
    
    this.clearTimers();
    
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    
    this.buttons = {};
    this.eventCallbacks = {};
    this.isInitialized = false;
    this.isVisible = false;
    
    this.log('交互面板組件資源清理完成');
  }

  // 設置事件處理器
  setupEventHandlers() {
    // VIDEO_ID_CHANGED 事件現在由 UI Manager 統一處理，這裡不再需要單獨處理
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[InteractionPanel] ${message}`, ...args);
    }
  }
}

export { InteractionPanel };