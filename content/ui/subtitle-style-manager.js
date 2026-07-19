/**
 * 字幕樣式管理器 - 統一管理單語和雙語字幕樣式（重構版）
 *
 * 設計理念：
 * 1. 配置由 ConfigBridge 管理：不再直接管理配置，只訂閱配置變更
 * 2. 依賴注入模式：接收現有 UIManager 實例，不創建新實例
 * 3. 純 UI 樣式應用：專注於將配置轉換為 UI 樣式並應用
 * 4. 預覽功能：為設定頁面提供即時預覽功能
 * 5. 向後兼容：保持與現有樣式系統的完全兼容
 */

import { registerInternalEventHandler } from '../system/messaging.js';

const CUSTOM_BASE_TEXT_SHADOW = '1px 1px 1px rgba(0, 0, 0, 0.5)';

function toFiniteNumber(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toStringValue(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function toOutlineEnabled(value) {
  return value === undefined ? false : value === true;
}

function createTextOutlineShadow({ enabled, width, color, baseShadow }) {
  const safeBaseShadow = toStringValue(baseShadow, 'none');
  const safeWidth = toFiniteNumber(width, 0);

  if (!enabled || safeWidth <= 0) {
    return safeBaseShadow;
  }

  const offset = `${safeWidth}px`;
  const safeColor = toStringValue(color, '#000000');
  const outlineShadow = [
    `-${offset} 0 0 ${safeColor}`,
    `${offset} 0 0 ${safeColor}`,
    `0 -${offset} 0 ${safeColor}`,
    `0 ${offset} 0 ${safeColor}`,
    `-${offset} -${offset} 0 ${safeColor}`,
    `${offset} -${offset} 0 ${safeColor}`,
    `-${offset} ${offset} 0 ${safeColor}`,
    `${offset} ${offset} 0 ${safeColor}`
  ].join(', ');

  return safeBaseShadow === 'none' ? outlineShadow : `${outlineShadow}, ${safeBaseShadow}`;
}

class SubtitleStyleManager {
  constructor() {
    this.isInitialized = false;

    // 當前樣式配置（從 ConfigBridge 讀取）
    this.currentConfig = {
      styleMode: 'custom',
      fontPreset: 'clearSans',
      fontFamily: 'Arial, sans-serif',
      mode: 'single',
      primary: {
        fontSize: 55,
        fontWeight: '700',
        textColor: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        outlineEnabled: false,
        outlineWidth: 2,
        outlineColor: '#000000',
        letterSpacing: 0
      },
      secondary: {
        fontSize: 24,
        fontWeight: '500',
        textColor: '#ffff00',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        outlineEnabled: false,
        outlineWidth: 2,
        outlineColor: '#000000',
        letterSpacing: 0
      },
      netflixPreset: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontWeight: '700',
        textColor: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        textShadow: '0 0 2px rgba(0, 0, 0, 0.9)'
      }
    };

    // UIManager 實例引用（依賴注入）
    this.uiManager = null;

    // 調試模式
    this.debug = false;
  }

  // === 基礎 ===

  /**
   * 初始化字幕樣式管理器
   * @param {Object} uiManager - 現有的 UIManager 實例
   */
  async initialize(uiManager) {
    if (!uiManager) {
      throw new Error('SubtitleStyleManager 需要 UIManager 實例才能初始化');
    }

    this.log('字幕樣式管理器初始化中...');

    try {
      // 注入 UIManager 實例
      this.uiManager = uiManager;

      // 初始化 ConfigBridge 並讀取配置
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取所有樣式配置。ConfigBridge 的預設值來自 config-schema，這裡只負責轉成 render style。
      this.currentConfig.styleMode = configBridge.get('subtitle.style.mode');
      this.currentConfig.fontPreset = configBridge.get('subtitle.style.fontPreset');
      this.currentConfig.fontFamily = configBridge.get('subtitle.style.fontFamily');
      this.currentConfig.primary.fontSize = configBridge.get('subtitle.style.primary.fontSize');
      this.currentConfig.primary.fontWeight = configBridge.get('subtitle.style.primary.fontWeight');
      this.currentConfig.primary.textColor = configBridge.get('subtitle.style.primary.textColor');
      this.currentConfig.primary.backgroundColor = configBridge.get('subtitle.style.primary.backgroundColor');
      this.currentConfig.primary.outlineEnabled = toOutlineEnabled(configBridge.get('subtitle.style.primary.outlineEnabled'));
      this.currentConfig.primary.outlineWidth = toFiniteNumber(configBridge.get('subtitle.style.primary.outlineWidth'), 2);
      this.currentConfig.primary.outlineColor = toStringValue(configBridge.get('subtitle.style.primary.outlineColor'), '#000000');
      this.currentConfig.primary.letterSpacing = toFiniteNumber(configBridge.get('subtitle.style.primary.letterSpacing'), 0);
      this.currentConfig.secondary.fontSize = configBridge.get('subtitle.style.secondary.fontSize');
      this.currentConfig.secondary.fontWeight = configBridge.get('subtitle.style.secondary.fontWeight');
      this.currentConfig.secondary.textColor = configBridge.get('subtitle.style.secondary.textColor');
      this.currentConfig.secondary.backgroundColor = configBridge.get('subtitle.style.secondary.backgroundColor');
      this.currentConfig.secondary.outlineEnabled = toOutlineEnabled(configBridge.get('subtitle.style.secondary.outlineEnabled'));
      this.currentConfig.secondary.outlineWidth = toFiniteNumber(configBridge.get('subtitle.style.secondary.outlineWidth'), 2);
      this.currentConfig.secondary.outlineColor = toStringValue(configBridge.get('subtitle.style.secondary.outlineColor'), '#000000');
      this.currentConfig.secondary.letterSpacing = toFiniteNumber(configBridge.get('subtitle.style.secondary.letterSpacing'), 0);
      this.currentConfig.netflixPreset.fontFamily = configBridge.get('subtitle.style.netflixPreset.fontFamily');
      this.currentConfig.netflixPreset.fontWeight = configBridge.get('subtitle.style.netflixPreset.fontWeight');
      this.currentConfig.netflixPreset.textColor = configBridge.get('subtitle.style.netflixPreset.textColor');
      this.currentConfig.netflixPreset.backgroundColor = configBridge.get('subtitle.style.netflixPreset.backgroundColor');
      this.currentConfig.netflixPreset.textShadow = configBridge.get('subtitle.style.netflixPreset.textShadow');
      this.currentConfig.mode = configBridge.get('subtitle.dualModeEnabled') ? 'dual' : 'single';

      this.debug = configBridge.get('debugMode');

      this.log('樣式配置已載入:', this.currentConfig);

      // 訂閱配置變更
      const styleKeys = [
        'subtitle.style.mode',
        'subtitle.style.fontPreset',
        'subtitle.style.fontFamily',
        'subtitle.style.primary.fontSize',
        'subtitle.style.primary.fontWeight',
        'subtitle.style.primary.textColor',
        'subtitle.style.primary.backgroundColor',
        'subtitle.style.primary.outlineEnabled',
        'subtitle.style.primary.outlineWidth',
        'subtitle.style.primary.outlineColor',
        'subtitle.style.primary.letterSpacing',
        'subtitle.style.secondary.fontSize',
        'subtitle.style.secondary.fontWeight',
        'subtitle.style.secondary.textColor',
        'subtitle.style.secondary.backgroundColor',
        'subtitle.style.secondary.outlineEnabled',
        'subtitle.style.secondary.outlineWidth',
        'subtitle.style.secondary.outlineColor',
        'subtitle.style.secondary.letterSpacing',
        'subtitle.style.netflixPreset.fontFamily',
        'subtitle.style.netflixPreset.fontWeight',
        'subtitle.style.netflixPreset.textColor',
        'subtitle.style.netflixPreset.backgroundColor',
        'subtitle.style.netflixPreset.textShadow',
        'subtitle.dualModeEnabled',
        'debugMode'
      ];

      for (const key of styleKeys) {
        configBridge.subscribe(key, (newValue) => {
          this.handleStyleChange(key, newValue);
        });
      }

      this.configBridge = configBridge;

      // 設置事件處理器
      this.setupEventHandlers();

      // 應用當前樣式
      this.applyCurrentStyle();

      this.isInitialized = true;
      this.log('字幕樣式管理器初始化完成');

    } catch (error) {
      console.error('字幕樣式管理器初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 處理樣式配置變更
   */
  handleStyleChange(key, newValue) {
    this.log(`配置變更: ${key} = ${newValue}`);

    // 映射配置鍵到 currentConfig
    const keyMap = {
      'subtitle.style.mode': ['styleMode'],
      'subtitle.style.fontPreset': ['fontPreset'],
      'subtitle.style.fontFamily': ['fontFamily'],
      'subtitle.style.primary.fontSize': ['primary', 'fontSize'],
      'subtitle.style.primary.fontWeight': ['primary', 'fontWeight'],
      'subtitle.style.primary.textColor': ['primary', 'textColor'],
      'subtitle.style.primary.backgroundColor': ['primary', 'backgroundColor'],
      'subtitle.style.primary.outlineEnabled': ['primary', 'outlineEnabled'],
      'subtitle.style.primary.outlineWidth': ['primary', 'outlineWidth'],
      'subtitle.style.primary.outlineColor': ['primary', 'outlineColor'],
      'subtitle.style.primary.letterSpacing': ['primary', 'letterSpacing'],
      'subtitle.style.secondary.fontSize': ['secondary', 'fontSize'],
      'subtitle.style.secondary.fontWeight': ['secondary', 'fontWeight'],
      'subtitle.style.secondary.textColor': ['secondary', 'textColor'],
      'subtitle.style.secondary.backgroundColor': ['secondary', 'backgroundColor'],
      'subtitle.style.secondary.outlineEnabled': ['secondary', 'outlineEnabled'],
      'subtitle.style.secondary.outlineWidth': ['secondary', 'outlineWidth'],
      'subtitle.style.secondary.outlineColor': ['secondary', 'outlineColor'],
      'subtitle.style.secondary.letterSpacing': ['secondary', 'letterSpacing'],
      'subtitle.style.netflixPreset.fontFamily': ['netflixPreset', 'fontFamily'],
      'subtitle.style.netflixPreset.fontWeight': ['netflixPreset', 'fontWeight'],
      'subtitle.style.netflixPreset.textColor': ['netflixPreset', 'textColor'],
      'subtitle.style.netflixPreset.backgroundColor': ['netflixPreset', 'backgroundColor'],
      'subtitle.style.netflixPreset.textShadow': ['netflixPreset', 'textShadow'],
      'subtitle.dualModeEnabled': ['mode'],
      'debugMode': ['debug']
    };

    const path = keyMap[key];
    if (!path) return;

    if (path[0] === 'mode') {
      this.currentConfig.mode = newValue ? 'dual' : 'single';
    } else if (path[0] === 'debug') {
      this.debug = newValue;
    } else if (path.length === 1) {
      this.currentConfig[path[0]] = newValue;
    } else {
      this.currentConfig[path[0]][path[1]] = newValue;
    }

    // 立即應用新樣式
    this.applyCurrentStyle();
  }

  // === 配置管理（配置由 ConfigBridge 管理，此類只訂閱變更） ===
  // 移除 loadSettings(), saveSettings(), updateConfig(), getCurrentConfig()
  // 配置更新現在通過 ConfigBridge.set() 和自動訂閱處理

  // === 樣式應用 ===
  
  /**
   * 應用當前樣式到 UI
   */
  applyCurrentStyle() {
    if (!this.uiManager) {
      this.log('無法應用樣式：缺少 UIManager 實例');
      return;
    }

    try {
      if (this.currentConfig.mode === 'dual') {
        this.applyDualModeStyle();
      } else {
        this.applySingleModeStyle();
      }
      
      this.log('當前樣式已應用到 UI');
    } catch (error) {
      console.error('應用樣式失敗:', error);
    }
  }

  /**
   * 應用單語模式樣式
   */
  applySingleModeStyle() {
    const legacyStyle = this.configToLegacyStyle(this.currentConfig.primary);
    
    // 使用現有的 setSubtitleStyle 方法
    if (this.uiManager.setSubtitleStyle) {
      this.uiManager.setSubtitleStyle(legacyStyle);
    }

    if (this.uiManager.subtitleDisplay?.setStyleMode) {
      this.uiManager.subtitleDisplay.setStyleMode(this.currentConfig.styleMode);
    }
  }

  /**
   * 應用雙語模式樣式
   */
  applyDualModeStyle() {
    // 檢查 SubtitleDisplay 是否支持雙語樣式
    if (this.uiManager.subtitleDisplay && this.uiManager.subtitleDisplay.setDualModeStyles) {
      const styles = {
        primary: this.configToLegacyStyle(this.currentConfig.primary),
        secondary: this.configToLegacyStyle(this.currentConfig.secondary)
      };
      
      this.uiManager.subtitleDisplay.setDualModeStyles(styles);
      if (this.uiManager.subtitleDisplay.setStyleMode) {
        this.uiManager.subtitleDisplay.setStyleMode(this.currentConfig.styleMode);
      }
    } else {
      // 降級處理：使用主要語言樣式
      this.log('SubtitleDisplay 不支持雙語樣式，使用主要語言樣式');
      this.applySingleModeStyle();
    }
  }

  /**
   * 將新配置格式轉換為舊系統格式
   * @param {Object} styleConfig - 新格式的樣式配置
   * @returns {Object} 轉換後的舊格式樣式
   */
  configToLegacyStyle(styleConfig) {
    const effectiveStyle = this.getEffectiveBaseStyle(styleConfig);

    return {
      fontSize: `${effectiveStyle.fontSize}px`,
      color: effectiveStyle.textColor,
      backgroundColor: effectiveStyle.backgroundColor,
      fontFamily: effectiveStyle.fontFamily,
      fontWeight: effectiveStyle.fontWeight,
      letterSpacing: `${effectiveStyle.letterSpacing}px`,
      textAlign: 'center',
      borderRadius: '4px',
      textShadow: effectiveStyle.textShadow,
      padding: '5px 10px'
    };
  }

  /**
   * 根據外觀模式決定實際要套用的基礎樣式。
   * nativeInherit 會先使用 Netflix preset，若字幕資料帶有原生 computed style，
   * SubtitleDisplay 會在渲染當下覆蓋可繼承欄位。
   */
  getEffectiveBaseStyle(styleConfig) {
    const outlineEnabled = toOutlineEnabled(styleConfig.outlineEnabled);
    const outlineWidth = toFiniteNumber(styleConfig.outlineWidth, 2);
    const outlineColor = toStringValue(styleConfig.outlineColor, '#000000');
    const letterSpacing = toFiniteNumber(styleConfig.letterSpacing, 0);

    if (this.currentConfig.styleMode === 'netflixPreset' ||
        this.currentConfig.styleMode === 'nativeInherit') {
      const baseShadow = this.currentConfig.netflixPreset.textShadow;

      return {
        fontSize: styleConfig.fontSize,
        fontFamily: this.currentConfig.netflixPreset.fontFamily,
        fontWeight: this.currentConfig.netflixPreset.fontWeight,
        textColor: styleConfig.textColor,
        backgroundColor: styleConfig.backgroundColor,
        textShadow: createTextOutlineShadow({
          enabled: outlineEnabled,
          width: outlineWidth,
          color: outlineColor,
          baseShadow
        }),
        letterSpacing
      };
    }

    return {
      fontSize: styleConfig.fontSize,
      fontFamily: this.currentConfig.fontFamily,
      fontWeight: styleConfig.fontWeight,
      textColor: styleConfig.textColor,
      backgroundColor: styleConfig.backgroundColor,
      textShadow: createTextOutlineShadow({
        enabled: outlineEnabled,
        width: outlineWidth,
        color: outlineColor,
        baseShadow: CUSTOM_BASE_TEXT_SHADOW
      }),
      letterSpacing
    };
  }

  // === 預覽功能 ===
  
  /**
   * 生成預覽樣式
   * @param {Object} config - 樣式配置
   * @param {string} type - 樣式類型 ('primary' | 'secondary')
   * @returns {Object} 預覽樣式對象
   */
  generatePreviewStyles(config, type = 'primary') {
    const styleConfig = config[type];
    
    return {
      fontSize: `${styleConfig.fontSize}px`,
      color: styleConfig.textColor,
      backgroundColor: styleConfig.backgroundColor,
      // 預覽專用樣式
      display: 'inline-block',
      padding: '8px 16px',
      borderRadius: '4px',
      textAlign: 'center',
      fontFamily: config.fontFamily || 'Arial, sans-serif',
      fontWeight: styleConfig.fontWeight || '400',
      textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
      minWidth: '100px',
      margin: '5px'
    };
  }

  /**
   * 將預覽樣式應用到指定元素
   * @param {HTMLElement} element - 目標元素
   * @param {Object} config - 樣式配置
   * @param {string} type - 樣式類型 ('primary' | 'secondary')
   */
  applyPreviewToElement(element, config, type) {
    if (!element) {
      console.error('無效的預覽元素');
      return;
    }

    const previewStyles = this.generatePreviewStyles(config, type);
    
    // 應用樣式到元素
    Object.keys(previewStyles).forEach(property => {
      element.style[property] = previewStyles[property];
    });
    
    this.log(`預覽樣式已應用到元素 (${type})`);
  }

  // === 事件處理 ===

  /**
   * 設置事件處理器
   */
  setupEventHandlers() {
    registerInternalEventHandler('UI_COMPONENTS_REINITIALIZED', (event) => {
      this.log('收到 UI 元件重建事件，重新套用字幕樣式:', event);
      this.applyCurrentStyle();
    });

    // 樣式配置更新已由 ConfigBridge 訂閱處理；UI 重建事件只負責重放目前設定。
    this.log('事件處理器設置完成');
  }

  // === 工具方法 ===
  
  /**
   * 驗證配置格式
   * @param {Object} config - 要驗證的配置
   * @returns {boolean} 驗證結果
   */
  validateConfig(config) {
    if (!config || typeof config !== 'object') {
      return false;
    }

    // 檢查基本結構
    if (!config.mode || !['single', 'dual'].includes(config.mode)) {
      return false;
    }

    // 檢查 primary 配置
    if (!this.validateStyleConfig(config.primary)) {
      return false;
    }

    // 如果是雙語模式，檢查 secondary 配置
    if (config.mode === 'dual' && !this.validateStyleConfig(config.secondary)) {
      return false;
    }

    return true;
  }

  /**
   * 驗證單個樣式配置
   * @param {Object} styleConfig - 樣式配置
   * @returns {boolean} 驗證結果
   */
  validateStyleConfig(styleConfig) {
    if (!styleConfig || typeof styleConfig !== 'object') {
      return false;
    }

    // 檢查必要屬性
    if (typeof styleConfig.fontSize !== 'number' || 
        styleConfig.fontSize < 12 || 
        styleConfig.fontSize > 100) {
      return false;
    }

    if (typeof styleConfig.textColor !== 'string' || 
        !styleConfig.textColor.match(/^#[0-9a-fA-F]{6}$/)) {
      return false;
    }

    if (typeof styleConfig.backgroundColor !== 'string') {
      return false;
    }

    return true;
  }

  /**
   * 深度合併配置對象
   * @param {Object} target - 目標對象
   * @param {Object} source - 源對象
   * @returns {Object} 合併後的對象
   */
  mergeConfig(target, source) {
    const result = { ...target };
    
    Object.keys(source).forEach(key => {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.mergeConfig(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    });
    
    return result;
  }

  /**
   * 獲取管理器狀態
   */
  getStatus() {
    const subtitleDisplay = this.uiManager?.subtitleDisplay || null;

    return {
      isInitialized: this.isInitialized,
      currentMode: this.currentConfig.mode,
      styleMode: this.currentConfig.styleMode,
      hasUIManager: !!this.uiManager,
      hasSubtitleDisplay: !!subtitleDisplay,
      supportsDoubleMode: !!(this.uiManager && 
                            this.uiManager.subtitleDisplay && 
                            this.uiManager.subtitleDisplay.setDualModeStyles),
      appliedSingleStyle: subtitleDisplay?.subtitleStyle ? { ...subtitleDisplay.subtitleStyle } : null,
      appliedDualStyles: subtitleDisplay?.getDualModeStyles ? subtitleDisplay.getDualModeStyles() : null,
      currentConfig: { ...this.currentConfig }
    };
  }

  /**
   * 清理資源
   */
  cleanup() {
    this.log('清理字幕樣式管理器資源...');
    
    this.isInitialized = false;
    this.uiManager = null;
    
    this.log('字幕樣式管理器資源清理完成');
  }

  /**
   * 日誌輸出
   */
  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubtitleStyleManager] ${message}`, ...args);
    }
  }
  // setDebugMode() 移除，debug mode 由 ConfigBridge 管理
}

export { SubtitleStyleManager };
