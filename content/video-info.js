/**
 * 字幕助手擴充功能 - 視頻信息模組
 * 
 * 這個模組負責獲取當前播放視頻的 ID、時間戳和其他相關信息。
 */

import { sendMessage } from './messaging.js';

// 當前視頻信息
let currentVideoId = null;
let currentVideoTitle = null;
let currentVideoLanguage = null;

// 視頻播放器元素
let videoElement = null;

/**
 * 初始化視頻信息模組
 */
export function initVideoInfo() {
  console.log('初始化視頻信息模組...');
  
  // 尋找視頻元素
  findVideoElement();
  
  // 提取視頻信息
  extractVideoInfo();
  
  // 設置定期檢查
  setInterval(checkVideoChange, 2000);
  
  // 監聽頁面變化，以檢測視頻切換
  window.addEventListener('popstate', () => {
    setTimeout(extractVideoInfo, 1000);
  });
  
  // 監聽 URL 變化
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(extractVideoInfo, 1000);
    }
  }).observe(document, { subtree: true, childList: true });
}

/**
 * 尋找視頻元素
 * @param {number} attempt - 當前重試次數
 * @param {number} maxAttempts - 最大重試次數
 */
function findVideoElement(attempt = 1, maxAttempts = 5) {
  // 尋找視頻元素
  videoElement = document.querySelector('video');
  
  if (!videoElement) {
    if (attempt <= maxAttempts) {
      const delay = Math.pow(2, attempt - 1) * 500; // 遞增等待時間：0.5s, 1s, 2s, 4s, 8s
      console.log(`找不到視頻元素，第 ${attempt} 次重試，將在 ${delay/1000} 秒後重試`);
      setTimeout(() => findVideoElement(attempt + 1, maxAttempts), delay);
    } else {
      console.error(`已達最大重試次數 (${maxAttempts})，仍找不到視頻元素`);
    }
    return;
  }
  
  console.log('找到視頻元素');
  
  // 監聽視頻播放事件
  videoElement.addEventListener('play', () => {
    extractVideoInfo();
    sendMessage({
      type: 'PLAYER_STATE_CHANGE',
      state: 'play',
      timestamp: getCurrentTimestamp()
    }).catch(error => {
      console.error('發送播放狀態消息失敗:', error);
    });
    console.log('視頻播放，通知其他模組');
  });
  
  videoElement.addEventListener('pause', () => {
    sendMessage({
      type: 'PLAYER_STATE_CHANGE',
      state: 'pause',
      timestamp: getCurrentTimestamp()
    }).catch(error => {
      console.error('發送暫停狀態消息失敗:', error);
    });
    console.log('視頻暫停，通知其他模組');
  });
  
  videoElement.addEventListener('seeked', () => {
    // 當用戶跳轉視頻時，可能需要更新時間戳
    console.log('視頻跳轉，當前時間:', getCurrentTimestamp());
    sendMessage({
      type: 'PLAYER_STATE_CHANGE',
      state: 'seeked',
      timestamp: getCurrentTimestamp()
    }).catch(error => {
      console.error('發送跳轉狀態消息失敗:', error);
    });
  });
}

/**
 * 提取視頻信息
 */
function extractVideoInfo() {
  // 從 URL 中提取視頻 ID
  const videoIdFromUrl = extractVideoIdFromUrl();
  
  if (videoIdFromUrl && videoIdFromUrl !== currentVideoId) {
    currentVideoId = videoIdFromUrl;
    console.log('視頻 ID 已更新:', currentVideoId);
    
    // 提取視頻標題
    extractVideoTitle();
    
    // 提取視頻語言
    extractVideoLanguage();
    
    // 將視頻信息保存到存儲中
    saveVideoInfo();
  }
}

/**
 * 從 URL 中提取視頻 ID
 * @returns {string|null} - 視頻 ID 或 null
 */
function extractVideoIdFromUrl() {
  // 串流平台 URL 格式，例如: https://www.netflix.com/watch/81234567
  const match = location.href.match(/netflix\.com\/watch\/(\d+)/);
  
  if (match && match[1]) {
    return match[1];
  }
  
  // 如果無法從 URL 中提取，嘗試從頁面元素中提取
  const videoIdElement = document.querySelector('[data-videoid]');
  if (videoIdElement) {
    return videoIdElement.getAttribute('data-videoid');
  }
  
  // 如果仍然無法提取，返回一個默認值或 null
  return 'unknown';
}

/**
 * 提取視頻標題
 * 此項暫時未實現，需要根據具體平台進行調整。
 */
function extractVideoTitle() {
  // 嘗試從頁面元素中提取視頻標題
  const titleElement = document.querySelector('.video-title h4');
  
  if (titleElement) {
    currentVideoTitle = titleElement.textContent.trim();
    console.log('視頻標題:', currentVideoTitle);
  } else {
    // 如果找不到標題元素，嘗試其他選擇器
    const altTitleElement = document.querySelector('.title-title');
    if (altTitleElement) {
      currentVideoTitle = altTitleElement.textContent.trim();
      console.log('視頻標題 (alt):', currentVideoTitle);
    } else {
      currentVideoTitle = 'Unknown Title';
    }
  }
}

/**
 * 提取視頻語言
 * 註: 目前這個功能無作用
 */
function extractVideoLanguage() {
  // 嘗試從字幕選擇器中提取當前語言
  const languageSelector = document.querySelector('.audio-subtitle-controller');
  
  if (languageSelector) {
    const selectedLanguage = languageSelector.textContent.trim();
    if (selectedLanguage) {
      currentVideoLanguage = selectedLanguage;
      console.log('視頻語言:', currentVideoLanguage);
    }
  }
  
  // 如果無法提取，設置為默認值
  if (!currentVideoLanguage) {
    currentVideoLanguage = 'unknown';
  }
}

/**
 * 檢查視頻是否已更改
 */
function checkVideoChange() {
  const newVideoId = extractVideoIdFromUrl();
  
  if (newVideoId && newVideoId !== currentVideoId) {
    console.log('檢測到視頻變更:', currentVideoId, '->', newVideoId);
    extractVideoInfo();
    // 重新初始化 videoElement 以確保抓取正確的元素
    videoElement = null;
    console.log('視頻變更，重新初始化 videoElement');
    findVideoElement();
  }
}

/**
 * 將視頻信息保存到存儲中
 */
function saveVideoInfo() {
  // 使用 sendMessage 而不是直接訪問 chrome.storage
  sendMessage({
    type: 'SAVE_VIDEO_INFO',
    data: {
      currentVideoId,
      currentVideoTitle,
      currentVideoLanguage
    }
  })
  .then(() => {
    console.log('視頻信息已保存到存儲中');
  })
  .catch(error => {
    console.error('保存視頻信息時出錯:', error);
  });
}

/**
 * 獲取當前視頻 ID
 * @returns {string} - 視頻 ID
 */
export function getVideoId() {
  // 如果尚未提取視頻 ID，則立即提取
  if (!currentVideoId) {
    currentVideoId = extractVideoIdFromUrl();
  }
  
  return currentVideoId;
}

/**
 * 獲取當前視頻標題
 * @returns {string} - 視頻標題
 */
export function getVideoTitle() {
  return currentVideoTitle;
}

/**
 * 獲取當前視頻語言 (已棄用，改為手動選擇)
 * @returns {string} - 'unknown'
 */
export function getVideoLanguage() {
  // console.warn('[Video Info] getVideoLanguage is deprecated. Language is now selected manually.');
  return 'unknown'; // 直接返回 unknown，不再嘗試自動檢測
  // return currentVideoLanguage; // 原始碼
}

/**
 * 獲取當前時間戳
 * @returns {number} - 時間戳（秒）
 */
export function getCurrentTimestamp() {
  if (videoElement) {
    // 返回當前播放時間（秒），保留一位小數
    return Math.round(videoElement.currentTime * 10) / 10;
  }
  
  return 0;
}
