/**
 * ConfigManager - 中央配置管理器
 *
 * 職責：
 * - 統一管理所有配置項
 * - 提供配置讀寫 API
 * - 自動設置預設值
 * - 配置變更通知（Observable pattern）
 * - 配置驗證
 * - 配置緩存
 *
 * @module config-manager
 */

import { StorageAdapter } from './storage-adapter.js';
import {
  CONFIG_SCHEMA,
  SUPPORTED_LANGUAGES,
  flattenSchema,
  getDefaultValues,
  validateConfigValue,
  getConfigMetadata,
  getAllConfigKeys,
  getConfigKeysByCategory,
  getSupportedLanguageCodes,
  isLanguageSupported,
  getLanguageName
} from './config-schema.js';

/**
 * ConfigManager 類
 * 中央配置管理器，所有模組通過它訪問配置
 */
export class ConfigManager {
  constructor(options = {}) {
    // Storage 適配器
    this.storage = options.storage || new StorageAdapter(options);

    // 配置緩存（扁平化的鍵值對）
    this.cache = new Map();

    // 訂閱者管理（key -> Set<callback>）
    this.subscribers = new Map();

    // 初始化標記
    this.isInitialized = false;

    // 調試模式
    this.debug = options.debug || false;

    // Storage 變化監聽取消函數
    this.unwatchStorage = null;
  }

  /**
   * 初始化配置管理器
   * 這是 ConfigManager 的入口點，必須先調用此方法
   *
   * 執行步驟：
   * 1. 初始化 StorageAdapter
   * 2. 載入所有配置到緩存
   * 3. 設置缺失的預設值
   * 4. 監聽 storage 變化
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.isInitialized) {
      this.log('ConfigManager 已經初始化');
      return;
    }

    this.log('開始初始化 ConfigManager...');

    try {
      // 1. 初始化 StorageAdapter
      await this.storage.initialize();

      // 2. 獲取所有配置鍵
      const allKeys = getAllConfigKeys();
      this.log(`總共 ${allKeys.length} 個配置鍵`);

      // 3. 從 storage 讀取現有配置（批量讀取）
      const storedConfig = await this.storage.getBatch(allKeys);
      this.log('已載入現有配置:', Object.keys(storedConfig).length);

      // 4. 獲取預設值
      const defaults = getDefaultValues();

      // 5. 找出缺失的配置（需要設置預設值的）
      const configToSet = {};
      for (const [key, defaultValue] of Object.entries(defaults)) {
        if (storedConfig[key] === undefined) {
          configToSet[key] = defaultValue;
          storedConfig[key] = defaultValue;
        }
      }

      // 6. 將缺失的預設值寫入 storage
      if (Object.keys(configToSet).length > 0) {
        this.log(`設置 ${Object.keys(configToSet).length} 個預設值`);
        await this.storage.setBatch(configToSet);
      }

      // 7. 載入配置到緩存
      for (const [key, value] of Object.entries(storedConfig)) {
        this.cache.set(key, value);
      }

      // 8. 監聽 storage 變化
      this.unwatchStorage = this.storage.watch((changes) => {
        this.handleStorageChange(changes);
      });

      this.isInitialized = true;
      this.log('ConfigManager 初始化完成');
    } catch (error) {
      this.error('ConfigManager 初始化失敗:', error);
      // 使用預設值填充緩存
      const defaults = getDefaultValues();
      for (const [key, value] of Object.entries(defaults)) {
        this.cache.set(key, value);
      }
      throw error;
    }
  }

  // ==================== 配置讀取 ====================

  /**
   * 獲取配置值
   * 支援點記法訪問巢狀配置
   *
   * @param {string} key - 配置鍵（支援點記法，如 'subtitle.primaryLanguage'）
   * @returns {any} 配置值
   *
   * @example
   * const debugMode = configManager.get('debugMode');
   * const fontSize = configManager.get('subtitle.style.primary.fontSize');
   */
  get(key) {
    this.ensureInitialized();

    if (!this.cache.has(key)) {
      this.warn(`配置鍵 "${key}" 不存在`);
      return undefined;
    }

    return this.cache.get(key);
  }

  /**
   * 批量獲取配置
   *
   * @param {string[]} keys - 配置鍵陣列
   * @returns {Object} 配置對象
   *
   * @example
   * const config = configManager.getMultiple([
   *   'debugMode',
   *   'subtitle.primaryLanguage'
   * ]);
   */
  getMultiple(keys) {
    this.ensureInitialized();

    const result = {};
    for (const key of keys) {
      result[key] = this.get(key);
    }
    return result;
  }

  /**
   * 獲取所有配置
   *
   * @returns {Object} 所有配置（扁平化的鍵值對）
   */
  getAll() {
    this.ensureInitialized();

    const result = {};
    for (const [key, value] of this.cache.entries()) {
      result[key] = value;
    }
    return result;
  }

  /**
   * 獲取指定分類的配置
   *
   * @param {string} category - 分類名稱
   * @returns {Object} 該分類的配置
   *
   * @example
   * const subtitleConfig = configManager.getByCategory('subtitle');
   */
  getByCategory(category) {
    this.ensureInitialized();

    const keys = getConfigKeysByCategory(category);
    return this.getMultiple(keys);
  }

  // ==================== 配置寫入 ====================

  /**
   * 設置配置值
   * 會自動驗證、更新緩存、寫入 storage 並通知訂閱者
   *
   * @param {string} key - 配置鍵
   * @param {any} value - 配置值
   * @returns {Promise<void>}
   *
   * @example
   * await configManager.set('debugMode', true);
   * await configManager.set('subtitle.primaryLanguage', 'en');
   */
  async set(key, value) {
    this.ensureInitialized();

    // 1. 驗證配置值
    const validation = validateConfigValue(key, value);
    if (!validation.valid) {
      throw new Error(`配置驗證失敗: ${validation.error}`);
    }

    // 2. 獲取舊值（用於通知）
    const oldValue = this.cache.get(key);

    // 3. 更新緩存
    this.cache.set(key, value);

    // 4. 寫入 storage
    try {
      await this.storage.setBatch({ [key]: value });
    } catch (error) {
      // 寫入失敗，回滾緩存
      this.cache.set(key, oldValue);
      throw error;
    }

    // 5. 通知訂閱者
    this.notifySubscribers(key, value, oldValue);

    this.log(`配置已更新: ${key} = ${JSON.stringify(value)}`);
  }

  /**
   * 批量設置配置
   *
   * @param {Object} items - 配置對象（鍵值對）
   * @returns {Promise<void>}
   *
   * @example
   * await configManager.setMultiple({
   *   'debugMode': true,
   *   'subtitle.primaryLanguage': 'en'
   * });
   */
  async setMultiple(items) {
    this.ensureInitialized();

    // 1. 驗證所有配置值
    const validations = {};
    for (const [key, value] of Object.entries(items)) {
      const validation = validateConfigValue(key, value);
      if (!validation.valid) {
        throw new Error(`配置驗證失敗 (${key}): ${validation.error}`);
      }
      validations[key] = { oldValue: this.cache.get(key), newValue: value };
    }

    // 2. 批量更新緩存
    for (const [key, value] of Object.entries(items)) {
      this.cache.set(key, value);
    }

    // 3. 批量寫入 storage
    try {
      await this.storage.setBatch(items);
    } catch (error) {
      // 寫入失敗，回滾所有緩存
      for (const [key, { oldValue }] of Object.entries(validations)) {
        this.cache.set(key, oldValue);
      }
      throw error;
    }

    // 4. 通知所有相關訂閱者
    for (const [key, { newValue, oldValue }] of Object.entries(validations)) {
      this.notifySubscribers(key, newValue, oldValue);
    }

    this.log(`批量更新 ${Object.keys(items).length} 個配置`);
  }

  /**
   * 重置配置為預設值
   *
   * @param {string|string[]} keys - 要重置的配置鍵（可選，不提供則重置所有）
   * @returns {Promise<void>}
   */
  async reset(keys = null) {
    this.ensureInitialized();

    const defaults = getDefaultValues();
    const itemsToReset = {};

    if (keys === null) {
      // 重置所有配置
      Object.assign(itemsToReset, defaults);
    } else {
      // 重置指定配置
      const keysArray = Array.isArray(keys) ? keys : [keys];
      for (const key of keysArray) {
        if (defaults[key] !== undefined) {
          itemsToReset[key] = defaults[key];
        }
      }
    }

    await this.setMultiple(itemsToReset);
    this.log(`已重置 ${Object.keys(itemsToReset).length} 個配置`);
  }

  // ==================== 訂閱機制 ====================

  /**
   * 訂閱配置變更
   * 支援細粒度訂閱，只訂閱需要的配置項
   *
   * @param {string|string[]} keys - 配置鍵或鍵陣列
   * @param {Function} callback - 回調函數 (key, newValue, oldValue) => void
   * @returns {Function} 取消訂閱函數
   *
   * @example
   * // 訂閱單個配置
   * const unsubscribe = configManager.subscribe('debugMode', (key, newValue, oldValue) => {
   *   console.log(`${key} 從 ${oldValue} 變更為 ${newValue}`);
   * });
   *
   * // 取消訂閱
   * unsubscribe();
   *
   * @example
   * // 訂閱多個配置
   * const unsubscribe = configManager.subscribe(
   *   ['subtitle.primaryLanguage', 'subtitle.secondaryLanguage'],
   *   (key, newValue, oldValue) => {
   *     console.log(`語言設置變更: ${key}`);
   *   }
   * );
   */
  subscribe(keys, callback) {
    this.ensureInitialized();

    if (typeof callback !== 'function') {
      throw new Error('callback 必須是函數');
    }

    const keysArray = Array.isArray(keys) ? keys : [keys];
    const unsubscribeFunctions = [];

    for (const key of keysArray) {
      if (!this.subscribers.has(key)) {
        this.subscribers.set(key, new Set());
      }

      this.subscribers.get(key).add(callback);

      // 創建取消訂閱函數
      const unsubscribe = () => {
        const callbacks = this.subscribers.get(key);
        if (callbacks) {
          callbacks.delete(callback);
        }
      };

      unsubscribeFunctions.push(unsubscribe);
    }

    this.log(`新增訂閱: ${keysArray.join(', ')}`);

    // 返回統一的取消訂閱函數
    return () => {
      unsubscribeFunctions.forEach(fn => fn());
      this.log(`取消訂閱: ${keysArray.join(', ')}`);
    };
  }

  /**
   * 通知訂閱者
   * @private
   */
  notifySubscribers(key, newValue, oldValue) {
    const callbacks = this.subscribers.get(key);
    if (!callbacks || callbacks.size === 0) {
      return;
    }

    this.log(`通知 ${callbacks.size} 個訂閱者: ${key}`);

    for (const callback of callbacks) {
      try {
        callback(key, newValue, oldValue);
      } catch (error) {
        this.error(`執行訂閱回調時發生錯誤 (${key}):`, error);
      }
    }
  }

  /**
   * 處理 storage 變化
   * 當其他地方（如 options 頁面）修改配置時觸發
   *
   * @private
   */
  handleStorageChange(changes) {
    this.log('Storage 變化:', changes);

    for (const [storageKey, { oldValue, newValue }] of Object.entries(changes)) {
      // 處理巢狀配置（從 storage 的巢狀結構提取扁平化的鍵）
      this.processStorageChange(storageKey, oldValue, newValue);
    }
  }

  /**
   * 處理單個 storage 變化
   * @private
   */
  processStorageChange(storageKey, oldValue, newValue) {
    const allKeys = getAllConfigKeys();

    // 檢查是否有匹配的配置鍵
    for (const configKey of allKeys) {
      if (configKey === storageKey || configKey.startsWith(storageKey + '.')) {
        // 更新緩存
        const currentValue = this.cache.get(configKey);
        const extractedValue = this.extractNestedValue(newValue, configKey.replace(storageKey + '.', ''));

        if (extractedValue !== undefined && extractedValue !== currentValue) {
          this.cache.set(configKey, extractedValue);
          this.notifySubscribers(configKey, extractedValue, currentValue);
        }
      }
    }
  }

  /**
   * 從巢狀對象中提取值
   * @private
   */
  extractNestedValue(obj, path) {
    if (!path) return obj;

    const keys = path.split('.');
    let value = obj;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }

  // ==================== 語言管理功能 ====================

  /**
   * 獲取所有支持的語言列表
   *
   * @returns {Array<{code: string, name: string}>} 語言列表
   */
  getSupportedLanguages() {
    return [...SUPPORTED_LANGUAGES];
  }

  /**
   * 獲取所有支持的語言代碼
   *
   * @returns {string[]} 語言代碼陣列
   */
  getSupportedLanguageCodes() {
    return getSupportedLanguageCodes();
  }

  /**
   * 檢查語言代碼是否支持
   *
   * @param {string} languageCode - 語言代碼
   * @returns {boolean} 是否支持
   */
  isLanguageSupported(languageCode) {
    return isLanguageSupported(languageCode);
  }

  /**
   * 獲取語言名稱
   *
   * @param {string} languageCode - 語言代碼
   * @returns {string} 語言名稱
   */
  getLanguageName(languageCode) {
    return getLanguageName(languageCode);
  }

  // ==================== 輔助方法 ====================

  /**
   * 獲取配置項的元數據
   *
   * @param {string} key - 配置鍵
   * @returns {Object|null} 元數據或 null
   */
  getMetadata(key) {
    return getConfigMetadata(key);
  }

  /**
   * 獲取配置 Schema
   *
   * @returns {Object} 配置 Schema
   */
  getSchema() {
    return CONFIG_SCHEMA;
  }

  /**
   * 獲取扁平化的 Schema
   *
   * @returns {Object} 扁平化的 Schema
   */
  getFlatSchema() {
    return flattenSchema(CONFIG_SCHEMA);
  }

  /**
   * 獲取統計信息
   *
   * @returns {Object} 統計信息
   */
  getStats() {
    return {
      configCount: this.cache.size,
      subscriberCount: this.subscribers.size,
      isInitialized: this.isInitialized,
      storageStats: this.storage.getStats()
    };
  }

  /**
   * 確保已初始化
   * @private
   */
  ensureInitialized() {
    if (!this.isInitialized) {
      throw new Error('ConfigManager 未初始化。請先調用 initialize() 方法。');
    }
  }

  /**
   * 清理資源
   */
  cleanup() {
    // 取消 storage 監聽
    if (this.unwatchStorage) {
      this.unwatchStorage();
      this.unwatchStorage = null;
    }

    // 清除訂閱者
    this.subscribers.clear();

    // 清除緩存
    this.cache.clear();

    // 清理 storage
    if (this.storage) {
      this.storage.cleanup();
    }

    this.isInitialized = false;
    this.log('ConfigManager 資源已清理');
  }

  /**
   * 設置調試模式
   *
   * @param {boolean} enabled - 是否啟用
   */
  setDebugMode(enabled) {
    this.debug = enabled;
    if (this.storage) {
      this.storage.setDebugMode(enabled);
    }
  }

  // ==================== 日誌方法 ====================

  /**
   * 輸出日誌
   * @private
   */
  log(...args) {
    if (this.debug) {
      console.log('[ConfigManager]', ...args);
    }
  }

  /**
   * 輸出警告
   * @private
   */
  warn(...args) {
    if (this.debug) {
      console.warn('[ConfigManager]', ...args);
    }
  }

  /**
   * 輸出錯誤
   * @private
   */
  error(...args) {
    console.error('[ConfigManager]', ...args);
  }
}

/**
 * 創建 ConfigManager 實例的工廠函數
 *
 * @param {Object} options - 配置選項
 * @returns {ConfigManager} ConfigManager 實例
 */
export function createConfigManager(options = {}) {
  return new ConfigManager(options);
}

// 導出單例實例（預設實例）
export const configManager = new ConfigManager();
