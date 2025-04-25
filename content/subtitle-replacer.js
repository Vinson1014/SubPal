/**
 * 字幕助手擴充功能 - 字幕替換模組
 * 
 * 這個模組負責處理字幕替換的邏輯，包括查詢替換規則和生成替換後的字幕內容。
 */

import { sendMessage, onMessage } from './messaging.js';

let debugMode = false;
let isEnabled = true; // 擴充功能是否啟用

// 僅在 debugMode 時輸出日誌
function debugLog(...args) {
  if (debugMode) {
    console.log('[SubtitleReplacer]', ...args);
  }
}

// --- 狀態管理 ---
let currentVideoId = null;
let subtitleCache = []; // 緩存從後端獲取的替換字幕列表 [{timestamp, originalSubtitle, suggestedSubtitle, translationID}, ...]
let lastFetchTimestamp = -1; // 上次觸發 fetch 的時間戳
let isFetching = false; // 是否正在請求後端
const FETCH_DURATION_SECONDS = 180; // 每次請求獲取的時長 (3分鐘)
const PREFETCH_THRESHOLD_SECONDS = 60; // 緩存剩餘時間少於此值時觸發預加載 (1分鐘)
const TIMESTAMP_TOLERANCE_SECONDS = 2; // 時間戳模糊匹配容差 (2秒)

// 測試模式狀態
let isTestModeEnabled = false;
let testRules = []; // 格式: [{ original: '原文', replacement: '替換文' }]

/**
 * 初始化字幕替換模組
 */
export function initSubtitleReplacer() {
  debugLog('初始化字幕替換模組...');
  loadInitialSettings(); // 載入初始設置 (debugMode, isEnabled, testMode)
  setupMessageListeners(); // 設置消息監聽器
}

/**
 * 載入初始設置
 */
function loadInitialSettings() {
  sendMessage({ type: 'GET_SETTINGS', keys: ['debugMode', 'isEnabled', 'isTestModeEnabled', 'testRules'] })
    .then(settings => {
      if (settings) {
        debugMode = settings.debugMode || false;
        isEnabled = settings.isEnabled === undefined ? true : settings.isEnabled; // 默認啟用
        isTestModeEnabled = settings.isTestModeEnabled || false;
        testRules = settings.testRules || [];
        debugLog('初始設置載入:', { debugMode, isEnabled, isTestModeEnabled, testRulesCount: testRules.length });
      }
    })
    .catch(err => {
      console.error('載入初始設置出錯:', err);
    });
}

/**
 * 設置消息監聽器
 */
function setupMessageListeners() {
  onMessage((msg) => {
    switch (msg.type) {
      case 'TOGGLE_DEBUG_MODE':
        debugMode = msg.debugMode;
        debugLog('調試模式切換:', debugMode);
        break;
      case 'TOGGLE_EXTENSION':
        isEnabled = msg.isEnabled;
        debugLog(`擴充功能已${isEnabled ? '啟用' : '停用'}`);
        if (!isEnabled) {
          clearCache(); // 禁用時清除緩存
        }
        break;
      case 'SETTINGS_CHANGED': // 監聽來自 popup 的設置變更
        if (msg.changes.isTestModeEnabled !== undefined) {
          isTestModeEnabled = msg.changes.isTestModeEnabled;
          debugLog(`測試模式已${isTestModeEnabled ? '啟用' : '停用'}`);
        }
        if (msg.changes.testRules) {
          testRules = msg.changes.testRules || [];
          debugLog('測試規則已更新:', testRules);
        }
        // 可以添加對 isEnabled 的監聽，如果 popup 可以直接修改 isEnabled
        if (msg.changes.isEnabled !== undefined) {
            isEnabled = msg.changes.isEnabled;
            debugLog(`擴充功能已${isEnabled ? '啟用' : '停用'} (來自設置變更)`);
             if (!isEnabled) {
                clearCache();
            }
        }
        break;
    }
  });
}

/**
 * 清除緩存和狀態
 */
function clearCache() {
    debugLog('清除字幕緩存和狀態');
    currentVideoId = null;
    subtitleCache = [];
    lastFetchTimestamp = -1;
    isFetching = false;
}

/**
 * 處理字幕替換
 * @param {Object} subtitleData - 當前偵測到的原生字幕數據 { text, ... }
 * @param {string} videoId - 視頻 ID
 * @param {number} timestamp - 當前字幕的時間戳 (秒)
 * @returns {Promise<Object|null>} - 替換後的字幕數據，如果沒有替換則返回 null
 */
export async function processSubtitle(subtitleData, videoId, timestamp) {
  if (!isEnabled) {
    return null; // 如果擴充功能被禁用，直接返回
  }

  const originalText = subtitleData.text;

  // --- 1. 檢查測試模式 ---
  if (isTestModeEnabled && testRules.length > 0) {
    const testReplacement = checkTestRules(originalText);
    if (testReplacement) {
      return createReplacedSubtitle(subtitleData, testReplacement.replacement, testReplacement.translationID);
    }
  }

  // --- 2. 檢查 Video ID 是否變更 ---
  if (videoId !== currentVideoId) {
    debugLog(`視頻 ID 變更: ${currentVideoId} -> ${videoId}`);
    clearCache();
    currentVideoId = videoId;
    // 觸發第一次獲取
    fetchSubtitleBatch(videoId, timestamp);
    return null; // 第一次請求，暫不替換
  }

  // --- 3. 在緩存中查找匹配的替換字幕 (優先文字，後時間戳) ---
  const cachedReplacement = findReplacementInCache(originalText, timestamp);
  if (cachedReplacement) {
    debugLog(`在緩存中找到匹配字幕 (Text: "${originalText}", TS: ${timestamp.toFixed(2)} -> Cached TS: ${cachedReplacement.timestamp.toFixed(2)}):`, cachedReplacement.suggestedSubtitle);
    // 檢查是否需要預加載
    checkAndTriggerPrefetch(timestamp);
    return createReplacedSubtitle(subtitleData, cachedReplacement.suggestedSubtitle, cachedReplacement.translationID);
  } else {
    debugLog(`在緩存中未找到時間戳 ${timestamp.toFixed(2)} 的匹配字幕`);
  }

  // --- 4. 檢查是否需要觸發新的獲取 (如果緩存為空或時間戳超出範圍) ---
  // 通常情況下，預加載機制會處理，但以防萬一
  if (subtitleCache.length === 0 && !isFetching) {
      debugLog(`緩存為空且未在請求中，為時間戳 ${timestamp.toFixed(2)} 觸發請求`);
      fetchSubtitleBatch(videoId, timestamp);
  } else {
      // 檢查是否需要預加載 (即使當前字幕未匹配，也可能需要加載後續的)
      checkAndTriggerPrefetch(timestamp);
  }


  // --- 5. 如果沒有找到替換規則，返回 null ---
  return null;
}

/**
 * 檢查測試規則
 * @param {string} text - 原始字幕文本
 * @returns {{replacement: string, translationID: string}|null} - 替換文本和ID，如果沒有匹配則返回 null
 */
function checkTestRules(text) {
  // 精確匹配優先
  for (const rule of testRules) {
    if (rule.original === text) {
      debugLog('測試模式精確匹配成功:', text, '->', rule.replacement);
      return { replacement: rule.replacement, translationID: `test_${rule.original}` }; // 使用 original 作為偽 ID
    }
  }
  // 包含匹配
  for (const rule of testRules) {
    if (text.includes(rule.original)) {
      debugLog('測試模式包含匹配成功:', rule.original, '在', text, '中，替換為', rule.replacement);
      // 只替換匹配的部分
      const replaced = text.replace(rule.original, rule.replacement);
      return { replacement: replaced, translationID: `test_partial_${rule.original}` };
    }
  }
  return null;
}

/**
 * 在緩存中查找匹配的替換字幕 (優先比對原生字幕，再比對時間戳)
 * @param {string} currentOriginalText - 當前原生字幕文本
 * @param {number} currentTimestamp - 當前字幕的時間戳 (秒)
 * @returns {object|null} - 緩存中匹配的字幕對象，或 null
 */
function findReplacementInCache(currentOriginalText, currentTimestamp) {
  if (subtitleCache.length === 0) {
    return null;
  }

  let exactTextMatches = [];
  let timestampMatches = [];

  // 遍歷緩存，分類匹配項
  for (const cachedSub of subtitleCache) {
    // 1. 檢查原生字幕文字是否完全匹配
    if (cachedSub.originalSubtitle === currentOriginalText) {
      exactTextMatches.push(cachedSub);
    }

    // 2. 檢查時間戳是否在容差範圍內 (即使文字不匹配也記錄，作為後備)
    const diff = Math.abs(currentTimestamp - cachedSub.timestamp);
    if (diff <= TIMESTAMP_TOLERANCE_SECONDS) {
      timestampMatches.push({ ...cachedSub, timestampDiff: diff });
    }
  }

  // 優先處理原生字幕完全匹配的結果
  if (exactTextMatches.length > 0) {
    debugLog(`找到 ${exactTextMatches.length} 條原生字幕完全匹配項`);
    // 如果有多個完全匹配，選擇時間戳最接近的
    if (exactTextMatches.length === 1) {
      return exactTextMatches[0];
    } else {
      let bestMatch = exactTextMatches[0];
      let minDiff = Math.abs(currentTimestamp - bestMatch.timestamp);
      for (let i = 1; i < exactTextMatches.length; i++) {
        const diff = Math.abs(currentTimestamp - exactTextMatches[i].timestamp);
        if (diff < minDiff) {
          minDiff = diff;
          bestMatch = exactTextMatches[i];
        }
      }
      debugLog(`從完全匹配項中選擇時間戳最接近的 (Diff: ${minDiff.toFixed(2)}s)`);
      return bestMatch;
    }
  }

  // 如果沒有文字完全匹配，則回退到時間戳模糊匹配
  if (timestampMatches.length > 0) {
    debugLog(`未找到文字完全匹配，找到 ${timestampMatches.length} 條時間戳匹配項`);
    // 選擇時間戳差異最小的
    timestampMatches.sort((a, b) => a.timestampDiff - b.timestampDiff);
    debugLog(`選擇時間戳差異最小的匹配項 (Diff: ${timestampMatches[0].timestampDiff.toFixed(2)}s)`);
    // 注意：這裡返回的是添加了 timestampDiff 的對象，需要移除它或確保後續邏輯不依賴它
    const { timestampDiff, ...bestMatch } = timestampMatches[0];
    return bestMatch;
  }

  // 如果文字和時間戳都沒有匹配
  debugLog(`未找到任何匹配項 (文字或時間戳)`);
  return null;
}

/**
 * (可選) 從緩存中移除早於當前時間戳一定範圍的字幕
 * @param {number} currentTimestamp
 */
function removeOldSubtitlesFromCache(currentTimestamp) {
    const removalThreshold = currentTimestamp - 10; // 例如移除 10 秒前的
    const originalLength = subtitleCache.length;
    subtitleCache = subtitleCache.filter(sub => sub.timestamp >= removalThreshold);
    if (subtitleCache.length < originalLength) {
        debugLog(`從緩存中移除 ${originalLength - subtitleCache.length} 條舊字幕`);
    }
}


/**
 * 檢查是否需要預加載並觸發
 * @param {number} currentTimestamp - 當前字幕的時間戳 (秒)
 */
function checkAndTriggerPrefetch(currentTimestamp) {
  if (isFetching || subtitleCache.length === 0) {
    return; // 如果正在請求或緩存為空，則不觸發
  }

  // 找到緩存中最大的時間戳
  const maxCachedTimestamp = subtitleCache.reduce((max, sub) => Math.max(max, sub.timestamp), 0);

  const remainingTime = maxCachedTimestamp - currentTimestamp;
  debugLog(`緩存剩餘時間: ${remainingTime.toFixed(2)}s (MaxTS: ${maxCachedTimestamp.toFixed(2)}, CurrentTS: ${currentTimestamp.toFixed(2)})`);

  if (remainingTime < PREFETCH_THRESHOLD_SECONDS) {
    debugLog(`剩餘時間 (${remainingTime.toFixed(2)}s) 少於閾值 (${PREFETCH_THRESHOLD_SECONDS}s)，觸發預加載`);
    // 從緩存的最大時間戳開始請求下一批
    fetchSubtitleBatch(currentVideoId, maxCachedTimestamp);
  }
}

/**
 * 向 background 請求一批字幕數據並更新緩存
 * @param {string} videoId - 視頻 ID
 * @param {number} startTimestamp - 開始時間戳 (秒)
 */
async function fetchSubtitleBatch(videoId, startTimestamp) {
  if (isFetching || !videoId) {
    debugLog(`請求被阻止: isFetching=${isFetching}, videoId=${videoId}`);
    return; // 防止重複請求或無效請求
  }
  // 檢查是否短時間內重複請求相同的起始時間戳
  if (startTimestamp <= lastFetchTimestamp && startTimestamp > 0) {
      debugLog(`請求被阻止: 嘗試請求的時間戳 (${startTimestamp.toFixed(2)}) 不大於上次請求的時間戳 (${lastFetchTimestamp.toFixed(2)})`);
      return;
  }


  isFetching = true;
  lastFetchTimestamp = startTimestamp; // 記錄這次請求的起始時間戳
  debugLog(`開始請求字幕批次: videoId=${videoId}, startTime=${startTimestamp.toFixed(2)}`);

  try {
    const response = await sendMessage({
      type: 'CHECK_SUBTITLE',
      videoId,
      timestamp: startTimestamp // 發送請求的起始時間戳
    });

    if (response && response.success && Array.isArray(response.subtitles)) {
      debugLog(`從 background 收到 ${response.subtitles.length} 條字幕數據`);
      if (response.subtitles.length > 0) {
        // 合併新數據到緩存，並去重 (基於 timestamp 或 translationID)
        const newSubs = response.subtitles;
        const existingTimestamps = new Set(subtitleCache.map(s => s.timestamp.toFixed(3))); // 使用固定精度比較
        const uniqueNewSubs = newSubs.filter(ns => !existingTimestamps.has(ns.timestamp.toFixed(3)));

        if (uniqueNewSubs.length > 0) {
            subtitleCache = [...subtitleCache, ...uniqueNewSubs];
            // 按時間戳排序緩存
            subtitleCache.sort((a, b) => a.timestamp - b.timestamp);
            debugLog(`緩存已更新，新增 ${uniqueNewSubs.length} 條，總數: ${subtitleCache.length}`);
            // 可選：限制緩存大小
            limitCacheSize();
        } else {
            debugLog('收到的字幕數據在緩存中已存在，未更新緩存。');
        }
      } else {
         debugLog('從 background 收到的字幕數據為空列表。');
      }
    } else {
      console.error('從 background 獲取字幕失敗或格式錯誤:', response);
      // 這裡可以考慮重試機制或錯誤處理
    }
  } catch (error) {
    console.error('請求字幕批次時出錯:', error);
    // 可以在這裡添加錯誤處理，例如延遲後重試
  } finally {
    isFetching = false;
    debugLog('字幕批次請求完成');
  }
}

/**
 * (可選) 限制緩存大小，例如移除最早的字幕
 */
function limitCacheSize() {
    const MAX_CACHE_SIZE = 500; // 例如最多緩存 500 條
    if (subtitleCache.length > MAX_CACHE_SIZE) {
        const removedCount = subtitleCache.length - MAX_CACHE_SIZE;
        subtitleCache = subtitleCache.slice(removedCount); // 保留最新的 MAX_CACHE_SIZE 條
        debugLog(`緩存大小超過限制，已移除 ${removedCount} 條舊字幕`);
    }
}


/**
 * 創建替換後的字幕數據
 * @param {Object} originalSubtitle - 原始字幕數據
 * @param {string} replacementText - 替換文本
 * @param {string} [translationID] - (可選) 替換字幕的 ID，用於投票等
 * @returns {Object} - 替換後的字幕數據
 */
function createReplacedSubtitle(originalSubtitle, replacementText, translationID = null) {
  // 創建新的字幕數據對象，保留原始字幕的位置和樣式
  return {
    ...originalSubtitle,
    text: replacementText,
    original: originalSubtitle.text, // 保留原始文本
    isReplaced: true,
    translationID: translationID // 添加 translationID
  };
}
