/**
 * StorageAdapter - Chrome Storage 訪問適配器
 *
 * 封裝 chrome.storage.local API，提供統一的 storage 接口
 * 職責：
 * - 讀取和寫入配置到 chrome.storage.local
 * - 監聽 storage 變化
 * - 錯誤處理和日誌記錄
 * - Promise 化的異步接口
 *
 * @module storage-adapter
 */

/**
 * StorageAdapter 類
 * 提供 Promise 化的 chrome.storage.local 訪問接口
 */
export class StorageAdapter {
  constructor(options = {}) {
    // 調試模式（預設從 chrome.storage 讀取，初始值為 false）
    this.debug = options.debug || false;

    // Storage 變化監聽器列表
    this.changeListeners = new Set();

    // 初始化標記
    this.isInitialized = false;

    // 統計信息
    this.stats = {
      reads: 0,
      writes: 0,
      errors: 0
    };
  }

  /**
   * 初始化 StorageAdapter
   * 設置 storage 變化監聽器
   */
  async initialize() {
    if (this.isInitialized) {
      this.log('StorageAdapter 已經初始化');
      return;
    }

    try {
      // 讀取 debugMode 設置
      // const result = await this.get(['debugMode']);
      // if (result && result.debugMode !== undefined) {
      //   this.debug = result.debugMode;
      // }
      if(!chrome?.storage?.local) {
        throw new Error('Chrome Storage API 不可用')
      }

      // 設置 storage 變化監聽器
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
          this.handleStorageChange(changes);
        }
      });

      this.isInitialized = true;
      this.log('StorageAdapter 初始化成功');
    } catch (error) {
      this.error('StorageAdapter 初始化失敗:', error);
      throw error;
    }
  }

  /**
   * 從 storage 讀取配置
   *
   * @param {string|string[]} keys - 要讀取的配置鍵（單個或數組）
   * @returns {Promise<Object>} 配置對象
   *
   * @example
   * // 讀取單個配置
   * const result = await adapter.get('debugMode');
   * console.log(result.debugMode);
   *
   * @example
   * // 讀取多個配置
   * const result = await adapter.get(['debugMode', 'isEnabled']);
   * console.log(result.debugMode, result.isEnabled);
   */
  async get(keys) {
    if (!chrome?.storage?.local) {
      throw new Error('Chrome Storage API 不可用');
    }

    this.stats.reads++;

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) {
            this.stats.errors++;
            this.error('讀取 storage 失敗:', chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            this.log('讀取 storage 成功:', keys, result);
            resolve(result);
          }
        });
      } catch (error) {
        this.stats.errors++;
        this.error('讀取 storage 時發生異常:', error);
        reject(error);
      }
    });
  }

  /**
   * 寫入配置到 storage
   *
   * @param {Object} items - 要寫入的配置對象（鍵值對）
   * @returns {Promise<void>}
   *
   * @example
   * await adapter.set({ debugMode: true, isEnabled: true });
   */
  async set(items) {
    if (!chrome?.storage?.local) {
      throw new Error('Chrome Storage API 不可用');
    }

    if (!items || typeof items !== 'object') {
      throw new Error('items 必須是一個對象');
    }

    this.stats.writes++;

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) {
            this.stats.errors++;
            this.error('寫入 storage 失敗:', chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            this.log('寫入 storage 成功:', items);
            resolve();
          }
        });
      } catch (error) {
        this.stats.errors++;
        this.error('寫入 storage 時發生異常:', error);
        reject(error);
      }
    });
  }

  /**
   * 監聽 storage 變化
   *
   * @param {Function} callback - 變化回調函數
   * @returns {Function} 取消監聽的函數
   *
   * @example
   * const unwatch = adapter.watch((changes) => {
   *   console.log('配置變更:', changes);
   * });
   *
   * // 取消監聽
   * unwatch();
   */
  watch(callback) {
    if (typeof callback !== 'function') {
      throw new Error('callback 必須是一個函數');
    }

    this.changeListeners.add(callback);
    this.log('新增 storage 變化監聽器，當前監聽器數量:', this.changeListeners.size);

    // 返回取消監聽的函數
    return () => {
      this.changeListeners.delete(callback);
      this.log('移除 storage 變化監聽器，當前監聽器數量:', this.changeListeners.size);
    };
  }

  /**
   * 清除所有配置（謹慎使用！）
   * 這會刪除所有存儲的配置數據
   *
   * @returns {Promise<void>}
   */
  async clear() {
    if (!chrome?.storage?.local) {
      throw new Error('Chrome Storage API 不可用');
    }

    this.warn('正在清除所有 storage 數據...');

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.clear(() => {
          if (chrome.runtime.lastError) {
            this.stats.errors++;
            this.error('清除 storage 失敗:', chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            this.log('storage 已清除');
            resolve();
          }
        });
      } catch (error) {
        this.stats.errors++;
        this.error('清除 storage 時發生異常:', error);
        reject(error);
      }
    });
  }

  /**
   * 獲取 storage 使用統計
   *
   * @returns {Promise<Object>} 使用統計對象
   * @property {number} bytesInUse - 使用的字節數
   * @property {number} quota - 配額（通常為 QUOTA_BYTES）
   *
   * @example
   * const usage = await adapter.getUsage();
   * console.log(`已使用: ${usage.bytesInUse} / ${usage.quota} bytes`);
   */
  async getUsage() {
    if (!chrome?.storage?.local) {
      throw new Error('Chrome Storage API 不可用');
    }

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
          if (chrome.runtime.lastError) {
            this.error('獲取 storage 使用量失敗:', chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({
              bytesInUse,
              quota: chrome.storage.local.QUOTA_BYTES || 10485760, // 預設 10MB
              percentUsed: ((bytesInUse / (chrome.storage.local.QUOTA_BYTES || 10485760)) * 100).toFixed(2)
            });
          }
        });
      } catch (error) {
        this.error('獲取 storage 使用量時發生異常:', error);
        reject(error);
      }
    });
  }

  /**
   * 批量讀取配置（優化版本）
   * 支援點記法鍵的批量讀取
   *
   * @param {string[]} keys - 配置鍵數組（支援點記法）
   * @returns {Promise<Object>} 配置對象（使用點記法鍵）
   *
   * @example
   * const result = await adapter.getBatch([
   *   'subtitle.primaryLanguage',
   *   'subtitle.style.primary.fontSize'
   * ]);
   */
  async getBatch(keys) {
    if (!chrome?.storage?.local) {
      throw new Error('Chrome Storage API 不可用');
    }

    if (!Array.isArray(keys)) {
      throw new Error('keys 必須是數組');
    }

    // 提取根鍵（點記法的第一部分）
    const rootKeys = [...new Set(keys.map(key => key.split('.')[0]))];

    // 讀取根鍵對應的配置
    const result = await this.get(rootKeys);

    // 展開點記法鍵
    const expanded = {};
    for (const key of keys) {
      const value = this.getNestedValue(result, key);
      if (value !== undefined) {
        expanded[key] = value;
      }
    }

    return expanded;
  }

  /**
   * 批量寫入配置（優化版本）
   * 支援點記法鍵的批量寫入
   * 使用深度合併避免 Chrome Storage API 淺合併導致的數據丟失
   *
   * @param {Object} items - 配置對象（使用點記法鍵）
   * @returns {Promise<void>}
   *
   * @example
   * await adapter.setBatch({
   *   'subtitle.primaryLanguage': 'en',
   *   'subtitle.style.primary.fontSize': 60
   * });
   */
  async setBatch(items) {
    if (!chrome?.storage?.local) {
      throw new Error('Chrome Storage API 不可用');
    }

    if (!items || typeof items !== 'object') {
      throw new Error('items 必須是對象');
    }

    // 將點記法鍵轉換為巢狀結構
    const nested = {};
    for (const [key, value] of Object.entries(items)) {
      this.setNestedValue(nested, key, value);
    }

    // 提取需要更新的根鍵
    const rootKeys = [...new Set(Object.keys(items).map(k => k.split('.')[0]))];

    // 讀取現有配置（深度合併需要）
    const existingData = await this.get(rootKeys);

    // 深度合併現有配置和新配置
    const mergedData = this.deepMerge(existingData, nested);

    // 寫入合併後的數據
    await this.set(mergedData);
  }

  /**
   * 深度合併兩個對象
   * 確保 Chrome Storage API 的淺合併不會丟失嵌套配置
   *
   * @private
   * @param {Object} existing - 現有配置
   * @param {Object} updates - 要更新的配置
   * @returns {Object} 合併後的配置
   */
  deepMerge(existing, updates) {
    const result = { ...existing };

    for (const [key, value] of Object.entries(updates)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        key in result &&
        result[key] !== null &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        // 遞歸合併嵌套對象
        result[key] = this.deepMerge(result[key], value);
      } else {
        // 直接覆蓋（非對象或數組）
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 處理 storage 變化
   * 通知所有註冊的監聽器
   *
   * @private
   * @param {Object} changes - Chrome storage changes 對象
   */
  handleStorageChange(changes) {
    this.log('Storage 變化:', changes);

    // 檢查 debugMode 是否變更
    if (changes.debugMode) {
      this.debug = changes.debugMode.newValue;
      this.log('Debug 模式已更新:', this.debug);
    }

    // 通知所有監聽器
    for (const listener of this.changeListeners) {
      try {
        listener(changes);
      } catch (error) {
        this.error('執行 storage 變化監聽器時發生錯誤:', error);
      }
    }
  }

  /**
   * 獲取巢狀對象的值（支援點記法）
   *
   * @private
   * @param {Object} obj - 對象
   * @param {string} path - 點記法路徑
   * @returns {any} 值或 undefined
   */
  getNestedValue(obj, path) {
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

  /**
   * 設置巢狀對象的值（支援點記法）
   *
   * @private
   * @param {Object} obj - 對象
   * @param {string} path - 點記法路徑
   * @param {any} value - 要設置的值
   */
  setNestedValue(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let current = obj;

    for (const key of keys) {
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }

    current[lastKey] = value;
  }

  /**
   * 獲取統計信息
   *
   * @returns {Object} 統計信息
   */
  getStats() {
    return {
      ...this.stats,
      listeners: this.changeListeners.size,
      isInitialized: this.isInitialized
    };
  }

  /**
   * 重置統計信息
   */
  resetStats() {
    this.stats = {
      reads: 0,
      writes: 0,
      errors: 0
    };
    this.log('統計信息已重置');
  }

  /**
   * 設置調試模式
   *
   * @param {boolean} enabled - 是否啟用調試模式
   */
  setDebugMode(enabled) {
    this.debug = enabled;
    this.log('Debug 模式已設置為:', enabled);
  }

  /**
   * 清理資源
   * 移除所有監聽器
   */
  cleanup() {
    this.changeListeners.clear();
    this.isInitialized = false;
    this.log('StorageAdapter 資源已清理');
  }

  // ==================== 隊列操作方法 ====================

  /**
   * 取得指定類型的待同步隊列
   *
   * @param {string} queueType - 隊列類型 ('vote' 或 'translation')
   * @returns {Promise<Array>} 隊列陣列
   *
   * @example
   * const voteQueue = await adapter.getQueue('vote');
   */
  async getQueue(queueType) {
    if (!queueType || !['vote', 'translation'].includes(queueType)) {
      throw new Error('queueType 必須是 "vote" 或 "translation"');
    }

    const storageKey = `${queueType}Queue`;
    const result = await this.get(storageKey);
    return result[storageKey] || [];
  }

  /**
   * 新增項目到隊列
   *
   * @param {string} queueType - 隊列類型 ('vote' 或 'translation')
   * @param {Object} item - 項目物件
   * @returns {Promise<void>}
   *
   * @example
   * await adapter.appendToQueue('vote', {
   *   id: 'uuid-v4',
   *   videoId: 'abc123',
   *   timestamp: 123456,
   *   voteType: 'upvote',
   *   status: 'pending',
   *   createdAt: Date.now()
   * });
   */
  async appendToQueue(queueType, item) {
    if (!queueType || !['vote', 'translation'].includes(queueType)) {
      throw new Error('queueType 必須是 "vote" 或 "translation"');
    }

    if (!item || typeof item !== 'object') {
      throw new Error('item 必須是一個對象');
    }

    const storageKey = `${queueType}Queue`;
    const queue = await this.getQueue(queueType);

    // 新增項目到隊列
    queue.push(item);

    // 維持最大長度限制 (100)
    const MAX_QUEUE_LENGTH = 100;
    if (queue.length > MAX_QUEUE_LENGTH) {
      queue.shift(); // 移除最舊項目
      this.warn(`${storageKey} 超過最大長度限制，已移除最舊項目`);
    }

    await this.set({ [storageKey]: queue });
    this.log(`新增項目到 ${storageKey}:`, item.id);
  }

  /**
   * 更新隊列中指定項目的屬性
   *
   * @param {string} queueType - 隊列類型
   * @param {string} itemId - 項目 ID
   * @param {Object} updates - 更新物件
   * @returns {Promise<boolean>} 是否找到並更新
   *
   * @example
   * const updated = await adapter.updateQueueItem('vote', 'uuid-v4', {
   *   status: 'syncing'
   * });
   */
  async updateQueueItem(queueType, itemId, updates) {
    if (!queueType || !['vote', 'translation'].includes(queueType)) {
      throw new Error('queueType 必須是 "vote" 或 "translation"');
    }

    if (!itemId || typeof itemId !== 'string') {
      throw new Error('itemId 必須是字串');
    }

    if (!updates || typeof updates !== 'object') {
      throw new Error('updates 必須是對象');
    }

    const storageKey = `${queueType}Queue`;
    const queue = await this.getQueue(queueType);

    const itemIndex = queue.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      this.warn(`找不到項目: ${itemId} in ${storageKey}`);
      return false;
    }

    // 更新項目屬性
    queue[itemIndex] = { ...queue[itemIndex], ...updates };

    await this.set({ [storageKey]: queue });
    this.log(`更新 ${storageKey} 項目:`, itemId, updates);
    return true;
  }

  /**
   * 從隊列中移除指定項目
   *
   * @param {string} queueType - 隊列類型
   * @param {string} itemId - 項目 ID
   * @returns {Promise<boolean>} 是否找到並移除
   *
   * @example
   * const removed = await adapter.removeFromQueue('vote', 'uuid-v4');
   */
  async removeFromQueue(queueType, itemId) {
    if (!queueType || !['vote', 'translation'].includes(queueType)) {
      throw new Error('queueType 必須是 "vote" 或 "translation"');
    }

    if (!itemId || typeof itemId !== 'string') {
      throw new Error('itemId 必須是字串');
    }

    const storageKey = `${queueType}Queue`;
    const queue = await this.getQueue(queueType);

    const initialLength = queue.length;
    const filteredQueue = queue.filter(item => item.id !== itemId);

    if (filteredQueue.length === initialLength) {
      this.warn(`找不到項目: ${itemId} in ${storageKey}`);
      return false;
    }

    await this.set({ [storageKey]: filteredQueue });
    this.log(`從 ${storageKey} 移除項目:`, itemId);
    return true;
  }

  /**
   * 清空指定隊列
   *
   * @param {string} queueType - 隊列類型
   * @returns {Promise<void>}
   *
   * @example
   * await adapter.clearQueue('vote');
   */
  async clearQueue(queueType) {
    if (!queueType || !['vote', 'translation'].includes(queueType)) {
      throw new Error('queueType 必須是 "vote" 或 "translation"');
    }

    const storageKey = `${queueType}Queue`;
    await this.set({ [storageKey]: [] });
    this.log(`清空 ${storageKey}`);
  }

  // ==================== 歷史記錄操作方法 ====================

  /**
   * 取得已完成記錄的歷史
   *
   * @param {string} historyType - 歷史類型 ('vote' 或 'translation')
   * @param {number} limit - 數量限制 (預設 100)
   * @returns {Promise<Array>} 歷史記錄陣列
   *
   * @example
   * const voteHistory = await adapter.getHistory('vote', 50);
   */
  async getHistory(historyType, limit = 100) {
    if (!historyType || !['vote', 'translation'].includes(historyType)) {
      throw new Error('historyType 必須是 "vote" 或 "translation"');
    }

    if (typeof limit !== 'number' || limit <= 0) {
      throw new Error('limit 必須是正整數');
    }

    const storageKey = `${historyType}History`;
    const result = await this.get(storageKey);
    const history = result[storageKey] || [];

    // 回傳最近 N 筆
    return history.slice(0, limit);
  }

  /**
   * 新增項目到歷史記錄
   *
   * @param {string} historyType - 歷史類型 ('vote' 或 'translation')
   * @param {Object} item - 項目物件
   * @returns {Promise<void>}
   *
   * @example
   * await adapter.addToHistory('vote', {
   *   id: 'uuid-v4',
   *   videoId: 'abc123',
   *   timestamp: 123456,
   *   voteType: 'upvote',
   *   status: 'completed',
   *   syncedAt: Date.now()
   * });
   */
  async addToHistory(historyType, item) {
    if (!historyType || !['vote', 'translation'].includes(historyType)) {
      throw new Error('historyType 必須是 "vote" 或 "translation"');
    }

    if (!item || typeof item !== 'object') {
      throw new Error('item 必須是一個對象');
    }

    const storageKey = `${historyType}History`;
    const result = await this.get(storageKey);
    const history = result[storageKey] || [];

    // 新增至陣列開頭（最新的在前）
    history.unshift(item);

    // 維持最大長度限制 (100)
    const MAX_HISTORY_LENGTH = 100;
    if (history.length > MAX_HISTORY_LENGTH) {
      history.pop(); // 移除最舊項目
      this.warn(`${storageKey} 超過最大長度限制，已移除最舊項目`);
    }

    await this.set({ [storageKey]: history });
    this.log(`新增項目到 ${storageKey}:`, item.id);
  }

  /**
   * 清空指定歷史記錄
   *
   * @param {string} historyType - 歷史類型 ('vote' 或 'translation')
   * @returns {Promise<void>}
   *
   * @example
   * await adapter.clearHistory('vote');
   */
  async clearHistory(historyType) {
    if (!historyType || !['vote', 'translation'].includes(historyType)) {
      throw new Error('historyType 必須是 "vote" 或 "translation"');
    }

    const storageKey = `${historyType}History`;
    await this.set({ [storageKey]: [] });
    this.log(`清空 ${storageKey}`);
  }

  // ==================== 日誌方法 ====================

  /**
   * 輸出日誌
   * @private
   */
  log(...args) {
    if (this.debug) {
      console.log('[StorageAdapter]', ...args);
    }
  }

  /**
   * 輸出警告
   * @private
   */
  warn(...args) {
    if (this.debug) {
      console.warn('[StorageAdapter]', ...args);
    }
  }

  /**
   * 輸出錯誤
   * @private
   */
  error(...args) {
    console.error('[StorageAdapter]', ...args);
  }
}

// ==================== UUID v4 工具函數 ====================

/**
 * 生成符合 UUID v4 格式的唯一 ID
 *
 * @returns {string} UUID v4 字串
 *
 * @example
 * const id = generateUUID();
 * console.log(id); // "550e8400-e29b-41d4-a716-446655440000"
 */
export function generateUUID() {
  // 優先使用原生 crypto.randomUUID()
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // 備用實作（基於 RFC 4122）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 創建 StorageAdapter 實例的工廠函數
 *
 * @param {Object} options - 配置選項
 * @returns {StorageAdapter} StorageAdapter 實例
 */
export function createStorageAdapter(options = {}) {
  return new StorageAdapter(options);
}

// 導出預設實例（單例模式）
export const storageAdapter = new StorageAdapter();
