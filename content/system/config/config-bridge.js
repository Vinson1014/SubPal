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
import { createSettingsSnapshotClient, validateSettingsSnapshotResult } from '../capabilities/settings-snapshot.js';

const CONFIG_CHANGED_KEYS = new Set(['type', 'key', 'newValue', 'oldValue']);

function parseConfigChange(message) {
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const keys = Object.getOwnPropertyNames(message);
    if (Object.getOwnPropertySymbols(message).length !== 0 || keys.length !== CONFIG_CHANGED_KEYS.size ||
        keys.some((key) => !CONFIG_CHANGED_KEYS.has(key))) return null;
    const values = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(message, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      values[key] = descriptor.value;
    }
    if (values.type !== 'CONFIG_CHANGED' || typeof values.key !== 'string') return null;
    const next = validateSettingsSnapshotResult({ ok: true, value: { [values.key]: values.newValue } });
    if (!next.ok) return null;
    const previous = values.oldValue === undefined
      ? undefined
      : validateSettingsSnapshotResult({ ok: true, value: { [values.key]: values.oldValue } });
    if (previous && !previous.ok) return null;
    if (typeof structuredClone === 'function') structuredClone(message);
    return { key: values.key, newValue: next.value[values.key], oldValue: previous?.value[values.key] };
  } catch {
    return null;
  }
}

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

    this.createSettingsSnapshotClient = options.createSettingsSnapshotClient || createSettingsSnapshotClient;
    this.settingsSnapshotClient = null;
    this.initializationPromise = null;
    this.lifecycleGeneration = 0;
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
    if (this.initializationPromise) return this.initializationPromise;

    this.log('開始初始化 ConfigBridge...');
    const lifecycle = this.lifecycleGeneration;
    const initialization = (async () => {
      let client;
      try {
        client = this.createSettingsSnapshotClient();
        this.settingsSnapshotClient = client;
        const result = validateSettingsSnapshotResult(await client.read());
        if (lifecycle !== this.lifecycleGeneration || !result.ok) throw new Error('settings snapshot unavailable');
        for (const [key, value] of Object.entries(result.value)) this.cache.set(key, value);
        if (lifecycle !== this.lifecycleGeneration) throw new Error('settings snapshot unavailable');
        this.unsubscribeMessage = onMessage((message) => {
          const change = parseConfigChange(message);
          if (change) this.handleConfigChange(change.key, change.newValue, change.oldValue);
        });
        if (lifecycle !== this.lifecycleGeneration) throw new Error('settings snapshot unavailable');
        this.isInitialized = true;
        this.log(`已載入 ${this.cache.size} 個配置項`);
        this.log('ConfigBridge 初始化完成');
      } catch {
        if (lifecycle === this.lifecycleGeneration) {
          this.cache.clear();
          this.unsubscribeMessage?.();
          this.unsubscribeMessage = null;
        }
        this.error('ConfigBridge 初始化失敗');
        throw new Error('settings snapshot unavailable');
      } finally {
        if (this.settingsSnapshotClient === client) {
          client?.dispose();
          this.settingsSnapshotClient = null;
        }
      }
    })();
    this.initializationPromise = initialization;
    try {
      return await initialization;
    } finally {
      if (this.initializationPromise === initialization) this.initializationPromise = null;
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

  async setSubtitleLanguages(primaryLanguage, secondaryLanguage) {
    this.ensureInitialized();

    try {
      const result = await sendMessage({
        category: 'settings-change',
        variant: 'subtitle-languages',
        payload: { primaryLanguage, secondaryLanguage }
      });
      this.log(`字幕語言已更新: 主要=${primaryLanguage}, 次要=${secondaryLanguage}`);
      return result;
    } catch (error) {
      this.error('設置字幕語言失敗:', error);
      throw error;
    }
  }

  async setDualSubtitleEnabled(enabled) {
    this.ensureInitialized();

    try {
      const result = await sendMessage({
        category: 'settings-change',
        variant: 'dual-subtitles',
        payload: { enabled }
      });
      this.log(`雙語字幕已更新: ${enabled}`);
      return result;
    } catch (error) {
      this.error('設置雙語字幕失敗:', error);
      throw error;
    }
  }

  // ==================== 訂閱機制 ====================

  /**
   * 訂閱配置變更
   * 支援細粒度訂閱，只訂閱需要的配置項
   *
   * @param {string|string[]} keys - 配置鍵或鍵陣列
   * @param {Function} callback - 回調函數 (newValue) => void
   * @returns {Function} 取消訂閱函數
   *
   * @example
   * // 訂閱單個配置
   * const unsubscribe = configBridge.subscribe('debugMode', (newValue) => {
   *   console.log(`debugMode 變更為 ${newValue}`);
   * });
   *
   * // 訂閱多個配置
   * const unsubscribe = configBridge.subscribe(
   *   ['subtitle.primaryLanguage', 'subtitle.secondaryLanguage'],
   *   (newValue) => {
   *     console.log(`語言設置變更`);
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
  handleConfigChange(key, newValue, _oldValue) {
    this.log(`收到配置變更通知: ${key}`);

    // 更新緩存
    this.cache.set(key, newValue);

    // 通知訂閱者
    this.notifySubscribers(key, newValue, _oldValue);
  }

  /**
   * 通知訂閱者
   * @private
   */
  notifySubscribers(key, newValue, _oldValue) {
    const callbacks = this.subscribers.get(key);
    if (!callbacks || callbacks.size === 0) {
      return;
    }

    this.log(`通知 ${callbacks.size} 個訂閱者: ${key}`);

    for (const callback of callbacks) {
      try {
        callback(newValue);
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
    this.lifecycleGeneration += 1;
    this.initializationPromise = null;
    this.settingsSnapshotClient?.dispose();
    this.settingsSnapshotClient = null;

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
