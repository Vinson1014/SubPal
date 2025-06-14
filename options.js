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

    // 設置消息監聽器，等待特定 messageId 的響應
    const onResponse = (responseMessage) => {
      if (responseMessage.messageId === messageId) {
        backgroundPort.onMessage.removeListener(onResponse); // 移除監聽器
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
document.addEventListener('DOMContentLoaded', () => {
  // 建立與 background script 的連接
  backgroundPort = chrome.runtime.connect({ name: "options-page-channel" });

  // 監聽 port 斷開事件
  backgroundPort.onDisconnect.addListener(() => {
    console.warn('Background port disconnected.');
    backgroundPort = null; // 清除 port 引用
  });

  restoreOptionsUI(); // Restore saved options into the UI
  updatePendingDataUI(); // Update pending data counts on UI load

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
