/**
 * SubPal Options Page
 *
 * 使用 config-schema.js 作為配置的單一真相來源
 * 直接讀寫 chrome.storage.local，使用扁平化鍵名
 */

import {
  SUPPORTED_LANGUAGES,
  getDefaultValues
} from './content/system/config/config-schema.js';

// ==================== 配置管理 ====================

// 從 config-schema.js 獲取預設值
const DEFAULT_CONFIG = getDefaultValues();

/**
 * 從嵌套對象中獲取值（支援點記法）
 * @param {Object} obj - 嵌套對象
 * @param {string} path - 點記法路徑
 * @returns {any} 值或 undefined
 */
function getNestedValue(obj, path) {
  const keys = path.split('.');
  let value = obj;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return undefined;
    }
  }

  return value;
}

/**
 * 載入所有配置
 * 從嵌套結構的 storage 中讀取，轉換為扁平化鍵的配置對象
 * @returns {Promise<Object>} 配置對象（扁平化鍵）
 */
async function loadConfig() {
  // 獲取所有根鍵
  const flatKeys = Object.keys(DEFAULT_CONFIG);
  const rootKeys = [...new Set(flatKeys.map(k => k.split('.')[0]))];

  // 從 storage 讀取根鍵對應的數據
  const result = await chrome.storage.local.get(rootKeys);

  // 將嵌套結構轉換為扁平化鍵
  const config = {};
  for (const flatKey of flatKeys) {
    const value = getNestedValue(result, flatKey);
    config[flatKey] = value !== undefined ? value : DEFAULT_CONFIG[flatKey];
  }

  return config;
}

/**
 * 將扁平化鍵轉換為嵌套對象結構
 * 例如: { 'subtitle.primaryLanguage': 'en' } → { subtitle: { primaryLanguage: 'en' } }
 * @param {Object} flatItems - 扁平化的配置對象
 * @returns {Object} 嵌套結構的配置對象
 */
function flatToNested(flatItems) {
  const nested = {};

  for (const [key, value] of Object.entries(flatItems)) {
    const keys = key.split('.');
    const lastKey = keys.pop();
    let current = nested;

    for (const k of keys) {
      if (!(k in current)) {
        current[k] = {};
      }
      current = current[k];
    }

    current[lastKey] = value;
  }

  return nested;
}

/**
 * 深度合併兩個對象
 * 確保 Chrome Storage API 的淺合併不會丟失嵌套配置
 * @param {Object} existing - 現有配置
 * @param {Object} updates - 要更新的配置
 * @returns {Object} 合併後的配置
 */
function deepMerge(existing, updates) {
  const result = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      key in result &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // 遞歸合併嵌套對象
      result[key] = deepMerge(result[key], value);
    } else {
      // 直接覆蓋（非對象或數組）
      result[key] = value;
    }
  }

  return result;
}

/**
 * 保存單個配置項
 * 使用深度合併避免 Chrome Storage API 淺合併導致的數據丟失
 * @param {string} key - 配置鍵（支援點記法）
 * @param {any} value - 配置值
 */
async function saveConfig(key, value) {
  // 將扁平化鍵轉換為嵌套結構
  const nested = flatToNested({ [key]: value });

  // 提取根鍵
  const rootKey = key.split('.')[0];

  // 讀取現有配置
  const existing = await chrome.storage.local.get([rootKey]);

  // 深度合併
  const merged = deepMerge(existing, nested);

  // 寫入合併後的數據
  await chrome.storage.local.set(merged);
  console.log(`[Options] 配置已保存: ${key} =`, value);
}

/**
 * 批量保存配置
 * 使用深度合併避免 Chrome Storage API 淺合併導致的數據丟失
 * @param {Object} items - 配置對象（支援點記法鍵）
 */
async function saveConfigMultiple(items) {
  // 將扁平化鍵轉換為嵌套結構
  const nested = flatToNested(items);

  // 提取所有根鍵
  const rootKeys = [...new Set(Object.keys(items).map(k => k.split('.')[0]))];

  // 讀取現有配置
  const existing = await chrome.storage.local.get(rootKeys);

  // 深度合併
  const merged = deepMerge(existing, nested);

  // 寫入合併後的數據
  await chrome.storage.local.set(merged);
  console.log(`[Options] 批量保存 ${Object.keys(items).length} 個配置`);
}

// ==================== Background 通訊 ====================

let backgroundPort = null;

/**
 * 發送消息到 background script
 * 用於清空隊列等需要 background 處理的操作
 */
function sendMessageToBackground(messageType, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!backgroundPort) {
      console.error('Background port not connected.');
      return reject(new Error('Background port not connected.'));
    }

    const messageId = Date.now() + Math.random().toString(36).substring(2, 7);
    const message = { type: messageType, ...payload };

    const timeout = setTimeout(() => {
      backgroundPort.onMessage.removeListener(onResponse);
      reject(new Error(`Message timeout: ${messageType}`));
    }, 10000);

    const onResponse = (responseMessage) => {
      if (responseMessage.messageId === messageId) {
        clearTimeout(timeout);
        backgroundPort.onMessage.removeListener(onResponse);

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

// ==================== UI 更新函數 ====================

/**
 * 恢復 UI 狀態
 */
async function restoreOptionsUI() {
  try {
    const config = await loadConfig();
    console.log('[Options] 載入配置:', config);

    // Debug Mode
    const debugModeCheckbox = document.getElementById('debugModeCheckbox');
    if (debugModeCheckbox) {
      debugModeCheckbox.checked = config['debugMode'];
    }

    // API URL
    const apiBaseUrlInput = document.getElementById('apiBaseUrlInput');
    if (apiBaseUrlInput) {
      apiBaseUrlInput.value = config['api.baseUrl'];
    }

    // 字幕模式
    const isDualMode = config['subtitle.dualModeEnabled'];
    const singleModeRadio = document.getElementById('singleMode');
    const dualModeRadio = document.getElementById('dualMode');
    if (singleModeRadio && dualModeRadio) {
      singleModeRadio.checked = !isDualMode;
      dualModeRadio.checked = isDualMode;
    }

    // 語言設定
    const primaryLanguageSelect = document.getElementById('primaryLanguageSelect');
    const secondaryLanguageSelect = document.getElementById('secondaryLanguageSelect');
    if (primaryLanguageSelect) {
      primaryLanguageSelect.value = config['subtitle.primaryLanguage'];
    }
    if (secondaryLanguageSelect) {
      secondaryLanguageSelect.value = config['subtitle.secondaryLanguage'];
    }

    // 主要字幕樣式
    updateStyleControls('primary', {
      fontSize: config['subtitle.style.primary.fontSize'],
      textColor: config['subtitle.style.primary.textColor'],
      backgroundColor: config['subtitle.style.primary.backgroundColor']
    });

    // 次要字幕樣式
    updateStyleControls('secondary', {
      fontSize: config['subtitle.style.secondary.fontSize'],
      textColor: config['subtitle.style.secondary.textColor'],
      backgroundColor: config['subtitle.style.secondary.backgroundColor']
    });

    // 更新 UI 顯示狀態
    updateSubtitleModeUI(isDualMode);
    updatePreview(config);

  } catch (error) {
    console.error('[Options] 載入配置失敗:', error);
  }
}

/**
 * 更新樣式控制項
 */
function updateStyleControls(type, styleConfig) {
  const fontSizeSlider = document.getElementById(`${type}FontSize`);
  const fontSizeValue = document.getElementById(`${type}FontSizeValue`);
  const textColorPicker = document.getElementById(`${type}TextColor`);
  const textColorHex = document.getElementById(`${type}TextColorHex`);
  const backgroundColorPicker = document.getElementById(`${type}BackgroundColor`);
  const backgroundColorHex = document.getElementById(`${type}BackgroundColorHex`);
  const backgroundOpacitySlider = document.getElementById(`${type}BackgroundOpacity`);
  const backgroundOpacityValue = document.getElementById(`${type}BackgroundOpacityValue`);

  if (fontSizeSlider && fontSizeValue) {
    fontSizeSlider.value = styleConfig.fontSize;
    fontSizeValue.textContent = styleConfig.fontSize;
  }

  if (textColorPicker) {
    textColorPicker.value = styleConfig.textColor;
    if (textColorHex) {
      textColorHex.textContent = styleConfig.textColor;
    }
  }

  if (backgroundColorPicker && backgroundOpacitySlider && backgroundOpacityValue) {
    const { hex, opacity } = parseRgba(styleConfig.backgroundColor);
    backgroundColorPicker.value = hex;
    backgroundOpacitySlider.value = opacity;
    backgroundOpacityValue.textContent = opacity.toFixed(2);
    if (backgroundColorHex) {
      backgroundColorHex.textContent = hex;
    }
  }
}

/**
 * 更新字幕模式 UI（顯示/隱藏雙語相關元素）
 * 主要語言選擇器始終顯示，次要語言相關元素只在雙語模式時顯示
 */
function updateSubtitleModeUI(isDualMode) {
  const secondaryLanguageGroup = document.getElementById('secondaryLanguageGroup');
  const secondaryStyleSection = document.getElementById('secondaryStyleSection');
  const secondaryPreview = document.getElementById('secondaryPreview');

  if (secondaryLanguageGroup) {
    secondaryLanguageGroup.style.display = isDualMode ? 'flex' : 'none';
  }
  if (secondaryStyleSection) {
    secondaryStyleSection.style.display = isDualMode ? 'block' : 'none';
  }
  if (secondaryPreview) {
    secondaryPreview.style.display = isDualMode ? 'inline-block' : 'none';
  }
}

/**
 * 更新預覽
 */
async function updatePreview(config = null) {
  if (!config) {
    config = await loadConfig();
  }

  const primaryPreview = document.getElementById('primaryPreview');
  const secondaryPreview = document.getElementById('secondaryPreview');

  if (primaryPreview) {
    applyPreviewStyles(primaryPreview, {
      fontSize: config['subtitle.style.primary.fontSize'],
      textColor: config['subtitle.style.primary.textColor'],
      backgroundColor: config['subtitle.style.primary.backgroundColor']
    });
  }

  if (secondaryPreview && config['subtitle.dualModeEnabled']) {
    applyPreviewStyles(secondaryPreview, {
      fontSize: config['subtitle.style.secondary.fontSize'],
      textColor: config['subtitle.style.secondary.textColor'],
      backgroundColor: config['subtitle.style.secondary.backgroundColor']
    });
  }
}

/**
 * 應用預覽樣式
 */
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

/**
 * 動態生成語言選項
 */
function populateLanguageSelects() {
  const primarySelect = document.getElementById('primaryLanguageSelect');
  const secondarySelect = document.getElementById('secondaryLanguageSelect');

  if (primarySelect) {
    primarySelect.innerHTML = '';
    for (const lang of SUPPORTED_LANGUAGES) {
      primarySelect.add(new Option(lang.name, lang.code));
    }
  }

  if (secondarySelect) {
    secondarySelect.innerHTML = '';
    for (const lang of SUPPORTED_LANGUAGES) {
      secondarySelect.add(new Option(lang.name, lang.code));
    }
  }

  console.log(`[Options] 已載入 ${SUPPORTED_LANGUAGES.length} 種語言選項`);
}

// ==================== Tab 切換邏輯 ====================

/**
 * 設置 Tab 導航切換
 */
function setupTabNavigation() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;

      // 更新按鈕狀態
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // 更新面板顯示
      tabPanels.forEach(panel => {
        panel.classList.remove('active');
        if (panel.id === `${targetTab}-panel`) {
          panel.classList.add('active');
        }
      });
    });
  });
}

// ==================== 事件監聽器設置 ====================

/**
 * 設置所有事件監聽器
 */
function setupEventListeners() {
  // Debug Mode
  const debugModeCheckbox = document.getElementById('debugModeCheckbox');
  if (debugModeCheckbox) {
    debugModeCheckbox.addEventListener('change', async (e) => {
      await saveConfig('debugMode', e.target.checked);
    });
  }

  // API URL
  const apiBaseUrlInput = document.getElementById('apiBaseUrlInput');
  if (apiBaseUrlInput) {
    apiBaseUrlInput.addEventListener('change', async (e) => {
      await saveConfig('api.baseUrl', e.target.value);
    });
  }

  // 字幕模式切換
  const singleModeRadio = document.getElementById('singleMode');
  const dualModeRadio = document.getElementById('dualMode');

  if (singleModeRadio) {
    singleModeRadio.addEventListener('change', async () => {
      if (singleModeRadio.checked) {
        await saveConfig('subtitle.dualModeEnabled', false);
        updateSubtitleModeUI(false);
        // 不需要調用 updatePreview()，因為樣式沒變，只是顯示/隱藏元素
      }
    });
  }

  if (dualModeRadio) {
    dualModeRadio.addEventListener('change', async () => {
      if (dualModeRadio.checked) {
        await saveConfig('subtitle.dualModeEnabled', true);
        updateSubtitleModeUI(true);
        // 不需要調用 updatePreview()，因為樣式沒變，只是顯示/隱藏元素
      }
    });
  }

  // 語言選擇器
  const primaryLanguageSelect = document.getElementById('primaryLanguageSelect');
  const secondaryLanguageSelect = document.getElementById('secondaryLanguageSelect');

  if (primaryLanguageSelect) {
    primaryLanguageSelect.addEventListener('change', async (e) => {
      await saveConfig('subtitle.primaryLanguage', e.target.value);
    });
  }

  if (secondaryLanguageSelect) {
    secondaryLanguageSelect.addEventListener('change', async (e) => {
      await saveConfig('subtitle.secondaryLanguage', e.target.value);
    });
  }

  // 主要字幕樣式控制項
  setupStyleControlListeners('primary', 'subtitle.style.primary');

  // 次要字幕樣式控制項
  setupStyleControlListeners('secondary', 'subtitle.style.secondary');

  // 重置樣式按鈕
  const resetStylesBtn = document.getElementById('resetStyles');
  if (resetStylesBtn) {
    resetStylesBtn.addEventListener('click', resetStyles);
  }

  // 備份按鈕
  const backupDataButton = document.getElementById('backupDataButton');
  if (backupDataButton) {
    backupDataButton.addEventListener('click', backupData);
  }

  // 恢復按鈕
  const restoreDataButton = document.getElementById('restoreDataButton');
  const restoreDataInput = document.getElementById('restoreDataInput');
  const selectedFileName = document.getElementById('selectedFileName');
  if (restoreDataButton && restoreDataInput) {
    // 監聽檔案選擇變化，顯示選中的檔案名
    restoreDataInput.addEventListener('change', () => {
      if (selectedFileName) {
        if (restoreDataInput.files.length > 0) {
          selectedFileName.textContent = restoreDataInput.files[0].name;
          selectedFileName.classList.add('has-file');
        } else {
          selectedFileName.textContent = '';
          selectedFileName.classList.remove('has-file');
        }
      }
    });

    restoreDataButton.addEventListener('click', () => {
      if (restoreDataInput.files.length > 0) {
        restoreData(restoreDataInput.files[0]);
      } else {
        alert('請選擇一個備份檔案');
      }
    });
  }

  // 清空隊列按鈕
  setupClearQueueButtons();
}

/**
 * 設置樣式控制項監聽器
 * 直接更新預覽元素樣式，實現真正的即時預覽
 */
function setupStyleControlListeners(type, keyPrefix) {
  const fontSizeSlider = document.getElementById(`${type}FontSize`);
  const fontSizeValue = document.getElementById(`${type}FontSizeValue`);
  const textColorPicker = document.getElementById(`${type}TextColor`);
  const textColorHex = document.getElementById(`${type}TextColorHex`);
  const backgroundColorPicker = document.getElementById(`${type}BackgroundColor`);
  const backgroundColorHex = document.getElementById(`${type}BackgroundColorHex`);
  const backgroundOpacitySlider = document.getElementById(`${type}BackgroundOpacity`);
  const backgroundOpacityValue = document.getElementById(`${type}BackgroundOpacityValue`);
  const preview = document.getElementById(`${type}Preview`);

  if (fontSizeSlider && fontSizeValue) {
    fontSizeSlider.addEventListener('input', async (e) => {
      const size = parseInt(e.target.value);
      fontSizeValue.textContent = size;
      // 即時更新預覽
      if (preview) {
        preview.style.fontSize = `${size}px`;
      }
      // 異步保存配置
      await saveConfig(`${keyPrefix}.fontSize`, size);
    });
  }

  if (textColorPicker) {
    textColorPicker.addEventListener('input', (e) => {
      // 即時更新預覽
      if (preview) {
        preview.style.color = e.target.value;
      }
      // 更新 hex 顯示
      if (textColorHex) {
        textColorHex.textContent = e.target.value;
      }
    });
    textColorPicker.addEventListener('change', async (e) => {
      // 異步保存配置
      await saveConfig(`${keyPrefix}.textColor`, e.target.value);
    });
  }

  if (backgroundColorPicker && backgroundOpacitySlider && backgroundOpacityValue) {
    const updateBackgroundColor = async (shouldSave = true) => {
      const hex = backgroundColorPicker.value;
      const opacity = parseFloat(backgroundOpacitySlider.value);
      const rgba = toRgba(hex, opacity);
      // 即時更新預覽
      if (preview) {
        preview.style.backgroundColor = rgba;
      }
      // 更新 hex 顯示
      if (backgroundColorHex) {
        backgroundColorHex.textContent = hex;
      }
      // 異步保存配置
      if (shouldSave) {
        await saveConfig(`${keyPrefix}.backgroundColor`, rgba);
      }
    };

    backgroundColorPicker.addEventListener('input', () => updateBackgroundColor(false));
    backgroundColorPicker.addEventListener('change', () => updateBackgroundColor(true));

    backgroundOpacitySlider.addEventListener('input', async (e) => {
      const opacity = parseFloat(e.target.value);
      backgroundOpacityValue.textContent = opacity.toFixed(2);
      await updateBackgroundColor(true);
    });
  }
}

/**
 * 設置清空隊列按鈕
 */
function setupClearQueueButtons() {
  const clearVoteQueueButton = document.getElementById('clearVoteQueueButton');
  const clearTranslationQueueButton = document.getElementById('clearTranslationQueueButton');
  const clearReplacementEventsQueueButton = document.getElementById('clearReplacementEventsQueueButton');

  if (clearVoteQueueButton) {
    clearVoteQueueButton.addEventListener('click', async () => {
      if (confirm('確定要清空投票隊列嗎？此操作不可撤銷。')) {
        try {
          await sendMessageToBackground('CLEAR_QUEUE', { queueType: 'voteQueue' });
          alert('投票隊列已清空。');
          updatePendingDataUI();
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
          updatePendingDataUI();
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
          updatePendingDataUI();
        } catch (error) {
          console.error('Error clearing replacement events queue:', error);
          alert('清空替換事件隊列失敗：' + error.message);
        }
      }
    });
  }
}

// ==================== 樣式操作 ====================

/**
 * 重置樣式為預設值
 */
async function resetStyles() {
  if (!confirm('確定要重置所有樣式設定嗎？')) {
    return;
  }

  const defaultStyleConfig = {
    'subtitle.dualModeEnabled': DEFAULT_CONFIG['subtitle.dualModeEnabled'],
    'subtitle.primaryLanguage': DEFAULT_CONFIG['subtitle.primaryLanguage'],
    'subtitle.secondaryLanguage': DEFAULT_CONFIG['subtitle.secondaryLanguage'],
    'subtitle.style.primary.fontSize': DEFAULT_CONFIG['subtitle.style.primary.fontSize'],
    'subtitle.style.primary.textColor': DEFAULT_CONFIG['subtitle.style.primary.textColor'],
    'subtitle.style.primary.backgroundColor': DEFAULT_CONFIG['subtitle.style.primary.backgroundColor'],
    'subtitle.style.secondary.fontSize': DEFAULT_CONFIG['subtitle.style.secondary.fontSize'],
    'subtitle.style.secondary.textColor': DEFAULT_CONFIG['subtitle.style.secondary.textColor'],
    'subtitle.style.secondary.backgroundColor': DEFAULT_CONFIG['subtitle.style.secondary.backgroundColor']
  };

  await saveConfigMultiple(defaultStyleConfig);
  await restoreOptionsUI();
  console.log('[Options] 樣式已重置為預設值');
}

// ==================== 備份/恢復功能 ====================

/**
 * 備份資料
 */
async function backupData() {
  try {
    // 提取根鍵（與 loadConfig 相同邏輯）
    const flatKeys = Object.keys(DEFAULT_CONFIG);
    const rootKeys = [...new Set(flatKeys.map(k => k.split('.')[0]))];

    // 從 storage 讀取完整的嵌套結構
    const result = await chrome.storage.local.get(rootKeys);

    const backupData = {
      version: '3.0',
      backupDate: new Date().toISOString(),
      config: result
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subpal_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alert('資料已成功備份');
  } catch (error) {
    console.error('[Options] 備份失敗:', error);
    alert('備份失敗：' + error.message);
  }
}

/**
 * 恢復資料
 */
function restoreData(file) {
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const backupData = JSON.parse(event.target.result);

      if (backupData.version === '3.0') {
        // v3.0 格式：直接寫入
        await chrome.storage.local.set(backupData.config);
        alert('資料已成功恢復');
        await restoreOptionsUI();
      } else if (backupData.version === '2.0' || (backupData.userID && backupData.settings)) {
        // v2.0 或舊格式：嘗試轉換
        alert('偵測到舊版本備份格式。\n\n由於配置結構已更新，部分設定可能無法完全恢復。\n建議手動重新設定。');
      } else {
        alert('不支援的備份檔案格式');
      }
    } catch (e) {
      console.error('[Options] 恢復失敗:', e);
      alert('備份檔案解析失敗：' + e.message);
    }
  };
  reader.onerror = () => {
    alert('讀取備份檔案失敗');
  };
  reader.readAsText(file);
}

// ==================== 待同步數據 UI ====================

/**
 * 更新待同步數據 UI
 */
async function updatePendingDataUI() {
  try {
    const result = await chrome.storage.local.get(['voteQueue', 'translationQueue', 'replacementEvents']);

    const voteQueueCount = document.getElementById('voteQueueCount');
    const translationQueueCount = document.getElementById('translationQueueCount');
    const replacementEventsQueueCount = document.getElementById('replacementEventsQueueCount');

    if (voteQueueCount) {
      voteQueueCount.textContent = (result.voteQueue || []).length;
    }
    if (translationQueueCount) {
      translationQueueCount.textContent = (result.translationQueue || []).length;
    }
    if (replacementEventsQueueCount) {
      replacementEventsQueueCount.textContent = (result.replacementEvents || []).length;
    }
  } catch (error) {
    console.error('[Options] 更新待同步數據 UI 失敗:', error);
  }
}

// ==================== 工具函數 ====================

/**
 * RGBA 轉 Hex + Opacity
 */
function parseRgba(rgba) {
  const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) {
    return { hex: '#000000', opacity: 1 };
  }

  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  const opacity = match[4] ? parseFloat(match[4]) : 1;

  return { hex: `#${r}${g}${b}`, opacity };
}

/**
 * Hex + Opacity 轉 RGBA
 */
function toRgba(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// ==================== 初始化 ====================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Options] 頁面載入中...');

  // 顯示版本號（從 manifest.json 動態讀取）
  const manifest = chrome.runtime.getManifest();
  const versionElement = document.getElementById('appVersion');
  if (versionElement && manifest.version) {
    versionElement.textContent = `v${manifest.version}`;
  }

  // 建立與 background script 的連接（用於清空隊列等操作）
  try {
    backgroundPort = chrome.runtime.connect({ name: 'options-page-channel' });
    backgroundPort.onDisconnect.addListener(() => {
      console.warn('[Options] Background port disconnected.');
      backgroundPort = null;
    });
  } catch (error) {
    console.warn('[Options] 無法連接到 background script:', error);
  }

  // 設置 Tab 導航
  setupTabNavigation();

  // 動態生成語言選項
  populateLanguageSelects();

  // 設置事件監聯器
  setupEventListeners();

  // 恢復 UI 狀態
  await restoreOptionsUI();

  // 更新待同步數據 UI
  await updatePendingDataUI();

  console.log('[Options] 頁面初始化完成');
});
