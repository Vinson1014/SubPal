/**
 * 字幕助手擴充功能 - 視頻信息模組
 * 
 * 這個模組負責獲取當前播放視頻的 ID、時間戳和其他相關信息。
 */

import { sendMessage, onMessage, dispatchInternalEvent } from './messaging.js';

// 當前視頻信息
let currentVideoId = null;
let currentVideoTitle = null;
let currentVideoLanguage = null;

// 視頻播放器元素
let videoElement = null;
let videoElements = []; // 新增：儲存所有找到的視頻元素

let debugMode = false;

function debugLog(...args) {
  if (debugMode) {
    console.log('[VideoInfo]', ...args);
  }
}

/**
 * 初始化視頻信息模組
 */
export function initVideoInfo() {
  console.log('初始化視頻信息模組...');

  // 設置調試模式
  loadDebugMode();

  // 尋找視頻元素
  findVideoElement();
  
  // 提取視頻信息
  extractVideoInfo();
  
  // 設置定期檢查
  setInterval(checkVideoChange, 2000);
  
  // 監聽頁面變化，以檢測視頻切換
  window.addEventListener('popstate', () => {
    setTimeout(checkVideoChange, 1000);
  });
  
  // 監聽 URL 變化
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(checkVideoChange, 1000);
    }
  }).observe(document, { subtree: true, childList: true });
}

/**
 * 從存儲中載入調試模式設置
 */
function loadDebugMode() {
  // 使用 sendMessage 而不是直接存取 chrome.storage
  sendMessage({
    type: 'GET_SETTINGS',
    keys: ['debugMode']
  })
.then(result => {
    if (result && result.debugMode !== undefined) {
      debugMode = result.debugMode;
      console.log('載入調試模式設置:', debugMode);
    }
  })
  .catch(error => {
    console.error('載入調試模式設置時出錯:', error);
  });
  
  // 監聽設置變更
  onMessage((message) => {
    if (message.type === 'TOGGLE_DEBUG_MODE') {
      debugMode = message.debugMode;
      console.log('調試模式設置已更新:', debugMode);
    }
  });
}


/**
 * 尋找視頻元素
 * @param {number} attempt - 當前重試次數
 * @param {number} maxAttempts - 最大重試次數
 */
function findVideoElement(attempt = 1, maxAttempts = 5) {
  // 尋找所有視頻元素
  videoElements = document.querySelectorAll('video');
  
  if (videoElements.length === 0) {
    if (attempt <= maxAttempts) {
      const delay = attempt === 1 ? 3000 : Math.pow(2, attempt - 1) * 1000; // 首次延遲3秒，之後指數增長
      debugLog(`找不到視頻元素，第 ${attempt} 次重試，將在 ${delay/1000} 秒後重試`);
      setTimeout(() => findVideoElement(attempt + 1, maxAttempts), delay);
    } else {
      console.error(`已達最大重試次數 (${maxAttempts})，仍找不到視頻元素`);
    }
    return;
  }
  
  debugLog(`找到 ${videoElements.length} 個視頻元素`);

  // 檢查是否為觀看頁面 (URL 格式如 https://www.netflix.com/watch/1234)
  const isViewingPage = location.href.match(/netflix\.com\/watch\/\d+/);
  
  // 使用 IntersectionObserver 檢查可見性
  let visibleVideos = [];
  if (!isViewingPage) {
    debugLog('非觀看頁面：使用 IntersectionObserver 檢查視頻可見性');
    observeVideoVisibility(videoElements, (visible) => {
      visibleVideos = visible;
      selectVideoElement(isViewingPage, visibleVideos);
    });
  } else {
    // 觀看頁面直接選擇播放中的元素
    selectVideoElement(isViewingPage, Array.from(videoElements));
  }
  
  // 為所有找到的視頻元素添加事件監聽器
  videoElements.forEach(video => {
    // 移除舊的監聽器以避免重複添加
    video.removeEventListener('play', handleVideoPlay);
    video.removeEventListener('pause', handleVideoPause);
    video.removeEventListener('seeked', handleVideoSeeked);

    video.addEventListener('play', handleVideoPlay);
    video.addEventListener('pause', handleVideoPause);
    video.addEventListener('seeked', handleVideoSeeked);
  });

  // 為非觀看頁面添加用戶互動偵測
  if (!isViewingPage) {
    setupInteractionDetection(videoElements);
  }

  debugLog('已為所有視頻元素添加事件監聽器');
}

/**
 * 使用 IntersectionObserver 觀察視頻元素的可見性
 * @param {NodeList} videoElements - 視頻元素列表
 * @param {Function} callback - 回調函數，接收可見視頻列表
 */
function observeVideoVisibility(videoElements, callback) {
  const visibleVideos = [];
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
        if (!visibleVideos.includes(entry.target)) {
          visibleVideos.push(entry.target);
          debugLog(`視頻元素可見，ID: ${entry.target.getAttribute('data-videoid') || '未知'}`);
        }
      }
    });
    callback(visibleVideos);
    if (visibleVideos.length > 0) {
      observer.disconnect(); // 找到可見視頻後停止觀察
    }
  }, { threshold: 0.5 });

  videoElements.forEach(video => observer.observe(video));
  
  // 設置超時以防 IntersectionObserver 無法觸發
  setTimeout(() => {
    if (visibleVideos.length === 0) {
      debugLog('IntersectionObserver 超時，無可見視頻，使用所有視頻元素');
      callback(Array.from(videoElements));
      observer.disconnect();
    }
  }, 2000);
}

/**
 * 選擇視頻元素基於可見性和播放狀態
 * @param {boolean} isViewingPage - 是否為觀看頁面
 * @param {Array} candidateVideos - 候選視頻元素列表
 */
function selectVideoElement(isViewingPage, candidateVideos) {
  if (candidateVideos.length === 0) {
    debugLog('無候選視頻元素可供選擇');
    return;
  }

  // 優先選擇播放中的元素
  let playingVideo = null;
  for (const video of candidateVideos) {
    if (!video.paused) {
      playingVideo = video;
      break;
    }
  }

  if (isViewingPage) {
    // 觀看頁面：保持現有邏輯
    if (playingVideo) {
      videoElement = playingVideo;
      debugLog('觀看頁面：選擇播放中的視頻元素作為有效元素');
    } else {
      // 如果沒有播放中的元素，選擇最後一個找到的元素作為默認值
      videoElement = candidateVideos[candidateVideos.length - 1];
      debugLog('觀看頁面：沒有播放中的視頻元素，選擇最後一個找到的元素作為有效元素');
    }
  } else {
    // 非觀看頁面：優先選擇播放中的可見元素
    if (playingVideo) {
      videoElement = playingVideo;
      debugLog('非觀看頁面：選擇播放中的可見視頻元素作為有效元素');
    } else {
      // 如果沒有播放中的元素，選擇優先級最高的元素
      videoElement = prioritizeVideoElement(candidateVideos);
      debugLog('非觀看頁面：無播放中視頻，選擇優先級最高的元素作為有效元素');
    }
  }
}

/**
 * 為視頻元素設定優先級，基於 DOM 位置和特定類名
 * @param {Array} videos - 視頻元素列表
 * @returns {Element} - 優先級最高的視頻元素
 */
function prioritizeVideoElement(videos) {
  if (videos.length === 0) return null;
  
  // 優先選擇具有特定類名或位於特定容器的元素（如 Netflix banner）
  for (const video of videos) {
    const parentContainer = video.closest('.billboard, .VideoContainer');
    if (parentContainer) {
      debugLog(`優先選擇位於 banner 或主要容器中的視頻元素`);
      return video;
    }
  }
  
  // 如果沒有特定容器，選擇第一個元素（通常在 DOM 中位置較高）
  debugLog(`無特定容器，選擇第一個視頻元素`);
  return videos[0];
}

/**
 * 設置用戶互動偵測（如滑鼠懸停或點擊）
 * @param {NodeList} videoElements - 視頻元素列表
 */
function setupInteractionDetection(videoElements) {
  videoElements.forEach(video => {
    const container = video.closest('.video-container, .billboard, .previewModal');
    if (container) {
      container.removeEventListener('mouseover', handleVideoInteraction);
      container.addEventListener('mouseover', handleVideoInteraction);
      debugLog(`為視頻容器添加互動偵測，ID: ${video.getAttribute('data-videoid') || '未知'}`);
    }
  });
}

/**
 * 處理用戶與視頻的互動
 * @param {Event} event - 事件對象
 */
function handleVideoInteraction(event) {
  const container = event.currentTarget;
  const video = container.querySelector('video');
  if (video) {
    videoElement = video;
    debugLog(`用戶互動偵測：選擇用戶懸停的視頻元素，ID: ${video.getAttribute('data-videoid') || '未知'}`);
    extractVideoInfo();
  }
}

// 新增：處理視頻播放事件
function handleVideoPlay() {
  debugLog('視頻播放事件觸發');
  // 更新當前有效的 videoElement
  videoElement = this;
  extractVideoInfo();
  try {
    dispatchInternalEvent({
      type: 'PLAYER_STATE_CHANGED',
      state: 'play',
      timestamp: getCurrentTimestamp()
    });
  } catch (error) {
    console.error('發送播放狀態內部事件失敗:', error);
  }
  console.log('視頻播放，通知其他模組');
}

// 新增：處理視頻暫停事件
function handleVideoPause() {
  debugLog('視頻暫停事件觸發');
  // 更新當前有效的 videoElement
  videoElement = this;
  try {
    dispatchInternalEvent({
      type: 'PLAYER_STATE_CHANGED',
      state: 'pause',
      timestamp: getCurrentTimestamp()
    });
  } catch (error) {
    console.error('發送暫停狀態內部事件失敗:', error);
  }
  console.log('視頻暫停，通知其他模組');
  // 檢查是否為非觀看頁面，如果是則重新啟動偵測流程，但延遲較長時間
  const isViewingPage = location.href.match(/netflix\.com\/watch\/\d+/);
  if (!isViewingPage) {
    debugLog('非觀看頁面：影片暫停，將在稍後重新啟動偵測流程');
    setTimeout(() => findVideoElement(1, 3), 3000); // 延遲3秒重新偵測，且減少重試次數
  }
}

// 新增：處理視頻跳轉事件
function handleVideoSeeked() {
  debugLog('視頻跳轉事件觸發');
  // 更新當前有效的 videoElement
  videoElement = this;
  // 當用戶跳轉視頻時，可能需要更新時間戳
  console.log('視頻跳轉，當前時間:', getCurrentTimestamp());
  try {
    dispatchInternalEvent({
      type: 'PLAYER_STATE_CHANGED',
      state: 'seeked',
      timestamp: getCurrentTimestamp()
    });
  } catch (error) {
    console.error('發送跳轉狀態內部事件失敗:', error);
  }
}

/**
 * 提取視頻信息
 */
function extractVideoInfo() {
    // 提取視頻標題
    extractVideoTitle();
    
    // 提取視頻語言
    extractVideoLanguage();
    
    // 將視頻信息保存到存儲中
    saveVideoInfo();
}

/**
 * 從 URL 中提取視頻 ID
 * @returns {string|null} - 視頻 ID 或 null
 */
function extractVideoIdFromUrl() {
  // 串流平台 URL 格式，例如: https://www.netflix.com/watch/81234567
  const match = location.href.match(/netflix\.com\/watch\/(\d+)/);
  
  if (match && match[1]) {
    debugLog('從 URL 提取視頻 ID:', match[1]);
    return match[1];
  }
  
  // 如果無法從 URL 中提取，嘗試從頁面元素中提取
  // 優先檢查當前有效的 videoElement
  if (videoElement && videoElement.hasAttribute('data-videoid')) {
    debugLog('從當前有效視頻元素中提取視頻 ID:', videoElement.getAttribute('data-videoid'));
    return videoElement.getAttribute('data-videoid');
  }

  // 檢查所有視頻元素及其父元素或相關容器
  const allVideoElements = document.querySelectorAll('video');
  for (const video of allVideoElements) {
    if (video.hasAttribute('data-videoid')) {
      debugLog('從其他視頻元素中提取視頻 ID:', video.getAttribute('data-videoid'));
      return video.getAttribute('data-videoid');
    }
    // 檢查父元素或相關容器
    const parentWithVideoId = video.closest('[data-videoid]');
    if (parentWithVideoId) {
      debugLog('從視頻元素的父元素中提取視頻 ID:', parentWithVideoId.getAttribute('data-videoid'));
      return parentWithVideoId.getAttribute('data-videoid');
    }
  }

  // 特別針對 Netflix 首頁 banner 結構
  const bannerVideoContainer = document.querySelector('.billboard .VideoContainer[data-videoid]');
  if (bannerVideoContainer) {
    debugLog('從 Netflix banner 容器中提取視頻 ID:', bannerVideoContainer.getAttribute('data-videoid'));
    return bannerVideoContainer.getAttribute('data-videoid');
  }
  
  // 如果仍然無法提取，返回一個默認值或 null
  debugLog('無法從 URL 或 DOM 中提取視頻 ID，回傳unknown。');
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
  debugLog('定時檢查視頻變更, 當前視頻 ID:', currentVideoId);

  const newVideoId = extractVideoIdFromUrl();
  
  if (newVideoId && newVideoId !== 'unknown' && newVideoId !== currentVideoId) {
    debugLog('檢測到視頻變更:', currentVideoId, '->', newVideoId);
    // 在更新 currentVideoId 之前保存舊的 ID
    const oldVideoId = currentVideoId;
    currentVideoId = newVideoId; // 更新 currentVideoId
    extractVideoInfo(); // 重新提取所有視頻信息
    // 重新尋找並設置 videoElement，確保監聽的是當前有效的元素
    findVideoElement();
    // 發送內部事件通知其他模組 videoID 已變動
    try {
      dispatchInternalEvent({
        type: 'VIDEO_ID_CHANGED',
        oldVideoId: oldVideoId, // 使用保存的舊 ID
        newVideoId: newVideoId
      });
    } catch (error) {
      console.error('發送 videoID 變動內部事件失敗:', error);
    }
  } else if (newVideoId === 'unknown') {
    debugLog('檢測到視頻 ID 為 unknown，不觸發變更事件');
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
    debugLog('視頻信息已保存到存儲中');
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
  // 如果尚未提取視頻 ID 或當前 ID 為 unknown，則立即提取
  if (!currentVideoId || currentVideoId === 'unknown') {
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
