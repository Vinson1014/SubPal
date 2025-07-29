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

// 導入新的簡化雙語字幕系統
import { initNetflixAPIBridge, isNetflixAPIAvailable } from './netflix-api-bridge.js';
import { 
  initSubtitleRenderer,
  setSubtitleLanguages,
  refreshSubtitleData,
  hideSubtitles,
  setSubtitleRendererCallbacks,
  getSubtitleRendererStatus,
  setSubtitleRendererDebugMode
} from './subtitle-renderer.js';
import { setSubtitleParserDebugMode } from './subtitle-parser.js';

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

// 新的簡化雙語字幕狀態
let dualSubtitleMode = true;  // 預設啟用雙語字幕進行測試
let netflixAPIAvailable = false;
let subtitleRendererInitialized = false;
let primaryLanguage = 'zh-Hant';  // 主要語言
let secondaryLanguage = 'en';     // 次要語言

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
  
  // 初始化新的簡化雙語字幕系統
  await initSimplifiedDualSubtitleSystem();
  
  // 設置事件監聽器
  console.log('設置事件監聽器...');
  setupEventListeners();
  console.log('事件監聽器設置完成');
  
  console.log('字幕助手擴充功能初始化完成');
}

/**
 * 初始化簡化雙語字幕系統
 */
async function initSimplifiedDualSubtitleSystem() {
  console.log('初始化簡化雙語字幕系統...');
  
  try {
    // 檢查是否在Netflix頁面
    if (!window.location.hostname.includes('netflix.com')) {
      debugLog('不在Netflix頁面，跳過雙語字幕初始化');
      return;
    }
    
    // 初始化Netflix API橋接器（用於字幕攔截）
    netflixAPIAvailable = await initNetflixAPIBridge();
    debugLog('Netflix API可用性:', netflixAPIAvailable);
    
    // 初始化字幕渲染器
    subtitleRendererInitialized = await initSubtitleRenderer();
    debugLog('字幕渲染器初始化結果:', subtitleRendererInitialized);
    
    if (subtitleRendererInitialized) {
      // 設置語言
      setSubtitleLanguages(primaryLanguage, secondaryLanguage);
      
      // 設置調試模式
      setSubtitleRendererDebugMode(debugMode);
      setSubtitleParserDebugMode(debugMode);
      
      // 設置回調
      setSubtitleRendererCallbacks({
        onSubtitleReady: handleSubtitleReady,
        onSubtitleChange: handleSubtitleChange,
        onError: handleSubtitleError
      });
      
      console.log('簡化雙語字幕系統初始化完成');
    } else {
      console.log('字幕渲染器初始化失敗，將使用單語模式');
    }
    
  } catch (error) {
    console.error('初始化簡化雙語字幕系統時出錯:', error);
    subtitleRendererInitialized = false;
  }
}

/**
 * 設置事件監聽器
 */
function setupEventListeners() {
  debugLog('設置字幕偵測回調...');

  // 監聽page script注入請求
  window.addEventListener('subpal-inject-page-script', async (event) => {
    debugLog('收到page script注入請求:', event.detail);
    
    try {
      // 檢查是否已經存在page script
      if (window.subpalPageScript) {
        debugLog('Page script已存在，跳過注入');
        return;
      }

      // 等待短暫時間確保DOM準備就緒
      await new Promise(resolve => setTimeout(resolve, 100));

      // 通過sendMessage請求content script注入page script
      // 因為在page context中無法直接訪問chrome.runtime API
      debugLog('請求content script注入page script');
      
      // 發送內部事件通知需要注入page script
      const injectionEvent = new CustomEvent('subpal-request-page-script-injection', {
        detail: { 
          timestamp: Date.now(),
          requestId: event.detail.requestId || 'unknown'
        }
      });
      window.dispatchEvent(injectionEvent);
      
      debugLog('Page script注入請求已轉發');
    } catch (error) {
      console.error('處理page script注入請求時出錯:', error);
    }
  });

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

    // 如果是空字幕，則隱藏所有字幕UI
    if (!subtitleData.text || subtitleData.isEmpty) {
      debugLog('偵測到空字幕，隱藏所有字幕UI');
      hideSubtitle(); // 隱藏單語字幕UI
      // 新系統會自動處理空字幕，不需要手動隱藏
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

          // 檢查當前字幕模式
          if (dualSubtitleMode && subtitleRendererInitialized) {
            debugLog('使用新的簡化雙語字幕模式');
            // 新系統會自動處理字幕渲染，這裡只需顯示原始字幕到單語UI
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
          } else {
            debugLog('使用單語字幕模式');
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

          // 檢查當前字幕模式
          if (dualSubtitleMode && subtitleRendererInitialized) {
            debugLog('使用新的簡化雙語字幕模式（原始字幕）');
            // 新系統會自動處理字幕渲染，這裡只需顯示原始字幕到單語UI
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
          } else {
            debugLog('使用單語字幕模式（原始字幕）');
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
        // 新系統會自動處理隱藏
        lastSubtitleCache.text = null;
        lastSubtitleCache.htmlContent = null;
        lastSubtitleCache.position = null;
      }
    } else if (message.type === 'TOGGLE_DEBUG_MODE') {
      debugMode = message.debugMode;
      debugLog(`調試模式已${debugMode ? '啟用' : '停用'}`);
      
      // 更新新系統的調試模式
      if (subtitleRendererInitialized) {
        setSubtitleRendererDebugMode(debugMode);
        setSubtitleParserDebugMode(debugMode);
      }
    } else if (message.type === 'TOGGLE_DUAL_SUBTITLE') {
      dualSubtitleMode = message.enabled;
      debugLog(`雙語字幕模式已${dualSubtitleMode ? '啟用' : '停用'}`);
      
      // 處理雙語字幕模式切換
      if (dualSubtitleMode && subtitleRendererInitialized) {
        // 更新語言設置
        primaryLanguage = message.primaryLanguage || 'zh-Hant';
        secondaryLanguage = message.secondaryLanguage || 'en';
        setSubtitleLanguages(primaryLanguage, secondaryLanguage);
        
        // 刷新字幕數據
        refreshSubtitleData()
          .then(() => {
            debugLog('新的簡化雙語字幕啟用成功');
          })
          .catch(error => {
            console.error('刷新字幕數據失敗:', error);
          });
      } else {
        debugLog('雙語字幕模式已停用或渲染器未初始化');
      }
    } else if (message.type === 'GET_VIDEO_INFO') {
      // 回應視頻信息請求
      return {
        videoId: getVideoId(),
        replacementCount,
        dualSubtitleEnabled: dualSubtitleMode,
        dualSubtitleInitialized: subtitleRendererInitialized,
        netflixAPIAvailable: netflixAPIAvailable,
        subtitleRendererStatus: subtitleRendererInitialized ? getSubtitleRendererStatus() : null
      };
    }
  });
}

/**
 * 新系統的回調函數
 */

/**
 * 處理字幕準備就緒
 */
function handleSubtitleReady() {
  debugLog('字幕準備就緒');
  // 新系統會自動處理渲染，這裡可以添加任何需要的邏輯
}

/**
 * 處理字幕變化
 */
function handleSubtitleChange(dualSubtitle) {
  debugLog('字幕已更新:', {
    primary: dualSubtitle.primaryText,
    secondary: dualSubtitle.secondaryText,
    timestamp: dualSubtitle.timestamp
  });
  // 可以在這裡添加任何需要的邏輯，例如記錄或分析
}

/**
 * 處理字幕錯誤
 */
function handleSubtitleError(error) {
  console.error('字幕系統錯誤:', error);
  // 可以在這裡添加錯誤處理邏輯
}

/**
 * 舊系統的處理函數（保留以避免破壞）
 */

/**
 * 處理雙語字幕顯示
 */
function handleDualSubtitleDisplay(subtitleData, timestamp) {
  debugLog('處理雙語字幕顯示:', subtitleData.text, '播放器時間戳(秒):', timestamp);
  
  try {
    // 檢查雙語字幕狀態
    const dualManager = getDualSubtitleManager();
    const status = dualManager.getStatus();
    debugLog('雙語字幕管理器狀態:', status);
    
    // 獲取當前時間的雙語字幕（現在使用正確的時間戳轉換）
    const dualSubtitle = getCurrentDualSubtitles(timestamp);
    debugLog('獲取到的雙語字幕:', dualSubtitle ? 
      { primaryText: dualSubtitle.primaryText, secondaryText: dualSubtitle.secondaryText } : 
      '未找到匹配的字幕');
    
    if (dualSubtitle) {
      // 將單語字幕數據融入雙語字幕
      const enhancedDualSubtitle = {
        ...dualSubtitle,
        // 使用當前處理的字幕作為主要字幕（如果有替換的話）
        primaryText: dualSubtitle.primaryText,
        // primaryText: subtitleData.text || dualSubtitle.primaryText,
        // 保持原有的次要字幕
        secondaryText: dualSubtitle.secondaryText || '',
        // 添加額外信息
        isReplaced: subtitleData.isReplaced || false,
        translationID: subtitleData.translationID,
        contributorUserID: subtitleData.contributorUserID
      };
      
      // 使用雙語字幕UI顯示
      showDualSubtitle(enhancedDualSubtitle);
      
      // 更新緩存
      lastSubtitleCache.text = enhancedDualSubtitle.primaryText;
      lastSubtitleCache.htmlContent = subtitleData.htmlContent;
      lastSubtitleCache.position = subtitleData.position ? { ...subtitleData.position } : null;
      
      // 隱藏單語字幕UI
      hideSubtitle();
    } else {
      // 沒有雙語字幕數據，回退到單語顯示
      debugLog('沒有對應的雙語字幕數據，回退到單語顯示');
      showSubtitle(subtitleData);
      hideDualSubtitle();
      
      // 更新緩存
      lastSubtitleCache.text = subtitleData.text;
      lastSubtitleCache.htmlContent = subtitleData.htmlContent;
      lastSubtitleCache.position = subtitleData.position ? { ...subtitleData.position } : null;
    }
  } catch (error) {
    console.error('處理雙語字幕顯示時出錯:', error);
    // 出錯時回退到單語顯示
    showSubtitle(subtitleData);
    hideDualSubtitle();
  }
}

/**
 * 處理雙語字幕就緒
 */
function handleDualSubtitleReady(alignedSubtitles) {
  debugLog('雙語字幕就緒，共', alignedSubtitles.length, '個對齊字幕');
  
  if (alignedSubtitles.length > 0) {
    // 設置為活躍的雙語字幕模式
    activeDualSubtitleMode = true;
    debugLog('雙語字幕載入成功，設為活躍雙語模式');
    
    // 啟用雙語字幕UI
    activateDualSubtitleUI();
    debugLog('雙語字幕UI已啟用');
  } else {
    // 雙語字幕載入失敗，保持單語模式
    activeDualSubtitleMode = false;
    debugLog('雙語字幕載入失敗，保持單語模式');
  }
}

/**
 * 處理fallback模式
 */
function handleFallbackMode() {
  debugLog('切換到fallback模式');
  dualSubtitleMode = false;
  activeDualSubtitleMode = false;  // 重置活躍雙語字幕模式
  
  // 停用雙語字幕UI
  deactivateDualSubtitleUI();
  
  debugLog('已重置為單語字幕模式');
  
  // 可以通知用戶切換到fallback模式
  // showToast('雙語字幕API不可用，已切換到單語模式');
}

/**
 * 處理雙語字幕錯誤
 */
function handleDualSubtitleError(error) {
  console.error('雙語字幕系統錯誤:', error);
  
  // 自動切換到fallback模式
  handleFallbackMode();
}

/**
 * 處理回退到單語字幕系統
 */
function handleFallbackToSingleSubtitle(reason) {
  debugLog('需要回退到單語字幕系統，原因:', reason);
  
  // 停用雙語字幕UI
  deactivateDualSubtitleUI();
  
  // 標記為非雙語模式
  dualSubtitleMode = false;
  activeDualSubtitleMode = false;  // 重置活躍雙語字幕模式
  
  debugLog('已回退到單語字幕系統');
}

/**
 * 從存儲中載入設置
 */
async function loadSettings() {
  return new Promise((resolve, reject) => {
    // 使用 sendMessage 而不是直接訪問 chrome.storage
    sendMessage({
      type: 'GET_SETTINGS',
      keys: ['isEnabled', 'debugMode', 'dualSubtitleEnabled']
    })
    .then(result => {
      if (result && result.isEnabled !== undefined) {
        isEnabled = result.isEnabled;
      }
      
      if (result && result.debugMode !== undefined) {
        debugMode = result.debugMode;
      }
      
      if (result && result.dualSubtitleEnabled !== undefined) {
        dualSubtitleMode = result.dualSubtitleEnabled;
      }
      
      debugLog(`載入設置: isEnabled=${isEnabled}, debugMode=${debugMode}, dualSubtitleMode=${dualSubtitleMode}`);
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
