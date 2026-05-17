/**
 * 語言代碼工具
 *
 * 統一前端設定值與 API 使用的語言代碼格式，避免不同模組各自轉換。
 */

const API_LANGUAGE_CODE_MAPPING = {
  'zh-Hant': 'zh-TW',
  'zh-Hans': 'zh-CN'
};

/**
 * 將前端設定語言代碼轉成 API 使用格式。
 * @param {string} languageCode
 * @returns {string}
 */
export function toAPILanguageCode(languageCode) {
  if (!languageCode || typeof languageCode !== 'string') {
    return '';
  }

  return API_LANGUAGE_CODE_MAPPING[languageCode] || languageCode;
}
