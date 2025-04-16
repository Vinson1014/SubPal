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

// 自定義 UI 元素
let customSubtitleContainer = null;
let customSubtitleElement = null;

// 調試模式
let debugMode = false;

// 上一次的字幕位置
let lastPosition = null;

// 字幕樣式設置
let subtitleStyle = {
  fontSize: '28px',
  fontFamily: 'Arial, sans-serif',
  color: '#ffffff',
  backgroundColor: 'rgba(0, 0, 0, 0.75)',
  textAlign: 'center',
  padding: '5px 10px',
  borderRadius: '4px',
  textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
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
  
  // 監聽視窗大小變化，調整字幕位置（使用防抖）
  window.addEventListener('resize', debounce(updateSubtitlePosition, 200));
  
  // 監聽滾動事件，確保字幕容器始終可見（使用防抖）
  window.addEventListener('scroll', debounce(updateSubtitlePosition, 200));
  
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
 * 應用字幕樣式
 */
function applySubtitleStyle() {
  if (!customSubtitleElement) return;
  
  // 應用樣式設置
  Object.assign(customSubtitleElement.style, {
    fontSize: subtitleStyle.fontSize,
    fontFamily: subtitleStyle.fontFamily,
    color: subtitleStyle.color,
    backgroundColor: subtitleStyle.backgroundColor,
    textAlign: subtitleStyle.textAlign,
    padding: subtitleStyle.padding || '5px 10px',
    borderRadius: subtitleStyle.borderRadius || '4px',
    textShadow: subtitleStyle.textShadow || '1px 1px 1px rgba(0, 0, 0, 0.5)',
    maxWidth: subtitleStyle.maxWidth || '100%',
    margin: '0 auto',
    display: 'inline-block'
  });
}

/**
 * 顯示替換後的字幕
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

  // 如果有 HTML 內容，直接插入 innerHTML（原生或替換字幕都支援分行/樣式）
  if (subtitleData.htmlContent) {
    customSubtitleElement.innerHTML = subtitleData.htmlContent;
  } else {
    // 如果沒有 HTML 內容，使用純文本
    customSubtitleElement.textContent = displayText;
  }

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
    }, 80); // 80ms 後重試，可依實際情況調整
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
 * 更新字幕位置
 * @param {Object} position - 位置信息
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
  
  // 獲取視頻播放器元素
  const videoPlayer = document.querySelector('.watch-video, .NFPlayer, video');
  if (!videoPlayer) {
    console.log('找不到視頻播放器元素，嘗試其他選擇器');
    
    // 嘗試其他可能的選擇器
    const altVideoPlayer = document.querySelector('.VideoContainer, .nf-player-container, .NFPlayer, [data-uia="video-player"]');
    
    if (altVideoPlayer) {
      console.log('使用替代選擇器找到視頻播放器');
      const playerRect = altVideoPlayer.getBoundingClientRect();
      console.log('視頻播放器位置和大小:', playerRect);
      
      // 使用固定位置，但基於播放器位置
      customSubtitleContainer.style.position = 'fixed';
      customSubtitleContainer.style.bottom = '20%';
      customSubtitleContainer.style.left = `${playerRect.left}px`;
      customSubtitleContainer.style.width = `${playerRect.width}px`;
      customSubtitleContainer.style.textAlign = 'center';
      
      console.log('使用替代播放器位置設置字幕位置');
      return;
    }
    
    // 如果仍然找不到，使用固定位置作為備用
    console.log('無法找到任何視頻播放器，使用固定位置作為備用');
    customSubtitleContainer.style.position = 'fixed';
    customSubtitleContainer.style.bottom = '10%';
    customSubtitleContainer.style.left = '0';
    customSubtitleContainer.style.width = '100%';
    customSubtitleContainer.style.textAlign = 'center';
    
    return;
  }
  
  // 獲取視頻播放器的位置和大小
  const playerRect = videoPlayer.getBoundingClientRect();
  console.log('視頻播放器位置和大小:', playerRect);
  
  // 如果有當前字幕數據且有原始字幕元素的位置信息，優先使用它
  if (currentSubtitle && currentSubtitle.position) {
    const pos = currentSubtitle.position;
    
    // 檢查位置是否真正變化
    if (lastPosition && 
        Math.abs(lastPosition.top - pos.top) < 5 && 
        Math.abs(lastPosition.left - pos.left) < 5) {
      // 位置變化不大，不需要更新
      console.log('字幕位置變化不大，不更新位置');
      return;
    }
    
    // 更新上一次的位置
    lastPosition = { ...pos };
    
    console.log('使用原始字幕位置:', pos);
    
    // 使用原始字幕的位置，但寬度自適應
    customSubtitleContainer.style.position = 'fixed';
    customSubtitleContainer.style.top = `${pos.top}px`;
    customSubtitleContainer.style.left = `${pos.left}px`;
    customSubtitleContainer.style.width = 'auto'; // 寬度自適應
    customSubtitleContainer.style.maxWidth = '80%'; // 設置最大寬度
    customSubtitleContainer.style.bottom = 'auto'; // 清除底部定位
    
    // console.log(`更新字幕位置: top=${pos.top}, left=${pos.left}, width=${pos.width}`);
    
    return;
  }
  
  // 如果沒有原始字幕位置，使用備用方法
  console.log('沒有原始字幕位置，使用備用方法');
  
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
  
  // 創建提交翻譯的對話框
  const originalText = currentSubtitle.original || currentSubtitle.text;
  const currentText = currentSubtitle.text;
  
  // 創建對話框元素
  const dialog = document.createElement('div');
  dialog.style.position = 'fixed';
  dialog.style.top = '50%';
  dialog.style.left = '50%';
  dialog.style.transform = 'translate(-50%, -50%)';
  dialog.style.backgroundColor = 'white';
  dialog.style.padding = '24px';
  dialog.style.borderRadius = '8px';
  dialog.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
  dialog.style.zIndex = Z_INDEX.DIALOG.toString();
  dialog.style.width = '400px';
  
  // 創建對話框內容（美觀化＋新增調整原因欄位）
  dialog.innerHTML = `
    <h3 style="margin-top: 0; margin-bottom: 18px; color: #222; font-size: 22px; font-weight: 600;">提交翻譯</h3>
    <div style="margin-bottom: 14px;">
      <label for="original-text" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">原文</label>
      <input id="original-text" type="text" value="${originalText.replace(/"/g, '"')}" readonly
        style="width: 100%; box-sizing: border-box; background: #f3f4f6; color: #222; border: 1px solid #e0e0e0; border-radius: 5px; padding: 8px 10px; font-size: 15px; margin-bottom: 0;"/>
    </div>
    <div style="margin-bottom: 14px;">
      <label for="translation-input" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">翻譯</label>
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
  
  // 添加對話框到文檔
  document.body.appendChild(dialog);

  // 事件監聽器
  document.getElementById('cancel-translation').addEventListener('click', () => {
    document.body.removeChild(dialog);
  });

  document.getElementById('submit-translation').addEventListener('click', () => {
    const translationInput = document.getElementById('translation-input');
    const reasonInput = document.getElementById('reason-input');
    const newTranslation = translationInput.value.trim();
    const reason = reasonInput.value.trim();

    if (!newTranslation) {
      alert('請輸入翻譯內容');
      return;
    }
    if (!reason) {
      alert('請填寫調整原因');
      return;
    }

    // 發送翻譯提交請求（reason 一併帶出）
    sendMessage({
      type: 'SUBMIT_TRANSLATION',
      videoId: currentSubtitle.videoId,
      timestamp: currentSubtitle.timestamp,
      original: originalText,
      translation: newTranslation,
      reason: reason
    })
    .then(response => {
      if (response && response.success) {
        alert('翻譯提交成功！');
      } else {
        alert('翻譯提交失敗，請稍後再試。');
      }
    })
    .catch(error => {
      console.error('提交翻譯時出錯:', error);
      alert('翻譯提交失敗，請稍後再試。');
    });

    document.body.removeChild(dialog);
  });
}

/**
 * 處理點讚按鈕點擊
 */
function handleLikeSubtitle() {
  if (!currentSubtitle) return;
  
  // 發送點讚請求
  sendMessage({
    type: 'RATE_SUBTITLE',
    videoId: currentSubtitle.videoId,
    timestamp: currentSubtitle.timestamp,
    text: currentSubtitle.text,
    rating: 'like'
  })
  .then(response => {
    if (response && response.success) {
      // 顯示成功提示
      showToast('已點讚！');
    }
  })
  .catch(error => {
    console.error('點讚時出錯:', error);
  });
}

/**
 * 處理倒讚按鈕點擊
 */
function handleDislikeSubtitle() {
  if (!currentSubtitle) return;
  
  // 發送倒讚請求
  sendMessage({
    type: 'RATE_SUBTITLE',
    videoId: currentSubtitle.videoId,
    timestamp: currentSubtitle.timestamp,
    text: currentSubtitle.text,
    rating: 'dislike'
  })
  .then(response => {
    if (response && response.success) {
      // 顯示成功提示
      showToast('已倒讚！');
    }
  })
  .catch(error => {
    console.error('倒讚時出錯:', error);
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
