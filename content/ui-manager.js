/**
 * 字幕助手擴充功能 - UI 管理模組
 * 
 * 這個模組負責創建和管理自定義 UI 層，顯示替換後的字幕。
 */

// 統一管理 z-index 層級
const Z_INDEX = {
  SUBTITLE: 10000,
  BUTTONS: 10100,
  DIALOG: 12000,
  TOAST: 13000
};

import { sendMessage, onMessage } from './messaging.js';
// 引入 vote-manager 的接口
import { handleVote } from './vote-manager.js';
// 引入 translation-manager 的接口
import { handleSubmitTranslation as submitTranslationViaManager } from './translation-manager.js';
import { getCurrentTimestamp } from './video-info.js';


// 自定義 UI 元素
let customSubtitleContainer = null;
let customSubtitleElement = null;

// 調試模式
let debugMode = false;
let debugTimestampElement = null;
let debugTimestampInterval = null;

// 上一次的字幕位置
let lastPosition = null;

/**
 * 字幕樣式設置，支持用戶自定義的多種樣式屬性。
 * 這些樣式將統一應用於所有字幕（原生或替換），以確保一致性。
 */
let subtitleStyle = {
  fontSize: '28px',
  fontFamily: 'Arial, sans-serif',
  fontWeight: 'normal',
  fontStyle: 'normal',
  color: '#ffffff',
  backgroundColor: 'rgba(0, 0, 0, 0.75)',
  textAlign: 'center',
  padding: '5px 10px',
  borderRadius: '4px',
  textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
  border: 'none',
  opacity: '1.0',
  maxWidth: '100%'
};

// 當前顯示的字幕數據
let currentSubtitle = null;

// 字幕交互按鈕
let interactionButtons = null;

/**
 * 防抖函數，限制函數的執行頻率
 * @param {Function} func - 要執行的函數
 * @param {number} wait - 等待時間（毫秒）
 * @returns {Function} - 防抖後的函數
 */
function debounce(func, wait) {
  let timeout;
  return function() {
    const context = this;
    const args = arguments;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}

/**
 * 初始化 UI 管理模組
 */
export function initUIManager() {
  console.log('初始化 UI 管理模組...');
  
  // 創建自定義字幕容器
  createCustomSubtitleContainer();
  
  // 從存儲中載入字幕樣式設置
  loadSubtitleStyle();
  
  // 載入調試模式設置
  loadDebugMode();
  
  // 監聽視窗大小變化，調整字幕位置和大小（使用防抖）
  window.addEventListener('resize', debounce(() => {
    updateSubtitlePosition(currentSubtitle?.position);
    updateSubtitleSize();
  }, 200));
  
  // 監聽滾動事件，確保字幕容器始終可見（使用防抖）
  window.addEventListener('scroll', debounce(updateSubtitlePosition, 200));
  
  // 隱藏原生字幕，確保偵測功能仍然有效
  hideNativeSubtitles();
  
  // 初始調整字幕大小
  updateSubtitleSize();
  
  console.log('UI 管理模組初始化完成');
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
      toggleDebugTimestamp(debugMode);
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
      toggleDebugTimestamp(debugMode);
    }
  });
}

// 切換 debug timestamp 顯示與更新
function toggleDebugTimestamp(enabled) {
  if (enabled) {
    if (!debugTimestampElement) {
      debugTimestampElement = document.createElement('div');
      debugTimestampElement.id = 'debug-timestamp';
      Object.assign(debugTimestampElement.style, {
        position: 'fixed',
        top: '10px',
        right: '10px',
        zIndex: Z_INDEX.BUTTONS.toString(),
        color: '#00ff00',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        padding: '4px 6px',
        borderRadius: '4px',
        fontSize: '14px'
      });
      document.body.appendChild(debugTimestampElement);
    }
    debugTimestampElement.style.display = 'block';
    if (debugTimestampInterval) clearInterval(debugTimestampInterval);
    debugTimestampInterval = setInterval(() => {
      debugTimestampElement.textContent = `Time: ${getCurrentTimestamp()}s`;
    }, 500);
  } else {
    if (debugTimestampInterval) {
      clearInterval(debugTimestampInterval);
      debugTimestampInterval = null;
    }
    if (debugTimestampElement) {
      debugTimestampElement.style.display = 'none';
    }
  }
}

/**
 * 從存儲中載入字幕樣式設置
 */
function loadSubtitleStyle() {
  // 使用 sendMessage 而不是直接存取 chrome.storage
  sendMessage({
    type: 'GET_SETTINGS',
    keys: ['subtitleStyle']
  })
  .then(result => {
    if (result && result.subtitleStyle) {
      subtitleStyle = { ...subtitleStyle, ...result.subtitleStyle };
      console.log('載入字幕樣式設置:', subtitleStyle);
      
      // 如果已經創建了字幕元素，則更新其樣式
      if (customSubtitleElement) {
        applySubtitleStyle();
      }
    }
  })
  .catch(error => {
    console.error('載入字幕樣式設置時出錯:', error);
  });
  
  // 監聽設置變更
  onMessage((message) => {
    if (message.type === 'SUBTITLE_STYLE_UPDATED' && message.subtitleStyle) {
      subtitleStyle = { ...subtitleStyle, ...message.subtitleStyle };
      console.log('字幕樣式設置已更新:', subtitleStyle);
      
      // 更新字幕元素樣式
      if (customSubtitleElement) {
        applySubtitleStyle();
      }
    }
  });
}

/**
 * 創建自定義字幕容器
 */
function createCustomSubtitleContainer() {
  console.log('創建自定義字幕容器...');
  
  // 檢查是否已經存在
  if (customSubtitleContainer) {
    console.log('字幕容器已存在，不需要重新創建');
    return;
  }
  
  // 創建容器元素
  customSubtitleContainer = document.createElement('div');
  customSubtitleContainer.id = 'subtitle-assistant-container';
  customSubtitleContainer.style.position = 'fixed'; // 改為 fixed 定位，確保不受滾動影響
  customSubtitleContainer.style.zIndex = Z_INDEX.SUBTITLE.toString(); // 統一 z-index
  customSubtitleContainer.style.pointerEvents = 'auto'; // 修改為可接收滑鼠事件
  customSubtitleContainer.style.display = 'none'; // 初始隱藏
  customSubtitleContainer.style.textAlign = 'left'; // 確保字幕文本左對齊盡量靠齊原生字幕

  customSubtitleContainer.style.width = '100%'; // 設置寬度為 100%
  customSubtitleContainer.style.bottom = '10%'; // 預設位置在底部
  customSubtitleContainer.style.left = '0'; // 預設位置在左側
  
  console.log('字幕容器元素已創建');
  
  // 只在調試模式下添加測試用邊框和背景
  if (debugMode) {
    customSubtitleContainer.style.border = '2px solid red';
    customSubtitleContainer.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
  }
  
  // 創建字幕元素
  customSubtitleElement = document.createElement('div');
  customSubtitleElement.id = 'subtitle-assistant-text';
  
  // 應用字幕樣式
  applySubtitleStyle();
  
  // 創建交互按鈕容器（作為字幕容器的子元素，絕對定位於右上角）
  interactionButtons = document.createElement('div');
  interactionButtons.id = 'subtitle-assistant-buttons';
  interactionButtons.style.display = 'none';
  interactionButtons.style.position = 'fixed'; // 浮動於 body
  interactionButtons.style.flexDirection = 'row';
  interactionButtons.style.pointerEvents = 'auto';
  interactionButtons.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  interactionButtons.style.padding = '5px 8px';
  interactionButtons.style.borderRadius = '8px';
  interactionButtons.style.gap = '4px';
  interactionButtons.style.alignItems = 'center';
  interactionButtons.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
  interactionButtons.style.zIndex = Z_INDEX.BUTTONS.toString();

  // 創建按鈕
  const submitButton = createButton('✏️', handleSubmitTranslation);
  const likeButton = createButton('👍', handleLikeSubtitle);
  const dislikeButton = createButton('👎', handleDislikeSubtitle);
  
  // 添加按鈕到容器
  interactionButtons.appendChild(submitButton);
  interactionButtons.appendChild(likeButton);
  interactionButtons.appendChild(dislikeButton);
  
  // 將元素添加到容器
  customSubtitleContainer.appendChild(customSubtitleElement);

  // 將互動按鈕添加到 body（外側浮動）
  document.body.appendChild(interactionButtons);

  // 將容器添加到文檔
  document.body.appendChild(customSubtitleContainer);

  // 添加鼠標事件監聽器
  customSubtitleContainer.addEventListener('mouseenter', showInteractionButtons);
  customSubtitleContainer.addEventListener('mouseleave', hideInteractionButtons);
  interactionButtons.addEventListener('mouseenter', showInteractionButtons);
  interactionButtons.addEventListener('mouseleave', hideInteractionButtons);

  // 設定 container 為 relative，並設最小寬度
  customSubtitleContainer.style.position = 'relative';
  customSubtitleContainer.style.minWidth = '100px';

  console.log('創建自定義字幕容器完成');
}

/**
 * 創建按鈕元素
 * @param {string} text - 按鈕文本
 * @param {Function} clickHandler - 點擊處理函數
 * @returns {HTMLButtonElement} - 按鈕元素
 */
function createButton(text, clickHandler) {
  const button = document.createElement('button');
  button.textContent = text;
  button.style.margin = '0 5px';
  button.style.padding = '3px 8px';
  button.style.backgroundColor = '#1976d2';
  button.style.color = 'white';
  button.style.border = 'none';
  button.style.borderRadius = '4px';
  button.style.cursor = 'pointer';
  button.style.fontSize = '20px';
  
  button.addEventListener('click', clickHandler);
  
  return button;
}

/**
 * 應用字幕樣式，統一應用自訂樣式設置，並根據需要從原生字幕提取樣式。
 */
function applySubtitleStyle() {
  if (!customSubtitleElement) return;
  
  // 應用所有自訂樣式設置，確保一致性
  Object.assign(customSubtitleElement.style, {
    fontSize: subtitleStyle.fontSize,
    fontFamily: subtitleStyle.fontFamily,
    fontWeight: subtitleStyle.fontWeight || 'normal',
    fontStyle: subtitleStyle.fontStyle || 'normal',
    color: subtitleStyle.color,
    backgroundColor: subtitleStyle.backgroundColor,
    textAlign: subtitleStyle.textAlign,
    padding: '5px 0px', // 左右 padding 設為 0，上下保留 5px
    borderRadius: subtitleStyle.borderRadius || '4px',
    textShadow: subtitleStyle.textShadow || '1px 1px 1px rgba(0, 0, 0, 0.5)',
    border: subtitleStyle.border || 'none',
    opacity: subtitleStyle.opacity || '1.0',
    maxWidth: subtitleStyle.maxWidth || '100%',
    margin: '0 auto',
    display: 'inline-block',
    boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.75)' // 讓背景向外延伸 2px，模擬原生字幕效果
  });
}

/**
 * 隱藏字幕
 */
export function hideSubtitle() {
  if (customSubtitleContainer) {
    customSubtitleContainer.style.display = 'none';
    hideInteractionButtons();
  }
  
  currentSubtitle = null;
}

/**
 * 隱藏原生字幕，確保偵測功能仍然有效
 */
function hideNativeSubtitles() {
  // 使用 visibility: hidden 隱藏原生字幕，保留 DOM 結構以便偵測
  const nativeSubtitleElements = document.querySelectorAll('.player-timedtext, .player-timedtext-text-container');
  nativeSubtitleElements.forEach(el => {
    el.style.visibility = 'hidden';
    // 或者使用 opacity: 0 作為備用方案
    // el.style.opacity = '0';
  });
  console.log('原生字幕已隱藏，保留 DOM 結構以便偵測');
}

/**
 * 顯示替換後的字幕，統一使用自訂樣式，保留 HTML 結構以確保換行效果。
 * @param {Object} subtitleData - 字幕數據
 */
export function showSubtitle(subtitleData) {
  console.log('顯示字幕:', subtitleData);

  if (!customSubtitleContainer || !customSubtitleElement) {
    console.log('字幕容器或字幕元素不存在，創建自定義字幕容器');
    createCustomSubtitleContainer();
  }

  // 保存當前字幕數據
  currentSubtitle = subtitleData;

  // 設置字幕文本
  let displayText = subtitleData.text;

  // 只在調試模式下添加標記
  if (debugMode) {
    displayText = `[自訂] ${displayText}`;

    // 如果是替換的字幕，添加標記
    if (subtitleData.isReplaced) {
      displayText = `[替換] ${displayText}`;
    }
  }

  // console.log('顯示字幕文本:', displayText);

  // 如果有 HTML 內容，解析並移除內聯樣式後插入，保留換行和格式（原生或替換字幕都支援）
  if (subtitleData.htmlContent) {
    // 創建臨時 DOM 元素來解析 HTML 內容
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = subtitleData.htmlContent;
    
    // 移除所有子元素的內聯樣式
    const elements = tempDiv.querySelectorAll('*');
    elements.forEach(el => {
      el.removeAttribute('style');
    });
    
    // 將處理後的內容插入到字幕元素中
    customSubtitleElement.innerHTML = tempDiv.innerHTML;
  } else {
    // 如果沒有 HTML 內容，使用純文本
    customSubtitleElement.textContent = displayText;
  }

  // 從 subtitleData.htmlContent 中解析 font-size，如果存在則更新 subtitleStyle
  if (subtitleData.htmlContent) {
    const fontSizeMatch = subtitleData.htmlContent.match(/font-size:(\d+(\.\d+)?px)/i);
    if (fontSizeMatch && fontSizeMatch[1]) {
      subtitleStyle.fontSize = fontSizeMatch[1];
      console.log('從原生字幕 HTML 解析字體大小:', subtitleStyle.fontSize);
    } else {
      console.log('無法從 HTML 內容中解析 font-size，使用預設值:', subtitleStyle.fontSize);
    }
  }

  // 應用自訂樣式
  applySubtitleStyle();

  // 更新字幕位置
  // console.log('更新字幕位置...');
  updateSubtitlePosition(subtitleData.position);

  // 若 position 無效，延遲重試定位，避免初次出現在左上角
  if (
    !subtitleData.position ||
    typeof subtitleData.position.top !== 'number' ||
    typeof subtitleData.position.left !== 'number' ||
    subtitleData.position.top < 10 // 可能是預設左上角
  ) {
    setTimeout(() => {
      if (currentSubtitle === subtitleData) {
        // 再次嘗試定位
        updateSubtitlePosition(subtitleData.position);
      }
    }, 30); // 30ms 後重試，可依實際情況調整
  }

  // 確保字幕容器可見
  customSubtitleContainer.style.display = 'block';

  // 添加額外的可見性檢查，無論是否處於調試模式
  console.log('字幕容器樣式:', {
    display: customSubtitleContainer.style.display,
    position: customSubtitleContainer.style.position,
    top: customSubtitleContainer.style.top,
    left: customSubtitleContainer.style.left,
    width: customSubtitleContainer.style.width,
    zIndex: customSubtitleContainer.style.zIndex
  });

  // 只在調試模式下添加測試用背景色
  if (debugMode) {
    customSubtitleElement.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
  } else {
    customSubtitleElement.style.backgroundColor = subtitleStyle.backgroundColor;
  }

  // 確保字幕元素可見
  customSubtitleElement.style.display = 'inline-block';

  // 檢查字幕元素是否在DOM中
  if (document.body.contains(customSubtitleContainer)) {
    console.log('字幕容器已在DOM中');
  } else {
    console.warn('字幕容器不在DOM中，重新添加');
    document.body.appendChild(customSubtitleContainer);
  }

  // 強制重繪（只執行一次）
  if (!customSubtitleContainer.dataset.initialized) {
    setTimeout(() => {
      console.log('強制重繪字幕容器（僅首次）');
      const originalPointerEvents = customSubtitleContainer.style.pointerEvents;
      customSubtitleContainer.style.display = 'none';
      // 強制瀏覽器重繪
      void customSubtitleContainer.offsetHeight;
      customSubtitleContainer.style.display = 'block';
      customSubtitleContainer.style.pointerEvents = originalPointerEvents || 'auto';
      customSubtitleContainer.dataset.initialized = 'true';
    }, 50);
  }

  // 更新字幕大小，確保與播放器尺寸一致
  updateSubtitleSize();
}


/**
 * 更新字幕大小和位置，根據原生字幕容器尺寸進行調整
 */
function updateSubtitleSize() {
  // 獲取原生字幕容器元素
  const nativeSubtitle = document.querySelector('.player-timedtext-text-container');
  if (!nativeSubtitle) {
    console.log('找不到原生字幕容器元素，無法調整字幕大小和位置');
    return;
  }

  // 獲取原生字幕容器的尺寸和位置
  const nativeRect = nativeSubtitle.getBoundingClientRect();
  console.log('原生字幕容器尺寸和位置:', nativeRect);

  // 更新自訂字幕容器的尺寸和位置以匹配原生字幕容器
  if (customSubtitleContainer) {
    customSubtitleContainer.style.width = `${nativeRect.width}px`;
    customSubtitleContainer.style.height = `${nativeRect.height}px`;
    customSubtitleContainer.style.top = `${nativeRect.top}px`;
    customSubtitleContainer.style.left = `${nativeRect.left}px`;
    customSubtitleContainer.style.bottom = 'auto';
    console.log('自訂字幕容器已更新以匹配原生字幕容器尺寸和位置');
  }

  // 如果字幕元素存在，確保應用當前樣式，但不依賴原生字幕的字體大小
  if (customSubtitleElement) {
    applySubtitleStyle();
  }
}

/**
 * 更新字幕位置，根據原生字幕容器位置進行調整
 * @param {Object} position - 位置信息（可選）
 */
function updateSubtitlePosition(position) {
  console.log('更新字幕位置，傳入位置:', position);
  
  if (!customSubtitleContainer) {
    console.error('字幕容器不存在，無法更新位置');
    return;
  }
  
  // 如果沒有當前字幕數據，不更新位置
  if (!currentSubtitle) {
    console.log('沒有當前字幕數據，不更新位置');
    return;
  }
  
  // 獲取原生字幕容器元素
  const nativeSubtitle = document.querySelector('.player-timedtext-text-container');
  if (!nativeSubtitle) {
    console.log('找不到原生字幕容器元素，嘗試使用備用方法');
    
    // 獲取視頻播放器元素作為備用
    const videoPlayer = document.querySelector('.watch-video, .NFPlayer, video, .VideoContainer, .nf-player-container, [data-uia="video-player"]');
    if (!videoPlayer) {
      console.log('也找不到播放器元素，使用固定位置作為最後備案');
      customSubtitleContainer.style.position = 'fixed';
      customSubtitleContainer.style.bottom = '10%';
      customSubtitleContainer.style.left = '0';
      customSubtitleContainer.style.width = '100%';
      customSubtitleContainer.style.textAlign = 'center';
      return;
    }
    
    const playerRect = videoPlayer.getBoundingClientRect();
    console.log('播放器位置和大小:', playerRect);
    
    // 使用播放器底部的位置
    const containerTop = playerRect.top + playerRect.height - 150;
    customSubtitleContainer.style.position = 'fixed';
    customSubtitleContainer.style.top = `${containerTop}px`;
    customSubtitleContainer.style.left = `${playerRect.left}px`;
    customSubtitleContainer.style.width = 'auto'; // 寬度自適應
    customSubtitleContainer.style.maxWidth = '80%'; // 設置最大寬度
    customSubtitleContainer.style.bottom = 'auto'; // 清除底部定位
    customSubtitleContainer.style.textAlign = 'center';
    
    console.log(`使用備用字幕位置: top=${containerTop}, left=${playerRect.left}, width=${playerRect.width}`);
    return;
  }
  
  // 獲取原生字幕容器的位置和大小
  const nativeRect = nativeSubtitle.getBoundingClientRect();
  console.log('原生字幕容器位置和大小:', nativeRect);
  
  // 檢查位置是否真正變化
  if (lastPosition && 
      Math.abs(lastPosition.top - nativeRect.top) < 5 && 
      Math.abs(lastPosition.left - nativeRect.left) < 5) {
    // 位置變化不大，不需要更新
    console.log('字幕位置變化不大，不更新位置');
    return;
  }
  
  // 更新上一次的位置
  lastPosition = { top: nativeRect.top, left: nativeRect.left };
  
  // 使用原生字幕容器的位置和尺寸
  customSubtitleContainer.style.position = 'fixed';
  customSubtitleContainer.style.top = `${nativeRect.top}px`;
  customSubtitleContainer.style.left = `${nativeRect.left}px`;
  customSubtitleContainer.style.width = `${nativeRect.width}px`;
  customSubtitleContainer.style.height = `${nativeRect.height}px`;
  customSubtitleContainer.style.bottom = 'auto'; // 清除底部定位
  customSubtitleContainer.style.textAlign = 'center';
  
  console.log('使用原生字幕容器位置和尺寸更新自訂字幕容器');
  
  // 確保字幕容器可見
  customSubtitleContainer.style.display = 'block';
  
  // 只在調試模式下添加測試用邊框和背景
  if (debugMode) {
    customSubtitleContainer.style.border = '2px solid red';
    customSubtitleContainer.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
  } else {
    customSubtitleContainer.style.border = 'none';
    customSubtitleContainer.style.backgroundColor = 'transparent';
  }
}

/**
 * 顯示交互按鈕
 */
let hoverTimer = null;
let isHovering = false;

function showInteractionButtons() {
  if (interactionButtons && customSubtitleContainer && currentSubtitle) {
    // 先顯示，才能正確取得 offsetHeight
    interactionButtons.style.display = 'flex';
    // 取得 container 的螢幕座標
    const rect = customSubtitleContainer.getBoundingClientRect();
    const margin = 8; // 與 container 間距
    // 設定按鈕浮動於 container 右上角外側（如圖）
    // left = container 右邊 - 按鈕寬度
    // top = container 上方 - 按鈕高度 - margin
    const btnWidth = interactionButtons.offsetWidth;
    const btnHeight = interactionButtons.offsetHeight;
    interactionButtons.style.left = `${rect.right - btnWidth * 0.5}px`;
    interactionButtons.style.top = `${rect.top - btnHeight - margin}px`;

    // 使字幕容器可以接收點擊事件
    customSubtitleContainer.style.pointerEvents = 'auto';

    isHovering = true;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }

    if (debugMode) {
      console.log('顯示交互按鈕');
    }
  }
}

// 只在滑鼠同時離開 container 和按鈕時才隱藏
function hideInteractionButtons() {
  isHovering = false;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!isHovering && interactionButtons) {
      interactionButtons.style.display = 'none';
      if (debugMode) {
        console.log('隱藏交互按鈕');
      }
    }
  }, 300); // 300ms 容錯，避免滑鼠移動過快導致 flicker
}

// 事件監聽器需確保滑鼠在 container 或按鈕上都算 hover
// 這段要放在 createCustomSubtitleContainer() 內：
// customSubtitleContainer.addEventListener('mouseenter', showInteractionButtons);
// customSubtitleContainer.addEventListener('mouseleave', hideInteractionButtons);
// interactionButtons.addEventListener('mouseenter', () => { isHovering = true; showInteractionButtons(); });
// interactionButtons.addEventListener('mouseleave', hideInteractionButtons);

/**
 * 處理提交翻譯按鈕點擊
 */
function handleSubmitTranslation() {
  if (!currentSubtitle) return;
  
  // 記錄當前字幕的 timestamp
  const recordedTimestamp = currentSubtitle.timestamp;
  
  // 創建提交翻譯的浮動視窗（網頁內）
  const originalText = currentSubtitle.original || currentSubtitle.text;
  const currentText = currentSubtitle.text;
  
  // 創建浮動視窗容器
  const floatingWindow = document.createElement('div');
  floatingWindow.id = 'translation-floating-window';
  floatingWindow.style.position = 'fixed';
  floatingWindow.style.top = '50%';
  floatingWindow.style.left = '50%';
  floatingWindow.style.transform = 'translate(-50%, -50%)';
  floatingWindow.style.backgroundColor = 'white';
  floatingWindow.style.padding = '24px';
  floatingWindow.style.borderRadius = '8px';
  floatingWindow.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
  floatingWindow.style.zIndex = Z_INDEX.DIALOG.toString();
  floatingWindow.style.width = '450px';
  floatingWindow.style.maxHeight = '80vh';
  floatingWindow.style.overflowY = 'auto';
  floatingWindow.style.boxSizing = 'border-box';

  // 創建一個 overlay 層，防止背景干擾
  const overlay = document.createElement('div');
  overlay.id = 'translation-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  overlay.style.zIndex = (Z_INDEX.DIALOG - 1).toString();
  document.body.appendChild(overlay);

  // 創建浮動視窗內容
  floatingWindow.innerHTML = `
    <h3 style="margin-top: 0; margin-bottom: 18px; color: #222; font-size: 22px; font-weight: 600;">提交翻譯</h3>
    <div style="margin-bottom: 14px;">
      <label for="original-text" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">原始翻譯</label>
      <input id="original-text" type="text" value="${originalText.replace(/"/g, '"')}" readonly
        style="width: 100%; box-sizing: border-box; background: #f3f4f6; color: #222; border: 1px solid #e0e0e0; border-radius: 5px; padding: 8px 10px; font-size: 15px; margin-bottom: 0;"/>
    </div>
    <div style="margin-bottom: 14px;">
      <label for="language-select" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">字幕語言</label>
      <select id="language-select" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1.5px solid #bfc7d1; border-radius: 5px; font-size: 15px; color: #222; background: #fff;">
        <option value="">請選擇語言...</option>
        <option value="en">English</option>
        <option value="zh-TW">繁體中文</option>
        <option value="zh-CN">简体中文</option>
        <option value="ja">日本語</option>
        <option value="ko">한국어</option>
        <option value="es">Español</option>
        <option value="fr">Français</option>
        <option value="de">Deutsch</option>
        <option value="other">其他 (請在原因中註明)</option>
      </select>
    </div>
    <div style="margin-bottom: 14px;">
      <label for="translation-input" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">修正翻譯</label>
      <textarea id="translation-input" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1.5px solid #bfc7d1; border-radius: 5px; font-size: 15px; height: 70px; color: #222; background: #fff; resize: vertical;">${currentText}</textarea>
    </div>
    <div style="margin-bottom: 18px;">
      <label for="reason-input" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">調整原因</label>
      <textarea id="reason-input" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1.5px solid #bfc7d1; border-radius: 5px; font-size: 15px; height: 50px; color: #222; background: #fff; resize: vertical;" placeholder="請簡述為何需要調整翻譯"></textarea>
    </div>
    <div style="text-align: right;">
      <button id="cancel-translation" style="padding: 8px 18px; margin-right: 10px; background-color: #f5f5f5; color: #888; border: none; border-radius: 4px; cursor: pointer; font-size: 15px;">取消</button>
      <button id="submit-translation" style="padding: 8px 18px; background-color: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 15px; font-weight: 500;">提交</button>
    </div>
  `;

  // 添加浮動視窗到文檔
  document.body.appendChild(floatingWindow);

  const languageSelect = document.getElementById('language-select');
  const translationInput = document.getElementById('translation-input');

  // 自動焦點到輸入框
  setTimeout(() => {
    translationInput.focus();
  }, 0);

  // 保存輸入狀態和光標位置
  let savedTranslation = translationInput.value;
  let savedTranslationCursorPosition = 0;
  let savedReason = '';
  let savedReasonCursorPosition = 0;
  let lastFocusedInput = translationInput;

  // 追蹤輸入欄位的內容和光標位置
  translationInput.addEventListener('input', () => {
    savedTranslation = translationInput.value;
    savedTranslationCursorPosition = translationInput.selectionStart;
    lastFocusedInput = translationInput;
  });
  translationInput.addEventListener('click', () => {
    savedTranslationCursorPosition = translationInput.selectionStart;
    lastFocusedInput = translationInput;
  });
  translationInput.addEventListener('keyup', () => {
    savedTranslationCursorPosition = translationInput.selectionStart;
    lastFocusedInput = translationInput;
  });

  const reasonInput = document.getElementById('reason-input');
  reasonInput.addEventListener('input', () => {
    savedReason = reasonInput.value;
    savedReasonCursorPosition = reasonInput.selectionStart;
    lastFocusedInput = reasonInput;
  });
  reasonInput.addEventListener('click', () => {
    savedReasonCursorPosition = reasonInput.selectionStart;
    lastFocusedInput = reasonInput;
  });
  reasonInput.addEventListener('keyup', () => {
    savedReasonCursorPosition = reasonInput.selectionStart;
    lastFocusedInput = reasonInput;
  });

  // 使用智能焦點管理機制：當焦點離開浮動視窗但不是去按鈕時進行保護
  const handleFocusOut = (e) => {
    // 檢查是否點擊按鈕 - 如果是，允許其正常工作
    const clickedButton = e.relatedTarget && (
      e.relatedTarget.id === 'submit-translation' || 
      e.relatedTarget.id === 'cancel-translation'
    );
    
    // 若焦點離開浮動視窗，且不是去往按鈕，則恢復焦點
    if (!clickedButton && !floatingWindow.contains(e.relatedTarget)) {
      // 恢復焦點到上次使用的輸入欄位並回復光標位置
      setTimeout(() => {
        if (lastFocusedInput === translationInput) {
          translationInput.focus();
          translationInput.setSelectionRange(savedTranslationCursorPosition, savedTranslationCursorPosition);
        } else if (lastFocusedInput === reasonInput) {
          reasonInput.focus();
          reasonInput.setSelectionRange(savedReasonCursorPosition, savedReasonCursorPosition);
        }
      }, 0);
    }
  };
  
  // 在捕獲階段監聽 focusout 事件
  floatingWindow.addEventListener('focusout', handleFocusOut, true);
  
  // 點擊 overlay 時回復焦點，並儲存引用以便清理
  const handleOverlayClick = (e) => {
    // 如果點擊的是 overlay 本身而非其子元素
    if (e.target === overlay) {
      e.preventDefault();
      if (lastFocusedInput === translationInput) {
        translationInput.focus();
        translationInput.setSelectionRange(savedTranslationCursorPosition, savedTranslationCursorPosition);
      } else if (lastFocusedInput === reasonInput) {
        reasonInput.focus();
        reasonInput.setSelectionRange(savedReasonCursorPosition, savedReasonCursorPosition);
      }
    }
  };
  
  overlay.addEventListener('mousedown', handleOverlayClick);
  
  // 阻止事件傳播，但確保按鈕可點擊
  floatingWindow.addEventListener('mousedown', (e) => {
    // 只有點擊的不是按鈕時才阻止事件傳播
    const clickedElement = e.target;
    const isButton = clickedElement.tagName === 'BUTTON' ||
                     clickedElement.id === 'submit-translation' ||
                     clickedElement.id === 'cancel-translation';
                     
    if (!isButton) {
      e.stopPropagation();
    }
  });
  
  // 監聽視窗大小變化事件，重新定位浮動視窗
  const repositionWindow = () => {
    floatingWindow.style.top = '50%';
    floatingWindow.style.left = '50%';
    floatingWindow.style.transform = 'translate(-50%, -50%)';
  };
  window.addEventListener('resize', repositionWindow);
  
  // 當關閉浮動視窗時，移除事件監聽器和 overlay
  const cleanup = () => {
    window.removeEventListener('resize', repositionWindow);
    floatingWindow.removeEventListener('focusout', handleFocusOut, true);
    if (document.body.contains(overlay)) {
      overlay.removeEventListener('mousedown', handleOverlayClick);
      document.body.removeChild(overlay);
    }
  };
  
  // 確保按鈕可以正常互動
  const cancelButton = document.getElementById('cancel-translation');
  const submitButton = document.getElementById('submit-translation');
  cancelButton.style.pointerEvents = 'auto';
  submitButton.style.pointerEvents = 'auto';

  cancelButton.addEventListener('click', () => {
    cleanup();
    document.body.removeChild(floatingWindow);
  });
  submitButton.addEventListener('click', () => {
    const translationInput = document.getElementById('translation-input');
    const reasonInput = document.getElementById('reason-input');
    const newTranslation = translationInput.value.trim();
    const submissionReason = reasonInput.value.trim();
    const selectedLanguage = languageSelect.value;

    if (!newTranslation) {
      alert('請輸入翻譯內容');
      return;
    }
    if (!submissionReason) {
      alert('請填寫調整原因');
      return;
    }
    if (!selectedLanguage) {
      alert('請選擇字幕語言');
      return;
    }

    // 調用 translation-manager 的接口，使用記錄的 timestamp
    submitTranslationViaManager({
      videoId: currentSubtitle.videoId,
      timestamp: recordedTimestamp,
      original: originalText,
      translation: newTranslation,
      submissionReason: submissionReason,
      languageCode: selectedLanguage
    })
    .then(response => {
      if (response && response.success) {
        sendMessage({ type: 'SAVE_USER_LANGUAGE', languageCode: selectedLanguage })
          .catch(error => console.error('儲存用戶語言設置失敗:', error));
        showToast('翻譯提交成功！');
      } else {
        const errorMsg = response?.error || '未知錯誤';
        showToast(`翻譯提交失敗：${errorMsg}`);
      }
    })
    .catch(error => {
      console.error('提交翻譯時出錯:', error);
      showToast(`翻譯提交失敗：${error.message}`);
    });

    cleanup();
    document.body.removeChild(floatingWindow);
  });

  // 向 background 請求已儲存的語言
  sendMessage({ type: 'GET_USER_LANGUAGE' })
    .then(result => {
      if (result && result.success && result.languageCode) {
        languageSelect.value = result.languageCode;
      }
    })
    .catch(error => {
      console.error('獲取用戶語言設置失敗:', error);
    });

  // 監聽語言選擇變化，並儲存
  languageSelect.addEventListener('change', () => {
    const selectedLanguage = languageSelect.value;
    if (selectedLanguage) {
      sendMessage({ type: 'SAVE_USER_LANGUAGE', languageCode: selectedLanguage })
        .catch(error => console.error('儲存用戶語言設置失敗:', error));
    }
  });
}

/**
 * 處理點讚按鈕點擊
 */
function handleLikeSubtitle() {
  if (!currentSubtitle) return;
  // 調用 vote-manager 的接口
  handleVote({
    translationID: currentSubtitle.translationID,
    videoID: currentSubtitle.videoId,
    originalSubtitle: currentSubtitle.text, // 可能不需要傳遞，取決於 vote-manager 實現
    timestamp: currentSubtitle.timestamp,
    voteType: 'upvote'
  })
  .then(result => {
    showToast('已點讚！'); // 可以在 vote-manager 中處理提示
  })
  .catch(error => {
    console.error('投票失敗:', error);
    showToast('投票失敗: ' + error.message); // 可以在 vote-manager 中處理提示
  });
}

/**
 * 處理倒讚按鈕點擊
 */
function handleDislikeSubtitle() {
  if (!currentSubtitle) return;
  // 調用 vote-manager 的接口
  handleVote({
    translationID: currentSubtitle.translationID,
    videoID: currentSubtitle.videoId,
    originalSubtitle: currentSubtitle.text, // 可能不需要傳遞
    timestamp: currentSubtitle.timestamp,
    voteType: 'downvote'
  })
  .then(result => {
    showToast('已倒讚！'); // 可以在 vote-manager 中處理提示
  })
  .catch(error => {
    console.error('投票失敗:', error);
    showToast('投票失敗: ' + error.message); // 可以在 vote-manager 中處理提示
  });
}

/**
 * 顯示提示訊息
 * @param {string} message - 提示訊息
 */
function showToast(message) {
  // 創建提示元素
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.position = 'fixed';
  toast.style.top = '30px';
  toast.style.left = '50%';
  toast.style.transform = 'translateX(-50%)';
  toast.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
  toast.style.color = 'white';
  toast.style.fontSize = '20px';
  toast.style.padding = '10px 20px';
  toast.style.borderRadius = '4px';
  toast.style.zIndex = Z_INDEX.TOAST.toString();
  
  // 添加到文檔
  document.body.appendChild(toast);
  
  // 2 秒後移除
  setTimeout(() => {
    document.body.removeChild(toast);
  }, 2000);
}
