import { API_BASE_URL } from './config.js';
// 引入 messaging 模組的 sendMessage
import { sendMessage } from './messaging.js';

/**
 * 通用投票函式 (舊版，直接呼叫 API)
 * @param {Object} params
 * @param {string} [params.translationID]
 * @param {string} params.videoID
 * @param {string} params.originalSubtitle
 * @param {number} params.timestamp
 * @param {string} params.userID
 * @param {'upvote'|'downvote'} params.voteType
 * @returns {Promise<Object>} 投票結果
 */
export async function voteSubtitle({ translationID, videoID, originalSubtitle, timestamp, userID, voteType }) {
    if (!userID || !videoID || !originalSubtitle || typeof timestamp !== 'number' || !['upvote','downvote'].includes(voteType)) {
        throw new Error('Missing or invalid vote parameters');
    }
    let url;
    let body = { userID, videoID, originalSubtitle, timestamp, voteType };
    if (translationID) {
        url = `${API_BASE_URL}/translations/${translationID}/vote`;
    } else {
        url = `${API_BASE_URL}/votes`;
    }
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '投票失敗');
    }
    return await res.json();
}

/**
 * 處理投票操作 (新版，透過 background 處理)
 * @param {Object} params
 * @param {string} [params.translationID]
 * @param {string} params.videoID
 * @param {string} params.originalSubtitle - 可能不需要，取決於 background 實現
 * @param {number} params.timestamp
 * @param {'upvote'|'downvote'} params.voteType
 * @returns {Promise<Object>} 投票結果 (由 background 回傳)
 */
export async function handleVote({ translationID, videoID, originalSubtitle, timestamp, voteType }) {
  // 驗證基本參數
  if (!videoID || typeof timestamp !== 'number' || !['upvote', 'downvote'].includes(voteType)) {
    throw new Error('Missing or invalid vote parameters');
  }

  // 透過 messaging 發送消息給 background 處理投票
  // background 會負責獲取 userID 並處理本地暫存與 API 呼叫
  return sendMessage({
    type: 'PROCESS_VOTE',
    payload: {
      translationID,
      videoID,
      originalSubtitle, // 傳遞給 background，由 background 決定是否需要
      timestamp,
      voteType
    }
  });
}
