/**
 * Netflix 字幕優化擴充功能 - UI 管理模組
 * 
 * 這個模組負責創建和管理自定義 UI 層，顯示替換後的字幕。
 */

// 自定義 UI 元素
let customSubtitleContainer = null;
let customSubtitleElement = null;

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
  
  // 監聽視窗大小變化，調整字幕位置
  window.addEventListener('resize', updateSubtitlePosition);
  
  // 監聽滾動事件，確保字幕容器始終可見
  window.addEventListener('scroll', updateSubtitlePosition);
  
  console.log('UI 管理模組初始化完成');
}

/**
 * 從存儲中載入字幕樣式設置
 */
function loadSubtitleStyle() {
  chrome.storage.local.get('subtitleStyle', (result) => {
    if (result.subtitleStyle) {
      subtitleStyle = { ...subtitleStyle, ...result.subtitleStyle };
      console.log('載入字幕樣式設置:', subtitleStyle);
      
      // 如果已經創建了字幕元素，則更新其樣式
      if (customSubtitleElement) {
        applySubtitleStyle();
      }
    }
  });
  
  // 監聽字幕樣式設置變更
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.subtitleStyle) {
      subtitleStyle = { ...subtitleStyle, ...changes.subtitleStyle.newValue };
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
  // 檢查是否已經存在
  if (customSubtitleContainer) {
    return;
  }
  
  // 創建容器元素
  customSubtitleContainer = document.createElement('div');
  customSubtitleContainer.id = 'netflix-subtitle-optimizer-container';
  customSubtitleContainer.style.position = 'absolute';
  customSubtitleContainer.style.zIndex = '9999';
  customSubtitleContainer.style.pointerEvents = 'none'; // 允許點擊穿透
  customSubtitleContainer.style.display = 'none'; // 初始隱藏
  
  // 創建字幕元素
  customSubtitleElement = document.createElement('div');
  customSubtitleElement.id = 'netflix-subtitle-optimizer-text';
  
  // 應用字幕樣式
  applySubtitleStyle();
  
  // 創建交互按鈕容器
  interactionButtons = document.createElement('div');
  interactionButtons.id = 'netflix-subtitle-optimizer-buttons';
  interactionButtons.style.display = 'none';
  interactionButtons.style.position = 'absolute';
  interactionButtons.style.top = '-30px';
  interactionButtons.style.right = '0';
  interactionButtons.style.pointerEvents = 'auto'; // 允許點擊
  
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
  if (!customSubtitleContainer || !customSubtitleElement) {
    createCustomSubtitleContainer();
  }
  
  // 保存當前字幕數據
  currentSubtitle = subtitleData;
  
  // 設置字幕文本
  customSubtitleElement.textContent = subtitleData.text;
  
  // 更新字幕位置
  updateSubtitlePosition(subtitleData.position);
  
  // 顯示字幕容器
  customSubtitleContainer.style.display = 'block';
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
  if (!customSubtitleContainer || !currentSubtitle) return;
  
  // 如果參數是事件對象，則使用當前字幕的位置
  const pos = position && position.top ? position : currentSubtitle.position;
  
  // 獲取視頻播放器元素
  const videoPlayer = document.querySelector('.watch-video');
  if (!videoPlayer) return;
  
  // 獲取視頻播放器的位置和大小
  const playerRect = videoPlayer.getBoundingClientRect();
  
  // 計算字幕容器的位置
  // 通常字幕在視頻底部，留出一定空間
  const containerTop = playerRect.top + playerRect.height - 150;
  
  // 設置字幕容器的位置
  customSubtitleContainer.style.top = `${containerTop}px`;
  customSubtitleContainer.style.left = `${playerRect.left}px`;
  customSubtitleContainer.style.width = `${playerRect.width}px`;
  customSubtitleContainer.style.textAlign = 'center';
}

/**
 * 顯示交互按鈕
 */
function showInteractionButtons() {
  if (interactionButtons && currentSubtitle) {
    interactionButtons.style.display = 'block';
    
    // 使字幕容器可以接收點擊事件
    customSubtitleContainer.style.pointerEvents = 'auto';
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
      chrome.runtime.sendMessage({
        type: 'SUBMIT_TRANSLATION',
        videoId: currentSubtitle.videoId,
        timestamp: currentSubtitle.timestamp,
        original: originalText,
        translation: newTranslation
      }, (response) => {
        if (response && response.success) {
          alert('翻譯提交成功！');
        } else {
          alert('翻譯提交失敗，請稍後再試。');
        }
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
  chrome.runtime.sendMessage({
    type: 'RATE_SUBTITLE',
    videoId: currentSubtitle.videoId,
    timestamp: currentSubtitle.timestamp,
    text: currentSubtitle.text,
    rating: 'like'
  }, (response) => {
    if (response && response.success) {
      // 顯示成功提示
      showToast('已點讚！');
    }
  });
}

/**
 * 處理倒讚按鈕點擊
 */
function handleDislikeSubtitle() {
  if (!currentSubtitle) return;
  
  // 發送倒讚請求
  chrome.runtime.sendMessage({
    type: 'RATE_SUBTITLE',
    videoId: currentSubtitle.videoId,
    timestamp: currentSubtitle.timestamp,
    text: currentSubtitle.text,
    rating: 'dislike'
  }, (response) => {
    if (response && response.success) {
      // 顯示成功提示
      showToast('已倒讚！');
    }
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
