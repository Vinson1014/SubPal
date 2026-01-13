/**
 * 字幕顯示組件 - 專責字幕顯示和樣式管理
 * 
 * 設計理念：
 * 1. 專責化：只負責字幕的顯示和隱藏
 * 2. 樣式管理：統一管理字幕樣式和位置
 * 3. 雙語支持：支持單語和雙語字幕顯示
 * 4. 智能位置：自動計算和調整字幕位置
 */

import { sendMessage, registerInternalEventHandler, dispatchInternalEvent } from '../system/messaging.js';
import { getPlayerAdapter } from './netflix-player-adapter.js';

const PRIMARY_SUB_FONT_SIZE = 55; // 基本字體大小
const SECONDARY_SUB_FONT_SIZE = 24; // 次要字體大小

class SubtitleDisplay {
  constructor() {
    this.isInitialized = false;
    this.container = null;
    this.element = null;
    this.currentSubtitle = null;
    this.lastPosition = null;
    
    // 雙語字幕容器
    this.primaryContainer = null;
    this.secondaryContainer = null;
    this.regionContainer = null;  // region 容器
    this.isDualMode = false;
    
    // 雙語樣式支持 (新增)
    this.dualModeStyles = null;
    
    // 字幕樣式（參考原有 ui-manager.js 的 subtitleStyle）
    this.subtitleStyle = {
      fontSize: '28px',
      fontFamily: 'Arial, sans-serif',
      fontWeight: 'normal',
      fontStyle: 'normal',
      color: '#ffffff',
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      textAlign: 'center',
      borderRadius: '4px',
      textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
      border: 'none',
      opacity: '1.0',
      maxWidth: '100%'
    };
    
    // 調試模式（將由 ConfigBridge 設置）
    this.debug = false;
  }

  async initialize() {
    this.log('字幕顯示組件初始化中...');

    try {
      // 導入 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 從 ConfigBridge 讀取配置（從本地緩存，無需 chrome API）
      this.debug = configBridge.get('debugMode');
      this.log(`調試模式設置為: ${this.debug}`);

      // 讀取所有字幕樣式配置
      const primaryFontSize = configBridge.get('subtitle.style.primary.fontSize');
      const primaryTextColor = configBridge.get('subtitle.style.primary.textColor');
      const primaryBgColor = configBridge.get('subtitle.style.primary.backgroundColor');
      const secondaryFontSize = configBridge.get('subtitle.style.secondary.fontSize');
      const secondaryTextColor = configBridge.get('subtitle.style.secondary.textColor');
      const secondaryBgColor = configBridge.get('subtitle.style.secondary.backgroundColor');
      const fontFamily = configBridge.get('subtitle.style.fontFamily');

      // 更新字幕樣式對象
      this.subtitleStyle.fontSize = `${primaryFontSize}px`;
      this.subtitleStyle.color = primaryTextColor;
      this.subtitleStyle.backgroundColor = primaryBgColor;
      this.subtitleStyle.fontFamily = fontFamily;

      this.log('字幕樣式配置已載入:', this.subtitleStyle);

      // 訂閱配置變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log('調試模式已更新:', newValue);
      });

      // 訂閱主要字幕樣式變更
      configBridge.subscribe('subtitle.style.primary.fontSize', (newValue) => {
        this.subtitleStyle.fontSize = `${newValue}px`;
        this.log('主要字幕字體大小已更新:', newValue);
        this.applyStyles();
      });

      configBridge.subscribe('subtitle.style.primary.textColor', (newValue) => {
        this.subtitleStyle.color = newValue;
        this.log('主要字幕字體顏色已更新:', newValue);
        this.applyStyles();
      });

      configBridge.subscribe('subtitle.style.primary.backgroundColor', (newValue) => {
        this.subtitleStyle.backgroundColor = newValue;
        this.log('主要字幕背景顏色已更新:', newValue);
        this.applyStyles();
      });

      // 訂閱次要字幕樣式變更
      configBridge.subscribe('subtitle.style.secondary.fontSize', (newValue) => {
        this.log('次要字幕字體大小已更新:', newValue);
        this.applyStyles();
      });

      configBridge.subscribe('subtitle.style.secondary.textColor', (newValue) => {
        this.log('次要字幕字體顏色已更新:', newValue);
        this.applyStyles();
      });

      configBridge.subscribe('subtitle.style.secondary.backgroundColor', (newValue) => {
        this.log('次要字幕背景顏色已更新:', newValue);
        this.applyStyles();
      });

      configBridge.subscribe('subtitle.style.fontFamily', (newValue) => {
        this.subtitleStyle.fontFamily = newValue;
        this.log('字體家族已更新:', newValue);
        this.applyStyles();
      });

      // 保存 ConfigBridge 實例供其他方法使用
      this.configBridge = configBridge;

      // 設置事件處理器
      this.setupEventHandlers();
      
      // 創建字幕容器
      await this.createContainer();
      
      this.isInitialized = true;
      this.log('字幕顯示組件初始化完成');
      
    } catch (error) {
      console.error('字幕顯示組件初始化失敗:', error);
      throw error;
    }
  }

  // 顯示字幕（統一接口）
  show(subtitleData) {
    if (!this.isInitialized) {
      console.error('字幕顯示組件未初始化');
      return;
    }
    
    this.log('顯示字幕:', subtitleData);
    
    // 檢查是否為雙語字幕
    if (subtitleData.isDualSubtitle && subtitleData.dualSubtitleData) {
      this.hideSingleSubtitle();
      this.showDualSubtitle(subtitleData);
    } else {
      this.hideDualSubtitle();
      this.showSingleSubtitle(subtitleData);
    }
  }

  // 隱藏字幕
  hide() {
    this.log('隱藏字幕');
    
    if (this.isDualMode) {
      this.hideDualSubtitle();
    } else {
      this.hideSingleSubtitle();
    }
    
    this.currentSubtitle = null;
  }

  // 顯示單語字幕（參考原有 ui-manager.js showSubtitle 實現）
  showSingleSubtitle(subtitleData) {
    this.log('顯示單語字幕');
    
    // 確保切換到單語模式
    if (this.isDualMode) {
      this.switchToSingleMode();
    }
    
    if (!this.container || !this.element) {
      this.log('字幕容器不存在，重新創建');
      this.createSingleSubtitleContainer();
    }
    
    // 保存當前字幕數據
    this.currentSubtitle = subtitleData;
    
    // 設置字幕文本
    this.updateSubtitleContent(subtitleData);
    
    // 應用樣式
    this.applySubtitleStyle();
    
    // 更新位置
    this.updatePosition(subtitleData.position);
    
    // 顯示容器
    this.container.style.display = 'block';
  }

  // 顯示雙語字幕（參考重構計劃中的設計）
  showDualSubtitle(subtitleData) {
    this.log('顯示雙語字幕', subtitleData);
    
    // 確保切換到雙語模式
    if (!this.isDualMode) {
      this.switchToDualMode();
    }
    
    if (!this.primaryContainer || !this.secondaryContainer) {
      this.log('雙語字幕容器不存在，重新創建');
      this.createDualSubtitleContainers();
    }
    
    // 保存當前字幕數據
    this.currentSubtitle = subtitleData;
    
    const dualSubtitleData = subtitleData.dualSubtitleData;
    
    // 顯示主要語言字幕
    if (dualSubtitleData.primaryText) {
      this.primaryContainer.textContent = dualSubtitleData.primaryText;
      this.primaryContainer.style.display = 'block';
    } else {
      this.primaryContainer.style.display = 'none';
    }
    
    // 只有在啟用雙語模式且有次要語言字幕時才顯示
    if (dualSubtitleData.isDualModeEnabled && dualSubtitleData.secondaryText) {
      // 將secondaryText 中的換行符號以空白取代
      dualSubtitleData.secondaryText = dualSubtitleData.secondaryText.replace(/\n/g, ' ');
      this.secondaryContainer.textContent = dualSubtitleData.secondaryText;
      this.secondaryContainer.style.display = 'block';
      this.secondaryContainer.style.opacity = '1';
      this.secondaryContainer.style.pointerEvents = 'auto';
    } else {
      // 使用透明度佔位符，避免主要字幕跳動
      this.secondaryContainer.style.opacity = '0';
      this.secondaryContainer.style.pointerEvents = 'none';
      // 保持 display: block 以維持佔位
      // 保留上一次的內容以維持高度一致性
    }
    
    // 更新字體大小
    this.updateDualSubtitleFontSize();
    
    // 在更新字體大小後，重新應用用戶設定的樣式（確保用戶設定優先）
    if (this.dualModeStyles) {
      // this.applyDualModeStyles();
    }
    
    // 更新雙語字幕位置（如果有位置信息）
    if (subtitleData.position) {
      this.updateDualSubtitlePosition(subtitleData.position);
    }
    
    // 調整次要語言位置確保緊貼主要語言（延遲執行確保內容已渲染）
    // setTimeout(() => {
    //   this.adjustSecondaryPosition();
    // }, 15);
  }

  // 隱藏單語字幕
  hideSingleSubtitle() {
    if (this.container) {
      this.container.style.display = 'none';
    }
  }

  // 隱藏雙語字幕
  hideDualSubtitle() {
    if (this.primaryContainer) {
      this.primaryContainer.style.display = 'none';
    }
    if (this.secondaryContainer) {
      // 完全隱藏時使用 display: none（因為整個字幕都不顯示了）
      this.secondaryContainer.style.display = 'none';
      this.secondaryContainer.style.opacity = '1'; // 重置透明度狀態
    }
  }

  // 創建字幕容器
  createContainer() {
    // 先檢查是否已存在
    if (document.getElementById('subpal-subtitle-container')) {
      this.log('字幕容器已存在，重用現有容器');
      this.container = document.getElementById('subpal-subtitle-container');
      this.element = this.container.querySelector('.subpal-subtitle-text');
      return;
    }
    
    this.createSingleSubtitleContainer();
  }

  // 創建單語字幕容器（參考原有 ui-manager.js createCustomSubtitleContainer）
  createSingleSubtitleContainer() {
    this.log('創建單語字幕容器');
    
    // 創建主容器
    this.container = document.createElement('div');
    this.container.id = 'subpal-subtitle-container';
    this.container.style.cssText = `
      position: fixed;
      z-index: 10000;
      pointer-events: auto;
      display: none;
    `;
    
    // 創建字幕文本元素
    this.element = document.createElement('div');
    this.element.className = 'subpal-subtitle-text';
    this.element.style.cssText = `
      position: relative;
      display: inline-block;
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.2;
    `;
    
    this.container.appendChild(this.element);
    document.body.appendChild(this.container);
    
    this.log('單語字幕容器創建完成');
  }

  // 創建雙語字幕容器（參考重構計劃設計）
  createDualSubtitleContainers() {
    this.log('創建雙語字幕容器');
    
    // 主要字幕容器（上層，較大字體）
    this.primaryContainer = this.createSubtitleContainer({
      id: 'subpal-primary-subtitle',
      fontSize: `${PRIMARY_SUB_FONT_SIZE}px`,
      fontWeight: 'bold',
      bottom: '120px',
      zIndex: 10200
    });
    
    // 次要字幕容器（下層，較小字體）
    this.secondaryContainer = this.createSubtitleContainer({
      id: 'subpal-secondary-subtitle', 
      fontSize: `${SECONDARY_SUB_FONT_SIZE}px`,
      fontWeight: 'normal',
      bottom: '80px',
      color: '#ffff00',
      zIndex: 10300
    });
    
    // 如果有雙語樣式，立即應用
    if (this.dualModeStyles) {
      this.applyDualModeStyles();
    }
    
    this.log('雙語字幕容器創建完成');
  }

  // 創建單個字幕容器的輔助方法
  createSubtitleContainer(options) {
    const container = document.createElement('div');
    container.id = options.id;
    container.style.cssText = `
      position: fixed;
      left: 50%;
      bottom: ${options.bottom};
      transform: translateX(-50%);
      z-index: ${options.zIndex};
      pointer-events: auto;
      display: none;
      text-align: center;
      font-size: ${options.fontSize};
      font-weight: ${options.fontWeight};
      color: ${options.color || '#ffffff'};
      background-color: rgba(0, 0, 0, 0.75);
      padding: 5px 10px;
      border-radius: 4px;
      text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.5);
      max-width: 80%;
      white-space: pre-wrap;
      word-wrap: break-word;
    `;
    
    document.body.appendChild(container);
    return container;
  }

  // 切換到單語模式
  switchToSingleMode() {
    this.log('切換到單語模式');
    this.isDualMode = false;
    
    // 隱藏雙語容器
    this.hideDualSubtitle();
    
    // 確保單語容器存在
    if (!this.container) {
      this.createSingleSubtitleContainer();
    }
  }

  // 切換到雙語模式
  switchToDualMode() {
    this.log('切換到雙語模式');
    this.isDualMode = true;
    
    // 隱藏單語容器
    this.hideSingleSubtitle();
    
    // 確保雙語容器存在
    if (!this.primaryContainer || !this.secondaryContainer) {
      this.createDualSubtitleContainers();
    }
  }

  // 更新字幕內容（參考原有邏輯）
  updateSubtitleContent(subtitleData) {
    if (!this.element) return;
    
    let displayText = subtitleData.text;
    
    // 調試模式添加標記
    if (this.debug) {
      displayText = `[SubPal] ${displayText}`;
      if (subtitleData.isReplaced) {
        displayText = `[替換] ${displayText}`;
      }
    }
    
    // 處理 HTML 內容（保留原有邏輯）
    if (subtitleData.htmlContent) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = subtitleData.htmlContent;
      
      // 移除所有子元素的內聯樣式
      const elements = tempDiv.querySelectorAll('*');
      elements.forEach(el => {
        el.removeAttribute('style');
      });
      
      this.element.innerHTML = tempDiv.innerHTML;
    } else {
      this.element.textContent = displayText;
    }
    
    // 從 HTML 內容解析字體大小（保留原有邏輯）
    if (subtitleData.htmlContent) {
      const fontSizeMatch = subtitleData.htmlContent.match(/font-size:(\d+(\.\d+)?px)/i);
      if (fontSizeMatch && fontSizeMatch[1]) {
        this.subtitleStyle.fontSize = fontSizeMatch[1];
      }
    }
  }

  // 應用字幕樣式（參考原有 applySubtitleStyle 實現）
  applySubtitleStyle() {
    if (!this.element) return;
    
    Object.assign(this.element.style, {
      fontSize: this.subtitleStyle.fontSize,
      fontFamily: this.subtitleStyle.fontFamily,
      fontWeight: this.subtitleStyle.fontWeight,
      fontStyle: this.subtitleStyle.fontStyle,
      color: this.subtitleStyle.color,
      backgroundColor: this.subtitleStyle.backgroundColor,
      textAlign: this.subtitleStyle.textAlign,
      padding: '5px 0px',
      borderRadius: this.subtitleStyle.borderRadius,
      textShadow: this.subtitleStyle.textShadow,
      border: this.subtitleStyle.border,
      opacity: this.subtitleStyle.opacity,
      maxWidth: this.subtitleStyle.maxWidth,
      margin: '0 auto',
      display: 'inline-block',
      boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.75)' // 模擬原生字幕效果
    });
  }

  // 更新位置（修復偏移問題）
  updatePosition(position) {
    if (!this.container || !position) return;
    
    // 位置去重，避免頻繁更新
    if (this.lastPosition && 
        Math.abs(this.lastPosition.top - position.top) < 5 &&
        Math.abs(this.lastPosition.left - position.left) < 5) {
      return;
    }
    
    this.lastPosition = { ...position };
    
    // 處理初次顯示在左上角的問題（保留原有重試機制）
    if (position.top < 10 && position.left < 10) {
      setTimeout(() => {
        if (this.currentSubtitle) {
          this.updatePosition(this.currentSubtitle.position);
        }
      }, 30);
      return;
    }
    
    // 動態位置計算：直接使用播放器適配器計算的位置
    let left = position.left;
    let top = position.top;
    
    // 處理 displayAlign 對齊方式 (只對攔截模式生效)
    if (position.displayAlign === 'after' && this.element && this.currentSubtitle?.mode === 'intercept') {
      // 底部對齊：確保字幕出現在 region 底部 (攔截模式)
      const contentHeight = this.element.offsetHeight || 0;
      if (contentHeight > 0 && contentHeight < position.height) {
        top = position.top + position.height - contentHeight;
      }
      this.log('攔截模式：應用 displayAlign=after 調整');
    }
    
    // 設置容器尺寸和位置
    this.container.style.left = `${left}px`;
    this.container.style.top = `${top}px`;
    this.container.style.width = `${position.width}px`;
    this.container.style.height = `${position.height}px`;
    
    // 確保字幕在容器內居中
    if (this.element) {
      this.element.style.width = '100%';
      this.element.style.height = '100%';
      this.element.style.display = 'flex';
      this.element.style.alignItems = 'center';
      this.element.style.justifyContent = 'center';
      this.element.style.textAlign = 'center';
    }
    
    this.log(`更新字幕位置: left=${left}, top=${top}, width=${position.width}, height=${position.height}`);
    this.log(`位置計算詳情:`, {
      originalPosition: position,
      finalLeft: left,
      finalTop: top,
      displayAlign: position.displayAlign,
      mode: this.currentSubtitle?.mode || 'unknown'
    });
  }

  // 更新雙語字幕位置（使用 region 容器邏輯）
  updateDualSubtitlePosition(position) {
    if (!this.primaryContainer || !this.secondaryContainer || !position) return;
    
    this.log('更新雙語字幕位置 (region 容器模式)', position);

    // 檢查 displayAlign 是否有變化（處理可能為空的情況）
    const newDisplayAlign = position.displayAlign || null;
    const oldDisplayAlign = this.lastPosition?.displayAlign || null;
    const hasDisplayAlignChanged = oldDisplayAlign !== newDisplayAlign;
  
    // 位置去重，避免頻繁更新
    if (this.lastPosition && 
        Math.abs(this.lastPosition.top - position.top) < 5 &&
        Math.abs(this.lastPosition.left - position.left) < 5 &&
        !hasDisplayAlignChanged) {
      return;
    }
    
    this.lastPosition = { ...position };
    
    // 處理初次顯示在左上角的問題
    if (position.top < 10 && position.left < 10) {
      setTimeout(() => {
        if (this.currentSubtitle && this.currentSubtitle.position) {
          this.updateDualSubtitlePosition(this.currentSubtitle.position);
        }
      }, 30);
      return;
    }
    
    // 使用 region 容器邏輯
    this.useRegionBasedPositioning(position);
  }

  // 使用 region 容器邏輯定位雙語字幕
  useRegionBasedPositioning(position) {
    this.log('使用 region 容器邏輯', position);
    
    // 確保 region 容器存在
    if (!this.regionContainer) {
      this.createRegionContainer(position);
    }
    
    // 更新 region 容器位置和大小
    this.updateRegionContainer(position);
    
    // 確保字幕容器在 region 內正確顯示
    this.setupSubtitlesInRegion();
  }

  // 創建 region 容器
  createRegionContainer(position) {
    this.log('創建 region 容器');
    
    // 移除舊的 region 容器（如果存在）
    if (this.regionContainer) {
      this.regionContainer.remove();
    }
    
    // 創建新的 region 容器
    this.regionContainer = document.createElement('div');
    this.regionContainer.id = 'subpal-region-container';
    this.regionContainer.style.cssText = `
      position: fixed;
      z-index: 10100;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: ${position.displayAlign === 'after' ? 'flex-end' : 'flex-start'};
      gap: 0px;
    `;
    
    // 將主要和次要語言容器移到 region 內
    this.regionContainer.appendChild(this.primaryContainer);
    this.regionContainer.appendChild(this.secondaryContainer);
    
    // 添加到頁面
    document.body.appendChild(this.regionContainer);
    
    this.log('region 容器創建完成');
    
    // 立即通知容器已創建，讓 fullscreen-handler 能及時處理
    this.notifyContainerCreated();
  }

  // 通知容器已創建
  notifyContainerCreated() {
    this.log('發送容器創建通知事件');
    
    // 使用 setTimeout 確保 DOM 更新完成後再通知
    setTimeout(() => {
      dispatchInternalEvent({
        type: 'SUBPAL_CONTAINER_CREATED',
        containerId: 'subpal-region-container',
        containerElement: this.regionContainer,
        timestamp: Date.now()
      });
      this.log('容器創建通知事件已發送');
    }, 0);
  }

  // 更新 region 容器位置和大小
  updateRegionContainer(position) {
    if (!this.regionContainer) return;
    
    this.regionContainer.style.left = `${position.left}px`;
    this.regionContainer.style.top = `${position.top}px`;
    this.regionContainer.style.width = `${position.width}px`;
    this.regionContainer.style.height = `${position.height}px`;
    
    // 更新對齊方式
    this.regionContainer.style.justifyContent = position.displayAlign === 'after' ? 'flex-end' : 'flex-start';
    
    this.log(`region 容器更新: left=${position.left}, top=${position.top}, width=${position.width}, height=${position.height}`);
  }

  // 設置字幕容器在 region 內的樣式
  setupSubtitlesInRegion() {
    if (!this.primaryContainer || !this.secondaryContainer) return;
    
    // 重置主要語言容器樣式（移除固定定位）
    this.primaryContainer.style.position = 'static';
    this.primaryContainer.style.left = 'auto';
    this.primaryContainer.style.top = 'auto';
    this.primaryContainer.style.bottom = 'auto';
    this.primaryContainer.style.transform = 'none';
    this.primaryContainer.style.maxWidth = '100%';
    this.primaryContainer.style.width = 'auto';
    this.primaryContainer.style.textAlign = 'center';
    
    // 重置次要語言容器樣式（移除固定定位）
    this.secondaryContainer.style.position = 'static';
    this.secondaryContainer.style.left = 'auto';
    this.secondaryContainer.style.top = 'auto';
    this.secondaryContainer.style.bottom = 'auto';
    this.secondaryContainer.style.transform = 'none';
    this.secondaryContainer.style.maxWidth = '100%';
    this.secondaryContainer.style.width = 'auto';
    this.secondaryContainer.style.textAlign = 'center';
    
    this.log('字幕容器在 region 內設置完成');
  }

  // 更新雙語字幕字體大小
  updateDualSubtitleFontSize() {
    if (!this.primaryContainer || !this.secondaryContainer) return;
    
    try {
      // 獲取播放器適配器實例進行動態縮放
      const playerAdapter = getPlayerAdapter();
      const playerBounds = playerAdapter.getCurrentPlayerBounds();
      
      if (!playerBounds || playerBounds.width < 100) {
        this.log('播放器邊界異常，使用固定字體大小');
        return;
      }
      
      // 基於播放器寬度動態計算字體大小
      const baseWidth = 1920; // 基準寬度
      
      // 優先從 dualModeStyles 讀取基準字體大小，如果沒有則使用全域變數
      let basePrimaryFontSize, baseSecondaryFontSize;
      
      if (this.dualModeStyles?.primary?.fontSize) {
        basePrimaryFontSize = parseInt(this.dualModeStyles.primary.fontSize);
      } else {
        basePrimaryFontSize = PRIMARY_SUB_FONT_SIZE;
      }
      
      if (this.dualModeStyles?.secondary?.fontSize) {
        baseSecondaryFontSize = parseInt(this.dualModeStyles.secondary.fontSize);
      } else {
        baseSecondaryFontSize = SECONDARY_SUB_FONT_SIZE;
      }
      
      const scaleFactor = Math.min(Math.max(playerBounds.width / baseWidth, 0.5), 2.0); // 限制縮放範圍 0.5-2.0
      
      const primaryFontSize = Math.round(basePrimaryFontSize * scaleFactor);
      const secondaryFontSize = Math.round(baseSecondaryFontSize * scaleFactor);
      
      // 應用字體大小
      this.primaryContainer.style.fontSize = `${primaryFontSize}px`;
      this.secondaryContainer.style.fontSize = `${secondaryFontSize}px`;
      
      // 同時調整行高以保持比例
      this.primaryContainer.style.lineHeight = '1.2';
      this.secondaryContainer.style.lineHeight = '1.2';
      
      // 記錄字體大小來源
      const primarySource = this.dualModeStyles?.primary?.fontSize ? '用戶設定' : '預設';
      const secondarySource = this.dualModeStyles?.secondary?.fontSize ? '用戶設定' : '預設';
      
      this.log(`更新雙語字幕字體大小 (動態縮放): 主要=${primaryFontSize}px (${primarySource}), 次要=${secondaryFontSize}px (${secondarySource}), 縮放=${scaleFactor.toFixed(2)}`);
    } catch (error) {
      this.log('更新雙語字幕字體大小失敗:', error);
    }
  }


  // 調整次要語言位置（region 容器模式下不需要，由 flex 布局自動處理）
  adjustSecondaryPosition() {
    if (this.regionContainer) {
      // 在 region 容器模式下，位置由 flex 布局自動處理
      this.log('使用 region 容器模式，位置由 flex 布局自動處理');
      return;
    }
    
    // 非 region 容器模式下的傳統邏輯（保留給可能的其他用途）
    if (!this.primaryContainer || !this.secondaryContainer) return;
    
    // 只有在兩個容器都顯示時才調整
    if (this.primaryContainer.style.display === 'none' || 
        this.secondaryContainer.style.display === 'none') {
      return;
    }
    
    // 等待DOM更新後再計算位置
    setTimeout(() => {
      try {
        const primaryRect = this.primaryContainer.getBoundingClientRect();
        
        if (primaryRect.height === 0) {
          this.log('主要語言容器尺寸為0，延遲調整位置');
          setTimeout(() => this.adjustSecondaryPosition(), 50);
          return;
        }
        
        // 參考舊代碼邏輯：獲取主要語言的實際渲染高度
        let primaryHeight = primaryRect.height;
        if (this.primaryContainer.querySelector('*')) {
          const primaryElement = this.primaryContainer.querySelector('*') || this.primaryContainer;
          const primaryComputedStyle = window.getComputedStyle(primaryElement);
          const primaryLineHeight = parseFloat(primaryComputedStyle.lineHeight) || parseFloat(primaryComputedStyle.fontSize) * 1.2;
          const primaryPadding = parseFloat(primaryComputedStyle.paddingTop) + parseFloat(primaryComputedStyle.paddingBottom);
          primaryHeight = primaryLineHeight + primaryPadding;
        }
        
        // 計算次要語言應該的位置（緊貼主要語言下方）
        const gap = 0; // 間距
        const newTop = primaryRect.top + primaryHeight + gap;
        
        // 獲取當前次要語言的 left 值（保持水平居中）
        const currentLeft = parseFloat(this.secondaryContainer.style.left) || 0;
        
        // 更新次要語言位置
        this.secondaryContainer.style.top = `${newTop}px`;
        this.secondaryContainer.style.left = `${currentLeft}px`;
        
        this.log(`調整次要語言位置: 主要語言實際高度=${primaryHeight}, 次要語言新位置=${newTop}`);
        
        // 確保次要語言不會超出視窗
        this.ensureSecondaryWithinViewport();
        
      } catch (error) {
        this.log('調整次要語言位置時出錯:', error);
      }
    }, 10); // 短暫延遲等待內容渲染完成
  }

  // 確保次要語言在視窗範圍內
  ensureSecondaryWithinViewport() {
    if (!this.secondaryContainer) return;
    
    const secondaryRect = this.secondaryContainer.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    
    // 如果次要語言超出視窗底部，向上調整
    if (secondaryRect.bottom > viewportHeight) {
      const overflow = secondaryRect.bottom - viewportHeight;
      const currentTop = parseFloat(this.secondaryContainer.style.top) || 0;
      const newTop = currentTop - overflow - 10; // 額外10px邊距
      
      this.secondaryContainer.style.top = `${newTop}px`;
      this.log(`次要語言超出視窗，調整至: ${newTop}px`);
      
      // 如果調整後次要語言會覆蓋主要語言，則隱藏次要語言
      if (this.primaryContainer && this.secondaryContainer) {
        const primaryRect = this.primaryContainer.getBoundingClientRect();
        const adjustedSecondaryRect = this.secondaryContainer.getBoundingClientRect();
        
        if (adjustedSecondaryRect.top < primaryRect.bottom) {
          this.log('次要語言會覆蓋主要語言，暫時隱藏次要語言');
          this.secondaryContainer.style.display = 'none';
        }
      }
    }
  }

  // 設置樣式
  setStyle(styleOptions) {
    this.subtitleStyle = { ...this.subtitleStyle, ...styleOptions };
    this.log('字幕樣式已更新:', styleOptions);
    
    // 如果當前有顯示的字幕，立即應用新樣式
    if (this.currentSubtitle) {
      this.applySubtitleStyle();
    }
  }

  // === 雙語樣式支持方法 (新增) ===
  
  /**
   * 設置雙語模式樣式
   * @param {Object} styles - 包含 primary 和 secondary 樣式的對象
   * @param {Object} styles.primary - 主要語言樣式
   * @param {Object} styles.secondary - 次要語言樣式
   */
  setDualModeStyles(styles) {
    if (!styles || typeof styles !== 'object') {
      console.error('無效的雙語樣式對象');
      return;
    }

    this.log('設置雙語模式樣式:', styles);
    this.dualModeStyles = { ...styles };
    
    // 如果當前處於雙語模式且有顯示的字幕，立即應用新樣式
    if (this.isDualMode && (this.primaryContainer || this.secondaryContainer)) {
      this.applyDualModeStyles();
    }
  }

  /**
   * 應用雙語模式樣式到容器
   * @param {HTMLElement} container - 目標容器
   * @param {Object} styleConfig - 樣式配置
   */
  applyStylesToContainer(container, styleConfig) {
    if (!container || !styleConfig) {
      return;
    }

    Object.assign(container.style, {
      fontSize: styleConfig.fontSize,
      fontFamily: styleConfig.fontFamily,
      fontWeight: styleConfig.fontWeight || 'normal',
      fontStyle: styleConfig.fontStyle || 'normal',
      color: styleConfig.color,
      backgroundColor: styleConfig.backgroundColor,
      textAlign: styleConfig.textAlign || 'center',
      borderRadius: styleConfig.borderRadius || '4px',
      textShadow: styleConfig.textShadow || '1px 1px 1px rgba(0, 0, 0, 0.5)',
      border: styleConfig.border || 'none',
      opacity: styleConfig.opacity || '1.0',
      padding: styleConfig.padding || '5px 10px'
    });
  }

  /**
   * 應用雙語樣式到容器
   */
  applyDualModeStyles() {
    if (!this.dualModeStyles) {
      this.log('沒有雙語樣式可供應用');
      return;
    }

    // 應用主要語言樣式
    if (this.primaryContainer && this.dualModeStyles.primary) {
      this.applyStylesToContainer(this.primaryContainer, this.dualModeStyles.primary);
      this.log('主要語言樣式已應用');
    }

    // 應用次要語言樣式
    if (this.secondaryContainer && this.dualModeStyles.secondary) {
      this.applyStylesToContainer(this.secondaryContainer, this.dualModeStyles.secondary);
      this.log('次要語言樣式已應用');
    }
  }

  /**
   * 應用樣式（配置變更時調用）
   * 根據當前模式（單語/雙語）應用最新的樣式配置
   */
  applyStyles() {
    if (!this.isInitialized || !this.configBridge) {
      this.log('字幕顯示組件未初始化或 ConfigBridge 不可用，跳過樣式應用');
      return;
    }

    this.log('應用最新樣式配置...');

    if (this.isDualMode) {
      // 雙語模式：從 ConfigBridge 讀取最新配置並應用
      const primaryFontSize = this.configBridge.get('subtitle.style.primary.fontSize');
      const primaryTextColor = this.configBridge.get('subtitle.style.primary.textColor');
      const primaryBgColor = this.configBridge.get('subtitle.style.primary.backgroundColor');
      const secondaryFontSize = this.configBridge.get('subtitle.style.secondary.fontSize');
      const secondaryTextColor = this.configBridge.get('subtitle.style.secondary.textColor');
      const secondaryBgColor = this.configBridge.get('subtitle.style.secondary.backgroundColor');
      const fontFamily = this.configBridge.get('subtitle.style.fontFamily');

      // 更新雙語樣式
      if (this.dualModeStyles) {
        this.dualModeStyles.primary = {
          ...this.dualModeStyles.primary,
          fontSize: `${primaryFontSize}px`,
          color: primaryTextColor,
          backgroundColor: primaryBgColor,
          fontFamily: fontFamily
        };

        this.dualModeStyles.secondary = {
          ...this.dualModeStyles.secondary,
          fontSize: `${secondaryFontSize}px`,
          color: secondaryTextColor,
          backgroundColor: secondaryBgColor,
          fontFamily: fontFamily
        };

        // 應用到容器
        this.applyDualModeStyles();
      } else {
        this.log('雙語樣式對象不存在，跳過樣式應用');
      }
    } else {
      // 單語模式：應用主要字幕樣式到單語容器
      if (this.element) {
        this.applyStylesToContainer(this.element, this.subtitleStyle);
        this.log('單語字幕樣式已應用');
      } else {
        this.log('單語字幕容器不存在，跳過樣式應用');
      }
    }

    this.log('樣式應用完成');
  }

  /**
   * 獲取當前雙語樣式
   * @returns {Object|null} 當前的雙語樣式對象
   */
  getDualModeStyles() {
    return this.dualModeStyles ? { ...this.dualModeStyles } : null;
  }

  /**
   * 檢查是否有雙語樣式
   * @returns {boolean} 是否設置了雙語樣式
   */
  hasDualModeStyles() {
    return !!(this.dualModeStyles && 
              this.dualModeStyles.primary && 
              this.dualModeStyles.secondary);
  }

  // 獲取當前狀態
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isDualMode: this.isDualMode,
      hasContainer: !!this.container,
      hasDualContainers: !!(this.primaryContainer && this.secondaryContainer),
      currentSubtitle: this.currentSubtitle ? {
        text: this.currentSubtitle.text?.substring(0, 50) + '...',
        isDual: this.currentSubtitle.isDualSubtitle
      } : null,
      style: this.subtitleStyle
    };
  }

  // 獲取容器元素（用於懸停事件）
  getContainer() {
    if (this.isDualMode) {
      // 雙語模式時，返回主要容器
      return this.primaryContainer;
    } else {
      // 單語模式時，返回單語容器
      return this.container;
    }
  }

  // 清理資源
  cleanup() {
    this.log('清理字幕顯示組件資源...');
    
    // 移除單語容器
    if (this.container) {
      this.container.remove();
      this.container = null;
      this.element = null;
    }
    
    // 移除 region 容器（會自動清理內部的主要和次要語言容器）
    if (this.regionContainer) {
      this.regionContainer.remove();
      this.regionContainer = null;
      this.primaryContainer = null;
      this.secondaryContainer = null;
    } else {
      // 如果沒有 region 容器，單獨清理雙語容器
      if (this.primaryContainer) {
        this.primaryContainer.remove();
        this.primaryContainer = null;
      }
      
      if (this.secondaryContainer) {
        this.secondaryContainer.remove();
        this.secondaryContainer = null;
      }
    }
    
    this.isInitialized = false;
    this.currentSubtitle = null;
    this.lastPosition = null;
    this.isDualMode = false;
    
    this.log('字幕顯示組件資源清理完成');
  }

  // 設置事件處理器
  setupEventHandlers() {
    // VIDEO_ID_CHANGED 事件現在由 UI Manager 統一處理，這裡不再需要單獨處理
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleDisplay] ${message}`, ...args);
    }
  }
}

export { SubtitleDisplay };