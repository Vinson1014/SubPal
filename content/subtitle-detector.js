/**
 * 字幕助手擴充功能 - 字幕偵測模組
 * 
 * 這個模組負責偵測串流平台播放器上的字幕，並提取字幕文本和時間信息。
 */

import { sendMessage, onMessage } from './messaging.js';

// 事件回調函數
let subtitleDetectedCallback = null;

// 上一次處理的字幕文本和位置
let lastSubtitleText = '';
let lastSubtitlePosition = null;

// 播放狀態
let isPlaying = false;

// 字幕元素選擇器
const SUBTITLE_SELECTORS = [
  '.player-timedtext-text-container', // 主要字幕容器
  '.player-timedtext-text-container span', // 字幕文本元素
  '.player-timedtext', // 備用選擇器
  '.VideoContainer div.player-timedtext', // 更具體的選擇器
  '.VideoContainer div.player-timedtext-text-container', // 更具體的選擇器
  'div[data-uia="player-timedtext-text-container"]', // 使用 data-uia 屬性
  '.player-timedtext-text-container > span', // 直接子元素
  '.player-timedtext > .player-timedtext-text-container' // 父子關係
];

let debugMode = false;

// 僅在 debugMode 時輸出日誌
function debugLog(...args) {
  if (debugMode) {
    console.log('[SubtitleDetector]', ...args);
  }
}

// MutationObserver 實例
let observer = null;

/**
 * 初始化字幕偵測模組
 */
export function initSubtitleDetector() {
  console.log('初始化字幕偵測模組...');
  
  // 載入調試模式設置
  loadDebugMode();
  
  // 創建 MutationObserver 實例
  observer = new MutationObserver(handleDOMChanges);
  
  // 開始觀察 DOM 變化
  startObserving();
  
  // 監聽視頻播放器加載事件
  document.addEventListener('load', checkForVideoPlayer, true);
  
  // 立即檢查視頻播放器是否已存在
  checkForVideoPlayer();
  
  // 設置字幕容器觀察器
  setupSubtitleObserver();
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
      debugLog('載入調試模式設置:', debugMode);
    }
  })
  .catch(error => {
    console.error('載入調試模式設置時出錯:', error);
  });
  
  // 註冊消息處理器來監聽設置變更
  onMessage((message) => {
    if (message.type === 'TOGGLE_DEBUG_MODE') {
      debugMode = message.debugMode;
      debugLog('調試模式設置已更新:', debugMode);
    }
  });
}

/**
 * 設置字幕容器觀察器
 */
function setupSubtitleObserver() {
  // 尋找字幕容器
  const subtitleContainer = document.querySelector('.player-timedtext');
  if (subtitleContainer) {
    // 創建專門用於字幕容器的 MutationObserver
    const subtitleObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' || mutation.type === 'characterData') {
          scanForSubtitles();
          break;
        }
      }
    });
    
    // 觀察字幕容器的變化
    subtitleObserver.observe(subtitleContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });
    
    debugLog('已設置字幕容器觀察器');
  } else {
    // 如果找不到字幕容器，稍後再試
    setTimeout(setupSubtitleObserver, 1000);
  }
}

/**
 * 主動掃描頁面尋找字幕元素
 */
function scanForSubtitles() {
  if (debugMode) {
    debugLog('主動掃描字幕元素...');
  }

  // 只針對最外層字幕 container 做偵測與合併
  const containers = document.querySelectorAll('.player-timedtext-text-container');
  if (containers.length > 0) {
    if (debugMode) {
      debugLog(`找到 ${containers.length} 個字幕 container`);
    }
    containers.forEach(container => {
      processSubtitleContainerMerged(container);
    });
    return;
  }

  // 沒有任何字幕時，主動觸發空字幕事件
  if (subtitleDetectedCallback) {
    if (debugMode) {
      debugLog('未找到字幕 container，觸發空字幕事件');
    }
    subtitleDetectedCallback({
      text: '',
      position: null,
      element: null,
      isEmpty: true
    });
  }
}

/**
 * 開始觀察 DOM 變化
 */
function startObserving() {
  // 如果已經在觀察，則先停止
  if (observer) {
    observer.disconnect();
  }
  
  // 獲取視頻播放器元素
  const videoPlayer = document.querySelector('.watch-video');
  
  if (videoPlayer) {
    // 觀察整個視頻播放器區域
    observer.observe(videoPlayer, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
    
    debugLog('開始觀察視頻播放器區域');
  } else {
    // 如果找不到視頻播放器，則觀察整個文檔
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    debugLog('找不到視頻播放器，觀察整個文檔');
    
    // 定期檢查視頻播放器是否已加載
    setTimeout(checkForVideoPlayer, 1000);
  }
}

/**
 * 檢查視頻播放器是否已加載
 */
function checkForVideoPlayer() {
  const videoPlayer = document.querySelector('.watch-video');
  
  if (videoPlayer) {
    debugLog('找到視頻播放器，重新配置觀察器');
    startObserving();
  }
}

/**
 * 處理 DOM 變化
 * @param {MutationRecord[]} mutations - 變化記錄
 */
function handleDOMChanges(mutations) {
  // 只有在影片未播放時才重新掃描字幕，以避免干擾輸入
  if (!isPlaying) {
    scanForSubtitles();
  } else {
    if (debugMode) {
      debugLog('影片播放中，暫不掃描字幕以避免干擾');
    }
  }
}

/**
 * 檢查元素是否是字幕元素
 * @param {Element} element - 要檢查的元素
 * @returns {boolean} - 是否是字幕元素
 */
function isSubtitleElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  
  // 檢查元素是否匹配任一字幕選擇器
  return SUBTITLE_SELECTORS.some(selector => {
    try {
      return element.matches(selector);
    } catch (e) {
      return false;
    }
  });
}

/**
 * 合併 container 內所有 span，並正確抓取分行與位置
 * @param {Element} container
 */
function processSubtitleContainerMerged(container) {
  // 直接抓取 container 的 innerHTML 與 textContent
  const text = container.textContent.trim();
  const htmlContent = container.innerHTML;

  // 如果字幕為空，觸發空字幕事件
  if (!text) {
    if (subtitleDetectedCallback) {
      if (debugMode) {
        debugLog('偵測到空字幕，觸發隱藏事件');
      }
      subtitleDetectedCallback({
        text: '',
        position: null,
        element: container,
        isEmpty: true
      });
    }
    return;
  }

  // 延遲抓取 position，確保 DOM 已排版
  function getAndEmitPosition(retry = 0) {
    const rect = container.getBoundingClientRect();
    const position = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };

    // 若 position 異常，最多重試 3 次
    if ((position.top < 1 || position.left < 1 || position.width < 1) && retry < 3) {
      setTimeout(() => getAndEmitPosition(retry + 1), 30 * (retry + 1));
      return;
    }

    // 去重：只用 text+position
    if (
      text === lastSubtitleText &&
      lastSubtitlePosition &&
      Math.abs(lastSubtitlePosition.top - position.top) < 5 &&
      Math.abs(lastSubtitlePosition.left - position.left) < 5
    ) {
      if (debugMode) {
        debugLog('字幕文本和位置與上一次相同，不觸發更新');
      }
      return;
    }
    lastSubtitleText = text;
    lastSubtitlePosition = { ...position };

    // 樣式提取僅用於調試或備用，不直接應用到顯示中
    const style = window.getComputedStyle(container);
    const subtitleStyle = {
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      color: style.color,
      backgroundColor: style.backgroundColor,
      textAlign: style.textAlign
    };

    if (debugMode) {
      debugLog('原生 innerHTML 字幕:', text);
      debugLog('字幕位置:', position);
      debugLog('字幕樣式:', subtitleStyle);
    }

    // 回調中包含 htmlContent 以保留原始換行結構
    const subtitleData = {
      text,
      position,
      style: subtitleStyle, // 僅用於調試，不影響最終顯示
      element: container,
      htmlContent
    };
    if (subtitleDetectedCallback) {
      subtitleDetectedCallback(subtitleData);
    }
  }

  // 延遲 1 frame 抓取位置
  requestAnimationFrame(() => getAndEmitPosition(0));
}

/**
 * 註冊字幕偵測事件回調
 * @param {Function} callback - 回調函數，接收字幕數據
 */
export function onSubtitleDetected(callback) {
  debugLog('註冊字幕偵測回調:', callback ? '已提供回調函數' : '未提供回調函數');
  subtitleDetectedCallback = callback;
  
  // 立即檢查是否已經找到字幕元素
  if (callback) {
    debugLog('回調已設置，主動掃描字幕元素...');
    scanForSubtitles();
  }
}
