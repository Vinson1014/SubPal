/**
 * 字幕助手擴充功能 - 字幕偵測模組
 * 
 * 這個模組負責偵測串流平台播放器上的字幕，並提取字幕文本和時間信息。
 */

import { sendMessage, onMessage, registerInternalEventHandler } from './messaging.js';

// 事件回調函數
let subtitleDetectedCallback = null;

// 上一次處理的字幕文本和位置
let lastSubtitleText = '';
let lastSubtitlePosition = null;

// 用於儲存當前 MutationObserver 實例的模組級變數
let currentSubtitleObserver = null;


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


/**
 * 初始化字幕偵測模組
 */
export function initSubtitleDetector() {
  console.log('初始化字幕偵測模組...');
  
  // 載入調試模式設置
  loadDebugMode();
  
  // 設置字幕容器觀察器
  setupSubtitleObserver();
  
  // 註冊內部事件處理器來監聽影片切換事件
  registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => {
    debugLog('收到內部事件 VIDEO_ID_CHANGED，重新設置字幕觀察器');
    // 斷開舊的觀察器並設置新的
    setupSubtitleObserver();
    // 立即掃描一次以獲取新影片的第一個字幕
    scanForSubtitles();
  });
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
    }
  })
  .catch(error => {
    console.error('載入調試模式設置時出錯:', error);
  });
  
  // 使用內部事件機制監聽設置變更
  registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
    debugMode = message.debugMode;
    debugLog('調試模式設置已更新:', debugMode);
  });
}

/**
 * 設置字幕容器觀察器
 */
function setupSubtitleObserver() {
  // 如果存在舊的觀察器，先斷開它
  if (currentSubtitleObserver) {
    debugLog('斷開舊的字幕容器觀察器');
    currentSubtitleObserver.disconnect();
    currentSubtitleObserver = null; // 清空引用
  }
  
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
    
    // 儲存新的觀察器實例
    currentSubtitleObserver = subtitleObserver;
    
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
