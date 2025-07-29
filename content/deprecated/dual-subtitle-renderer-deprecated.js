/**
 * 雙語字幕渲染器 - 負責雙語字幕的顯示和排版
 * 
 * 此模組負責：
 * 1. 雙語字幕的排版和佈局
 * 2. 不同的顯示模式（上下排列、左右排列等）
 * 3. 字幕樣式管理
 * 4. 與現有UI管理器的集成
 * 5. 交互功能（如語言切換）
 */

import { sendMessage, registerInternalEventHandler } from './messaging.js';

// 調試模式
let debugMode = false;

function debugLog(...args) {
  if (debugMode) {
    console.log('[DualSubtitleRenderer]', ...args);
  }
}

/**
 * 雙語字幕渲染器類
 */
class DualSubtitleRenderer {
  constructor() {
    this.isInitialized = false;
    this.currentContainer = null;
    this.primaryElement = null;
    this.secondaryElement = null;
    this.controlsElement = null;
    
    // 顯示模式
    this.displayModes = {
      VERTICAL: 'vertical',        // 上下排列
      HORIZONTAL: 'horizontal',    // 左右排列
      OVERLAY: 'overlay',         // 重疊顯示
      SWITCH: 'switch'            // 切換顯示
    };
    
    this.currentMode = this.displayModes.VERTICAL;
    this.isVisible = false;
    this.currentSubtitle = null;
    
    // 樣式配置
    this.styles = {
      container: {
        position: 'fixed',
        zIndex: '10000',
        pointerEvents: 'none',
        textAlign: 'center',
        transition: 'opacity 0.3s ease'
      },
      primary: {
        fontSize: '28px',
        fontFamily: 'Arial, sans-serif',
        color: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        padding: '5px 10px',
        borderRadius: '4px',
        textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
        margin: '2px 0'
      },
      secondary: {
        fontSize: '24px',
        fontFamily: 'Arial, sans-serif',
        color: '#ffff99',
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        padding: '4px 8px',
        borderRadius: '3px',
        textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
        margin: '2px 0'
      },
      controls: {
        position: 'absolute',
        top: '-35px',
        right: '0',
        display: 'none',
        flexDirection: 'row',
        gap: '5px',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        padding: '4px 8px',
        borderRadius: '4px',
        fontSize: '12px'
      }
    };
    
    // 位置配置
    this.positions = {
      vertical: {
        bottom: '10%',
        left: '50%',
        transform: 'translateX(-50%)'
      },
      horizontal: {
        bottom: '10%',
        left: '50%',
        transform: 'translateX(-50%)'
      },
      overlay: {
        bottom: '10%',
        left: '50%',
        transform: 'translateX(-50%)'
      }
    };
    
    // 動畫配置
    this.animations = {
      fadeIn: 'subpal-fade-in 0.3s ease',
      fadeOut: 'subpal-fade-out 0.3s ease',
      slideIn: 'subpal-slide-in 0.3s ease',
      slideOut: 'subpal-slide-out 0.3s ease'
    };
    
    // 交互狀態
    this.isHovered = false;
    this.switchTimer = null;
    this.switchInterval = 3000; // 切換模式下的顯示間隔
  }

  /**
   * 初始化雙語字幕渲染器
   */
  async initialize() {
    debugLog('初始化雙語字幕渲染器...');
    
    try {
      // 載入設置
      await this.loadSettings();
      
      // 創建容器
      this.createContainer();
      
      // 注入CSS樣式
      this.injectCSS();
      
      // 設置事件監聽
      this.setupEventListeners();
      
      this.isInitialized = true;
      debugLog('雙語字幕渲染器初始化完成');
      
      return true;
    } catch (error) {
      console.error('初始化雙語字幕渲染器失敗:', error);
      return false;
    }
  }

  /**
   * 載入設置
   */
  async loadSettings() {
    try {
      const settings = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['debugMode', 'dualSubtitleDisplayMode', 'dualSubtitleStyles']
      });
      
      if (settings) {
        debugMode = settings.debugMode || false;
        this.currentMode = settings.dualSubtitleDisplayMode || this.displayModes.VERTICAL;
        
        if (settings.dualSubtitleStyles) {
          this.mergeStyles(settings.dualSubtitleStyles);
        }
      }
      
      debugLog('設置已載入:', { debugMode, currentMode: this.currentMode });
    } catch (error) {
      console.error('載入設置失敗:', error);
    }
  }

  /**
   * 創建容器
   */
  createContainer() {
    debugLog('創建雙語字幕容器...');
    
    // 查找播放器元素
    const videoPlayer = document.querySelector('.watch-video, .NFPlayer, video, .VideoContainer, .nf-player-container, [data-uia="video-player"]');
    if (!videoPlayer) {
      throw new Error('找不到視頻播放器元素');
    }
    
    // 創建主容器
    this.currentContainer = document.createElement('div');
    this.currentContainer.id = 'subpal-dual-subtitle-container';
    this.currentContainer.className = 'subpal-dual-subtitle-container';
    
    // 應用容器樣式
    Object.assign(this.currentContainer.style, this.styles.container);
    this.applyPosition();
    
    // 創建主語言字幕元素
    this.primaryElement = document.createElement('div');
    this.primaryElement.className = 'subpal-primary-subtitle';
    Object.assign(this.primaryElement.style, this.styles.primary);
    
    // 創建次語言字幕元素
    this.secondaryElement = document.createElement('div');
    this.secondaryElement.className = 'subpal-secondary-subtitle';
    Object.assign(this.secondaryElement.style, this.styles.secondary);
    
    // 創建控制元素
    this.controlsElement = document.createElement('div');
    this.controlsElement.className = 'subpal-dual-subtitle-controls';
    Object.assign(this.controlsElement.style, this.styles.controls);
    
    // 創建控制按鈕
    this.createControlButtons();
    
    // 組裝元素
    this.assembleElements();
    
    // 添加到播放器
    videoPlayer.appendChild(this.currentContainer);
    
    // 設置交互事件
    this.setupInteractionEvents();
    
    debugLog('雙語字幕容器創建完成');
  }

  /**
   * 創建控制按鈕
   */
  createControlButtons() {
    // 模式切換按鈕
    const modeButton = document.createElement('button');
    modeButton.textContent = '🔄';
    modeButton.title = '切換顯示模式';
    modeButton.style.cssText = `
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 2px;
      font-size: 14px;
    `;
    modeButton.addEventListener('click', () => this.switchDisplayMode());
    
    // 語言切換按鈕
    const langButton = document.createElement('button');
    langButton.textContent = '🌐';
    langButton.title = '切換主次語言';
    langButton.style.cssText = `
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 2px;
      font-size: 14px;
    `;
    langButton.addEventListener('click', () => this.switchLanguagePriority());
    
    // 隱藏按鈕
    const hideButton = document.createElement('button');
    hideButton.textContent = '👁️';
    hideButton.title = '隱藏雙語字幕';
    hideButton.style.cssText = `
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 2px;
      font-size: 14px;
    `;
    hideButton.addEventListener('click', () => this.hide());
    
    // 添加到控制元素
    this.controlsElement.appendChild(modeButton);
    this.controlsElement.appendChild(langButton);
    this.controlsElement.appendChild(hideButton);
  }

  /**
   * 組裝元素
   */
  assembleElements() {
    // 清空容器
    this.currentContainer.innerHTML = '';
    
    // 添加控制元素
    this.currentContainer.appendChild(this.controlsElement);
    
    // 根據顯示模式組裝
    switch (this.currentMode) {
      case this.displayModes.VERTICAL:
        this.assembleVerticalLayout();
        break;
      case this.displayModes.HORIZONTAL:
        this.assembleHorizontalLayout();
        break;
      case this.displayModes.OVERLAY:
        this.assembleOverlayLayout();
        break;
      case this.displayModes.SWITCH:
        this.assembleSwitchLayout();
        break;
    }
  }

  /**
   * 組裝垂直布局
   */
  assembleVerticalLayout() {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '4px';
    
    wrapper.appendChild(this.primaryElement);
    wrapper.appendChild(this.secondaryElement);
    
    this.currentContainer.appendChild(wrapper);
  }

  /**
   * 組裝水平布局
   */
  assembleHorizontalLayout() {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'row';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';
    wrapper.style.justifyContent = 'center';
    
    wrapper.appendChild(this.primaryElement);
    wrapper.appendChild(this.secondaryElement);
    
    this.currentContainer.appendChild(wrapper);
  }

  /**
   * 組裝重疊布局
   */
  assembleOverlayLayout() {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'center';
    
    // 調整次語言字幕的透明度
    this.secondaryElement.style.opacity = '0.8';
    this.secondaryElement.style.fontSize = '22px';
    
    wrapper.appendChild(this.primaryElement);
    wrapper.appendChild(this.secondaryElement);
    
    this.currentContainer.appendChild(wrapper);
  }

  /**
   * 組裝切換布局
   */
  assembleSwitchLayout() {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'center';
    wrapper.style.minHeight = '60px';
    
    // 初始只顯示主語言
    this.secondaryElement.style.display = 'none';
    
    wrapper.appendChild(this.primaryElement);
    wrapper.appendChild(this.secondaryElement);
    
    this.currentContainer.appendChild(wrapper);
  }

  /**
   * 應用位置樣式
   */
  applyPosition() {
    if (!this.currentContainer) return;
    
    const position = this.positions[this.currentMode] || this.positions.vertical;
    Object.assign(this.currentContainer.style, position);
  }

  /**
   * 設置交互事件
   */
  setupInteractionEvents() {
    // 鼠標懸停事件
    this.currentContainer.addEventListener('mouseenter', () => {
      this.isHovered = true;
      this.showControls();
    });
    
    this.currentContainer.addEventListener('mouseleave', () => {
      this.isHovered = false;
      this.hideControls();
    });
    
    // 允許容器接收鼠標事件
    this.currentContainer.style.pointerEvents = 'auto';
  }

  /**
   * 顯示控制按鈕
   */
  showControls() {
    if (this.controlsElement) {
      this.controlsElement.style.display = 'flex';
    }
  }

  /**
   * 隱藏控制按鈕
   */
  hideControls() {
    if (this.controlsElement && !this.isHovered) {
      this.controlsElement.style.display = 'none';
    }
  }

  /**
   * 設置事件監聽器
   */
  setupEventListeners() {
    // 監聽調試模式變更
    registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
      debugMode = message.debugMode;
      debugLog('調試模式已更新:', debugMode);
    });
    
    // 監聽雙語字幕設置變更
    registerInternalEventHandler('DUAL_SUBTITLE_SETTINGS_CHANGED', (message) => {
      if (message.displayMode) {
        this.setDisplayMode(message.displayMode);
      }
      if (message.styles) {
        this.mergeStyles(message.styles);
        this.applyStyles();
      }
    });
    
    // 監聽窗口大小變化
    window.addEventListener('resize', () => {
      this.applyPosition();
    });
  }

  /**
   * 渲染雙語字幕
   */
  render(dualSubtitle) {
    if (!this.isInitialized || !this.currentContainer) {
      debugLog('渲染器未初始化，無法渲染字幕');
      return;
    }
    
    this.currentSubtitle = dualSubtitle;
    
    // 設置字幕內容
    this.primaryElement.textContent = dualSubtitle.primaryText || '';
    this.secondaryElement.textContent = dualSubtitle.secondaryText || '';
    
    // 處理空字幕
    if (!dualSubtitle.primaryText && !dualSubtitle.secondaryText) {
      this.hide();
      return;
    }
    
    // 根據模式渲染
    switch (this.currentMode) {
      case this.displayModes.SWITCH:
        this.renderSwitchMode();
        break;
      default:
        this.renderNormalMode();
    }
    
    // 顯示字幕
    this.show();
    
    debugLog('雙語字幕已渲染:', dualSubtitle);
  }

  /**
   * 渲染正常模式
   */
  renderNormalMode() {
    this.primaryElement.style.display = this.currentSubtitle.primaryText ? 'block' : 'none';
    this.secondaryElement.style.display = this.currentSubtitle.secondaryText ? 'block' : 'none';
    
    // 停止切換定時器
    if (this.switchTimer) {
      clearInterval(this.switchTimer);
      this.switchTimer = null;
    }
  }

  /**
   * 渲染切換模式
   */
  renderSwitchMode() {
    // 停止現有定時器
    if (this.switchTimer) {
      clearInterval(this.switchTimer);
    }
    
    // 如果只有一種語言，直接顯示
    if (!this.currentSubtitle.primaryText || !this.currentSubtitle.secondaryText) {
      this.primaryElement.style.display = this.currentSubtitle.primaryText ? 'block' : 'none';
      this.secondaryElement.style.display = this.currentSubtitle.secondaryText ? 'block' : 'none';
      return;
    }
    
    // 開始切換顯示
    let showPrimary = true;
    this.primaryElement.style.display = 'block';
    this.secondaryElement.style.display = 'none';
    
    this.switchTimer = setInterval(() => {
      if (showPrimary) {
        this.primaryElement.style.display = 'none';
        this.secondaryElement.style.display = 'block';
      } else {
        this.primaryElement.style.display = 'block';
        this.secondaryElement.style.display = 'none';
      }
      showPrimary = !showPrimary;
    }, this.switchInterval);
  }

  /**
   * 顯示字幕
   */
  show() {
    if (!this.currentContainer) return;
    
    this.isVisible = true;
    this.currentContainer.style.display = 'block';
    this.currentContainer.style.opacity = '1';
    
    // 添加動畫效果
    this.currentContainer.style.animation = this.animations.fadeIn;
  }

  /**
   * 隱藏字幕
   */
  hide() {
    if (!this.currentContainer) return;
    
    this.isVisible = false;
    this.currentContainer.style.opacity = '0';
    
    // 停止切換定時器
    if (this.switchTimer) {
      clearInterval(this.switchTimer);
      this.switchTimer = null;
    }
    
    // 延遲隱藏
    setTimeout(() => {
      if (!this.isVisible) {
        this.currentContainer.style.display = 'none';
      }
    }, 300);
  }

  /**
   * 設置顯示模式
   */
  setDisplayMode(mode) {
    if (this.displayModes[mode.toUpperCase()]) {
      this.currentMode = this.displayModes[mode.toUpperCase()];
    } else {
      this.currentMode = mode;
    }
    
    debugLog('顯示模式已更改:', this.currentMode);
    
    // 重新組裝元素
    this.assembleElements();
    this.applyPosition();
    
    // 如果有當前字幕，重新渲染
    if (this.currentSubtitle) {
      this.render(this.currentSubtitle);
    }
    
    // 保存設置
    this.saveSettings();
  }

  /**
   * 切換顯示模式
   */
  switchDisplayMode() {
    const modes = Object.values(this.displayModes);
    const currentIndex = modes.indexOf(this.currentMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    
    this.setDisplayMode(modes[nextIndex]);
  }

  /**
   * 切換語言優先級
   */
  switchLanguagePriority() {
    if (!this.currentSubtitle) return;
    
    // 交換主次語言文本
    const tempText = this.currentSubtitle.primaryText;
    this.currentSubtitle.primaryText = this.currentSubtitle.secondaryText;
    this.currentSubtitle.secondaryText = tempText;
    
    // 重新渲染
    this.render(this.currentSubtitle);
    
    debugLog('語言優先級已切換');
  }

  /**
   * 合併樣式
   */
  mergeStyles(newStyles) {
    if (newStyles.container) {
      Object.assign(this.styles.container, newStyles.container);
    }
    if (newStyles.primary) {
      Object.assign(this.styles.primary, newStyles.primary);
    }
    if (newStyles.secondary) {
      Object.assign(this.styles.secondary, newStyles.secondary);
    }
    if (newStyles.controls) {
      Object.assign(this.styles.controls, newStyles.controls);
    }
    
    debugLog('樣式已合併:', newStyles);
  }

  /**
   * 應用樣式
   */
  applyStyles() {
    if (!this.isInitialized) return;
    
    if (this.currentContainer) {
      Object.assign(this.currentContainer.style, this.styles.container);
    }
    if (this.primaryElement) {
      Object.assign(this.primaryElement.style, this.styles.primary);
    }
    if (this.secondaryElement) {
      Object.assign(this.secondaryElement.style, this.styles.secondary);
    }
    if (this.controlsElement) {
      Object.assign(this.controlsElement.style, this.styles.controls);
    }
    
    debugLog('樣式已應用');
  }

  /**
   * 注入CSS樣式
   */
  injectCSS() {
    const css = `
      @keyframes subpal-fade-in {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      @keyframes subpal-fade-out {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(10px); }
      }
      
      @keyframes subpal-slide-in {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      
      @keyframes subpal-slide-out {
        from { transform: translateY(0); opacity: 1; }
        to { transform: translateY(20px); opacity: 0; }
      }
      
      .subpal-dual-subtitle-container {
        font-family: system-ui, -apple-system, sans-serif;
        line-height: 1.4;
      }
      
      .subpal-primary-subtitle, .subpal-secondary-subtitle {
        display: block;
        white-space: pre-wrap;
        word-wrap: break-word;
        max-width: 80vw;
        box-sizing: border-box;
      }
      
      .subpal-dual-subtitle-controls button:hover {
        background-color: rgba(255, 255, 255, 0.2) !important;
      }
    `;
    
    const style = document.createElement('style');
    style.id = 'subpal-dual-subtitle-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /**
   * 保存設置
   */
  async saveSettings() {
    try {
      await sendMessage({
        type: 'SAVE_SETTINGS',
        settings: {
          dualSubtitleDisplayMode: this.currentMode,
          dualSubtitleStyles: this.styles
        }
      });
      debugLog('設置已保存');
    } catch (error) {
      console.error('保存設置失敗:', error);
    }
  }

  /**
   * 清理資源
   */
  destroy() {
    if (this.switchTimer) {
      clearInterval(this.switchTimer);
      this.switchTimer = null;
    }
    
    if (this.currentContainer && this.currentContainer.parentNode) {
      this.currentContainer.parentNode.removeChild(this.currentContainer);
    }
    
    // 移除CSS
    const style = document.getElementById('subpal-dual-subtitle-styles');
    if (style) {
      style.remove();
    }
    
    this.isInitialized = false;
    debugLog('雙語字幕渲染器已清理');
  }

  /**
   * 獲取狀態
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      currentMode: this.currentMode,
      isVisible: this.isVisible,
      hasCurrentSubtitle: !!this.currentSubtitle
    };
  }
}

// 創建單例實例
const dualSubtitleRenderer = new DualSubtitleRenderer();

/**
 * 初始化雙語字幕渲染器
 */
export async function initDualSubtitleRenderer() {
  debugLog('開始初始化雙語字幕渲染器...');
  
  try {
    const success = await dualSubtitleRenderer.initialize();
    if (success) {
      debugLog('雙語字幕渲染器初始化成功');
    } else {
      debugLog('雙語字幕渲染器初始化失敗');
    }
    return success;
  } catch (error) {
    console.error('初始化雙語字幕渲染器時出錯:', error);
    return false;
  }
}

/**
 * 渲染雙語字幕
 */
export function renderDualSubtitle(dualSubtitle) {
  dualSubtitleRenderer.render(dualSubtitle);
}

/**
 * 隱藏雙語字幕
 */
export function hideDualSubtitle() {
  dualSubtitleRenderer.hide();
}

/**
 * 設置顯示模式
 */
export function setDualSubtitleDisplayMode(mode) {
  dualSubtitleRenderer.setDisplayMode(mode);
}

/**
 * 獲取渲染器實例
 */
export function getDualSubtitleRenderer() {
  return dualSubtitleRenderer;
}

/**
 * 獲取渲染器狀態
 */
export function getDualSubtitleRendererStatus() {
  return dualSubtitleRenderer.getStatus();
}

/**
 * 清理渲染器
 */
export function destroyDualSubtitleRenderer() {
  dualSubtitleRenderer.destroy();
}

debugLog('雙語字幕渲染器模組已載入');