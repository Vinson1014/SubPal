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
const FETCH_DURATION_SECONDS = 180; // 每次請求獲取的時長 (3分鐘)
const PREFETCH_THRESHOLD_SECONDS = 60; // 緩存剩餘時間少於此值時觸發預加載 (1分鐘)
const TIMESTAMP_TOLERANCE_SECONDS = 2; // 時間戳模糊匹配容差 (2秒)

// 測試模式狀態
let isTestModeEnabled = false;
let testRules = []; // 格式: [{ original: '原文', replacement: '替換文' }]

// 已請求區間管理
let requestedIntervals = []; // 記錄已請求區間列表

/**
 * 判斷區間是否已請求
 * @param {number} startTimestamp - 開始時間戳
 * @returns {boolean} - 是否已請求
 */
function isIntervalRequested(startTimestamp) {
  return requestedIntervals.some(i =>
    (i.status === 'in-progress' || i.status === 'done') &&
    startTimestamp >= i.start &&
    startTimestamp < i.end
  );
}

/**
 * 合併接近或重疊的區間
 */
function mergeIntervals() {
  if (requestedIntervals.length < 2) return;

  requestedIntervals.sort((a, b) => a.start - b.start);
  const merged = [];
  let current = { ...requestedIntervals[0] };

  for (let i = 1; i < requestedIntervals.length; i++) {
    const next = requestedIntervals[i];
    if (next.start <= current.end + 10) { // 接近或重疊（10秒容差）
      current.end = Math.max(current.end, next.end);
      current.status = (current.status === 'done' && next.status === 'done') ? 'done' : 'in-progress';
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  debugLog(`區間合併: 從 ${requestedIntervals.length} 合併為 ${merged.length} 個區間`, merged);
  requestedIntervals = merged;
}

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
      case 'PLAYER_STATE_UPDATE':
        debugLog(`收到播放器狀態更新: ${msg.state} at ${msg.timestamp}`);
        handlePlayerStateUpdate(msg.state, msg.timestamp);
        break;
    }
  });
}

/**
 * 處理播放器狀態更新
 * @param {string} state - 播放器狀態 ('play', 'pause', 'seeked')
 * @param {number} timestamp - 當前時間戳
 */
function handlePlayerStateUpdate(state, timestamp) {
  if (state === 'play' && currentVideoId) {
    // 當播放器開始播放時，檢查是否需要獲取字幕
    if (subtitleCache.length === 0) {
      debugLog(`播放器播放，緩存為空，觸發字幕獲取 at ${timestamp}`);
      fetchSubtitleBatch(currentVideoId, timestamp);
    } else {
      // 檢查是否需要預加載
      checkAndTriggerPrefetch(timestamp);
    }
  }
  // 可以根據需要添加對 'pause' 或 'seeked' 的處理
}

/**
 * 清除緩存和狀態
 */
function clearCache() {
  debugLog('清除字幕緩存和狀態，包括 requestedIntervals');
  currentVideoId = null;
  subtitleCache = [];
  requestedIntervals = [];
  debugLog('緩存和狀態已完全清除');
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
    clearCache();  // 這將清除 requestedIntervals
    currentVideoId = videoId;
    // 觸發第一次獲取
    fetchSubtitleBatch(videoId, timestamp);
    return null; // 第一次請求，暫不替換
  }

  // --- 3. 在緩存中查找匹配的替換字幕 ---
  const cachedReplacement = findReplacementInCache(originalText, timestamp);
  if (cachedReplacement) {
    debugLog(`在緩存中找到匹配字幕 (Text: "${originalText}", TS: ${timestamp.toFixed(1)} -> Cached TS: ${cachedReplacement.timestamp.toFixed(2)}):`, cachedReplacement.suggestedSubtitle);
    // 檢查是否需要預加載
    checkAndTriggerPrefetch(timestamp);
    return createReplacedSubtitle(subtitleData, cachedReplacement.suggestedSubtitle, cachedReplacement.translationID);
  } else {
    debugLog(`在緩存中未找到時間戳 ${timestamp.toFixed(1)} 的匹配字幕`);
  }

  // --- 4. 檢查是否需要觸發新的獲取 (如果緩存為空或時間戳超出範圍) ---
  // 通常情況下，預加載機制會處理，但以防萬一
  if (subtitleCache.length === 0) {
      debugLog(`緩存為空，為時間戳 ${timestamp.toFixed(2)} 觸發請求`);
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
 * 在緩存中查找匹配的替換字幕 (優先比對字幕，再比對時間戳)
 * @param {string} currentOriginalText - 當前原生字幕文本
 * @param {number} currentTimestamp - 當前字幕的時間戳 (秒)
 * @returns {object|null} - 緩存中匹配的字幕對象，或 null
 */
function findReplacementInCache(currentOriginalText, currentTimestamp) {
  if (subtitleCache.length === 0) {
    debugLog('緩存中沒有字幕');
    return null;
  }

  let exactTextMatches = [];

  // 遍歷緩存，分類匹配項
  for (const cachedSub of subtitleCache) {
    // 檢查原生字幕文字是否完全匹配
    if (cachedSub.originalSubtitle === currentOriginalText) {
      exactTextMatches.push(cachedSub);
    }

  }

  // 優先處理原生字幕完全匹配的結果，並加入時間戳容差檢查
  if (exactTextMatches.length > 0) {
    debugLog(`找到 ${exactTextMatches.length} 條原生字幕完全匹配項`);
    // 過濾在容差範圍內的匹配
    const tolMatches = exactTextMatches.filter(sub =>
      Math.abs(currentTimestamp - sub.timestamp) <= TIMESTAMP_TOLERANCE_SECONDS
    );
    if (tolMatches.length === 0) {
      debugLog(`無符合時間戳容差 (${TIMESTAMP_TOLERANCE_SECONDS}s) 的完全匹配，跳過替換`);
      return null;
    }
    // 選擇時間戳差異最小的匹配
    let bestMatch = tolMatches[0];
    let minDiff = Math.abs(currentTimestamp - bestMatch.timestamp);
    for (let i = 1; i < tolMatches.length; i++) {
      const diff = Math.abs(currentTimestamp - tolMatches[i].timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        bestMatch = tolMatches[i];
      }
    }
    debugLog(`在容差範圍內選擇最佳匹配 (Diff: ${minDiff.toFixed(1)}s)`);
    return bestMatch;
  }

  // 如果文字和時間戳都沒有匹配
  debugLog(`未找到任何匹配項`);
  return null;
}


/**
 * 檢查是否需要預加載並觸發
 * @param {number} currentTimestamp - 當前字幕的時間戳 (秒)
 */
function checkAndTriggerPrefetch(currentTimestamp) {
  if (subtitleCache.length === 0) {
    debugLog('緩存為空，不觸發預加載');
    return;
  }

  // 找到與當前時間戳相關的最近 end timestamp
  let relevantEnd = Infinity;
  let relevantInterval = null;
  for (const interval of requestedIntervals) {
    if (currentTimestamp >= interval.start && currentTimestamp < interval.end && (interval.status === 'in-progress' || interval.status === 'done')) {
      relevantEnd = interval.end;
      relevantInterval = interval;
      break; // 當前時間戳在某個區間內，優先使用該區間的 end
    } else if (interval.start > currentTimestamp && interval.start - currentTimestamp < relevantEnd - currentTimestamp && (interval.status === 'in-progress' || interval.status === 'done')) {
      // 找到下一個最近的區間，但不包括當前時間戳在該區間內的情況
      // 比較當前時間到下一個區間的start 是否大於FETCH_DURATION_SECONDS
      // 如果是，直接fetch 以新增一個區間(包含currentTime)
      if (interval.start - currentTimestamp > FETCH_DURATION_SECONDS) {
        fetchSubtitleBatch(currentVideoId, currentTimestamp); //利用fetch 建立一個新區間
      } else {
        fetchSubtitleBatch(currentVideoId, currentTimestamp);
        relevantEnd = interval.end; // 更新 relevantEnd
      }
    }
  }

  if (relevantEnd === Infinity) {
    debugLog(`未找到與當前時間戳 ${currentTimestamp.toFixed(2)} 相關的區間，觸發預加載`);
    fetchSubtitleBatch(currentVideoId, currentTimestamp);
    return;
  }

  const distanceToEnd = relevantEnd - currentTimestamp;
  debugLog(`當前時間戳 ${currentTimestamp.toFixed(2)} 至最近區間末尾 ${relevantEnd.toFixed(2)} 的距離: ${distanceToEnd.toFixed(2)}s`);

  if (distanceToEnd < PREFETCH_THRESHOLD_SECONDS) {
    const nextStart = relevantEnd;
    const nextEnd = nextStart + FETCH_DURATION_SECONDS;
    debugLog(`距離末尾小於閾值 (${distanceToEnd.toFixed(2)}s < ${PREFETCH_THRESHOLD_SECONDS}s)，觸發預加載：從 ${nextStart.toFixed(2)} 開始請求新區間 (${nextStart.toFixed(2)} ~ ${nextEnd.toFixed(2)})`);
    fetchSubtitleBatch(currentVideoId, nextStart);
  } else {
    debugLog(`距離末尾充足 (${distanceToEnd.toFixed(2)}s >= ${PREFETCH_THRESHOLD_SECONDS}s)，不觸發預加載，相關區間: (${relevantInterval.start.toFixed(2)} ~ ${relevantInterval.end.toFixed(2)})`);
  }
}

/**
 * 向 background 請求一批字幕數據並更新緩存
 * @param {string} videoId - 視頻 ID
 * @param {number} startTimestamp - 開始時間戳 (秒)
 */
async function fetchSubtitleBatch(videoId, startTimestamp) {
  if (!videoId) {
    debugLog('無效請求: videoId 缺失');
    return;
  }
  const start = startTimestamp;
  const end = start + FETCH_DURATION_SECONDS;
  if (isIntervalRequested(start) && isIntervalRequested(end - 0.1)) {
    debugLog(`區間 ${start.toFixed(1)}~${end.toFixed(1)} 已請求過，忽略`);
    return;
  }

  // 檢查是否與現有區間重疊或接近
  let merged = false;
  for (const interval of requestedIntervals) {
    if ((start <= interval.end + 10 && end >= interval.start - 10) && (interval.status === 'in-progress' || interval.status === 'done')) {
      interval.start = Math.min(interval.start, start);
      interval.end = Math.max(interval.end, end);
      interval.status = 'in-progress';
      debugLog(`新區間 ${start.toFixed(1)}~${end.toFixed(1)} 與現有區間 ${interval.start.toFixed(1)}~${interval.end.toFixed(1)} 重疊或接近，已更新`);
      merged = true;
      break;
    }
  }

  if (!merged) {
    requestedIntervals.push({ start, end, status: 'in-progress' });
    debugLog(`新增獨立區間: ${start.toFixed(1)} ~ ${end.toFixed(1)}`);
  }

  mergeIntervals();
  debugLog(`開始請求字幕區間: ${start.toFixed(1)} ~ ${end.toFixed(1)}`);

  try {
    const response = await sendMessage({
      type: 'CHECK_SUBTITLE',
      videoId,
      timestamp: startTimestamp
    });

    if (response && response.success && Array.isArray(response.subtitles)) {
      debugLog(`從 background 收到 ${response.subtitles.length} 條字幕數據`);
      if (response.subtitles.length > 0) {
        const newSubs = response.subtitles;
        const existingTimestamps = new Set(subtitleCache.map(s => s.timestamp.toFixed(3)));
        const uniqueNewSubs = newSubs.filter(ns => !existingTimestamps.has(ns.timestamp.toFixed(3)));
        if (uniqueNewSubs.length > 0) {
          subtitleCache = [...subtitleCache, ...uniqueNewSubs];
          subtitleCache.sort((a, b) => a.timestamp - b.timestamp);
          debugLog(`緩存已更新，新增 ${uniqueNewSubs.length} 條，總數: ${subtitleCache.length}`);
          const intervalDone = requestedIntervals.find(i => i.start === start || (start >= i.start && start < i.end));
          if (intervalDone) intervalDone.status = 'done';
          limitCacheSize();
        } else {
          debugLog('收到的字幕數據在緩存中已存在，未更新緩存。');
        }
      } else {
        debugLog('從 background 收到的字幕數據為空列表。');
      }
    } else {
      console.error('從 background 獲取字幕失敗或格式錯誤:', response);
    }
  } catch (error) {
    console.error('請求字幕批次時出錯:', error);
    const intervalFail = requestedIntervals.find(i => i.start === start || (start >= i.start && start < i.end));
    if (intervalFail) intervalFail.status = 'failed';
  } finally {
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
  // 處理換行符號，轉換成 <br>
  const replacementHtml = replacementText.replace(/\n/g, '<br>');
  
  // 創建新的字幕數據對象，保留原始字幕的位置和樣式，並更新 text 和 htmlContent
  return {
    ...originalSubtitle,
    text: replacementText, // 更新純文本
    htmlContent: `<span>${replacementHtml}</span>`, // 更新 HTML 內容，保留換行
    original: originalSubtitle.text, // 保留原始文本
    isReplaced: true,
    translationID: translationID // 添加 translationID
  };
}
