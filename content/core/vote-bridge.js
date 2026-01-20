/**
 * 投票 Bridge - 運行在 page context
 *
 * 設計理念：
 * 1. 提供簡潔的投票 API 給 page context 使用
 * 2. 透過 sendMessage 與 content script 的 SubmissionQueueManager 溝通
 * 3. 所有數據持久化由 content script 處理
 * 4. 專注於消息傳遞和參數驗證
 */

import { sendMessage } from '../system/messaging.js';

/**
 * 投票 Bridge 對象
 */
export const voteBridge = {
  isInitialized: false,
  debug: false,

  /**
   * 初始化 vote-bridge
   */
  async initialize() {
    this.log('投票 Bridge 初始化中...');

    try {
      // 初始化 ConfigBridge 並讀取配置
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取 debugMode
      this.debug = configBridge.get('debugMode');
      this.log(`投票 Bridge 初始化完成，調試模式: ${this.debug}`);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log(`調試模式已更新: ${newValue}`);
      });

      this.isInitialized = true;
      this.log('投票 Bridge 初始化完成');

    } catch (error) {
      console.error('投票 Bridge 初始化失敗:', error);
      throw error;
    }
  },

  /**
   * 將投票加入隊列
   * @param {Object} data - 投票數據
   * @param {string} data.videoId - 影片 ID (必填)
   * @param {number} data.timestamp - 字幕時間戳 (必填)
   * @param {string} data.voteType - 投票類型 'upvote' | 'downvote' (必填)
   * @param {string} [data.translationID] - 翻譯 ID (選填)
   * @param {string} [data.originalSubtitle] - 原始字幕 (選填)
   * @returns {Promise<Object>} - 返回 { itemId, message }
   */
  async enqueue(data) {
    this.log('enqueue 方法被調用，參數:', data);

    // 參數驗證
    const { videoId, timestamp, voteType, translationID, originalSubtitle } = data;

    if (!videoId || typeof videoId !== 'string') {
      const error = new Error('缺少必要參數: videoId 必須是字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (timestamp === undefined || typeof timestamp !== 'number' || timestamp < 0) {
      const error = new Error('缺少必要參數: timestamp 必須是有效的正數');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (!voteType || !['upvote', 'downvote'].includes(voteType)) {
      const error = new Error('缺少必要參數: voteType 必須是 "upvote" 或 "downvote"');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    try {
      this.log('發送 VOTE_ENQUEUE 消息到 content script');
      const response = await sendMessage({
        type: 'VOTE_ENQUEUE',
        payload: {
          videoId,
          timestamp,
          voteType,
          translationID: translationID || null,
          originalSubtitle: originalSubtitle || null
        }
      });

      this.log('VOTE_ENQUEUE 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response;

    } catch (error) {
      this.log('enqueue 失敗:', error.message);
      throw new Error(`投票加入隊列失敗: ${error.message}`);
    }
  },

  /**
   * 獲取投票歷史
   * @param {number} [limit=100] - 返回記錄數量上限
   * @returns {Promise<Array>} - 投票歷史陣列
   */
  async getHistory(limit = 100) {
    this.log('getHistory 方法被調用，limit:', limit);

    try {
      this.log('發送 VOTE_GET_HISTORY 消息到 content script');
      const response = await sendMessage({
        type: 'VOTE_GET_HISTORY',
        payload: { limit }
      });

      this.log('VOTE_GET_HISTORY 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response.history || [];

    } catch (error) {
      this.log('getHistory 失敗:', error.message);
      throw new Error(`獲取投票歷史失敗: ${error.message}`);
    }
  },

  /**
   * 獲取項目狀態
   * @param {string} itemId - 項目唯一識別碼
   * @returns {Promise<Object>} - 狀態物件 { status, error? }
   */
  async getStatus(itemId) {
    this.log('getStatus 方法被調用，itemId:', itemId);

    if (!itemId) {
      const error = new Error('缺少必要參數: itemId');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    try {
      this.log('發送 VOTE_GET_STATUS 消息到 content script');
      const response = await sendMessage({
        type: 'VOTE_GET_STATUS',
        payload: { itemId }
      });

      this.log('VOTE_GET_STATUS 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response;

    } catch (error) {
      this.log('getStatus 失敗:', error.message);
      throw new Error(`獲取項目狀態失敗: ${error.message}`);
    }
  },

  /**
   * 重試失敗的投票
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
      this.log('發送 VOTE_RETRY 消息到 content script');
      const response = await sendMessage({
        type: 'VOTE_RETRY',
        payload: { itemId }
      });

      this.log('VOTE_RETRY 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response.success || false;

    } catch (error) {
      this.log('retry 失敗:', error.message);
      throw new Error(`重試投票失敗: ${error.message}`);
    }
  },

  /**
   * 除錯日誌
   * @param {string} message - 日誌訊息
   * @param  {...any} args - 其他參數
   */
  log(message, ...args) {
    if (this.debug) {
      console.log(`[VoteBridge] ${message}`, ...args);
    }
  }
};
