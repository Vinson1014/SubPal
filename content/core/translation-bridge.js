/**
 * 翻譯 Bridge - 運行在 page context
 *
 * 設計理念：
 * 1. 提供簡潔的翻譯提交 API 給 page context 使用
 * 2. 透過 sendMessage 發送 typed contribution intent
 * 3. 所有數據持久化由 background owner 處理
 * 4. 專注於消息傳遞和參數驗證
 */

import { sendMessage } from '../system/messaging.js';

/**
 * 翻譯 Bridge 對象
 */
function normalizeResolutionContext(context) {
  if (!context || typeof context !== 'object') {
    throw new Error('resolutionContext 必須是物件');
  }

  const requiredKeys = ['taskID', 'targetType', 'action', 'slotKey', 'timestamp'];
  if (!requiredKeys.every((key) => Object.hasOwn(context, key))) {
    throw new Error('resolutionContext 缺少必要欄位');
  }

  return {
    taskID: context.taskID,
    targetType: context.targetType,
    action: context.action,
    slotKey: context.slotKey,
    timestamp: context.timestamp
  };
}

export const translationBridge = {
  isInitialized: false,
  debug: false,

  /**
   * 初始化 translation-bridge
   */
  async initialize() {
    this.log('翻譯 Bridge 初始化中...');

    try {
      // 初始化 ConfigBridge 並讀取配置
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 讀取 debugMode
      this.debug = configBridge.get('debugMode');
      this.log(`翻譯 Bridge 初始化完成，調試模式: ${this.debug}`);

      // 訂閱 debugMode 變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log(`調試模式已更新: ${newValue}`);
      });

      this.isInitialized = true;
      this.log('翻譯 Bridge 初始化完成');

    } catch (error) {
      console.error('翻譯 Bridge 初始化失敗:', error);
      throw error;
    }
  },

  /**
   * 將翻譯提交加入隊列
   * @param {Object} data - 翻譯數據
   * @param {string} data.videoId - 影片 ID (必填)
   * @param {number} data.timestamp - 字幕時間戳 (必填)
   * @param {string} data.original - 原始字幕 (必填)
   * @param {string} data.translation - 翻譯建議 (必填)
   * @param {string} data.languageCode - 語言代碼 (必填)
   * @param {string} data.submissionReason - 提交原因 (必填)
   * @param {string} [data.slotKey] - 字幕 slot 識別值（選填）
   * @returns {Promise<Object>} - 返回 { itemId, message }
   */
  async enqueue(data) {
    this.log('enqueue 方法被調用，參數:', data);

    // 參數驗證
    const {
      videoId,
      timestamp,
      original,
      translation,
      languageCode,
      submissionReason,
      slotKey,
      translationID,
      sourceTranslationID,
      resolutionContext
    } = data;

    // 驗證所有必填參數
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

    if (!original || typeof original !== 'string' || original.trim().length === 0) {
      const error = new Error('缺少必要參數: original 必須是非空字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (!translation || typeof translation !== 'string' || translation.trim().length === 0) {
      const error = new Error('缺少必要參數: translation 必須是非空字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (!languageCode || typeof languageCode !== 'string') {
      const error = new Error('缺少必要參數: languageCode 必須是字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    if (!submissionReason || typeof submissionReason !== 'string' || submissionReason.trim().length === 0) {
      const error = new Error('缺少必要參數: submissionReason 必須是非空字符串');
      this.log('參數驗證失敗:', error.message);
      throw error;
    }

    try {
      this.log('發送 typed translation contribution intent 到 content script');
      const payload = {
        videoId,
        timestamp,
        original: original.trim(),
        translation: translation.trim(),
        languageCode,
        submissionReason: submissionReason.trim(),
        slotKey: slotKey || null
      };

      if (resolutionContext !== undefined && resolutionContext !== null) {
        payload.resolutionContext = normalizeResolutionContext(resolutionContext);
        payload.translationID = translationID ?? null;
      } else if (Object.hasOwn(data, 'translationID')) {
        payload.translationID = translationID ?? null;
      }

      if (sourceTranslationID !== undefined) {
        payload.sourceTranslationID = sourceTranslationID;
      }

      const response = await sendMessage({
        category: 'contribution-intent',
        variant: 'enqueue-translation',
        payload
      });

      this.log('translation contribution intent 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response;

    } catch (error) {
      this.log('enqueue 失敗:', error.message);
      throw new Error(`翻譯提交加入隊列失敗: ${error.message}`);
    }
  },

  /**
   * 重試失敗的翻譯提交
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
      this.log('發送 typed translation retry intent 到 content script');
      const response = await sendMessage({
        category: 'contribution-intent',
        variant: 'retry-operation',
        payload: { operationId }
      });

      this.log('translation retry intent 響應:', response);

      if (response.error) {
        throw new Error(response.error);
      }

      return response.retryScheduled === true;

    } catch (error) {
      this.log('retry 失敗:', error.message);
      throw new Error(`重試翻譯提交失敗: ${error.message}`);
    }
  },

  /**
   * 除錯日誌
   * @param {string} message - 日誌訊息
   * @param  {...any} args - 其他參數
   */
  log(message, ...args) {
    if (this.debug) {
      console.log(`[TranslationBridge] ${message}`, ...args);
    }
  }
};
