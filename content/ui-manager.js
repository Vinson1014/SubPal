/**
 * 字幕助手擴充功能 - UI 管理模組
 * 
 * 這個模組負責創建和管理自定義 UI 層，顯示替換後的字幕。
 */

import { sendMessage, onMessage } from './messaging.js';

// 自定義 UI 元素
let customSubtitleContainer = null;
let customSubtitleElement = null;

// 調試模式
let debugMode = false;

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
  maxWidth: '80%'
};

// 當前顯示的字幕數據
let currentSubtitle = null;

// 字幕交互按鈕
let interactionButtons = null;

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
  
  // 監聽視窗大小變化，調整字幕位置
  window.addEventListener('resize', updateSubtitlePosition);
  
  // 監聽滾動事件，確保字幕容器始終可見
  window.addEventListener('scroll', updateSubtitlePosition);
  
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
  customSubtitleContainer.style.zIndex = '99999'; // 增加 z-index 確保在最上層
  customSubtitleContainer.style.pointerEvents = 'none'; // 初始設置為點擊穿透
  customSubtitleContainer.style.display = 'none'; // 初始隱藏
  customSubtitleContainer.style.textAlign = 'center'; // 確保字幕居中
  customSubtitleContainer.style.width = '100%'; // 設置寬度為 100%
  customSubtitleContainer.style.bottom = '10%'; // 預設位置在底部
  customSubtitleContainer.style.left = '0'; // 預設位置在左側
  
  console.log('字幕容器元素已創建');
  
  // 添加測試用邊框和背景，方便調試
  customSubtitleContainer.style.border = '2px solid red';
  customSubtitleContainer.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
  
  // 創建字幕元素
  customSubtitleElement = document.createElement('div');
  customSubtitleElement.id = 'subtitle-assistant-text';
  
  // 應用字幕樣式
  applySubtitleStyle();
  
  // 創建交互按鈕容器
  interactionButtons = document.createElement('div');
  interactionButtons.id = 'subtitle-assistant-buttons';
  interactionButtons.style.display = 'none';
  interactionButtons.style.position = 'absolute';
  interactionButtons.style.top = '-30px';
  interactionButtons.style.left = '50%'; // 置中
  interactionButtons.style.transform = 'translateX(-50%)'; // 確保真正置中
  interactionButtons.style.pointerEvents = 'auto'; // 允許點擊
  interactionButtons.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'; // 半透明背景
  interactionButtons.style.padding = '5px';
  interactionButtons.style.borderRadius = '4px';
  
  // 創建按鈕
  const submitButton = createButton('提交翻譯', handleSubmitTranslation);
  const likeButton = createButton('👍', handleLikeSubtitle);
  const dislikeButton = createButton('👎', handleDislikeSubtitle);
  
  // 添加按鈕到容器
  interactionButtons.appendChild(submitButton);
  interactionButtons.appendChild(likeButton);
  interactionButtons.appendChild(dislikeButton);
  
  // 將元素添加到容器
  customSubtitleContainer.appendChild(customSubtitleElement);
  customSubtitleContainer.appendChild(interactionButtons);
  
  // 將容器添加到文檔
  document.body.appendChild(customSubtitleContainer);
  
  // 添加鼠標事件監聽器
  customSubtitleContainer.addEventListener('mouseenter', showInteractionButtons);
  customSubtitleContainer.addEventListener('mouseleave', hideInteractionButtons);
  
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
  button.style.fontSize = '12px';
  
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
    maxWidth: subtitleStyle.maxWidth || '80%',
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
  
  // 添加標記，無論是否處於調試模式
  displayText = `[自訂] ${displayText}`;
  
  // 如果是替換的字幕，添加標記
  if (subtitleData.isReplaced) {
    displayText = `[替換] ${displayText}`;
  }
  
  console.log('顯示字幕文本:', displayText);
  
  customSubtitleElement.textContent = displayText;
  
  // 更新字幕位置
  console.log('更新字幕位置...');
  updateSubtitlePosition(subtitleData.position);
  
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
  
  // 添加測試用背景色，無論是否處於調試模式
  customSubtitleElement.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
  
  // 確保字幕元素可見
  customSubtitleElement.style.display = 'inline-block';
  
  // 檢查字幕元素是否在DOM中
  if (document.body.contains(customSubtitleContainer)) {
    console.log('字幕容器已在DOM中');
  } else {
    console.warn('字幕容器不在DOM中，重新添加');
    document.body.appendChild(customSubtitleContainer);
  }
  
  // 強制重繪
  setTimeout(() => {
    console.log('強制重繪字幕容器');
    customSubtitleContainer.style.display = 'none';
    // 強制瀏覽器重繪
    void customSubtitleContainer.offsetHeight;
    customSubtitleContainer.style.display = 'block';
  }, 50);
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
    console.log('使用原始字幕位置:', pos);
    
    // 使用原始字幕的位置，但確保在播放器內
    customSubtitleContainer.style.position = 'fixed';
    customSubtitleContainer.style.top = `${pos.top}px`;
    customSubtitleContainer.style.left = `${pos.left}px`;
    customSubtitleContainer.style.width = `${pos.width}px`;
    customSubtitleContainer.style.bottom = 'auto'; // 清除底部定位
    
    console.log(`更新字幕位置: top=${pos.top}, left=${pos.left}, width=${pos.width}`);
    
    return;
  }
  
  // 如果沒有原始字幕位置，使用備用方法
  console.log('沒有原始字幕位置，使用備用方法');
  
  // 使用播放器底部的位置
  const containerTop = playerRect.top + playerRect.height - 150;
  
  customSubtitleContainer.style.position = 'fixed';
  customSubtitleContainer.style.top = `${containerTop}px`;
  customSubtitleContainer.style.left = `${playerRect.left}px`;
  customSubtitleContainer.style.width = `${playerRect.width}px`;
  customSubtitleContainer.style.bottom = 'auto'; // 清除底部定位
  customSubtitleContainer.style.textAlign = 'center';
  
  console.log(`使用備用字幕位置: top=${containerTop}, left=${playerRect.left}, width=${playerRect.width}`);
  
  // 確保字幕容器可見
  customSubtitleContainer.style.display = 'block';
  
  // 添加測試用邊框和背景，確保可見
  customSubtitleContainer.style.border = '2px solid red';
  customSubtitleContainer.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
}

/**
 * 顯示交互按鈕
 */
function showInteractionButtons() {
  if (interactionButtons && currentSubtitle) {
    interactionButtons.style.display = 'block';
    
    // 使字幕容器可以接收點擊事件
    customSubtitleContainer.style.pointerEvents = 'auto';
    
    if (debugMode) {
      console.log('顯示交互按鈕');
    }
  }
}

/**
 * 隱藏交互按鈕
 */
function hideInteractionButtons() {
  if (interactionButtons) {
    interactionButtons.style.display = 'none';
    
    // 恢復字幕容器的點擊穿透
    customSubtitleContainer.style.pointerEvents = 'none';
    
    if (debugMode) {
      console.log('隱藏交互按鈕');
    }
  }
}

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
  dialog.style.padding = '20px';
  dialog.style.borderRadius = '8px';
  dialog.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
  dialog.style.zIndex = '10000';
  dialog.style.width = '400px';
  
  // 創建對話框內容
  dialog.innerHTML = `
    <h3 style="margin-top: 0;">提交翻譯</h3>
    <div style="margin-bottom: 10px;">
      <label style="display: block; margin-bottom: 5px;">原文:</label>
      <div style="padding: 8px; background-color: #f5f5f5; border-radius: 4px;">${originalText}</div>
    </div>
    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px;">翻譯:</label>
      <textarea id="translation-input" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; height: 80px;">${currentText}</textarea>
    </div>
    <div style="text-align: right;">
      <button id="cancel-translation" style="padding: 8px 16px; margin-right: 10px; background-color: #f5f5f5; border: none; border-radius: 4px; cursor: pointer;">取消</button>
      <button id="submit-translation" style="padding: 8px 16px; background-color: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer;">提交</button>
    </div>
  `;
  
  // 添加對話框到文檔
  document.body.appendChild(dialog);
  
  // 添加事件監聽器
  document.getElementById('cancel-translation').addEventListener('click', () => {
    document.body.removeChild(dialog);
  });
  
  document.getElementById('submit-translation').addEventListener('click', () => {
    const translationInput = document.getElementById('translation-input');
    const newTranslation = translationInput.value.trim();
    
    if (newTranslation && newTranslation !== currentText) {
      // 發送翻譯提交請求
      sendMessage({
        type: 'SUBMIT_TRANSLATION',
        videoId: currentSubtitle.videoId,
        timestamp: currentSubtitle.timestamp,
        original: originalText,
        translation: newTranslation
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
    }
    
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
  toast.style.bottom = '20px';
  toast.style.left = '50%';
  toast.style.transform = 'translateX(-50%)';
  toast.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
  toast.style.color = 'white';
  toast.style.padding = '10px 20px';
  toast.style.borderRadius = '4px';
  toast.style.zIndex = '10000';
  
  // 添加到文檔
  document.body.appendChild(toast);
  
  // 2 秒後移除
  setTimeout(() => {
    document.body.removeChild(toast);
  }, 2000);
}
