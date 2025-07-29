/**
 * 雙語字幕UI管理器 - 與單語字幕系統並行運作
 * 
 * 此模組負責：
 * 1. 創建雙語字幕顯示容器
 * 2. 跟隨原生字幕的位置和大小變化
 * 3. 管理主要和次要語言字幕的顯示
 * 4. 提供fallback機制回退到單語系統
 * 5. 預留自訂樣式接口
 */

import { sendMessage, registerInternalEventHandler } from './messaging.js';
import { getCurrentTimestamp } from './video-info.js';

// Z-index 層級管理
const DUAL_SUBTITLE_Z_INDEX = {
  PRIMARY: 10200,    // 主要語言字幕
  SECONDARY: 10300   // 次要語言字幕 (在主要語言之上)
};

// 調試模式
let debugMode = false;

function debugLog(...args) {
  if (debugMode) {
    console.log('[DualSubtitleUI]', ...args);
  }
}

/**
 * 雙語字幕UI管理器類
 */
class DualSubtitleUI {
  constructor() {
    this.isInitialized = false;
    this.isActive = false;
    
    // UI 元素
    this.primaryContainer = null;
    this.secondaryContainer = null;
    this.primaryElement = null;
    this.secondaryElement = null;
    
    // 當前顯示的字幕數據
    this.currentDualSubtitle = null;
    this.currentTimestamp = 0;
    
    // 位置跟蹤
    this.lastNativePosition = null;
    this.positionUpdateInterval = null;
    
    // 樣式配置 (預留自訂樣式接口)
    this.styleConfig = this.getDefaultStyleConfig();
    
    // 回調函數
    this.onFallbackRequired = null;
  }

  /**
   * 獲取預設樣式配置
   */
  getDefaultStyleConfig() {
    return {
      // 位置設定
      position: {
        followNative: true,
        groupOffset: { x: 0, y: -20 }, // 整體字幕組合向上偏移20px
        primaryOffset: { x: 0, y: 0 },  // 主要語言相對於組合起點
        secondaryOffset: { x: 0, y: 0 } // 次要語言緊貼主要語言下方
      },
      
      // 大小設定
      size: {
        useNativeAsBase: true,
        primarySizeMultiplier: 1.0,     // 主要語言使用與原生相同大小
        secondarySizeMultiplier: 0.6,  // 次要語言更小一點以示區別
        userSizeOffset: 0
      },
      
      // 字體設定 (預留接口)
      font: {
        primary: {
          fontFamily: 'inherit',
          fontWeight: 'bold',
          color: '#ffffff',
          textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
          backgroundColor: 'rgba(0,0,0,0.7)',
          borderRadius: '4px',
          padding: '4px 8px'
        },
        secondary: {
          fontFamily: 'inherit', 
          fontWeight: 'normal',
          color: '#ffff00',
          textShadow: '1px 1px 2px rgba(0,0,0,0.6)',
          backgroundColor: 'rgba(0,0,0,0.5)',
          borderRadius: '4px',
          padding: '4px 8px'
        }
      }
    };
  }

  /**
   * 初始化雙語字幕UI
   */
  async initialize() {
    debugLog('初始化雙語字幕UI...');
    
    try {
      // 載入設定
      await this.loadSettings();
      
      // 創建UI容器
      this.createDualSubtitleContainers();
      
      // 設置事件監聽
      this.setupEventListeners();
      
      // 開始位置監聽
      this.startPositionTracking();
      
      this.isInitialized = true;
      debugLog('雙語字幕UI初始化完成');
      
      return true;
    } catch (error) {
      console.error('初始化雙語字幕UI失敗:', error);
      return false;
    }
  }

  /**
   * 載入設定
   */
  async loadSettings() {
    try {
      const settings = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['debugMode', 'dualSubtitleStyle']
      });
      
      if (settings) {
        debugMode = settings.debugMode || false;
        
        // 預留：載入用戶自訂樣式設定
        if (settings.dualSubtitleStyle) {
          this.styleConfig = { ...this.styleConfig, ...settings.dualSubtitleStyle };
        }
        
        debugLog('雙語字幕UI設定已載入');
      }
    } catch (error) {
      console.error('載入雙語字幕UI設定失敗:', error);
    }
  }

  /**
   * 創建雙語字幕容器
   */
  createDualSubtitleContainers() {
    debugLog('創建雙語字幕容器...');
    
    // 清理舊容器
    this.removeDualSubtitleContainers();
    
    // 尋找視頻播放器
    const videoPlayer = document.querySelector('.watch-video, .NFPlayer, video, .VideoContainer, .nf-player-container, [data-uia="video-player"]');
    if (!videoPlayer) {
      throw new Error('找不到視頻播放器元素');
    }
    
    // 創建主要語言容器
    this.primaryContainer = document.createElement('div');
    this.primaryContainer.id = 'subpal-primary-subtitle-container';
    this.primaryContainer.style.cssText = `
      position: fixed;
      z-index: ${DUAL_SUBTITLE_Z_INDEX.PRIMARY};
      pointer-events: none;
      display: none;
      text-align: center;
      max-width: 80%;
      word-wrap: break-word;
    `;
    
    this.primaryElement = document.createElement('div');
    this.primaryElement.id = 'subpal-primary-subtitle';
    this.primaryContainer.appendChild(this.primaryElement);
    
    // 創建次要語言容器
    this.secondaryContainer = document.createElement('div');
    this.secondaryContainer.id = 'subpal-secondary-subtitle-container';
    this.secondaryContainer.style.cssText = `
      position: fixed;
      z-index: ${DUAL_SUBTITLE_Z_INDEX.SECONDARY};
      pointer-events: none;
      display: none;
      text-align: center;
      max-width: 80%;
      word-wrap: break-word;
    `;
    
    this.secondaryElement = document.createElement('div');
    this.secondaryElement.id = 'subpal-secondary-subtitle';
    this.secondaryContainer.appendChild(this.secondaryElement);
    
    // 附加到播放器
    videoPlayer.appendChild(this.primaryContainer);
    videoPlayer.appendChild(this.secondaryContainer);
    
    // 應用預設樣式
    this.applySubtitleStyles();
    
    debugLog('雙語字幕容器創建完成');
  }

  /**
   * 移除雙語字幕容器
   */
  removeDualSubtitleContainers() {
    if (this.primaryContainer) {
      this.primaryContainer.remove();
      this.primaryContainer = null;
      this.primaryElement = null;
    }
    
    if (this.secondaryContainer) {
      this.secondaryContainer.remove();
      this.secondaryContainer = null;
      this.secondaryElement = null;
    }
    
    debugLog('雙語字幕容器已移除');
  }

  /**
   * 應用字幕樣式
   */
  applySubtitleStyles() {
    if (!this.primaryElement || !this.secondaryElement) {
      return;
    }
    
    const primaryStyle = this.styleConfig.font.primary;
    const secondaryStyle = this.styleConfig.font.secondary;
    
    // 應用主要語言樣式
    Object.assign(this.primaryElement.style, {
      fontFamily: primaryStyle.fontFamily,
      fontWeight: primaryStyle.fontWeight,
      color: primaryStyle.color,
      textShadow: primaryStyle.textShadow,
      backgroundColor: primaryStyle.backgroundColor,
      borderRadius: primaryStyle.borderRadius,
      padding: primaryStyle.padding,
      display: 'inline-block',
      whiteSpace: 'pre-line'
    });
    
    // 應用次要語言樣式
    Object.assign(this.secondaryElement.style, {
      fontFamily: secondaryStyle.fontFamily,
      fontWeight: secondaryStyle.fontWeight,
      color: secondaryStyle.color,
      textShadow: secondaryStyle.textShadow,
      backgroundColor: secondaryStyle.backgroundColor,
      borderRadius: secondaryStyle.borderRadius,
      padding: secondaryStyle.padding,
      display: 'inline-block',
      whiteSpace: 'pre-line'
    });
    
    debugLog('字幕樣式已應用');
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
    
    // 監聽視頻變更
    registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => {
      debugLog('視頻ID變更，重新創建雙語字幕容器');
      this.createDualSubtitleContainers();
    });
    
    // 監聽全螢幕變更
    document.addEventListener('fullscreenchange', () => {
      debugLog('全螢幕狀態變更，重新調整位置');
      setTimeout(() => {
        this.updateSubtitlePositions();
      }, 100);
    });
    
    // 監聽視窗大小變更
    window.addEventListener('resize', () => {
      debugLog('視窗大小變更，重新調整位置');
      setTimeout(() => {
        this.updateSubtitlePositions();
      }, 100);
    });
  }

  /**
   * 開始位置跟蹤
   */
  startPositionTracking() {
    if (this.positionUpdateInterval) {
      clearInterval(this.positionUpdateInterval);
    }
    
    // 每 100ms 檢查一次原生字幕位置變化
    this.positionUpdateInterval = setInterval(() => {
      if (this.isActive) {
        this.updateSubtitlePositions();
      }
    }, 100);
    
    debugLog('位置跟蹤已開始');
  }

  /**
   * 停止位置跟蹤
   */
  stopPositionTracking() {
    if (this.positionUpdateInterval) {
      clearInterval(this.positionUpdateInterval);
      this.positionUpdateInterval = null;
    }
    
    debugLog('位置跟蹤已停止');
  }

  /**
   * 更新字幕位置
   */
  updateSubtitlePositions() {
    if (!this.primaryContainer || !this.secondaryContainer) {
      return;
    }
    
    // 獲取原生字幕容器位置
    const nativeSubtitle = document.querySelector('.player-timedtext-text-container');
    if (!nativeSubtitle) {
      // 如果找不到原生字幕，隱藏雙語字幕UI（可能是字幕消失了）
      // debugLog('找不到原生字幕容器，隱藏雙語字幕UI');
      this.hideSubtitles();
      return;
    }
    
    // 檢查原生字幕是否實際可見（有內容）
    const nativeText = nativeSubtitle.textContent?.trim();
    if (!nativeText) {
      // 原生字幕容器存在但沒有內容，也隱藏雙語字幕
      // debugLog('原生字幕容器無內容，隱藏雙語字幕UI');
      this.hideSubtitles();
      return;
    }
    
    const nativeRect = nativeSubtitle.getBoundingClientRect();
    
    // 檢查位置是否有變化
    if (this.lastNativePosition && 
        Math.abs(this.lastNativePosition.top - nativeRect.top) < 5 &&
        Math.abs(this.lastNativePosition.left - nativeRect.left) < 5) {
      return; // 位置變化不大，不需要更新
    }
    
    this.lastNativePosition = { ...nativeRect };
    
    // 計算主要語言位置
    const primaryPosition = this.calculatePosition(nativeRect, false);
    this.applyPosition(this.primaryContainer, primaryPosition, nativeRect);
    
    // 計算次要語言位置
    const secondaryPosition = this.calculatePosition(nativeRect, true);
    this.applyPosition(this.secondaryContainer, secondaryPosition, nativeRect);
    
    // 更新字體大小
    this.updateFontSizes(nativeSubtitle);
    
    // debugLog('字幕位置已更新');
  }

  /**
   * 計算字幕位置 - 實現黏在一起的效果
   */
  calculatePosition(nativeRect, isSecondary) {
    const groupOffset = this.styleConfig.position.groupOffset;
    const baseTop = nativeRect.top + groupOffset.y;
    const baseLeft = nativeRect.left + groupOffset.x;
    
    if (isSecondary) {
      // 次要語言：計算主要語言容器的實際高度，然後緊貼在下方
      let primaryHeight = nativeRect.height;
      if (this.primaryElement) {
        // 獲取主要語言的實際渲染高度
        const primaryComputedStyle = window.getComputedStyle(this.primaryElement);
        const primaryLineHeight = parseFloat(primaryComputedStyle.lineHeight) || parseFloat(primaryComputedStyle.fontSize) * 1.2;
        const primaryPadding = parseFloat(primaryComputedStyle.paddingTop) + parseFloat(primaryComputedStyle.paddingBottom);
        primaryHeight = primaryLineHeight + primaryPadding;
        
        // debugLog('主要語言容器高度計算:', {
        //   原生高度: nativeRect.height,
        //   行高: primaryLineHeight,
        //   padding: primaryPadding,
        //   計算高度: primaryHeight
        // });
      }
      
      return {
        top: baseTop + primaryHeight, // 緊貼主要語言下方
        left: baseLeft,
        width: nativeRect.width,
        height: nativeRect.height
      };
    } else {
      // 主要語言：基於原生位置加上組合偏移
      return {
        top: baseTop,
        left: baseLeft,
        width: nativeRect.width,
        height: nativeRect.height
      };
    }
  }

  /**
   * 應用位置到容器 - 採用舊系統的寬度計算邏輯
   */
  applyPosition(container, position, nativeRect) {
    // 獲取播放器元素以計算最大寬度
    const videoPlayer = document.querySelector('.watch-video, .NFPlayer, video, .VideoContainer, .nf-player-container, [data-uia="video-player"]');
    let maxWidth = 800; // 預設最大寬度
    if (videoPlayer) {
      const playerRect = videoPlayer.getBoundingClientRect();
      maxWidth = playerRect.width * 0.8; // 播放器寬度的 80%
    }
    
    // 計算當前字幕文本所需的寬度
    let textWidth = 0;
    const isSecondary = container.id.includes('secondary');
    const textElement = isSecondary ? this.secondaryElement : this.primaryElement;
    
    if (textElement && textElement.textContent) {
      textWidth = this.calculateTextWidth(textElement.textContent, textElement);
      debugLog(`${isSecondary ? '次要' : '主要'}語言字幕文本所需寬度:`, textWidth);
    }
    
    // 計算目標寬度（與舊系統相同邏輯）
    const targetWidth = Math.min(maxWidth, Math.max(nativeRect.width, textWidth + 20)); // 加上20px padding
    
    container.style.top = `${position.top}px`;
    container.style.width = `${targetWidth}px`;
    container.style.minHeight = `${nativeRect.height}px`;
    
    // 居中對齊容器
    const leftPosition = nativeRect.left + (nativeRect.width - targetWidth) / 2;
    container.style.left = `${leftPosition}px`;
    
    debugLog(`${isSecondary ? '次要' : '主要'}語言容器寬度調整:`, {
      原生寬度: nativeRect.width,
      文字寬度: textWidth,
      目標寬度: targetWidth,
      最大寬度: maxWidth
    });
  }

  /**
   * 計算文本所需的寬度 - 移植自舊系統
   */
  calculateTextWidth(text, referenceElement) {
    // 創建臨時元素
    const tempElement = document.createElement('div');
    tempElement.style.position = 'absolute';
    tempElement.style.visibility = 'hidden';
    tempElement.style.whiteSpace = 'nowrap'; // 確保單行測量
    
    // 應用與參考元素相同的樣式
    if (referenceElement) {
      const computedStyle = window.getComputedStyle(referenceElement);
      tempElement.style.fontSize = computedStyle.fontSize;
      tempElement.style.fontFamily = computedStyle.fontFamily;
      tempElement.style.fontWeight = computedStyle.fontWeight;
      tempElement.style.fontStyle = computedStyle.fontStyle;
      tempElement.style.padding = computedStyle.padding;
    }
    
    // 插入文本內容
    tempElement.textContent = text;
    
    // 添加到 DOM 以進行測量
    document.body.appendChild(tempElement);
    
    // 獲取寬度
    const width = tempElement.offsetWidth;
    
    // 移除臨時元素
    document.body.removeChild(tempElement);
    
    return width;
  }

  /**
   * 更新字體大小 - 採用與舊系統相同的方法
   */
  updateFontSizes(nativeSubtitle) {
    let baseFontSize = null;
    
    // 方法1: 嘗試從原生字幕HTML內容解析字體大小 (與舊系統相同)
    const nativeHTML = nativeSubtitle.innerHTML;
    if (nativeHTML) {
      const fontSizeMatch = nativeHTML.match(/font-size:(\d+(\.\d+)?px)/i);
      if (fontSizeMatch && fontSizeMatch[1]) {
        baseFontSize = parseFloat(fontSizeMatch[1]);
        debugLog('從原生字幕HTML解析字體大小:', fontSizeMatch[1], '解析結果:', baseFontSize);
      }
    }
    
    // 方法2: 如果HTML解析失敗，從computedStyle獲取
    if (!baseFontSize) {
      const nativeStyle = window.getComputedStyle(nativeSubtitle);
      baseFontSize = parseFloat(nativeStyle.fontSize);
      debugLog('從computedStyle獲取字體大小:', nativeStyle.fontSize, '解析結果:', baseFontSize);
      
      // 嘗試從子元素獲取
      if (!baseFontSize || baseFontSize < 10) {
        const textElement = nativeSubtitle.querySelector('span') || nativeSubtitle;
        if (textElement) {
          const textStyle = window.getComputedStyle(textElement);
          baseFontSize = parseFloat(textStyle.fontSize);
          debugLog('從文本元素獲取字體大小:', textStyle.fontSize, '解析結果:', baseFontSize);
        }
      }
    }
    
    // 方法3: 如果仍然無法獲取，使用舊系統的預設值邏輯
    if (!baseFontSize || baseFontSize < 10) {
      baseFontSize = 28; // 與舊系統預設值相同
      debugLog('使用與舊系統相同的預設字體大小:', baseFontSize, 'px');
    }
    
    // 計算主要語言字體大小
    const primarySize = (baseFontSize * this.styleConfig.size.primarySizeMultiplier) + 
                       this.styleConfig.size.userSizeOffset;
    this.primaryElement.style.fontSize = `${primarySize}px`;
    
    // 計算次要語言字體大小
    const secondarySize = (baseFontSize * this.styleConfig.size.secondarySizeMultiplier) + 
                         this.styleConfig.size.userSizeOffset;
    this.secondaryElement.style.fontSize = `${secondarySize}px`;
    
    debugLog('雙語字幕字體大小設定:', {
      基礎大小: baseFontSize,
      主要語言: primarySize,
      次要語言: secondarySize
    });
  }

  /**
   * 備用位置策略
   */
  useBackupPositioning() {
    debugLog('使用備用位置策略');
    
    const videoPlayer = document.querySelector('.watch-video, .NFPlayer, video, .VideoContainer, .nf-player-container, [data-uia="video-player"]');
    if (!videoPlayer) {
      return;
    }
    
    const playerRect = videoPlayer.getBoundingClientRect();
    const bottomPosition = playerRect.top + playerRect.height - 120;
    
    // 主要語言位置
    this.primaryContainer.style.top = `${bottomPosition}px`;
    this.primaryContainer.style.left = `${playerRect.left}px`;
    this.primaryContainer.style.width = `${playerRect.width}px`;
    
    // 次要語言位置 (下移35px)
    this.secondaryContainer.style.top = `${bottomPosition + 35}px`;
    this.secondaryContainer.style.left = `${playerRect.left}px`;
    this.secondaryContainer.style.width = `${playerRect.width}px`;
  }

  /**
   * 啟用雙語字幕顯示
   */
  activate() {
    if (!this.isInitialized) {
      debugLog('雙語字幕UI未初始化，無法啟用');
      return false;
    }
    
    this.isActive = true;
    debugLog('雙語字幕UI已啟用');
    return true;
  }

  /**
   * 停用雙語字幕顯示
   */
  deactivate() {
    this.isActive = false;
    this.hideSubtitles();
    debugLog('雙語字幕UI已停用');
  }

  /**
   * 顯示雙語字幕
   */
  showDualSubtitle(dualSubtitleData) {
    if (!this.isActive || !this.primaryContainer || !this.secondaryContainer) {
      return;
    }
    
    this.currentDualSubtitle = dualSubtitleData;
    
    // 顯示主要語言字幕（支援Netflix分行格式）
    if (dualSubtitleData.primaryText) {
      this.primaryElement.innerHTML = this.formatNetflixSubtitleText(dualSubtitleData.primaryText);
      this.primaryContainer.style.display = 'block';
    } else {
      this.primaryContainer.style.display = 'none';
    }
    
    // 顯示次要語言字幕（支援Netflix分行格式）
    if (dualSubtitleData.secondaryText) {
      this.secondaryElement.innerHTML = this.formatNetflixSubtitleText(dualSubtitleData.secondaryText);
      this.secondaryContainer.style.display = 'block';
    } else {
      this.secondaryContainer.style.display = 'none';
    }
    
    // 確保位置正確
    this.updateSubtitlePositions();
    
    debugLog('雙語字幕已顯示:', {
      primary: dualSubtitleData.primaryText,
      secondary: dualSubtitleData.secondaryText
    });
  }

  /**
   * 格式化Netflix字幕文本 - 處理分行
   */
  formatNetflixSubtitleText(text) {
    if (!text) return '';
    
    // 處理Netflix的分行格式
    // 將 \n 轉換為 <br>，並保持原有的HTML格式
    let formattedText = text
      .replace(/\n/g, '<br>')  // 處理換行符
      .replace(/\r/g, '')      // 移除回車符
      .trim();
    
    // 確保安全的HTML輸出（防止XSS）
    // 但保留必要的HTML標籤如 <br>
    formattedText = formattedText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/&lt;br&gt;/g, '<br>'); // 恢復 <br> 標籤
    
    debugLog('格式化字幕文本:', {
      原始: text,
      格式化後: formattedText,
      包含換行: text.includes('\n'),
      換行數量: (text.match(/\n/g) || []).length,
      最終HTML: formattedText
    });
    
    return formattedText;
  }

  /**
   * 隱藏字幕
   */
  hideSubtitles() {
    if (this.primaryContainer) {
      this.primaryContainer.style.display = 'none';
    }
    if (this.secondaryContainer) {
      this.secondaryContainer.style.display = 'none';
    }
    
    this.currentDualSubtitle = null;
    debugLog('雙語字幕已隱藏');
  }

  /**
   * 檢查是否需要fallback到單語系統
   */
  checkFallbackRequired() {
    // 檢查原生字幕容器是否存在
    const nativeSubtitle = document.querySelector('.player-timedtext-text-container');
    if (!nativeSubtitle) {
      debugLog('原生字幕容器不存在，可能需要fallback');
      if (this.onFallbackRequired) {
        this.onFallbackRequired('native-subtitle-not-found');
      }
      return true;
    }
    
    return false;
  }

  /**
   * 設置fallback回調
   */
  setFallbackCallback(callback) {
    this.onFallbackRequired = callback;
  }

  /**
   * 清理資源
   */
  destroy() {
    this.stopPositionTracking();
    this.removeDualSubtitleContainers();
    this.isInitialized = false;
    this.isActive = false;
    debugLog('雙語字幕UI已清理');
  }
}

// 創建單例實例
const dualSubtitleUI = new DualSubtitleUI();

/**
 * 初始化雙語字幕UI
 */
export async function initDualSubtitleUI() {
  debugLog('開始初始化雙語字幕UI...');
  
  try {
    const success = await dualSubtitleUI.initialize();
    if (success) {
      debugLog('雙語字幕UI初始化成功');
    } else {
      debugLog('雙語字幕UI初始化失敗');
    }
    return success;
  } catch (error) {
    console.error('初始化雙語字幕UI時出錯:', error);
    return false;
  }
}

/**
 * 獲取雙語字幕UI實例
 */
export function getDualSubtitleUI() {
  return dualSubtitleUI;
}

/**
 * 啟用雙語字幕顯示
 */
export function activateDualSubtitleUI() {
  return dualSubtitleUI.activate();
}

/**
 * 停用雙語字幕顯示
 */
export function deactivateDualSubtitleUI() {
  dualSubtitleUI.deactivate();
}

/**
 * 顯示雙語字幕
 */
export function showDualSubtitle(dualSubtitleData) {
  dualSubtitleUI.showDualSubtitle(dualSubtitleData);
}

/**
 * 隱藏雙語字幕
 */
export function hideDualSubtitle() {
  dualSubtitleUI.hideSubtitles();
}

/**
 * 設置fallback回調
 */
export function setFallbackCallback(callback) {
  dualSubtitleUI.setFallbackCallback(callback);
}

debugLog('雙語字幕UI模組已載入');