/**
 * SubPal 配置 Schema 定義
 *
 * 定義所有配置項的結構、預設值、類型和驗證規則
 * 這是配置管理系統的單一真相來源（Single Source of Truth）
 *
 * @module config-schema
 */

/**
 * 支持的語言列表
 * 從 dual-subtitle-config.js 遷移
 */
export const SUPPORTED_LANGUAGES = [
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

/**
 * 獲取所有支持的語言代碼
 */
export function getSupportedLanguageCodes() {
  return SUPPORTED_LANGUAGES.map(lang => lang.code);
}

/**
 * 檢查語言代碼是否支持
 */
export function isLanguageSupported(languageCode) {
  return SUPPORTED_LANGUAGES.some(lang => lang.code === languageCode);
}

/**
 * 獲取語言名稱
 */
export function getLanguageName(languageCode) {
  const language = SUPPORTED_LANGUAGES.find(lang => lang.code === languageCode);
  return language ? language.name : languageCode;
}

/**
 * 字幕外觀模式
 * custom: 使用 SubPal 自訂樣式
 * netflixPreset: 使用穩定的 Netflix 原生風格預設
 */
export const SUBTITLE_STYLE_MODES = [
  { value: 'custom', label: '自訂' },
  { value: 'netflixPreset', label: 'Netflix 原生風格' }
];

/**
 * 字幕字體風格預設
 * UI 顯示簡單名稱，實際渲染使用跨平台 fallback stack。
 */
export const SUBTITLE_FONT_PRESETS = [
  {
    value: 'system',
    label: '系統預設',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", Arial, sans-serif'
  },
  {
    value: 'clearSans',
    label: '清晰黑體',
    fontFamily: '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", Arial, sans-serif'
  },
  {
    value: 'serif',
    label: '襯線字體',
    fontFamily: 'Georgia, "Times New Roman", "Noto Serif TC", "PMingLiU", "Songti TC", serif'
  },
  {
    value: 'code',
    label: '方正字體',
    fontFamily: 'Consolas, "Courier New", "SF Mono", "Liberation Mono", Menlo, "Noto Sans Mono CJK TC", monospace'
  }
];

export const SUBTITLE_FONT_WEIGHT_OPTIONS = [
  { value: '400', label: '一般' },
  { value: '700', label: '粗體' }
];

export function isSubtitleStyleModeSupported(value) {
  return SUBTITLE_STYLE_MODES.some(mode => mode.value === value);
}

export function isSubtitleFontPresetSupported(value) {
  return SUBTITLE_FONT_PRESETS.some(preset => preset.value === value);
}

export function isSubtitleFontWeightSupported(value) {
  return SUBTITLE_FONT_WEIGHT_OPTIONS.some(weight => weight.value === value);
}

/**
 * 配置 Schema 定義
 *
 * 每個配置項包含：
 * - type: 資料類型
 * - default: 預設值
 * - description: 配置描述
 * - validation: 驗證函數（可選）
 * - min/max: 數值範圍（可選）
 * - editable: 是否可編輯（可選，預設 true）
 */
export const CONFIG_SCHEMA = {
  // ==================== 調試與功能開關 ====================

  /**
   * 調試模式開關
   * 控制是否輸出詳細的調試日誌
   */
  debugMode: {
    type: 'boolean',
    default: false,
    description: '調試模式開關',
    category: 'system'
  },

  /**
   * 擴充功能總開關
   * 控制整個擴充功能是否啟用
   */
  isEnabled: {
    type: 'boolean',
    default: true,
    description: '擴充功能總開關',
    category: 'system'
  },

  // ==================== 字幕設定 ====================

  subtitle: {
    /**
     * 雙語字幕模式開關
     * true: 顯示雙語字幕, false: 僅顯示主要語言字幕
     */
    dualModeEnabled: {
      type: 'boolean',
      default: true,
      description: '雙語字幕模式開關',
      category: 'subtitle'
    },

    /**
     * 主要字幕語言
     * 預設為繁體中文
     */
    primaryLanguage: {
      type: 'string',
      default: 'zh-Hant',
      description: '主要字幕語言',
      category: 'subtitle',
      validation: (value) => {
        if (typeof value !== 'string') return false;
        return isLanguageSupported(value);
      },
      validationError: '不支持的語言代碼'
    },

    /**
     * 次要字幕語言
     * 預設為英文
     */
    secondaryLanguage: {
      type: 'string',
      default: 'en',
      description: '次要字幕語言',
      category: 'subtitle',
      validation: (value) => {
        if (typeof value !== 'string') return false;
        return isLanguageSupported(value);
      },
      validationError: '不支持的語言代碼'
    },

    /**
     * 字幕樣式配置
     * 分為主要語言（primary）和次要語言（secondary）兩組樣式
     */
    style: {
      /**
       * 字幕外觀模式
       */
      mode: {
        type: 'string',
        default: 'custom',
        description: '字幕外觀模式',
        category: 'subtitle-style',
        validation: (value) => {
          if (typeof value !== 'string') return false;
          return isSubtitleStyleModeSupported(value);
        },
        validationError: '不支持的字幕外觀模式'
      },

      /**
       * 主要語言字幕樣式
       */
      primary: {
        /**
         * 主要字幕字體大小（像素）
         */
        fontSize: {
          type: 'number',
          default: 55,
          min: 12,
          max: 100,
          description: '主要字幕字體大小（px）',
          category: 'subtitle-style'
        },

        /**
         * 主要字幕字體顏色
         * 預設為白色
         */
        textColor: {
          type: 'string',
          default: '#ffffff',
          description: '主要字幕字體顏色',
          category: 'subtitle-style',
          validation: (value) => {
            if (typeof value !== 'string') return false;
            return /^#[0-9a-fA-F]{6}$/.test(value);
          },
          validationError: '顏色必須為 6 位十六進制格式（如 #ffffff）'
        },

        /**
         * 主要字幕背景顏色
         * 使用 RGBA 格式以支持透明度
         */
        backgroundColor: {
          type: 'string',
          default: 'rgba(0, 0, 0, 0.75)',
          description: '主要字幕背景顏色',
          category: 'subtitle-style',
          validation: (value) => {
            if (typeof value !== 'string') return false;
            // 驗證 rgba 或 rgb 格式
            return /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(value);
          },
          validationError: '背景顏色必須為 rgb 或 rgba 格式'
        },

        /**
         * 主要字幕字重
         */
        fontWeight: {
          type: 'string',
          default: '700',
          description: '主要字幕字重',
          category: 'subtitle-style',
          validation: (value) => {
            if (typeof value !== 'string') return false;
            return isSubtitleFontWeightSupported(value);
          },
          validationError: '不支持的字幕字重'
        }
      },

      /**
       * 次要語言字幕樣式
       */
      secondary: {
        /**
         * 次要字幕字體大小（像素）
         */
        fontSize: {
          type: 'number',
          default: 24,
          min: 12,
          max: 100,
          description: '次要字幕字體大小（px）',
          category: 'subtitle-style'
        },

        /**
         * 次要字幕字體顏色
         * 預設為黃色以區分主要字幕
         */
        textColor: {
          type: 'string',
          default: '#ffff00',
          description: '次要字幕字體顏色',
          category: 'subtitle-style',
          validation: (value) => {
            if (typeof value !== 'string') return false;
            return /^#[0-9a-fA-F]{6}$/.test(value);
          },
          validationError: '顏色必須為 6 位十六進制格式（如 #ffffff）'
        },

        /**
         * 次要字幕背景顏色
         * 使用 RGBA 格式以支持透明度
         */
        backgroundColor: {
          type: 'string',
          default: 'rgba(0, 0, 0, 0.75)',
          description: '次要字幕背景顏色',
          category: 'subtitle-style',
          validation: (value) => {
            if (typeof value !== 'string') return false;
            // 驗證 rgba 或 rgb 格式
            return /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(value);
          },
          validationError: '背景顏色必須為 rgb 或 rgba 格式'
        },

        /**
         * 次要字幕字重
         */
        fontWeight: {
          type: 'string',
          default: '500',
          description: '次要字幕字重',
          category: 'subtitle-style',
          validation: (value) => {
            if (typeof value !== 'string') return false;
            return isSubtitleFontWeightSupported(value);
          },
          validationError: '不支持的字幕字重'
        }
      },

      /**
       * 字體風格預設
       */
      fontPreset: {
        type: 'string',
        default: 'clearSans',
        description: '字幕字體風格',
        category: 'subtitle-style',
        validation: (value) => {
          if (typeof value !== 'string') return false;
          return isSubtitleFontPresetSupported(value);
        },
        validationError: '不支持的字幕字體風格'
      },

      /**
       * 實際用於渲染的 CSS font-family fallback stack
       */
      fontFamily: {
        type: 'string',
        default: 'Arial, Helvetica, "Microsoft JhengHei", "PingFang TC", sans-serif',
        description: '字體家族',
        category: 'subtitle-style',
        validation: (value) => {
          if (typeof value !== 'string') return false;
          return value.trim().length > 0 && value.length <= 300;
        },
        validationError: '字體家族必須為非空字串'
      },

      /**
       * Netflix 原生風格預設
       * 不開放 UI 編輯，用於 netflixPreset/nativeInherit fallback。
       */
      netflixPreset: {
        fontFamily: {
          type: 'string',
          default: 'Arial, Helvetica, sans-serif',
          description: 'Netflix 原生風格字體',
          category: 'subtitle-style',
          editable: false
        },
        fontWeight: {
          type: 'string',
          default: '700',
          description: 'Netflix 原生風格字重',
          category: 'subtitle-style',
          editable: false
        },
        textColor: {
          type: 'string',
          default: '#ffffff',
          description: 'Netflix 原生風格文字顏色',
          category: 'subtitle-style',
          editable: false
        },
        backgroundColor: {
          type: 'string',
          default: 'rgba(0, 0, 0, 0.75)',
          description: 'Netflix 原生風格背景顏色',
          category: 'subtitle-style',
          editable: false
        },
        textShadow: {
          type: 'string',
          default: '0 0 2px rgba(0, 0, 0, 0.9)',
          description: 'Netflix 原生風格文字陰影',
          category: 'subtitle-style',
          editable: false
        }
      }
    }
  },

  // ==================== API 設定 ====================

  /**
   * API 基礎 URL
   */
  api: {
    baseUrl: {
      type: 'string',
      default: 'https://subnfbackend.zeabur.app',
      description: 'API 基礎 URL',
      category: 'api',
      validation: (value) => {
        if (typeof value !== 'string') return false;
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      },
      validationError: '必須為有效的 URL'
    }
  },

  // ==================== 用戶資料 ====================

  user: {
    /**
     * 用戶 ID
     */
    userId: {
      type: 'string',
      default: '',
      description: '用戶 ID',
      category: 'user'
    }
  },

  // ==================== 影片資訊 ====================

  video: {
    /**
     * 當前播放的影片 ID
     */
    currentVideoId: {
      type: 'string',
      default: '',
      description: '當前影片 ID',
      category: 'video'
    },

    /**
     * 當前播放的影片標題
     */
    currentVideoTitle: {
      type: 'string',
      default: '',
      description: '當前影片標題',
      category: 'video'
    },

    /**
     * 當前影片的語言
     */
    currentVideoLanguage: {
      type: 'string',
      default: '',
      description: '當前影片語言',
      category: 'video'
    }
  }
};

/**
 * 將巢狀配置結構扁平化為點記法鍵值對
 * 例如：{ subtitle: { style: { primary: { fontSize: 55 } } } }
 * 轉換為：{ 'subtitle.style.primary.fontSize': 55 }
 *
 * @param {Object} schema - 配置 schema
 * @param {string} prefix - 鍵前綴
 * @returns {Object} 扁平化的配置對象
 */
export function flattenSchema(schema, prefix = '') {
  const result = {};

  for (const [key, value] of Object.entries(schema)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    // 如果有 type 屬性，表示這是一個配置項
    if (value.type) {
      result[fullKey] = value;
    } else {
      // 否則繼續遞歸
      Object.assign(result, flattenSchema(value, fullKey));
    }
  }

  return result;
}

/**
 * 獲取所有配置的預設值
 *
 * @returns {Object} 預設值對象（使用點記法鍵）
 */
export function getDefaultValues() {
  const flatSchema = flattenSchema(CONFIG_SCHEMA);
  const defaults = {};

  for (const [key, schema] of Object.entries(flatSchema)) {
    defaults[key] = schema.default;
  }

  return defaults;
}

/**
 * 驗證配置值
 *
 * @param {string} key - 配置鍵（點記法）
 * @param {any} value - 要驗證的值
 * @returns {{ valid: boolean, error?: string }} 驗證結果
 */
export function validateConfigValue(key, value) {
  const flatSchema = flattenSchema(CONFIG_SCHEMA);
  const schema = flatSchema[key];

  if (!schema) {
    return { valid: false, error: `未知的配置鍵: ${key}` };
  }

  // 類型檢查
  const valueType = Array.isArray(value) ? 'array' : typeof value;
  if (valueType !== schema.type) {
    return {
      valid: false,
      error: `類型錯誤: 期望 ${schema.type}，得到 ${valueType}`
    };
  }

  // 自定義驗證
  if (schema.validation && !schema.validation(value)) {
    return {
      valid: false,
      error: schema.validationError || '驗證失敗'
    };
  }

  // 數值範圍檢查
  if (schema.type === 'number') {
    if (schema.min !== undefined && value < schema.min) {
      return { valid: false, error: `值必須 >= ${schema.min}` };
    }
    if (schema.max !== undefined && value > schema.max) {
      return { valid: false, error: `值必須 <= ${schema.max}` };
    }
  }

  return { valid: true };
}

/**
 * 獲取配置項的元數據
 *
 * @param {string} key - 配置鍵（點記法）
 * @returns {Object|null} 配置項的 schema 或 null
 */
export function getConfigMetadata(key) {
  const flatSchema = flattenSchema(CONFIG_SCHEMA);
  return flatSchema[key] || null;
}

/**
 * 獲取所有配置鍵（扁平化）
 *
 * @returns {string[]} 所有配置鍵的數組
 */
export function getAllConfigKeys() {
  const flatSchema = flattenSchema(CONFIG_SCHEMA);
  return Object.keys(flatSchema);
}

/**
 * 根據分類獲取配置鍵
 *
 * @param {string} category - 分類名稱
 * @returns {string[]} 該分類下的所有配置鍵
 */
export function getConfigKeysByCategory(category) {
  const flatSchema = flattenSchema(CONFIG_SCHEMA);
  return Object.entries(flatSchema)
    .filter(([_, schema]) => schema.category === category)
    .map(([key, _]) => key);
}
