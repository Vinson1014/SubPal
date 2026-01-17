// 引入配置管理系統
import { configManager } from './content/system/config/config-manager.js';
import { SUPPORTED_LANGUAGES } from './content/system/config/config-schema.js';

// 狀態變數
let isEnabled = true;
let replacementCount = 0;
let currentVideoId = '';
let isTestModeEnabled = false; // 已移除，功能不再需要
let testRules = []; // 已移除，功能不再需要
let debugMode = false; // 已移除，功能移至設定頁面

// 新增：積分、貢獻數、統計數據
let score = 0;
let contribCount = 0;
let replaceCount = 0;
let userId = '';
let translationSubmissions = 0;
let translationViews = 0;
let upvotesReceived = 0;
let subtitlesReplaced = 0;

// ===== userID 相關 =====

/**
 * 取得 userID（使用 configManager）
 * 註冊 API 範例：呼叫後端 /users，送出 userID 與 nickname
 */
function getUserId() {
    return configManager.get('user.userId');
}

/**
 * 註冊/初始化用戶到後端並獲取統計數據
 * @param {string} userId - 用戶 ID
 * @param {string} [nickname] - 暱稱
 * @returns {Promise<Object>} 回傳用戶數據
 */
async function registerUser(userId, nickname) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'POPUP_API_REQUEST',
            api: 'registerUser',
            params: { userId, nickname }
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error sending message:', chrome.runtime.lastError.message);
                reject(new Error('無法連接到背景服務'));
                return;
            }
            if (response.success) {
                resolve(response.data);
            } else {
                reject(new Error(response.error || '註冊失敗'));
            }
        });
    });
}

/**
 * 獲取用戶統計數據
 * @param {string} userId - 用戶 ID
 * @returns {Promise<Object>} 回傳用戶數據
 */
async function fetchUserStats(userId) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'POPUP_API_REQUEST',
            api: 'fetchUserStats',
            params: { userId }
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error sending message:', chrome.runtime.lastError.message);
                reject(new Error('無法連接到背景服務'));
                return;
            }
            if (response.success) {
                resolve(response.data);
            } else {
                reject(new Error(response.error || '獲取統計數據失敗'));
            }
        });
    });
}

// 遮蔽 userID 顯示（前4+****+後4）
function maskUserId(id) {
    if (!id || id.length < 8) return id;
    return id.slice(0, 4) + '****' + id.slice(-4);
}

// 複製 userID
function copyUserId() {
    if (!userId) return;
    navigator.clipboard.writeText(userId).then(() => {
        showToast('userID 已複製');
    });
}

// 重設 userID（使用 configManager）
async function resetUserId() {
    if (!confirm('確定要重設 userID？此操作無法還原。')) return;
    const newId = crypto.randomUUID();
    try {
        // 使用 configManager 設置新的 userId
        await configManager.set('user.userId', newId);
        // 清除舊的 JWT
        await new Promise((resolve) => {
            chrome.storage.local.remove('jwt', resolve);
        });
        userId = newId;
        updateUserIdUI();
        showToast('userID 已重設，請重啟瀏覽器以應用更改。');
    } catch (error) {
        console.error('[Popup] 重設 userID 失敗:', error);
        showToast('重設失敗: ' + error.message);
    }
}

// 更新 userID 顯示
function updateUserIdUI() {
    const userIdSpan = document.getElementById('user-id');
    if (userIdSpan) {
        userIdSpan.textContent = maskUserId(userId);
    }
}

// ===== ConfigManager 初始化 =====

/**
 * 初始化 configManager
 * 必須在 DOMContentLoaded 中首先調用
 */
async function initializeConfig() {
    if (!configManager.isInitialized) {
        await configManager.initialize();
        console.log('[Popup] ConfigManager 初始化完成');
    }
}

// ===== UI 更新 =====

function updateUI() {
    // 狀態條
    const statusBar = document.querySelector('.status-bar');
    const mainToggle = document.getElementById('mainToggle');
    if (statusBar && mainToggle) {
        statusBar.className = 'status-bar' + (isEnabled ? ' active' : ' inactive');
        mainToggle.checked = isEnabled;
    }

    // userID
    updateUserIdUI();

    // 積分、貢獻、替換數 (僅使用 API 回傳的統計數據)
    const scoreElement = document.getElementById('score');
    if (scoreElement) scoreElement.textContent = score;
    const contribElement = document.getElementById('contrib-count');
    if (contribElement) contribElement.textContent = contribCount;
    const replaceElement = document.getElementById('replace-count');
    if (replaceElement) replaceElement.textContent = subtitlesReplaced; // 僅使用 API 回傳值

    // 統計數據 (僅更新存在的元素)
    const viewsElement = document.getElementById('translation-views');
    if (viewsElement) viewsElement.textContent = translationViews;
    const upvotesElement = document.getElementById('upvotes-received');
    if (upvotesElement) upvotesElement.textContent = upvotesReceived;

    // 影片資訊
    const videoElement = document.getElementById('currentVideo');
    if (videoElement) videoElement.textContent = currentVideoId || '未偵測到影片';
}

// ===== Toast =====
function showToast(msg) {
    const toast = document.getElementById('success-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
}

// ===== 字幕設定卡片 =====

/**
 * 填充語言選擇下拉選單
 */
function populateLanguageSelects() {
    const primarySelect = document.getElementById('popup-primary-lang');
    const secondarySelect = document.getElementById('popup-secondary-lang');

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
}

/**
 * 初始化字幕設定卡片
 */
function initSubtitleCard() {
    // 填充語言選單
    populateLanguageSelects();

    // 獲取當前配置
    const isDualMode = configManager.get('subtitle.dualModeEnabled');
    const primaryLang = configManager.get('subtitle.primaryLanguage');
    const secondaryLang = configManager.get('subtitle.secondaryLanguage');
    const fontSize = configManager.get('subtitle.style.primary.fontSize');

    // 更新 UI
    updateSubtitleModeUI(isDualMode);

    const primarySelect = document.getElementById('popup-primary-lang');
    const secondarySelect = document.getElementById('popup-secondary-lang');
    const fontSizeSlider = document.getElementById('popup-font-size');
    const fontSizeValue = document.getElementById('popup-font-size-value');

    if (primarySelect) primarySelect.value = primaryLang;
    if (secondarySelect) secondarySelect.value = secondaryLang;
    if (fontSizeSlider) fontSizeSlider.value = fontSize;
    if (fontSizeValue) fontSizeValue.textContent = `${fontSize}px`;
}

/**
 * 更新字幕模式 UI（單語/雙語切換）
 */
function updateSubtitleModeUI(isDualMode) {
    const singleModeBtn = document.getElementById('single-mode-btn');
    const dualModeBtn = document.getElementById('dual-mode-btn');
    const secondaryRow = document.getElementById('secondary-lang-row');

    if (singleModeBtn && dualModeBtn) {
        singleModeBtn.classList.toggle('active', !isDualMode);
        dualModeBtn.classList.toggle('active', isDualMode);
    }

    if (secondaryRow) {
        secondaryRow.classList.toggle('hidden', !isDualMode);
    }
}

/**
 * 設置字幕設定卡片事件監聽器
 */
function setupSubtitleCardListeners() {
    const singleModeBtn = document.getElementById('single-mode-btn');
    const dualModeBtn = document.getElementById('dual-mode-btn');
    const primarySelect = document.getElementById('popup-primary-lang');
    const secondarySelect = document.getElementById('popup-secondary-lang');
    const fontSizeSlider = document.getElementById('popup-font-size');
    const fontSizeValue = document.getElementById('popup-font-size-value');
    const openOptionsBtn = document.getElementById('open-subtitle-options');

    // 單語模式按鈕
    if (singleModeBtn) {
        singleModeBtn.addEventListener('click', async () => {
            try {
                await configManager.set('subtitle.dualModeEnabled', false);
                updateSubtitleModeUI(false);
                showToast('已切換為單語字幕');
            } catch (error) {
                console.error('[Popup] 設置字幕模式失敗:', error);
                showToast('設置失敗');
            }
        });
    }

    // 雙語模式按鈕
    if (dualModeBtn) {
        dualModeBtn.addEventListener('click', async () => {
            try {
                await configManager.set('subtitle.dualModeEnabled', true);
                updateSubtitleModeUI(true);
                showToast('已切換為雙語字幕');
            } catch (error) {
                console.error('[Popup] 設置字幕模式失敗:', error);
                showToast('設置失敗');
            }
        });
    }

    // 主要語言選擇
    if (primarySelect) {
        primarySelect.addEventListener('change', async (e) => {
            try {
                await configManager.set('subtitle.primaryLanguage', e.target.value);
                const langName = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)?.name || e.target.value;
                showToast(`主要語言: ${langName}`);
            } catch (error) {
                console.error('[Popup] 設置主要語言失敗:', error);
                showToast('設置失敗');
            }
        });
    }

    // 次要語言選擇
    if (secondarySelect) {
        secondarySelect.addEventListener('change', async (e) => {
            try {
                await configManager.set('subtitle.secondaryLanguage', e.target.value);
                const langName = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)?.name || e.target.value;
                showToast(`次要語言: ${langName}`);
            } catch (error) {
                console.error('[Popup] 設置次要語言失敗:', error);
                showToast('設置失敗');
            }
        });
    }

    // 字幕大小滑塊
    if (fontSizeSlider && fontSizeValue) {
        fontSizeSlider.addEventListener('input', (e) => {
            fontSizeValue.textContent = `${e.target.value}px`;
        });

        fontSizeSlider.addEventListener('change', async (e) => {
            const size = parseInt(e.target.value);
            try {
                await configManager.set('subtitle.style.primary.fontSize', size);
                showToast(`字幕大小: ${size}px`);
            } catch (error) {
                console.error('[Popup] 設置字幕大小失敗:', error);
                showToast('設置失敗');
            }
        });
    }

    // 進階設定按鈕
    if (openOptionsBtn) {
        openOptionsBtn.addEventListener('click', () => {
            chrome.runtime.openOptionsPage();
        });
    }

    // 訂閱配置變更
    configManager.subscribe('subtitle.dualModeEnabled', (key, newValue) => {
        updateSubtitleModeUI(newValue);
    });

    configManager.subscribe('subtitle.primaryLanguage', (key, newValue) => {
        if (primarySelect && primarySelect.value !== newValue) {
            primarySelect.value = newValue;
        }
    });

    configManager.subscribe('subtitle.secondaryLanguage', (key, newValue) => {
        if (secondarySelect && secondarySelect.value !== newValue) {
            secondarySelect.value = newValue;
        }
    });

    configManager.subscribe('subtitle.style.primary.fontSize', (key, newValue) => {
        if (fontSizeSlider && parseInt(fontSizeSlider.value) !== newValue) {
            fontSizeSlider.value = newValue;
            if (fontSizeValue) fontSizeValue.textContent = `${newValue}px`;
        }
    });
}

// ===== 事件綁定 =====

document.addEventListener('DOMContentLoaded', async () => {
    // 1. 首先初始化 configManager
    await initializeConfig();

    // 2. 從 configManager 獲取 userId（遷移由 background.js 處理）
    userId = getUserId();
    if (!userId) {
        console.log('[Popup] userId 尚未設置，等待 updateUserData 處理');
    }

    // 3. 主動向後端請求資料並更新數據
    await updateUserData();

    // 4. 從 configManager 獲取初始設置
    getInitialSettings();

    // 5. 設置配置變更訂閱
    setupConfigSubscriptions();

    // 6. 初始化字幕設定卡片
    initSubtitleCard();
    setupSubtitleCardListeners();

    // 複製 userID
    document.getElementById('copy-userid').addEventListener('click', copyUserId);

// 主動更新用戶數據的函數
async function updateUserData() {
    try {
        // 首先嘗試註冊用戶
        let userData = await registerUser(userId, '');
        score = userData.points || 0;
        if (userData.statistics) {
            translationSubmissions = userData.statistics.translationSubmissions || 0;
            translationViews = userData.statistics.translationViews || 0;
            upvotesReceived = userData.statistics.upvotesReceived || 0;
            subtitlesReplaced = userData.statistics.subtitlesReplaced || 0;
            contribCount = translationSubmissions; // 假設累積貢獻等於提交翻譯數量
            replaceCount = subtitlesReplaced; // 已自動替換等於替換字幕數量
            console.log('註冊後更新數據 - 已自動替換:', replaceCount);
        } else {
            console.warn('後端未返回統計數據，使用預設值');
            translationSubmissions = 0;
            translationViews = 0;
            upvotesReceived = 0;
            subtitlesReplaced = 0;
            contribCount = 0;
            replaceCount = 0;
        }
        updateUI();
        // 隨後立即再次獲取最新數據
        userData = await fetchUserStats(userId);
        score = userData.points || 0;
        if (userData.statistics) {
            translationSubmissions = userData.statistics.translationSubmissions || 0;
            translationViews = userData.statistics.translationViews || 0;
            upvotesReceived = userData.statistics.upvotesReceived || 0;
            subtitlesReplaced = userData.statistics.subtitlesReplaced || 0;
            contribCount = translationSubmissions; // 假設累積貢獻等於提交翻譯數量
            replaceCount = subtitlesReplaced; // 已自動替換等於替換字幕數量
            console.log('獲取最新數據後更新 - 已自動替換:', replaceCount);
        } else {
            console.warn('後端未返回統計數據，使用預設值');
            translationSubmissions = 0;
            translationViews = 0;
            upvotesReceived = 0;
            subtitlesReplaced = 0;
            contribCount = 0;
            replaceCount = 0;
        }
        updateUI();
    } catch (e) {
        console.error('更新用戶數據失敗:', e);
        showToast('更新數據失敗: ' + e.message);
    }
}

    // 重設 userID
    document.getElementById('reset-userid').addEventListener('click', resetUserId);

    // 設定按鈕
    document.getElementById('settings-btn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // 主開關
    const mainToggle = document.getElementById('mainToggle');
    mainToggle.addEventListener('change', async (e) => {
        const newValue = e.target.checked;
        try {
            // 1. 使用 configManager 更新配置
            await configManager.set('isEnabled', newValue);
            isEnabled = newValue;
            // 2. 更新 UI
            updateUI();
            // 3. 發送消息通知 background 和 content
            chrome.runtime.sendMessage({ type: 'TOGGLE_EXTENSION', isEnabled });
        } catch (error) {
            console.error('[Popup] 設置 isEnabled 失敗:', error);
            // 回滾 UI
            e.target.checked = isEnabled;
            showToast('設置失敗: ' + error.message);
        }
    });

    // 調試模式開關已移除，功能移至設定頁面

    // 測試模式開關已移除，功能不再需要

    // 恢復 userID 功能已移至設定頁面，不再於此處處理相關事件

    /**
     * 從 configManager 獲取初始設置
     */
    function getInitialSettings() {
        try {
            isEnabled = configManager.get('isEnabled');
            currentVideoId = configManager.get('video.currentVideoId') || '';
            updateUI();
            console.log('[Popup] 已從 configManager 獲取初始設置:', { isEnabled, currentVideoId });
        } catch (error) {
            console.error('[Popup] 從 configManager 獲取初始設置失敗:', error);
            // 使用預設值
            isEnabled = true;
            currentVideoId = '';
            updateUI();
        }
    }

    /**
     * 設置配置變更訂閱
     * 響應其他頁面（如 Options Page）對配置的修改
     */
    function setupConfigSubscriptions() {
        // 訂閱 isEnabled 變更
        configManager.subscribe('isEnabled', (key, newValue, oldValue) => {
            console.log(`[Popup] ${key} 從 ${oldValue} 變更為 ${newValue}`);
            isEnabled = newValue;
            updateUI();
        });

        // 訂閱 currentVideoId 變更
        configManager.subscribe('video.currentVideoId', (key, newValue, oldValue) => {
            console.log(`[Popup] ${key} 從 ${oldValue} 變更為 ${newValue}`);
            currentVideoId = newValue || '';
            updateUI();
        });
    }

    // 監聽來自 background 的狀態更新消息 (可選，如果需要即時同步)
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'UPDATE_STATS') {
            // 更新替換計數等統計信息
            if (message.replacementCount !== undefined) {
                replaceCount = message.replacementCount;
            }
            if (message.videoId) {
                currentVideoId = message.videoId;
            }
            updateUI();
        }
        // 可以添加更多消息類型來同步其他狀態
    });

    // 定時更新統計數據 (每分鐘一次)
    setInterval(async () => {
        if (userId) {
            await updateUserData();
        }
    }, 60000);
});
