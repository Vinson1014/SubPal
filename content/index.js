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

// 字幕內容快取，避免重複刷新造成閃爍
let lastSubtitleCache = {
  text: null,
  htmlContent: null,
  position: null
};
import { initMessaging, sendMessage, onMessage } from './messaging.js';

/**
 * 擴充功能狀態與調試函式
 */
let isEnabled = true;
let replacementCount = 0;
let debugMode = false;

// 僅在 debugMode 開啟時輸出日誌
function debugLog(...args) {
  if (debugMode) console.log('[Index]', ...args);
}

/**
 * 初始化擴充功能
 */
async function initExtension() {
  console.log('字幕助手擴充功能初始化中...');

  // 從存儲中載入設置
  await loadSettings();

  if(!isEnabled) {
    console.log('擴充功能已禁用');
    return;
  }

  // 初始化所有模組
  initMessaging();
  console.log('消息傳遞模組已就緒');
  
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
  
  console.log('字幕助手擴充功能初始化完成');
}

/**
 * 設置事件監聽器
 */
function setupEventListeners() {
  debugLog('設置字幕偵測回調...');

  // 去重：只處理不同內容/位置的字幕
  let lastDetectedSubtitle = {
    text: null,
    position: null
  };

  // 監聽字幕偵測事件
  onSubtitleDetected((subtitleData) => {
    // 去重判斷（只用 text+position）
    if (
      subtitleData.text === lastDetectedSubtitle.text &&
      lastDetectedSubtitle.position &&
      subtitleData.position &&
      Math.abs(lastDetectedSubtitle.position.top - subtitleData.position.top) < 5 &&
      Math.abs(lastDetectedSubtitle.position.left - subtitleData.position.left) < 5
    ) {
      // debugLog('跳過重複字幕:', subtitleData.text, subtitleData.position);
      return;
    }
    lastDetectedSubtitle.text = subtitleData.text;
    lastDetectedSubtitle.position = subtitleData.position ? { ...subtitleData.position } : null;

    debugLog('字幕偵測回調被觸發:', subtitleData);

    if (!isEnabled) {
      debugLog('擴充功能已停用，不處理字幕');
      return;
    }

    // 如果是空字幕，則隱藏自訂字幕
    if (!subtitleData.text || subtitleData.isEmpty) {
      debugLog('偵測到空字幕，隱藏自訂字幕');
      hideSubtitle();
      return;
    }

    const videoId = getVideoId();
    const timestamp = getCurrentTimestamp();

    // 處理字幕替換
    processSubtitle(subtitleData, videoId, timestamp)
      .then(replacedSubtitle => {
        if (replacedSubtitle) {
          // 創建替換後的字幕數據對象，添加必要的屬性
          const replacedSubtitleData = {
            ...replacedSubtitle,
            videoId: videoId,
            timestamp: timestamp,
          };


          debugLog(`字幕替換成功: "${subtitleData.text}" -> "${replacedSubtitleData.text}"`);

          // 顯示替換後的字幕
          // 內容比對，只有變化才顯示
          if (
            replacedSubtitleData.text !== lastSubtitleCache.text ||
            replacedSubtitleData.htmlContent !== lastSubtitleCache.htmlContent ||
            JSON.stringify(replacedSubtitleData.position) !== JSON.stringify(lastSubtitleCache.position)
          ) {
            showSubtitle(replacedSubtitleData);
            lastSubtitleCache.text = replacedSubtitleData.text;
            lastSubtitleCache.htmlContent = replacedSubtitleData.htmlContent;
            lastSubtitleCache.position = replacedSubtitleData.position ? { ...replacedSubtitleData.position } : null;
          }

          // 更新替換計數
          replacementCount++;

          // 記錄替換事件
          const now = new Date().toISOString();
          sendMessage({
            type: 'GET_USER_ID'
          }).then(response => {
            const userID = response.userID || 'unknown';
            const replacementEvent = {
              occurredAt: now,
              translationID: replacedSubtitleData.translationID || 'unknown', // 從 API 回傳值中提取
              contributorUserID: replacedSubtitleData.contributorUserID || 'unknown', // 從 API 回傳值中提取
              beneficiaryUserID: userID // 使用當前用戶的 ID
            };

            // 將事件發送到背景腳本進行處理
            sendMessage({
              type: 'REPORT_REPLACEMENT_EVENTS',
              events: [replacementEvent]
            }).then(() => {
              debugLog('替換事件已發送到背景腳本:', replacementEvent);
            }).catch(error => {
              console.error('發送替換事件到背景腳本時出錯:', error);
            });
          }).catch(error => {
            console.error('獲取用戶 ID 時出錯:', error);
            const replacementEvent = {
              occurredAt: now,
              translationID: replacedSubtitleData.translationID || 'unknown', // 從 API 回傳值中提取
              contributorUserID: replacedSubtitleData.contributorUserID || 'unknown', // 從 API 回傳值中提取
              beneficiaryUserID: 'unknown' // 無法獲取用戶 ID 時使用預設值
            };

            // 將事件發送到背景腳本進行處理
            sendMessage({
              type: 'REPORT_REPLACEMENT_EVENTS',
              events: [replacementEvent]
            }).then(() => {
              debugLog('替換事件已發送到背景腳本:', replacementEvent);
            }).catch(error => {
              console.error('發送替換事件到背景腳本時出錯:', error);
            });
          });
        } else {
          debugLog(`沒有找到替換規則，使用原始字幕: "${subtitleData.text}"`);

          // 創建原始字幕數據對象，添加必要的屬性
          const originalSubtitleData = {
            ...subtitleData,
            videoId: videoId,
            timestamp: timestamp,
            isReplaced: false
          };

          // 顯示原始字幕
          // 內容比對，只有變化才顯示
          if (
            originalSubtitleData.text !== lastSubtitleCache.text ||
            originalSubtitleData.htmlContent !== lastSubtitleCache.htmlContent ||
            JSON.stringify(originalSubtitleData.position) !== JSON.stringify(lastSubtitleCache.position)
          ) {
            showSubtitle(originalSubtitleData);
            lastSubtitleCache.text = originalSubtitleData.text;
            lastSubtitleCache.htmlContent = originalSubtitleData.htmlContent;
            lastSubtitleCache.position = originalSubtitleData.position ? { ...originalSubtitleData.position } : null;
          }
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
      debugLog(`擴充功能已${isEnabled ? '啟用' : '停用'}`);
      
      // 如果停用，隱藏所有自定義字幕
      if (!isEnabled) {
        hideSubtitle();
        lastSubtitleCache.text = null;
        lastSubtitleCache.htmlContent = null;
        lastSubtitleCache.position = null;
      }
    } else if (message.type === 'TOGGLE_DEBUG_MODE') {
      debugMode = message.debugMode;
      debugLog(`調試模式已${debugMode ? '啟用' : '停用'}`);
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
async function loadSettings() {
  return new Promise((resolve, reject) => {
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
      
      debugLog(`載入設置: isEnabled=${isEnabled}, debugMode=${debugMode}`);
      resolve(); // 設置載入完成，解析 Promise
    })
    .catch(error => {
      console.error('載入設置時出錯:', error);
      reject(error); // 載入設置出錯，拒絕 Promise
    });
  });
  // 注意：定時回報機制已在背景腳本中實現，此處不再設置定時器
}

// 當頁面加載完成後初始化擴充功能
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initExtension);
} else {
  initExtension();
}
