/**
 * Netflix 字幕優化擴充功能 - 字幕偵測模組
 * 
 * 這個模組負責偵測 Netflix 播放器上的字幕，並提取字幕文本和時間信息。
 */

// 事件回調函數
let subtitleDetectedCallback = null;

// 字幕元素選擇器
const SUBTITLE_SELECTORS = [
  '.player-timedtext-text-container', // 主要字幕容器
  '.player-timedtext-text-container span', // 字幕文本元素
  '.player-timedtext' // 備用選擇器
];

// MutationObserver 實例
let observer = null;

/**
 * 初始化字幕偵測模組
 */
export function initSubtitleDetector() {
  console.log('初始化字幕偵測模組...');
  
  // 創建 MutationObserver 實例
  observer = new MutationObserver(handleDOMChanges);
  
  // 開始觀察 DOM 變化
  startObserving();
  
  // 監聽視頻播放器加載事件
  document.addEventListener('load', checkForVideoPlayer, true);
  
  // 立即檢查視頻播放器是否已存在
  checkForVideoPlayer();
  
  console.log('字幕偵測模組初始化完成');
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
  
  // 獲取字幕位置信息
  const rect = element.getBoundingClientRect();
  const position = {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
  
  // 獲取字幕樣式
  const style = window.getComputedStyle(element);
  const subtitleStyle = {
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    color: style.color,
    backgroundColor: style.backgroundColor,
    textAlign: style.textAlign
  };
  
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
    subtitleDetectedCallback(subtitleData);
  }
}

/**
 * 註冊字幕偵測事件回調
 * @param {Function} callback - 回調函數，接收字幕數據
 */
export function onSubtitleDetected(callback) {
  subtitleDetectedCallback = callback;
}
