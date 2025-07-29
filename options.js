// 全局變量，用於保存與 background script 的連接 port
let backgroundPort;

// Function to save options
function saveOptions(options) {
  chrome.storage.local.set(options, () => {
    if (chrome.runtime.lastError) {
      console.error('Error saving options:', chrome.runtime.lastError);
    } else {
      console.log('Options saved.');
      // You might want to show a "Settings saved" confirmation to the user here
    }
  });
}

// Function to load options
function loadOptions(callback) {
  const defaultOptions = {
    debugMode: false, // Default value for debug mode
    apiBaseUrl: 'https://subnfbackend.zeabur.app' // Default API Base URL for first-time users
  };
  chrome.storage.local.get(defaultOptions, (items) => {
    if (chrome.runtime.lastError) {
      console.error('Error loading options:', chrome.runtime.lastError);
      callback(null, chrome.runtime.lastError);
    } else {
      callback(items);
    }
  });
}

// Function to restore options into the UI
function restoreOptionsUI() {
  loadOptions((items, error) => {
    if (error) {
      // Handle error, perhaps show a message to the user
      console.error("Error loading options for UI:", error);
      return;
    }
    const debugModeCheckbox = document.getElementById('debugModeCheckbox');
    const apiBaseUrlInput = document.getElementById('apiBaseUrlInput');
    
    if (debugModeCheckbox) {
      debugModeCheckbox.checked = items.debugMode;
    } else {
      console.error('debugModeCheckbox not found');
    }
    
    if (apiBaseUrlInput) {
      apiBaseUrlInput.value = items.apiBaseUrl;
    } else {
      console.error('apiBaseUrlInput not found');
    }
  });
}

// 消息發送函數，通過 port 發送消息並處理響應
function sendMessageToBackground(messageType, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!backgroundPort) {
      console.error('Background port not connected.');
      return reject(new Error('Background port not connected.'));
    }

    const messageId = Date.now() + Math.random().toString(36).substring(2, 7);
    const message = { type: messageType, ...payload };

    console.log(`發送消息到背景腳本: ${messageType}`, message);

    // 設置超時處理
    const timeout = setTimeout(() => {
      backgroundPort.onMessage.removeListener(onResponse);
      console.error(`消息超時: ${messageType} (${messageId})`);
      reject(new Error(`Message timeout: ${messageType}`));
    }, 10000); // 10秒超時

    // 設置消息監聽器，等待特定 messageId 的響應
    const onResponse = (responseMessage) => {
      if (responseMessage.messageId === messageId) {
        clearTimeout(timeout);
        backgroundPort.onMessage.removeListener(onResponse); // 移除監聽器
        
        console.log(`收到響應: ${messageType}`, responseMessage.response);
        
        if (responseMessage.response.success) {
          resolve(responseMessage.response);
        } else {
          reject(new Error(responseMessage.response.error || '未知錯誤'));
        }
      }
    };
    
    backgroundPort.onMessage.addListener(onResponse);
    backgroundPort.postMessage({ messageId, message });
  });
}


// Event listener for when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', async () => {
  // 建立與 background script 的連接
  backgroundPort = chrome.runtime.connect({ name: "options-page-channel" });

  // 監聽 port 斷開事件
  backgroundPort.onDisconnect.addListener(() => {
    console.warn('Background port disconnected.');
    backgroundPort = null; // 清除 port 引用
  });

  restoreOptionsUI(); // Restore saved options into the UI
  updatePendingDataUI(); // Update pending data counts on UI load
  await initializeSubtitleStyleFeatures(); // Initialize subtitle style customization features

  const debugModeCheckbox = document.getElementById('debugModeCheckbox');
  const apiBaseUrlInput = document.getElementById('apiBaseUrlInput');
  const backupDataButton = document.getElementById('backupDataButton');
  const restoreDataInput = document.getElementById('restoreDataInput');
  const restoreDataButton = document.getElementById('restoreDataButton');

  // Get references to the new queue elements
  const clearVoteQueueButton = document.getElementById('clearVoteQueueButton');
  const clearTranslationQueueButton = document.getElementById('clearTranslationQueueButton');
  const clearReplacementEventsQueueButton = document.getElementById('clearReplacementEventsQueueButton');
  
  if (debugModeCheckbox) {
    debugModeCheckbox.addEventListener('change', async (event) => {
      const options = {
        debugMode: event.target.checked
      };
      saveOptions(options);
      // Notify background and content scripts about the change
      try {
        await sendMessageToBackground('TOGGLE_DEBUG_MODE', { debugMode: event.target.checked });
        console.log('Debug mode change message sent successfully.');
      } catch (error) {
        console.error('Error sending debug mode change message:', error);
      }
    });
  } else {
    console.error('debugModeCheckbox not found, cannot add change listener');
  }
  
  if (apiBaseUrlInput) {
    apiBaseUrlInput.addEventListener('change', async (event) => {
      const options = {
        apiBaseUrl: event.target.value
      };
      saveOptions(options);
      // Notify background script about the API URL change
      try {
        await sendMessageToBackground('API_BASE_URL_CHANGED', { url: event.target.value });
        console.log('API base URL change message sent successfully.');
      } catch (error) {
        console.error('Error sending API base URL change message:', error);
      }
    });
  } else {
    console.error('apiBaseUrlInput not found, cannot add change listener');
  }
  
  if (backupDataButton) {
    backupDataButton.addEventListener('click', () => {
      backupData();
    });
  } else {
    console.error('backupDataButton not found, cannot add click listener');
  }
  
  if (restoreDataButton) {
    restoreDataButton.addEventListener('click', () => {
      if (restoreDataInput && restoreDataInput.files.length > 0) {
        restoreData(restoreDataInput.files[0]);
      } else {
        alert('請選擇一個備份檔案');
      }
    });
  } else {
    console.error('restoreDataButton not found, cannot add click listener');
  }

  // Add event listeners for clear queue buttons
  if (clearVoteQueueButton) {
    clearVoteQueueButton.addEventListener('click', async () => {
      if (confirm('確定要清空投票隊列嗎？此操作不可撤銷。')) {
        try {
          await sendMessageToBackground('CLEAR_QUEUE', { queueType: 'voteQueue' });
          alert('投票隊列已清空。');
          updatePendingDataUI(); // Refresh UI
        } catch (error) {
          console.error('Error clearing vote queue:', error);
          alert('清空投票隊列失敗：' + error.message);
        }
      }
    });
  }

  if (clearTranslationQueueButton) {
    clearTranslationQueueButton.addEventListener('click', async () => {
      if (confirm('確定要清空翻譯隊列嗎？此操作不可撤銷。')) {
        try {
          await sendMessageToBackground('CLEAR_QUEUE', { queueType: 'translationQueue' });
          alert('翻譯隊列已清空。');
          updatePendingDataUI(); // Refresh UI
        } catch (error) {
          console.error('Error clearing translation queue:', error);
          alert('清空翻譯隊列失敗：' + error.message);
        }
      }
    });
  }

  if (clearReplacementEventsQueueButton) {
    clearReplacementEventsQueueButton.addEventListener('click', async () => {
      if (confirm('確定要清空替換事件隊列嗎？此操作不可撤銷。')) {
        try {
          await sendMessageToBackground('CLEAR_QUEUE', { queueType: 'replacementEvents' });
          alert('替換事件隊列已清空。');
          updatePendingDataUI(); // Refresh UI
        } catch (error) {
          console.error('Error clearing replacement events queue:', error);
          alert('清空替換事件隊列失敗：' + error.message);
        }
      }
    });
  }
});

// Function to backup data
function backupData() {
  // Get data from chrome.storage.local (userID)
  chrome.storage.local.get(['userID'], (localResult) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting local data for backup:', chrome.runtime.lastError);
      alert('備份失敗：無法獲取本地資料');
      return;
    }
    
    // Get data from chrome.storage.local (settings)
    chrome.storage.local.get(['debugMode', 'apiBaseUrl'], (localResultSettings) => {
      if (chrome.runtime.lastError) {
        console.error('Error getting local data for backup:', chrome.runtime.lastError);
        alert('備份失敗：無法獲取設定資料');
        return;
      }
      
      // Combine data
      const backupData = {
        userID: localResult.userID || '',
        settings: {
          debugMode: localResultSettings.debugMode || false,
          apiBaseUrl: localResultSettings.apiBaseUrl || 'http://localhost:3000'
        },
        backupDate: new Date().toISOString()
      };
      
      // Convert to JSON
      const backupJson = JSON.stringify(backupData, null, 2);
      
      // Create a download link
      const blob = new Blob([backupJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `subpal_backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      alert('資料已成功備份');
    });
  });
}

// Function to restore data
function restoreData(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const backupData = JSON.parse(event.target.result);
      
      // Validate backup data
      if (!backupData.userID || !backupData.settings) {
        alert('備份檔案格式無效');
        return;
      }
      
      // Restore userID to chrome.storage.local
      chrome.storage.local.set({ userID: backupData.userID }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error restoring userID:', chrome.runtime.lastError);
        alert('恢復 userID 失敗');
        return;
        }
      });

      // 清除舊的 JWT
      chrome.storage.local.remove('jwt', () => {
        if (chrome.runtime.lastError) {
          console.error('清除 JWT 失敗:', chrome.runtime.lastError);
        } else if (isDebugModeEnabled) {
          console.log('成功清除舊的 JWT');
        }
        
        // 恢復設置
        chrome.storage.local.set(backupData.settings, () => {
          if (chrome.runtime.lastError) {
            console.error('Error restoring settings:', chrome.runtime.lastError);
            alert('恢復設定失敗');
            return;
          }
          
          // Notify background and content scripts about the changes
          // 使用 sendMessageToBackground 替代 chrome.runtime.sendMessage
          sendMessageToBackground('TOGGLE_DEBUG_MODE', { debugMode: backupData.settings.debugMode })
            .catch(error => console.error('Error sending debug mode change message during restore:', error));
          
          sendMessageToBackground('API_BASE_URL_CHANGED', { url: backupData.settings.apiBaseUrl })
            .catch(error => console.error('Error sending API base URL change message during restore:', error));
          
          // Update UI
          restoreOptionsUI();
          
          alert('資料已成功恢復，請重新載入擴充功能以確保變更生效');
        });
      });
    } catch (e) {
      console.error('Error parsing backup file:', e);
      alert('備份檔案解析失敗：' + e.message);
    }
  };
  reader.onerror = () => {
    console.error('Error reading backup file:', reader.error);
    alert('讀取備份檔案失敗');
  };
  reader.readAsText(file);
}

// Function to update the UI with pending data counts
async function updatePendingDataUI() {
  try {
    const result = await chrome.storage.local.get(['voteQueue', 'translationQueue', 'replacementEvents']);
    document.getElementById('voteQueueCount').textContent = (result.voteQueue || []).length;
    document.getElementById('translationQueueCount').textContent = (result.translationQueue || []).length;
    document.getElementById('replacementEventsQueueCount').textContent = (result.replacementEvents || []).length;
  } catch (error) {
    console.error('Error updating pending data UI:', error);
  }
}

// === 字幕樣式自定義功能 ===

// 語言設定管理
let dualSubtitleConfig = null;

// 預設字幕樣式配置
const DEFAULT_SUBTITLE_STYLE_CONFIG = {
  mode: 'single',
  primary: {
    fontSize: 55,
    textColor: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.75)'
  },
  secondary: {
    fontSize: 24,
    textColor: '#ffff00',
    backgroundColor: 'rgba(0, 0, 0, 0.75)'
  }
};

// 當前樣式配置
let currentStyleConfig = { ...DEFAULT_SUBTITLE_STYLE_CONFIG };

// 初始化字幕樣式功能
async function initializeSubtitleStyleFeatures() {
  // 初始化語言設定模組
  await initializeDualSubtitleConfig();
  
  // 載入現有配置（等待完成）
  await loadSubtitleStyleConfig();
  
  // 設置事件監聽器
  setupSubtitleStyleEventListeners();
  
  // 初始化 UI 狀態（現在配置已正確載入）
  await updateSubtitleStyleUI();
}

// 初始化語言設定模組
async function initializeDualSubtitleConfig() {
  try {
    // options 頁面不需要導入 content script 模組
    // 在 options 頁面中，我們直接使用 chrome.storage 來讀取語言設定
    console.log('語言設定管理：使用 options 頁面模式');
    dualSubtitleConfig = null; // 在 options 頁面中不使用
  } catch (error) {
    console.error('語言設定模組初始化失敗:', error);
  }
}

// 載入字幕樣式配置
async function loadSubtitleStyleConfig() {
  try {
    const result = await chrome.storage.local.get(['subtitleStyleConfig', 'dualSubtitleEnabled']);
    
    // 確定模式設定
    let mode = DEFAULT_SUBTITLE_STYLE_CONFIG.mode;
    
    if (result.subtitleStyleConfig && result.subtitleStyleConfig.mode) {
      // 優先使用 subtitleStyleConfig.mode
      mode = result.subtitleStyleConfig.mode;
      console.log(`[Options] 從 subtitleStyleConfig.mode 讀取: ${mode}`);
    } else if (result.dualSubtitleEnabled !== undefined) {
      // 降級方案：從 dualSubtitleEnabled 轉換
      mode = result.dualSubtitleEnabled ? 'dual' : 'single';
      console.log(`[Options] 從 dualSubtitleEnabled 轉換: ${result.dualSubtitleEnabled} -> ${mode}`);
    }
    
    if (result.subtitleStyleConfig) {
      // 深度合併配置，確保所有屬性都正確載入
      currentStyleConfig = {
        mode: mode,
        primary: {
          ...DEFAULT_SUBTITLE_STYLE_CONFIG.primary,
          ...(result.subtitleStyleConfig.primary || {})
        },
        secondary: {
          ...DEFAULT_SUBTITLE_STYLE_CONFIG.secondary,
          ...(result.subtitleStyleConfig.secondary || {})
        }
      };
    } else {
      // 如果沒有 subtitleStyleConfig，但有 dualSubtitleEnabled 設定
      currentStyleConfig = {
        ...DEFAULT_SUBTITLE_STYLE_CONFIG,
        mode: mode
      };
    }
    
    console.log('字幕樣式配置已載入:', currentStyleConfig);
  } catch (error) {
    console.error('載入字幕樣式配置失敗:', error);
  }
}

// 保存字幕樣式配置
async function saveSubtitleStyleConfig() {
  try {
    await chrome.storage.local.set({ subtitleStyleConfig: currentStyleConfig });
    console.log('字幕樣式配置已保存:', currentStyleConfig);
    
    // 通知 content script 更新樣式
    try {
      await sendMessageToBackground('SUBTITLE_STYLE_UPDATED', { config: currentStyleConfig });
    } catch (error) {
      console.warn('通知樣式更新失敗:', error);
    }
  } catch (error) {
    console.error('保存字幕樣式配置失敗:', error);
  }
}

// 設置字幕樣式事件監聽器
function setupSubtitleStyleEventListeners() {
  // 模式切換
  const singleModeRadio = document.getElementById('singleMode');
  const dualModeRadio = document.getElementById('dualMode');
  
  if (singleModeRadio) {
    singleModeRadio.addEventListener('change', async () => {
      if (singleModeRadio.checked) {
        currentStyleConfig.mode = 'single';
        updateSubtitleStyleUI();
        updatePreview();
        
        // 同步更新 dualSubtitleEnabled 設定
        try {
          await sendMessageToBackground('SAVE_SETTINGS', {
            settings: { dualSubtitleEnabled: false }
          });
          console.log('[Options] 已同步更新 dualSubtitleEnabled: false');
        } catch (error) {
          console.warn('[Options] 同步 dualSubtitleEnabled 失敗:', error);
        }
      }
    });
  }
  
  if (dualModeRadio) {
    dualModeRadio.addEventListener('change', async () => {
      if (dualModeRadio.checked) {
        currentStyleConfig.mode = 'dual';
        updateSubtitleStyleUI();
        updatePreview();
        
        // 同步更新 dualSubtitleEnabled 設定
        try {
          await sendMessageToBackground('SAVE_SETTINGS', {
            settings: { dualSubtitleEnabled: true }
          });
          console.log('[Options] 已同步更新 dualSubtitleEnabled: true');
        } catch (error) {
          console.warn('[Options] 同步 dualSubtitleEnabled 失敗:', error);
        }
      }
    });
  }
  
  // 主要語言樣式控制項
  setupStyleControlListeners('primary');
  
  // 次要語言樣式控制項
  setupStyleControlListeners('secondary');
  
  // 語言選擇器
  setupLanguageSelectors();
  
  // 控制按鈕
  const resetStylesBtn = document.getElementById('resetStyles');
  const applyStylesBtn = document.getElementById('applyStyles');
  
  if (resetStylesBtn) {
    resetStylesBtn.addEventListener('click', resetStyles);
  }
  
  if (applyStylesBtn) {
    applyStylesBtn.addEventListener('click', applyStyles);
  }
}

// 設置特定類型的樣式控制項監聽器
function setupStyleControlListeners(type) {
  const fontSizeSlider = document.getElementById(`${type}FontSize`);
  const fontSizeValue = document.getElementById(`${type}FontSizeValue`);
  const textColorPicker = document.getElementById(`${type}TextColor`);
  const backgroundColorPicker = document.getElementById(`${type}BackgroundColor`);
  const backgroundOpacitySlider = document.getElementById(`${type}BackgroundOpacity`);
  const backgroundOpacityValue = document.getElementById(`${type}BackgroundOpacityValue`);
  
  if (fontSizeSlider && fontSizeValue) {
    fontSizeSlider.addEventListener('input', (e) => {
      const size = parseInt(e.target.value);
      fontSizeValue.textContent = size;
      currentStyleConfig[type].fontSize = size;
      updatePreview();
    });
  }
  
  if (textColorPicker) {
    textColorPicker.addEventListener('change', (e) => {
      currentStyleConfig[type].textColor = e.target.value;
      updatePreview();
    });
  }
  
  if (backgroundColorPicker) {
    backgroundColorPicker.addEventListener('change', (e) => {
      const color = e.target.value;
      const opacity = backgroundOpacitySlider ? parseFloat(backgroundOpacitySlider.value) : 0.75;
      currentStyleConfig[type].backgroundColor = hexToRgba(color, opacity);
      updatePreview();
    });
  }
  
  if (backgroundOpacitySlider && backgroundOpacityValue) {
    backgroundOpacitySlider.addEventListener('input', (e) => {
      const opacity = parseFloat(e.target.value);
      backgroundOpacityValue.textContent = opacity.toFixed(2);
      
      // 更新背景色的透明度
      const color = backgroundColorPicker ? backgroundColorPicker.value : '#000000';
      currentStyleConfig[type].backgroundColor = hexToRgba(color, opacity);
      updatePreview();
    });
  }
}

// 設置語言選擇器
function setupLanguageSelectors() {
  const primaryLanguageSelect = document.getElementById('primaryLanguageSelect');
  const secondaryLanguageSelect = document.getElementById('secondaryLanguageSelect');
  
  if (primaryLanguageSelect) {
    primaryLanguageSelect.addEventListener('change', async (e) => {
      try {
        // 直接使用 options 頁面的消息傳遞方式
        await sendMessageToBackground('SAVE_SETTINGS', {
          settings: {
            primaryLanguage: e.target.value
          }
        });
        console.log('主要語言已更新:', e.target.value);
        
        // 更新本地 dualSubtitleConfig 的狀態（如果存在）
        if (dualSubtitleConfig) {
          dualSubtitleConfig.settings.primaryLanguage = e.target.value;
        }
      } catch (error) {
        console.error('更新主要語言失敗:', error);
        // 恢復到原來的值（直接從 storage 讀取）
        try {
          const result = await chrome.storage.local.get(['primaryLanguage']);
          e.target.value = result.primaryLanguage || 'zh-Hant';
        } catch (storageError) {
          console.error('恢復主要語言值失敗:', storageError);
          e.target.value = 'zh-Hant';
        }
      }
    });
  }
  
  if (secondaryLanguageSelect) {
    secondaryLanguageSelect.addEventListener('change', async (e) => {
      try {
        // 直接使用 options 頁面的消息傳遞方式
        await sendMessageToBackground('SAVE_SETTINGS', {
          settings: {
            secondaryLanguage: e.target.value
          }
        });
        console.log('次要語言已更新:', e.target.value);
        
        // 更新本地 dualSubtitleConfig 的狀態（如果存在）
        if (dualSubtitleConfig) {
          dualSubtitleConfig.settings.secondaryLanguage = e.target.value;
        }
      } catch (error) {
        console.error('更新次要語言失敗:', error);
        // 恢復到原來的值（直接從 storage 讀取）
        try {
          const result = await chrome.storage.local.get(['secondaryLanguage']);
          e.target.value = result.secondaryLanguage || 'en';
        } catch (storageError) {
          console.error('恢復次要語言值失敗:', storageError);
          e.target.value = 'en';
        }
      }
    });
  }
}

// 更新字幕樣式 UI
async function updateSubtitleStyleUI() {
  // 更新模式選擇
  const singleModeRadio = document.getElementById('singleMode');
  const dualModeRadio = document.getElementById('dualMode');
  
  if (singleModeRadio && dualModeRadio) {
    singleModeRadio.checked = currentStyleConfig.mode === 'single';
    dualModeRadio.checked = currentStyleConfig.mode === 'dual';
  }
  
  // 顯示/隱藏雙語相關元素
  const dualLanguageGroup = document.getElementById('dualLanguageGroup');
  const secondaryStyleSection = document.getElementById('secondaryStyleSection');
  const secondaryPreview = document.getElementById('secondaryPreview');
  
  const isDualMode = currentStyleConfig.mode === 'dual';
  
  if (dualLanguageGroup) {
    dualLanguageGroup.style.display = isDualMode ? 'block' : 'none';
  }
  if (secondaryStyleSection) {
    secondaryStyleSection.style.display = isDualMode ? 'block' : 'none';
  }
  if (secondaryPreview) {
    secondaryPreview.style.display = isDualMode ? 'block' : 'none';
  }
  
  // 更新樣式控制項值
  updateStyleControlValues('primary');
  updateStyleControlValues('secondary');
  
  // 更新語言選擇器
  await updateLanguageSelectors();
  
  // 更新預覽
  updatePreview();
}

// 更新特定類型的樣式控制項值
function updateStyleControlValues(type) {
  const config = currentStyleConfig[type];
  
  const fontSizeSlider = document.getElementById(`${type}FontSize`);
  const fontSizeValue = document.getElementById(`${type}FontSizeValue`);
  const textColorPicker = document.getElementById(`${type}TextColor`);
  const backgroundColorPicker = document.getElementById(`${type}BackgroundColor`);
  const backgroundOpacitySlider = document.getElementById(`${type}BackgroundOpacity`);
  const backgroundOpacityValue = document.getElementById(`${type}BackgroundOpacityValue`);
  
  if (fontSizeSlider && fontSizeValue) {
    fontSizeSlider.value = config.fontSize;
    fontSizeValue.textContent = config.fontSize;
  }
  
  if (textColorPicker) {
    textColorPicker.value = config.textColor;
  }
  
  if (backgroundColorPicker && backgroundOpacitySlider && backgroundOpacityValue) {
    const { color, opacity } = rgbaToHex(config.backgroundColor);
    backgroundColorPicker.value = color;
    backgroundOpacitySlider.value = opacity;
    backgroundOpacityValue.textContent = opacity.toFixed(2);
  }
}


// 更新預覽（現在總是即時更新）
function updatePreview() {
  const primaryPreview = document.getElementById('primaryPreview');
  const secondaryPreview = document.getElementById('secondaryPreview');
  
  if (primaryPreview) {
    applyPreviewStyles(primaryPreview, currentStyleConfig.primary);
  }
  
  if (secondaryPreview && currentStyleConfig.mode === 'dual') {
    applyPreviewStyles(secondaryPreview, currentStyleConfig.secondary);
  }
}

// 應用預覽樣式到元素
function applyPreviewStyles(element, styleConfig) {
  if (!element || !styleConfig) return;
  
  Object.assign(element.style, {
    fontSize: `${styleConfig.fontSize}px`,
    color: styleConfig.textColor,
    backgroundColor: styleConfig.backgroundColor,
    fontFamily: 'Arial, sans-serif',
    textAlign: 'center',
    borderRadius: '4px',
    textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
    padding: '8px 16px',
    display: 'inline-block',
    minWidth: '120px',
    margin: '2px 5px'
  });
}


// 重置樣式
async function resetStyles() {
  if (confirm('確定要重置所有樣式設定嗎？')) {
    currentStyleConfig = { ...DEFAULT_SUBTITLE_STYLE_CONFIG };
    await updateSubtitleStyleUI();
  }
}

// 套用樣式
async function applyStyles() {
  try {
    await saveSubtitleStyleConfig();
    alert('字幕樣式已套用！');
  } catch (error) {
    console.error('套用樣式失敗:', error);
    alert('套用樣式失敗：' + error.message);
  }
}

// 工具函數：十六進位轉 RGBA
function hexToRgba(hex, alpha = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 工具函數：RGBA 轉十六進位
function rgbaToHex(rgba) {
  const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d\.]+))?\)/);
  if (!match) {
    return { color: '#000000', opacity: 1 };
  }
  
  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  const opacity = match[4] ? parseFloat(match[4]) : 1;
  
  return {
    color: `#${r}${g}${b}`,
    opacity: opacity
  };
}

// 更新語言選擇器的值
async function updateLanguageSelectors() {
  const primaryLanguageSelect = document.getElementById('primaryLanguageSelect');
  const secondaryLanguageSelect = document.getElementById('secondaryLanguageSelect');
  
  try {
    // 嘗試使用 sendMessageToBackground（如果 backgroundPort 已連接）
    if (backgroundPort) {
      const response = await sendMessageToBackground('GET_SETTINGS', {
        keys: ['primaryLanguage', 'secondaryLanguage']
      });
      
      if (response.success) {
        if (primaryLanguageSelect) {
          primaryLanguageSelect.value = response.primaryLanguage || 'zh-Hant';
        }
        
        if (secondaryLanguageSelect) {
          secondaryLanguageSelect.value = response.secondaryLanguage || 'en';
        }
        
        console.log('語言選擇器已更新 (通過 background):', { 
          primaryLanguage: response.primaryLanguage, 
          secondaryLanguage: response.secondaryLanguage 
        });
        return;
      }
    }
    
    // 降級方案：直接使用 chrome.storage.local
    console.log('使用直接存取方式載入語言設定');
    const result = await chrome.storage.local.get(['primaryLanguage', 'secondaryLanguage']);
    
    if (primaryLanguageSelect) {
      primaryLanguageSelect.value = result.primaryLanguage || 'zh-Hant';
    }
    
    if (secondaryLanguageSelect) {
      secondaryLanguageSelect.value = result.secondaryLanguage || 'en';
    }
    
    console.log('語言選擇器已更新 (直接存取):', result);
    
  } catch (error) {
    console.error('更新語言選擇器失敗:', error);
    // 回退到預設值
    if (primaryLanguageSelect) primaryLanguageSelect.value = 'zh-Hant';
    if (secondaryLanguageSelect) secondaryLanguageSelect.value = 'en';
  }
}
