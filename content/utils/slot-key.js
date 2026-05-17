/**
 * Slot Key 工具
 *
 * 統一前端字幕 slot 的識別規則，避免各模組各自重算造成 key 不一致。
 */

/**
 * 生成 slotKey 所需的標準化 timestamp。
 * @param {number|string} timestamp
 * @returns {string}
 */
export function normalizeSlotTimestamp(timestamp) {
  const numericTimestamp = Number(timestamp);

  if (!Number.isFinite(numericTimestamp)) {
    return '';
  }

  return numericTimestamp.toFixed(4);
}

/**
 * 生成字幕 slotKey。
 * @param {Object} params
 * @param {string} params.videoID
 * @param {string} params.originalSubtitle
 * @param {string} params.languageCode
 * @param {number|string} params.timestamp
 * @returns {string|null}
 */
export function buildSlotKey({ videoID, originalSubtitle, languageCode, timestamp }) {
  const normalizedVideoID = typeof videoID === 'string' ? videoID.trim() : '';
  const normalizedOriginalSubtitle = String(originalSubtitle || '').trim();
  const normalizedLanguageCode = typeof languageCode === 'string' ? languageCode.trim() : '';
  const normalizedTimestamp = normalizeSlotTimestamp(timestamp);

  if (!normalizedVideoID || !normalizedOriginalSubtitle || !normalizedLanguageCode || !normalizedTimestamp) {
    return null;
  }

  return `${normalizedVideoID}::${normalizedOriginalSubtitle}::${normalizedLanguageCode}::${normalizedTimestamp}`;
}
