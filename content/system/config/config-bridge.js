/**
 * ConfigBridge - Page Context 配置橋接器
 *
 * 在 page context 中使用，通過 messaging 系統與
 * content script 的 ConfigManager 通信
 *
 * 職責：
 * - 在 page context 中提供配置訪問接口
 * - 通過 messaging 與 content script 的 ConfigManager 通信
 * - 緩存配置以減少通信開銷
 * - 轉發配置變更通知到訂閱者
 *
 * @module config-bridge
 */

import { sendMessage, onMessage } from '../messaging.js';

/**
 * ConfigBridge 類
 * 為 page context 提供配置訪問接口
 */
export class ConfigBridge {
  constructor(options = {}) {
    // 配置緩存（扁平化的鍵值對）
    this.cache = new Map();

    // 訂閱者管理（key -> Set<callback>）
    this.subscribers = new Map();

    // 初始化標記
    this.isInitialized = false;

    // 調試模式
    this.debug = options.debug || false;

    // 消息監聽取消函數
    this.unsubscribeMessage = null;
  }

  /**
   * 初始化配置橋接器
   * 從 content script 獲取初始配置並設置監聽器
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.isInitialized) {
      this.log('ConfigBridge 已經初始化');
      return;
    }

    this.log('開始初始化 ConfigBridge...');

    try {
      // 1. 從 content script 獲取所有配置
      const result = await sendMessage({
        type: 'CONFIG_GET_ALL'
      });

      if (!result.success) {
        throw new Error(result.error || '獲取配置失敗');
      }

      // 2. 載入配置到緩存
      const config = result.config || {};
      for (const [key, value] of Object.entries(config)) {
        this.cache.set(key, value);
      }

      this.log(`已載入 ${this.cache.size} 個配置項`);

      // 3. 監聽配置變更通知
      this.unsubscribeMessage = onMessage((message) => {
        if (message.type === 'CONFIG_CHANGED') {
          this.handleConfigChange(message.key, message.newValue, message.oldValue);
        }
      });

      this.isInitialized = true;
      this.log('ConfigBridge 初始化完成');

    } catch (error) {
      this.error('ConfigBridge 初始化失敗:', error);
      throw error;
    }
  }

  // ==================== 配置讀取 ====================

  /**
   * 獲取配置值
   * 支援點記法訪問巢狀配置
   *
   * @param {string} key - 配置鍵（支援點記法）
   * @returns {any} 配置值
   *
   * @example
   * const debugMode = configBridge.get('debugMode');
   * const fontSize = configBridge.get('subtitle.style.primary.fontSize');
   */
  get(key) {
    this.ensureInitialized();

    if (!this.cache.has(key)) {
      this.warn(`配置鍵 "${key}" 不存在於緩存中`);
      return undefined;
    }

    return this.cache.get(key);
  }

  /**
   * 批量獲取配置
   *
   * @param {string[]} keys - 配置鍵陣列
   * @returns {Object} 配置對象
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

  // ==================== 配置寫入 ====================

  /**
   * 設置配置值
   * 會通過 messaging 發送到 content script 的 ConfigManager
   *
   * @param {string} key - 配置鍵
   * @param {any} value - 配置值
   * @returns {Promise<void>}
   *
   * @example
   * await configBridge.set('debugMode', true);
   * await configBridge.set('subtitle.primaryLanguage', 'en');
   */
  async set(key, value) {
    this.ensureInitialized();

    try {
      // 通過 messaging 發送配置更新請求
      const result = await sendMessage({
        type: 'CONFIG_SET',
        key: key,
        value: value
      });

      if (!result.success) {
        throw new Error(result.error || '設置配置失敗');
      }

      // 更新本地緩存（ConfigManager 會發送 CONFIG_CHANGED 通知）
      // 但為了即時性，這裡也立即更新
      const oldValue = this.cache.get(key);
      this.cache.set(key, value);

      // 立即通知本地訂閱者
      this.notifySubscribers(key, value, oldValue);

      this.log(`配置已更新: ${key} = ${JSON.stringify(value)}`);

    } catch (error) {
      this.error(`設置配置失敗 (${key}):`, error);
      throw error;
    }
  }

  /**
   * 批量設置配置
   *
   * @param {Object} items - 配置對象（鍵值對）
   * @returns {Promise<void>}
   */
  async setMultiple(items) {
    this.ensureInitialized();

    try {
      // 通過 messaging 發送批量配置更新請求
      const result = await sendMessage({
        type: 'CONFIG_SET_MULTIPLE',
        items: items
      });

      if (!result.success) {
        throw new Error(result.error || '批量設置配置失敗');
      }

      // 更新本地緩存並通知訂閱者
      for (const [key, value] of Object.entries(items)) {
        const oldValue = this.cache.get(key);
        this.cache.set(key, value);
        this.notifySubscribers(key, value, oldValue);
      }

      this.log(`批量更新 ${Object.keys(items).length} 個配置`);

    } catch (error) {
      this.error('批量設置配置失敗:', error);
      throw error;
    }
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
   * const unsubscribe = configBridge.subscribe('debugMode', (key, newValue, oldValue) => {
   *   console.log(`${key} 從 ${oldValue} 變更為 ${newValue}`);
   * });
   *
   * // 訂閱多個配置
   * const unsubscribe = configBridge.subscribe(
   *   ['subtitle.primaryLanguage', 'subtitle.secondaryLanguage'],
   *   (key, newValue, oldValue) => {
   *     console.log(`語言設置變更: ${key}`);
   *   }
   * );
   *
   * // 取消訂閱
   * unsubscribe();
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
   * 處理配置變更通知
   * 從 content script 接收的 CONFIG_CHANGED 消息
   *
   * @private
   * @param {string} key - 配置鍵
   * @param {any} newValue - 新值
   * @param {any} oldValue - 舊值
   */
  handleConfigChange(key, newValue, oldValue) {
    this.log(`收到配置變更通知: ${key}`);

    // 更新緩存
    this.cache.set(key, newValue);

    // 通知訂閱者
    this.notifySubscribers(key, newValue, oldValue);
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

  // ==================== 輔助方法 ====================

  /**
   * 獲取統計信息
   *
   * @returns {Object} 統計信息
   */
  getStats() {
    return {
      configCount: this.cache.size,
      subscriberCount: this.subscribers.size,
      isInitialized: this.isInitialized
    };
  }

  /**
   * 確保已初始化
   * @private
   */
  ensureInitialized() {
    if (!this.isInitialized) {
      throw new Error('ConfigBridge 未初始化。請先調用 initialize() 方法。');
    }
  }

  /**
   * 清理資源
   */
  cleanup() {
    // 取消消息監聽
    if (this.unsubscribeMessage) {
      this.unsubscribeMessage();
      this.unsubscribeMessage = null;
    }

    // 清除訂閱者
    this.subscribers.clear();

    // 清除緩存
    this.cache.clear();

    this.isInitialized = false;
    this.log('ConfigBridge 資源已清理');
  }

  /**
   * 設置調試模式
   *
   * @param {boolean} enabled - 是否啟用
   */
  setDebugMode(enabled) {
    this.debug = enabled;
  }

  // ==================== 日誌方法 ====================

  /**
   * 輸出日誌
   * @private
   */
  log(...args) {
    if (this.debug) {
      console.log('[ConfigBridge]', ...args);
    }
  }

  /**
   * 輸出警告
   * @private
   */
  warn(...args) {
    if (this.debug) {
      console.warn('[ConfigBridge]', ...args);
    }
  }

  /**
   * 輸出錯誤
   * @private
   */
  error(...args) {
    console.error('[ConfigBridge]', ...args);
  }
}

/**
 * 創建 ConfigBridge 實例的工廠函數
 *
 * @param {Object} options - 配置選項
 * @returns {ConfigBridge} ConfigBridge 實例
 */
export function createConfigBridge(options = {}) {
  return new ConfigBridge(options);
}

// 導出預設實例（單例模式）
export const configBridge = new ConfigBridge();
