/**
 * 字幕樣式管理器 - 統一管理單語和雙語字幕樣式
 * 
 * 設計理念：
 * 1. 統一配置格式：使用 SubtitleStyleConfig 統一管理所有樣式配置
 * 2. 依賴注入模式：接收現有 UIManager 實例，不創建新實例
 * 3. 雙語樣式支持：支持主要和次要語言的獨立樣式配置
 * 4. 預覽功能：為設定頁面提供即時預覽功能
 * 5. 向後兼容：保持與現有樣式系統的完全兼容
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

/**
 * 預設樣式配置
 */
const DEFAULT_SUBTITLE_STYLE_CONFIG = {
  mode: 'single',  
  
  primary: {
    fontSize: 55,                           // 用戶測試的預設值
    textColor: '#ffffff',                   
    backgroundColor: 'rgba(0, 0, 0, 0.75)' // RGBA格式傳遞
  },
  
  secondary: {
    fontSize: 24,                           // 用戶測試的預設值
    textColor: '#ffff00',                   // 黃色
    backgroundColor: 'rgba(0, 0, 0, 0.75)'
  }
};

class SubtitleStyleManager {
  constructor() {
    this.isInitialized = false;
    
    // 當前樣式配置
    this.currentConfig = { ...DEFAULT_SUBTITLE_STYLE_CONFIG };
    
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
      
      // 載入用戶設定
      await this.loadSettings();
      
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

  // === 配置管理 ===
  
  /**
   * 載入保存的樣式設定
   */
  async loadSettings() {
    try {
      const result = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['subtitleStyleConfig']
      });
      
      if (result && result.subtitleStyleConfig) {
        const savedConfig = result.subtitleStyleConfig;
        
        // 驗證並應用保存的配置
        if (this.validateConfig(savedConfig)) {
          this.currentConfig = { ...this.currentConfig, ...savedConfig };
          this.log('載入用戶樣式配置:', savedConfig);
        } else {
          this.log('保存的配置無效，使用預設配置');
        }
      }
    } catch (error) {
      console.error('載入樣式設定時出錯:', error);
    }
  }

  /**
   * 保存樣式設定
   */
  async saveSettings() {
    try {
      await sendMessage({
        type: 'SAVE_SETTINGS',
        settings: {
          subtitleStyleConfig: this.currentConfig
        }
      });
      
      this.log('樣式設定已保存');
    } catch (error) {
      console.error('保存樣式設定時出錯:', error);
    }
  }

  /**
   * 獲取預設配置
   */
  getDefaultConfig() {
    return { ...DEFAULT_SUBTITLE_STYLE_CONFIG };
  }

  /**
   * 更新配置
   * @param {Object} updates - 要更新的配置項
   */
  updateConfig(updates) {
    if (!updates || typeof updates !== 'object') {
      console.error('無效的配置更新對象');
      return false;
    }

    this.log('更新樣式配置:', updates);
    
    // 深度合併配置
    this.currentConfig = this.mergeConfig(this.currentConfig, updates);
    
    // 驗證配置
    if (!this.validateConfig(this.currentConfig)) {
      console.error('更新後的配置無效，恢復預設配置');
      this.currentConfig = { ...DEFAULT_SUBTITLE_STYLE_CONFIG };
      return false;
    }
    
    return true;
  }

  /**
   * 獲取當前配置
   */
  getCurrentConfig() {
    return { ...this.currentConfig };
  }

  /**
   * 重置為預設配置
   */
  resetToDefaults() {
    this.log('重置為預設配置');
    this.currentConfig = { ...DEFAULT_SUBTITLE_STYLE_CONFIG };
    this.applyCurrentStyle();
    this.saveSettings();
  }

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
    return {
      fontSize: `${styleConfig.fontSize}px`,
      color: styleConfig.textColor,
      backgroundColor: styleConfig.backgroundColor,
      // 固定屬性
      fontFamily: 'Arial, sans-serif',
      textAlign: 'center',
      borderRadius: '4px',
      textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
      padding: '5px 10px'
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
      fontFamily: 'Arial, sans-serif',
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
    // 監聽來自 options 頁面的樣式更新
    registerInternalEventHandler('SUBTITLE_STYLE_UPDATED', (event) => {
      if (event.config) {
        this.log('接收到樣式更新事件:', event.config);
        
        // 更新配置
        if (this.updateConfig(event.config)) {
          // 應用新樣式
          this.applyCurrentStyle();
          this.log('樣式更新已應用');
        } else {
          this.log('樣式更新失敗，配置無效');
        }
      }
    });
    
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
    return {
      isInitialized: this.isInitialized,
      currentMode: this.currentConfig.mode,
      hasUIManager: !!this.uiManager,
      supportsDoubleMode: !!(this.uiManager && 
                            this.uiManager.subtitleDisplay && 
                            this.uiManager.subtitleDisplay.setDualModeStyles),
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
    this.currentConfig = { ...DEFAULT_SUBTITLE_STYLE_CONFIG };
    
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
  
  /**
   * 啟用調試模式
   * @param {boolean} enabled - 是否啟用調試模式
   */
  setDebugMode(enabled) {
    this.debug = enabled;
    this.log(`調試模式已${enabled ? '啟用' : '關閉'}`);
  }
}

export { SubtitleStyleManager, DEFAULT_SUBTITLE_STYLE_CONFIG };