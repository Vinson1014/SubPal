/**
 * 替換事件 Bridge - 運行在 page context
 *
 * 設計理念：
 * 1. 提供簡潔的替換事件記錄 API 給 page context 使用
 * 2. 透過 Contributions capability 發送 typed contribution intent
 * 3. 所有數據持久化由 background owner 處理
 * 4. 專注於消息傳遞和參數驗證
 */

import { createPageContributions } from '../system/capabilities/contributions.js';

let contributions;

function getContributions() {
  contributions ??= createPageContributions({ window });
  return contributions;
}

const REPLACEMENT_EVENT_KEYS = new Set(['translationID', 'contributorUserID', 'occurredAt']);

function parseReplacementEvent(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('replacement event payload must be an object');
  }
  const keys = Object.getOwnPropertyNames(data);
  if (Object.getOwnPropertySymbols(data).length !== 0 || keys.length !== REPLACEMENT_EVENT_KEYS.size ||
      keys.some((key) => !REPLACEMENT_EVENT_KEYS.has(key)) ||
      keys.some((key) => !Object.getOwnPropertyDescriptor(data, key)?.enumerable)) {
    throw new Error('replacement event payload contains unsupported fields');
  }
  const { translationID, contributorUserID, occurredAt } = data;
  if (!translationID || typeof translationID !== 'string') {
    throw new Error('缺少必要參數: translationID 必須是字符串');
  }
  if (!contributorUserID || typeof contributorUserID !== 'string') {
    throw new Error('缺少必要參數: contributorUserID 必須是字符串');
  }
  if (!occurredAt || typeof occurredAt !== 'string') {
    throw new Error('缺少必要參數: occurredAt 必須是 ISO8601 格式字符串');
  }
  return { translationID, contributorUserID, occurredAt };
}

/**
 * 替換事件 Bridge 對象
 */
export const replacementEventBridge = {
  isInitialized: false,
  debug: false,

  /**
   * 初始化 replacement-event-bridge
   */
  async initialize() {
    this.log('替換事件 Bridge 初始化中...');

    try {
      // 初始化 ConfigBridge 並讀取配置
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取 debugMode
      this.debug = configBridge.get('debugMode');
      this.log(`替換事件 Bridge 初始化完成，調試模式: ${this.debug}`);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log(`調試模式已更新: ${newValue}`);
      });

      this.isInitialized = true;
      this.log('替換事件 Bridge 初始化完成');

    } catch (error) {
      console.error('替換事件 Bridge 初始化失敗:', error);
      throw error;
    }
  },

  /**
   * 將替換事件加入隊列
   * @param {Object} data - 替換事件數據
   * @param {string} data.translationID - 翻譯 ID (必填)
   * @param {string} data.contributorUserID - 貢獻者用戶 ID (必填)
   * @param {string} data.occurredAt - 發生時間，ISO8601 格式 (必填)
   * @returns {Promise<Object>} - 返回 { itemId, message }
   */
  async enqueue(data) {
    this.log('enqueue 方法被調用，參數:', data);

    const { translationID, contributorUserID, occurredAt } = parseReplacementEvent(data);

    try {
      this.log('發送 typed replacement-event contribution intent 到 content script');
      const response = await getContributions().enqueue({
        variant: 'enqueue-replacement-event',
        payload: {
          translationID,
          contributorUserID,
          occurredAt
        }
      });

      this.log('replacement-event contribution intent 響應:', response);

      if (!response.ok) {
        throw new Error(response.error.code);
      }

      return response;

    } catch (error) {
      this.log('enqueue 失敗:', error.message);
      throw new Error(`替換事件加入隊列失敗: ${error.message}`);
    }
  },

  /**
   * 重試失敗的替換事件
   * @param {string} operationId - 失敗操作的 ID
   * @returns {Promise<boolean>} - 是否成功重試
   */
  async retry(operationId) {
    this.log('retry 方法被調用，operationId:', operationId);

    if (!operationId) {
      const error = new Error('缺少必要參數: operationId');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    try {
      this.log('發送 typed replacement-event retry intent 到 content script');
      const response = await getContributions().retry(operationId);

      this.log('replacement-event retry intent 響應:', response);

      if (!response.ok) {
        throw new Error(response.error.code);
      }

      return response.value.retryScheduled === true;

    } catch (error) {
      this.log('retry 失敗:', error.message);
      throw new Error(`重試替換事件失敗: ${error.message}`);
    }
  },

  /**
   * 除錯日誌
   * @param {string} message - 日誌訊息
   * @param  {...any} args - 其他參數
   */
  log(message, ...args) {
    if (this.debug) {
      console.log(`[ReplacementEventBridge] ${message}`, ...args);
    }
  }
};
