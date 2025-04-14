/**
 * 字幕助手擴充功能 - 字幕替換模組
 * 
 * 這個模組負責處理字幕替換的邏輯，包括查詢替換規則和生成替換後的字幕內容。
 */

import { sendMessage, onMessage } from './messaging.js';

// 測試模式狀態
let isTestModeEnabled = false;
let testRules = []; // 格式: [{ original: '原文', replacement: '替換文' }]

/**
 * 初始化字幕替換模組
 */
export function initSubtitleReplacer() {
  console.log('初始化字幕替換模組...');
  
  // 從存儲中載入測試模式狀態和測試規則
  loadTestModeSettings();
  
  // 監聽設置變更
  onMessage((message) => {
    if (message.type === 'SETTINGS_CHANGED') {
      if (message.changes.isTestModeEnabled !== undefined) {
        isTestModeEnabled = message.changes.isTestModeEnabled;
        console.log(`測試模式已${isTestModeEnabled ? '啟用' : '停用'}`);
      }
      
      if (message.changes.testRules) {
        testRules = message.changes.testRules || [];
        console.log('測試規則已更新:', testRules);
      }
    }
  });
  
  console.log('字幕替換模組初始化完成');
}

/**
 * 從存儲中載入測試模式設置
 */
function loadTestModeSettings() {
  // 使用sendMessage而不是直接使用chrome.storage
  sendMessage({
    type: 'GET_SETTINGS',
    keys: ['isTestModeEnabled', 'testRules']
  })
  .then(result => {
    if (result && result.isTestModeEnabled !== undefined) {
      isTestModeEnabled = result.isTestModeEnabled;
      console.log(`載入測試模式狀態: ${isTestModeEnabled}`);
    }
    
    if (result && result.testRules && Array.isArray(result.testRules)) {
      testRules = result.testRules;
      console.log('載入測試規則:', testRules);
    }
  })
  .catch(error => {
    console.error('載入測試模式設置時出錯:', error);
  });
}

/**
 * 處理字幕替換
 * @param {Object} subtitleData - 字幕數據
 * @param {string} videoId - 視頻 ID
 * @param {number} timestamp - 時間戳
 * @returns {Promise<Object|null>} - 替換後的字幕數據，如果沒有替換則返回 null
 */
export async function processSubtitle(subtitleData, videoId, timestamp) {
  const originalText = subtitleData.text;
  
  // 首先檢查測試模式
  if (isTestModeEnabled && testRules.length > 0) {
    const testReplacement = checkTestRules(originalText);
    if (testReplacement) {
      return createReplacedSubtitle(subtitleData, testReplacement);
    }
  }
  
  // 如果測試模式未啟用或沒有匹配的測試規則，查詢後端替換規則
  const backendReplacement = await queryBackendReplacement(originalText, videoId, timestamp);
  if (backendReplacement) {
    return createReplacedSubtitle(subtitleData, backendReplacement);
  }
  
  // 如果沒有找到替換規則，返回 null
  return null;
}

/**
 * 檢查測試規則
 * @param {string} text - 原始字幕文本
 * @returns {string|null} - 替換文本，如果沒有匹配則返回 null
 */
function checkTestRules(text) {
  // 使用精確匹配
  for (const rule of testRules) {
    if (rule.original === text) {
      console.log('測試模式精確匹配成功:', text, '->', rule.replacement);
      return rule.replacement;
    }
  }
  
  // 使用包含匹配
  for (const rule of testRules) {
    if (text.includes(rule.original)) {
      console.log('測試模式包含匹配成功:', rule.original, '在', text, '中，替換為', rule.replacement);
      // 只替換匹配的部分
      return text.replace(rule.original, rule.replacement);
    }
  }
  
  return null;
}

/**
 * 查詢後端替換規則
 * @param {string} text - 原始字幕文本
 * @param {string} videoId - 視頻 ID
 * @param {number} timestamp - 時間戳
 * @returns {Promise<string|null>} - 替換文本，如果沒有匹配則返回 null
 */
async function queryBackendReplacement(text, videoId, timestamp) {
  // 使用sendMessage向後端發送請求
  try {
    const response = await sendMessage({
      type: 'CHECK_SUBTITLE',
      videoId,
      timestamp,
      text
    });
    
    if (response && response.replacement) {
      console.log('後端替換成功:', text, '->', response.replacement);
      return response.replacement;
    }
    return null;
  } catch (error) {
    console.error('查詢後端替換規則時出錯:', error);
    return null;
  }
}

/**
 * 創建替換後的字幕數據
 * @param {Object} originalSubtitle - 原始字幕數據
 * @param {string} replacementText - 替換文本
 * @returns {Object} - 替換後的字幕數據
 */
function createReplacedSubtitle(originalSubtitle, replacementText) {
  // 創建新的字幕數據對象，保留原始字幕的位置和樣式
  return {
    ...originalSubtitle,
    text: replacementText,
    original: originalSubtitle.text,
    isReplaced: true
  };
}
