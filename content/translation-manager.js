// content/translation-manager.js
// 負責處理翻譯提交相關邏輯

import { sendMessage } from './messaging.js';

/**
 * 處理提交翻譯操作 (透過 background 處理)
 * @param {Object} params
 * @param {string} params.videoId
 * @param {number} params.timestamp
 * @param {string} params.original
 * @param {string} params.translation
 * @param {string} params.submissionReason
 * @param {string} params.languageCode // 新增語言代碼參數
 * @returns {Promise<Object>} 提交結果 (由 background 回傳)
 */
export async function handleSubmitTranslation({ videoId, timestamp, original, translation, submissionReason, languageCode }) {
  // 驗證基本參數 (reason is now submissionReason, 新增 languageCode)
  if (!videoId || typeof timestamp !== 'number' || !original || !translation || !submissionReason || !languageCode) {
    console.error('handleSubmitTranslation 缺少參數:', { videoId, timestamp, original, translation, submissionReason, languageCode });
    throw new Error('Missing or invalid translation submission parameters');
  }

  // 透過 messaging 發送消息給 background 處理提交
  // background 會負責獲取 userID 並處理本地暫存與 API 呼叫
  return sendMessage({
    type: 'SUBMIT_TRANSLATION',
    // 直接傳遞參數，讓 background 處理
    videoId,
    timestamp,
    original,
    translation,
    submissionReason, // Use submissionReason
    languageCode // 傳遞 languageCode
  });
}

// 未來可以擴展此模組，例如處理翻譯相關的 UI 反饋或狀態管理
