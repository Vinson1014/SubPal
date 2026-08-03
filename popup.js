// 引入配置管理系統
import { configManager } from './content/system/config/config-manager.js';
import { SUPPORTED_LANGUAGES } from './content/system/config/config-schema.js';

let isEnabled = true;
let activeProfileUserMask = '--';
let activeProfileTotals = createEmptyProfileTotals();
let activeProfileStatsRequest = null;

const POPUP_ACTIVE_PROFILE_STATS_REQUEST = Object.freeze({ type: 'POPUP_ACTIVE_PROFILE_STATS' });
const POPUP_ACTIVE_PROFILE_STATS_RESULT = 'POPUP_ACTIVE_PROFILE_STATS_RESULT';
const POPUP_STATS_TIMEOUT_MS = 5000;
const ACTIVE_PROFILE_STATS_SCOPE = 'active-backend-profile-user';
const PROFILE_TOTAL_KEYS = Object.freeze([
    'points',
    'translationSubmissions',
    'translationViews',
    'upvotesReceived',
    'subtitlesReplaced'
]);

function createEmptyProfileTotals() {
    return {
        points: 0,
        translationSubmissions: 0,
        translationViews: 0,
        upvotesReceived: 0,
        subtitlesReplaced: 0
    };
}

function isRecord(value) {
    try {
        return Boolean(value) &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.prototype.toString.call(value) === '[object Object]';
    } catch (_error) {
        return false;
    }
}

function normalizeProfileTotal(value) {
    const total = Number(value);
    return Number.isFinite(total) && total >= 0 ? total : 0;
}

function createProfileStatsFailure(kind, code, retryable) {
    return { ok: false, error: { kind, code, retryable } };
}

function isMaskedIdentity(value) {
    return typeof value === 'string' && (value.includes('...') || value.includes('****'));
}

function normalizeActiveProfileStatsResult(result) {
    try {
        if (!isRecord(result) || typeof result.ok !== 'boolean') {
            return createProfileStatsFailure('domain-rejected', 'popup-stats-response', false);
        }

        if (!result.ok) {
            const error = result.error;
            if (
                !isRecord(error) ||
                typeof error.kind !== 'string' ||
                typeof error.code !== 'string' ||
                typeof error.retryable !== 'boolean'
            ) {
                return createProfileStatsFailure('domain-rejected', 'popup-stats-response', false);
            }
            return createProfileStatsFailure(error.kind, error.code, error.retryable);
        }

        const value = result.value;
        if (
            !isRecord(value) ||
            value.scope !== ACTIVE_PROFILE_STATS_SCOPE ||
            !isMaskedIdentity(value.userIdMasked) ||
            !isRecord(value.totals)
        ) {
            return createProfileStatsFailure('domain-rejected', 'popup-stats-response', false);
        }

        const totals = createEmptyProfileTotals();
        for (const key of PROFILE_TOTAL_KEYS) {
            totals[key] = normalizeProfileTotal(value.totals[key]);
        }

        return { ok: true, value: { userIdMasked: value.userIdMasked, totals } };
    } catch (_error) {
        return createProfileStatsFailure('domain-rejected', 'popup-stats-response', false);
    }
}

function applyActiveProfileStatsResult(result) {
    if (!result.ok) {
        showToast('無法取得設定檔貢獻統計資料。');
        return;
    }

    activeProfileUserMask = result.value.userIdMasked;
    activeProfileTotals = result.value.totals;
    updateUI();
}

function requestActiveProfileStats() {
    if (activeProfileStatsRequest) {
        return;
    }

    const request = { settled: false, timeoutId: null, settle: null };
    const settle = (result) => {
        if (request.settled || activeProfileStatsRequest !== request) {
            return;
        }

        request.settled = true;
        clearTimeout(request.timeoutId);
        activeProfileStatsRequest = null;
        applyActiveProfileStatsResult(normalizeActiveProfileStatsResult(result));
    };

    request.settle = settle;
    activeProfileStatsRequest = request;
    request.timeoutId = setTimeout(() => {
        settle(createProfileStatsFailure('timeout', 'popup-stats-timeout', true));
    }, POPUP_STATS_TIMEOUT_MS);

    try {
        chrome.runtime.sendMessage(POPUP_ACTIVE_PROFILE_STATS_REQUEST, (response) => {
            if (chrome.runtime.lastError) {
                settle(createProfileStatsFailure('disconnected', 'background-runtime-disconnected', true));
                return;
            }
            settle(response);
        });
    } catch (_error) {
        settle(createProfileStatsFailure('disconnected', 'background-runtime-disconnected', true));
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

    const profileUserElement = document.getElementById('profile-user-id');
    if (profileUserElement) profileUserElement.textContent = activeProfileUserMask;

    const scoreElement = document.getElementById('score');
    if (scoreElement) scoreElement.textContent = activeProfileTotals.points;
    const contribElement = document.getElementById('contrib-count');
    if (contribElement) contribElement.textContent = activeProfileTotals.translationSubmissions;
    const replaceElement = document.getElementById('replace-count');
    if (replaceElement) replaceElement.textContent = activeProfileTotals.subtitlesReplaced;

    const viewsElement = document.getElementById('translation-views');
    if (viewsElement) viewsElement.textContent = activeProfileTotals.translationViews;
    const upvotesElement = document.getElementById('upvotes-received');
    if (upvotesElement) upvotesElement.textContent = activeProfileTotals.upvotesReceived;
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
    const openTutorialBtn = document.getElementById('open-tutorial');

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

    // 使用教學入口
    if (openTutorialBtn) {
        openTutorialBtn.addEventListener('click', () => {
            const tutorialUrl = chrome.runtime.getURL('tutorial.html');
            if (chrome.tabs?.create) {
                chrome.tabs.create({ url: tutorialUrl });
            } else {
                window.open(tutorialUrl, '_blank');
            }
        });
    }

    // 訂閱配置變更
    configManager.subscribe('subtitle.dualModeEnabled', (_key, newValue) => {
        updateSubtitleModeUI(newValue);
    });

    configManager.subscribe('subtitle.primaryLanguage', (_key, newValue) => {
        if (primarySelect && primarySelect.value !== newValue) {
            primarySelect.value = newValue;
        }
    });

    configManager.subscribe('subtitle.secondaryLanguage', (_key, newValue) => {
        if (secondarySelect && secondarySelect.value !== newValue) {
            secondarySelect.value = newValue;
        }
    });

    configManager.subscribe('subtitle.style.primary.fontSize', (_key, newValue) => {
        if (fontSizeSlider && parseInt(fontSizeSlider.value) !== newValue) {
            fontSizeSlider.value = newValue;
            if (fontSizeValue) fontSizeValue.textContent = `${newValue}px`;
        }
    });
}

// ===== 事件綁定 =====

document.addEventListener('DOMContentLoaded', async () => {
    await initializeConfig();

    getInitialSettings();
    setupConfigSubscriptions();
    initSubtitleCard();
    setupSubtitleCardListeners();

    // 設定按鈕
    document.getElementById('settings-btn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // 主開關
    const mainToggle = document.getElementById('mainToggle');
    mainToggle.addEventListener('change', async (e) => {
        const newValue = e.target.checked;
        try {
            // 1. 使用 configManager 更新配置（content 側透過 ConfigBridge 訂閱偵測）
            await configManager.set('isEnabled', newValue);
            isEnabled = newValue;
            // 2. 更新 UI
            updateUI();
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
            updateUI();
        } catch (error) {
            console.error('[Popup] 從 configManager 獲取初始設置失敗:', error);
            isEnabled = true;
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

    }

    chrome.runtime.onMessage.addListener((message) => {
        try {
            if (isRecord(message) && message.type === POPUP_ACTIVE_PROFILE_STATS_RESULT) {
                activeProfileStatsRequest?.settle(message.result);
            }
        } catch (_error) {
            return false;
        }
        return false;
    });

    requestActiveProfileStats();
    setInterval(requestActiveProfileStats, 60000);
});
