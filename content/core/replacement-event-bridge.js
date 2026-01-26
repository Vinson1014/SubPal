/**
 * 替換事件 Bridge - 運行在 page context
 *
 * 設計理念：
 * 1. 提供簡潔的替換事件記錄 API 給 page context 使用
 * 2. 透過 sendMessage 與 content script 的 SubmissionQueueManager 溝通
 * 3. 所有數據持久化由 content script 處理
 * 4. 專注於消息傳遞和參數驗證
 */

import { sendMessage } from '../system/messaging.js';

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
   * @param {string} data.beneficiaryUserID - 受益者用戶 ID (必填)
   * @param {string} data.occurredAt - 發生時間，ISO8601 格式 (必填)
   * @returns {Promise<Object>} - 返回 { itemId, message }
   */
  async enqueue(data) {
    this.log('enqueue 方法被調用，參數:', data);

    // 參數驗證
    const { translationID, contributorUserID, beneficiaryUserID, occurredAt } = data;

    if (!translationID || typeof translationID !== 'string') {
      const error = new Error('缺少必要參數: translationID 必須是字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (!contributorUserID || typeof contributorUserID !== 'string') {
      const error = new Error('缺少必要參數: contributorUserID 必須是字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (!beneficiaryUserID || typeof beneficiaryUserID !== 'string') {
      const error = new Error('缺少必要參數: beneficiaryUserID 必須是字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (!occurredAt || typeof occurredAt !== 'string') {
      const error = new Error('缺少必要參數: occurredAt 必須是 ISO8601 格式字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    try {
      this.log('發送 REPLACEMENT_EVENT_ENQUEUE 消息到 content script');
      const response = await sendMessage({
        type: 'REPLACEMENT_EVENT_ENQUEUE',
        payload: {
          translationID,
          contributorUserID,
          beneficiaryUserID,
          occurredAt
        }
      });

      this.log('REPLACEMENT_EVENT_ENQUEUE 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response;

    } catch (error) {
      this.log('enqueue 失敗:', error.message);
      throw new Error(`替換事件加入隊列失敗: ${error.message}`);
    }
  },

  /**
   * 獲取替換事件歷史
   * @param {number} [limit=100] - 返回記錄數量上限
   * @returns {Promise<Array>} - 替換事件歷史陣列
   */
  async getHistory(limit = 100) {
    this.log('getHistory 方法被調用，limit:', limit);

    try {
      this.log('發送 REPLACEMENT_EVENT_GET_HISTORY 消息到 content script');
      const response = await sendMessage({
        type: 'REPLACEMENT_EVENT_GET_HISTORY',
        payload: { limit }
      });

      this.log('REPLACEMENT_EVENT_GET_HISTORY 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response.history || [];

    } catch (error) {
      this.log('getHistory 失敗:', error.message);
      throw new Error(`獲取替換事件歷史失敗: ${error.message}`);
    }
  },

  /**
   * 重試失敗的替換事件
   * @param {string} itemId - 失敗項目的 ID
   * @returns {Promise<boolean>} - 是否成功重試
   */
  async retry(itemId) {
    this.log('retry 方法被調用，itemId:', itemId);

    if (!itemId) {
      const error = new Error('缺少必要參數: itemId');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    try {
      this.log('發送 REPLACEMENT_EVENT_RETRY 消息到 content script');
      const response = await sendMessage({
        type: 'REPLACEMENT_EVENT_RETRY',
        payload: { itemId }
      });

      this.log('REPLACEMENT_EVENT_RETRY 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response.success || false;

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
