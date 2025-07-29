/**
 * 雙語字幕配置管理器
 * 
 * 基於 SubPal 消息傳遞架構，提供雙語字幕設置管理
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class DualSubtitleConfig {
  constructor() {
    this.settings = {
      dualSubtitleEnabled: true,
      primaryLanguage: 'zh-Hant',
      secondaryLanguage: 'en'
    };
    
    // 支持的語言列表（常用語言）
    this.supportedLanguages = [
      { code: 'zh-Hant', name: '繁體中文' },
      { code: 'zh-Hans', name: '简体中文' },
      { code: 'en', name: 'English' },
      { code: 'ja', name: '日本語' },
      { code: 'ko', name: '한국어' },
      { code: 'es', name: 'Español' },
      { code: 'fr', name: 'Français' },
      { code: 'de', name: 'Deutsch' },
      { code: 'it', name: 'Italiano' },
      { code: 'pt', name: 'Português' },
      { code: 'ru', name: 'Русский' },
      { code: 'ar', name: 'العربية' },
      { code: 'th', name: 'ไทย' },
      { code: 'vi', name: 'Tiếng Việt' },
      { code: 'id', name: 'Bahasa Indonesia' },
      { code: 'ms', name: 'Bahasa Melayu' },
      { code: 'hi', name: 'हिन्दी' },
      { code: 'tr', name: 'Türkçe' },
      { code: 'nl', name: 'Nederlands' },
      { code: 'pl', name: 'Polski' },
      { code: 'sv', name: 'Svenska' }
    ];
    
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;
    
    // 載入現有設置
    await this.loadSettings();
    
    // 註冊內部事件處理器
    this.setupEventHandlers();
    
    this.isInitialized = true;
  }

  // 載入設置（通過 Background Script 的 storage 模組）
  async loadSettings() {
    try {
      const response = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['dualSubtitleEnabled', 'primaryLanguage', 'secondaryLanguage', 'subtitleStyleConfig']
      });
      
      if (response && response.success) {
        // 優先從 subtitleStyleConfig.mode 讀取雙語設定（設定頁面格式）
        let dualSubtitleEnabled = true; // 預設值
        
        if (response.subtitleStyleConfig && response.subtitleStyleConfig.mode) {
          // 從設定頁面的 subtitleStyleConfig.mode 讀取
          dualSubtitleEnabled = response.subtitleStyleConfig.mode === 'dual';
          console.log(`[DualSubtitleConfig] 從 subtitleStyleConfig.mode 讀取: ${response.subtitleStyleConfig.mode} -> ${dualSubtitleEnabled}`);
        } else if (response.dualSubtitleEnabled !== undefined) {
          // 降級方案：從教學頁面的 dualSubtitleEnabled 讀取
          dualSubtitleEnabled = response.dualSubtitleEnabled;
          console.log(`[DualSubtitleConfig] 從 dualSubtitleEnabled 讀取: ${dualSubtitleEnabled}`);
        }
        
        this.settings = {
          dualSubtitleEnabled: dualSubtitleEnabled,
          primaryLanguage: response.primaryLanguage || 'zh-Hant',
          secondaryLanguage: response.secondaryLanguage || 'en'
        };
        
        console.log('[DualSubtitleConfig] 最終載入的設置:', this.settings);
      }
    } catch (error) {
      console.error('載入雙語字幕設置失敗:', error);
    }
  }

  // 保存設置（通過 Background Script 的 storage 模組）
  async saveSettings() {
    try {
      // 同時更新兩種格式以確保兼容性
      const settingsToSave = {
        // 教學頁面格式
        dualSubtitleEnabled: this.settings.dualSubtitleEnabled,
        primaryLanguage: this.settings.primaryLanguage,
        secondaryLanguage: this.settings.secondaryLanguage
      };
      
      // 也需要更新 subtitleStyleConfig.mode（設定頁面格式）
      const modeValue = this.settings.dualSubtitleEnabled ? 'dual' : 'single';
      console.log(`[DualSubtitleConfig] 保存設置: dualSubtitleEnabled=${this.settings.dualSubtitleEnabled} -> mode=${modeValue}`);
      
      const response = await sendMessage({
        type: 'SAVE_SETTINGS',
        settings: settingsToSave
      });
      
      if (response && response.success) {
        // 額外更新 subtitleStyleConfig.mode
        try {
          const updateModeResponse = await sendMessage({
            type: 'UPDATE_SUBTITLE_STYLE_MODE',
            mode: modeValue
          });
          
          if (updateModeResponse && updateModeResponse.success) {
            console.log(`[DualSubtitleConfig] subtitleStyleConfig.mode 已更新為: ${modeValue}`);
          }
        } catch (modeError) {
          console.warn('[DualSubtitleConfig] 更新 subtitleStyleConfig.mode 失敗，但主要設置已保存:', modeError);
        }
        
        // 通知設置變更（內部事件）
        this.notifySettingsChanged();
      } else {
        throw new Error(response?.error || '保存設置失敗');
      }
    } catch (error) {
      console.error('保存雙語字幕設置失敗:', error);
      throw error;
    }
  }

  // 獲取當前設置
  getSettings() {
    return { ...this.settings };
  }

  // 設置雙語字幕開關
  async setDualSubtitleEnabled(enabled) {
    this.settings.dualSubtitleEnabled = enabled;
    await this.saveSettings();
  }

  // 設置主要語言
  async setPrimaryLanguage(languageCode) {
    if (!this.isLanguageSupported(languageCode)) {
      throw new Error(`不支持的語言代碼: ${languageCode}`);
    }
    
    this.settings.primaryLanguage = languageCode;
    await this.saveSettings();
  }

  // 設置次要語言
  async setSecondaryLanguage(languageCode) {
    if (!this.isLanguageSupported(languageCode)) {
      throw new Error(`不支持的語言代碼: ${languageCode}`);
    }
    
    this.settings.secondaryLanguage = languageCode;
    await this.saveSettings();
  }

  // 同時設置兩種語言
  async setLanguages(primaryLanguage, secondaryLanguage) {
    if (!this.isLanguageSupported(primaryLanguage) || !this.isLanguageSupported(secondaryLanguage)) {
      throw new Error(`不支持的語言代碼: ${primaryLanguage} 或 ${secondaryLanguage}`);
    }
    
    this.settings.primaryLanguage = primaryLanguage;
    this.settings.secondaryLanguage = secondaryLanguage;
    await this.saveSettings();
  }

  // 檢查語言是否支持
  isLanguageSupported(languageCode) {
    return this.supportedLanguages.some(lang => lang.code === languageCode);
  }

  // 獲取語言名稱
  getLanguageName(languageCode) {
    const language = this.supportedLanguages.find(lang => lang.code === languageCode);
    return language ? language.name : languageCode;
  }

  // 獲取支持的語言列表
  getSupportedLanguages() {
    return [...this.supportedLanguages];
  }

  // 獲取設置摘要
  getSettingsSummary() {
    return {
      enabled: this.settings.dualSubtitleEnabled,
      primaryLanguage: {
        code: this.settings.primaryLanguage,
        name: this.getLanguageName(this.settings.primaryLanguage)
      },
      secondaryLanguage: {
        code: this.settings.secondaryLanguage,
        name: this.getLanguageName(this.settings.secondaryLanguage)
      }
    };
  }

  // 通知設置變更（內部事件）
  notifySettingsChanged() {
    // 使用內部事件通知其他模組
    const event = {
      type: 'DUAL_SUBTITLE_SETTINGS_CHANGED',
      dualSubtitleEnabled: this.settings.dualSubtitleEnabled,
      primaryLanguage: this.settings.primaryLanguage,
      secondaryLanguage: this.settings.secondaryLanguage
    };
    
    // 直接分發內部事件（不通過 Background Script）
    this.dispatchInternalEvent(event);
  }

  // 分發內部事件
  dispatchInternalEvent(event) {
    // 創建自定義事件
    const customEvent = new CustomEvent('internalEvent', {
      detail: event
    });
    
    // 在 document 上觸發事件
    document.dispatchEvent(customEvent);
  }

  // 設置事件處理器
  setupEventHandlers() {
    // 監聽其他地方的設置變更（例如從 options 頁面）
    registerInternalEventHandler('DUAL_SUBTITLE_SETTINGS_CHANGED', (event) => {
      // 更新本地設置
      if (event.dualSubtitleEnabled !== undefined) {
        this.settings.dualSubtitleEnabled = event.dualSubtitleEnabled;
      }
      if (event.primaryLanguage) {
        this.settings.primaryLanguage = event.primaryLanguage;
      }
      if (event.secondaryLanguage) {
        this.settings.secondaryLanguage = event.secondaryLanguage;
      }
      
      console.log('雙語字幕設置已更新:', this.settings);
    });
  }

  // 重置為默認設置
  async resetToDefaults() {
    this.settings = {
      dualSubtitleEnabled: true,
      primaryLanguage: 'zh-Hant',
      secondaryLanguage: 'en'
    };
    await this.saveSettings();
  }

  // 獲取狀態
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      settings: this.getSettings(),
      supportedLanguagesCount: this.supportedLanguages.length
    };
  }
}

// 創建全局實例
const dualSubtitleConfig = new DualSubtitleConfig();

// 導出
export { DualSubtitleConfig, dualSubtitleConfig };