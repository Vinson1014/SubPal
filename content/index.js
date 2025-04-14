/**
 * 字幕助手擴充功能 - 內容腳本主入口點
 * 
 * 這個文件是內容腳本的主入口點，負責初始化和協調各個模組。
 */

// 導入所有模組
import { initSubtitleDetector, onSubtitleDetected } from './subtitle-detector.js';
import { initSubtitleReplacer, processSubtitle } from './subtitle-replacer.js';
import { initUIManager, showSubtitle, hideSubtitle } from './ui-manager.js';
import { initVideoInfo, getVideoId, getCurrentTimestamp } from './video-info.js';
import { initMessaging, sendMessage, onMessage } from './messaging.js';

// 擴充功能狀態
let isEnabled = true;
let replacementCount = 0;
let debugMode = false;

/**
 * 初始化擴充功能
 */
function initExtension() {
  console.log('字幕助手擴充功能初始化中...');
  
  // 初始化所有模組
  initMessaging();
  console.log('消息傳遞模組初始化完成');
  
  initVideoInfo();
  console.log('視頻信息模組初始化完成');
  
  initSubtitleDetector();
  console.log('字幕偵測模組初始化完成');
  
  initSubtitleReplacer();
  console.log('字幕替換模組初始化完成');
  
  initUIManager();
  console.log('UI管理模組初始化完成');
  
  // 設置事件監聽器
  console.log('設置事件監聽器...');
  setupEventListeners();
  console.log('事件監聽器設置完成');
  
  // 從存儲中載入設置
  loadSettings();
  
  console.log('字幕助手擴充功能初始化完成');
}

/**
 * 設置事件監聽器
 */
function setupEventListeners() {
  console.log('設置字幕偵測回調...');
  
  // 監聽字幕偵測事件
  onSubtitleDetected((subtitleData) => {
    console.log('字幕偵測回調被觸發:', subtitleData);
    
    if (!isEnabled) {
      console.log('擴充功能已停用，不處理字幕');
      return;
    }
    
    const videoId = getVideoId();
    const timestamp = getCurrentTimestamp();
    
    console.log(`偵測到字幕: "${subtitleData.text}" (videoId: ${videoId}, timestamp: ${timestamp})`);
    
    // 處理字幕替換
    console.log('開始處理字幕替換...');
    processSubtitle(subtitleData, videoId, timestamp)
      .then(replacedSubtitle => {
        if (replacedSubtitle) {
          console.log(`字幕替換成功: "${subtitleData.text}" -> "${replacedSubtitle.text}"`);
          
          // 顯示替換後的字幕
          console.log('顯示替換後的字幕...');
          showSubtitle(replacedSubtitle);
          
          // 更新替換計數
          replacementCount++;
          
          // 發送統計信息更新
          sendMessage({
            type: 'UPDATE_STATS',
            videoId,
            replacementCount
          });
        } else {
          console.log(`沒有找到替換規則，使用原始字幕: "${subtitleData.text}"`);
          
          // 創建原始字幕數據對象，添加必要的屬性
          const originalSubtitleData = {
            ...subtitleData,
            videoId: videoId,
            timestamp: timestamp,
            isReplaced: false
          };
          
          // 顯示原始字幕
          console.log('顯示原始字幕...');
          showSubtitle(originalSubtitleData);
        }
      })
      .catch(error => {
        console.error('處理字幕替換時出錯:', error);
      });
  });
  
  // 監聽來自 popup 或 background 的消息
  onMessage((message) => {
    if (message.type === 'TOGGLE_EXTENSION') {
      isEnabled = message.isEnabled;
      console.log(`擴充功能已${isEnabled ? '啟用' : '停用'}`);
      
      // 如果停用，隱藏所有自定義字幕
      if (!isEnabled) {
        hideSubtitle();
      }
    } else if (message.type === 'TOGGLE_DEBUG_MODE') {
      debugMode = message.debugMode;
      console.log(`調試模式已${debugMode ? '啟用' : '停用'}`);
    } else if (message.type === 'GET_VIDEO_INFO') {
      // 回應視頻信息請求
      return {
        videoId: getVideoId(),
        replacementCount
      };
    }
  });
}

/**
 * 從存儲中載入設置
 */
function loadSettings() {
  // 使用 sendMessage 而不是直接訪問 chrome.storage
  sendMessage({
    type: 'GET_SETTINGS',
    keys: ['isEnabled', 'debugMode']
  })
  .then(result => {
    if (result && result.isEnabled !== undefined) {
      isEnabled = result.isEnabled;
    }
    
    if (result && result.debugMode !== undefined) {
      debugMode = result.debugMode;
    }
    
    console.log(`載入設置: isEnabled=${isEnabled}, debugMode=${debugMode}`);
  })
  .catch(error => {
    console.error('載入設置時出錯:', error);
  });
}

// 當頁面加載完成後初始化擴充功能
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initExtension);
} else {
  initExtension();
}
