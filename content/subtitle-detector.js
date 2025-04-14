/**
 * 字幕助手擴充功能 - 字幕偵測模組
 * 
 * 這個模組負責偵測串流平台播放器上的字幕，並提取字幕文本和時間信息。
 */

import { sendMessage, onMessage } from './messaging.js';

// 事件回調函數
let subtitleDetectedCallback = null;

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

// 調試模式
let debugMode = false;

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
  
  // 定期檢查字幕元素
  setInterval(scanForSubtitles, 2000);
  
  console.log('字幕偵測模組初始化完成');
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
  
  // 註冊消息處理器來監聽設置變更
  onMessage((message) => {
    if (message.type === 'TOGGLE_DEBUG_MODE') {
      debugMode = message.debugMode;
      console.log('調試模式設置已更新:', debugMode);
    }
  });
}

/**
 * 主動掃描頁面尋找字幕元素
 */
function scanForSubtitles() {
  if (debugMode) {
    console.log('主動掃描字幕元素...');
  }
  
  // 嘗試所有選擇器
  for (const selector of SUBTITLE_SELECTORS) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      if (debugMode) {
        console.log(`找到 ${elements.length} 個字幕元素，使用選擇器: ${selector}`);
      }
      
      // 處理每個找到的元素
      elements.forEach(element => {
        processSubtitleElement(element);
      });
      
      // 找到元素後不需要繼續嘗試其他選擇器
      return;
    }
  }
  
  if (debugMode) {
    console.log('未找到字幕元素');
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
    
    console.log('開始觀察視頻播放器區域');
  } else {
    // 如果找不到視頻播放器，則觀察整個文檔
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    console.log('找不到視頻播放器，觀察整個文檔');
    
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
    console.log('找到視頻播放器，重新配置觀察器');
    startObserving();
  }
}

/**
 * 處理 DOM 變化
 * @param {MutationRecord[]} mutations - 變化記錄
 */
function handleDOMChanges(mutations) {
  // 檢查是否有字幕元素的變化
  for (const mutation of mutations) {
    // 如果是字幕元素的變化
    if (isSubtitleElement(mutation.target)) {
      processSubtitleElement(mutation.target);
    }
    
    // 檢查新增的節點
    if (mutation.addedNodes && mutation.addedNodes.length > 0) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 檢查新增的元素是否是字幕元素
          if (isSubtitleElement(node)) {
            processSubtitleElement(node);
          }
          
          // 檢查新增元素的子元素
          const subtitleElements = node.querySelectorAll(SUBTITLE_SELECTORS.join(', '));
          for (const element of subtitleElements) {
            processSubtitleElement(element);
          }
        }
      }
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
 * 處理字幕元素
 * @param {Element} element - 字幕元素
 */
function processSubtitleElement(element) {
  // 提取字幕文本
  const text = element.textContent.trim();
  
  // 如果字幕為空，則忽略
  if (!text) {
    return;
  }
  
  if (debugMode) {
    console.log(`處理字幕元素: "${text}"`);
    console.log('元素類型:', element.tagName);
    console.log('元素類名:', element.className);
    console.log('元素 ID:', element.id);
    console.log('元素屬性:', Array.from(element.attributes).map(attr => `${attr.name}="${attr.value}"`).join(', '));
  }
  
  // 獲取字幕位置信息
  const rect = element.getBoundingClientRect();
  const position = {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
  
  if (debugMode) {
    console.log('字幕位置:', position);
  }
  
  // 獲取字幕樣式
  const style = window.getComputedStyle(element);
  const subtitleStyle = {
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    color: style.color,
    backgroundColor: style.backgroundColor,
    textAlign: style.textAlign
  };
  
  if (debugMode) {
    console.log('字幕樣式:', subtitleStyle);
  }
  
  // 創建字幕數據對象
  const subtitleData = {
    text,
    position,
    style: subtitleStyle,
    element,
    timestamp: Date.now()
  };
  
  // 觸發字幕偵測事件
  if (subtitleDetectedCallback) {
    if (debugMode) {
      console.log('觸發字幕偵測事件:', subtitleData);
    }
    subtitleDetectedCallback(subtitleData);
  } else if (debugMode) {
    console.warn('字幕偵測回調未設置，無法處理字幕');
  }
}

/**
 * 註冊字幕偵測事件回調
 * @param {Function} callback - 回調函數，接收字幕數據
 */
export function onSubtitleDetected(callback) {
  console.log('註冊字幕偵測回調:', callback ? '已提供回調函數' : '未提供回調函數');
  subtitleDetectedCallback = callback;
  
  // 立即檢查是否已經找到字幕元素
  if (callback) {
    console.log('回調已設置，主動掃描字幕元素...');
    scanForSubtitles();
  }
}
