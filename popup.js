// 狀態變數
let isEnabled = true;
let replacementCount = 0;
let currentVideoId = '';
let isTestModeEnabled = false;
let testRules = [];
let debugMode = false;

// 新增：積分、貢獻數（mock）、userID
let score = 20; // mock
let contribCount = 50; // mock
let replaceCount = 12; // mock
let userId = '';

// ===== userID 相關 =====

/**
 * 取得或產生 userID
 * 註冊 API 範例：呼叫後端 /users，送出 userID 與 nickname
 */
async function getUserId() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['userID'], (result) => {
            if (result.userID) {
                resolve(result.userID);
            } else {
                const newId = crypto.randomUUID();
                chrome.storage.local.set({ userID: newId }, () => resolve(newId));
            }
        });
    });
}

import { API_BASE_URL } from './content/config.js';

/**
 * 註冊/初始化用戶到後端
 * @param {string} userID
 * @param {string} [nickname]
 * @returns {Promise<string>} 回傳 userID
 */
async function registerUser(userID, nickname) {
    try {
        const res = await fetch(`${API_BASE_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userID, nickname })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || '註冊失敗');
        }
        const data = await res.json();
        return data.userID;
    } catch (e) {
        showToast('用戶註冊失敗: ' + e.message);
        throw e;
    }
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

let restoreSectionTimeout = null;

// 重設 userID
function resetUserId() {
    if (!confirm('確定要重設 userID？此操作無法還原。\n如果想要恢復舊有ID 請先重設一次')) return;
    const newId = crypto.randomUUID();
    chrome.storage.local.set({ userID: newId }, () => {
        userId = newId;
        updateUserIdUI();
        showToast('userID 已重設');
        // 顯示恢復 userID 區塊
        showRestoreUserIdSection();
    });
}

// 顯示恢復 userID 區塊
function showRestoreUserIdSection() {
    const section = document.getElementById('restore-userid-section');
    if (section) {
        section.classList.remove('hidden');
        // 自動隱藏（如需可調整時間）
        clearTimeout(restoreSectionTimeout);
        restoreSectionTimeout = setTimeout(() => {
            section.classList.add('hidden');
            hideRestoreUserIdForm();
        }, 20000);
    }
}

// 隱藏恢復 userID 輸入表單
function hideRestoreUserIdForm() {
    const form = document.getElementById('restore-userid-form');
    if (form) form.classList.add('hidden');
    const input = document.getElementById('restore-userid-input');
    if (input) input.value = '';
}

// 展開恢復 userID 輸入表單
function showRestoreUserIdForm() {
    const form = document.getElementById('restore-userid-form');
    if (form) form.classList.remove('hidden');
    const input = document.getElementById('restore-userid-input');
    if (input) input.focus();
}

// 恢復 userID
function restoreUserId() {
    const input = document.getElementById('restore-userid-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val || val.length < 8) {
        showToast('請輸入有效的 userID');
        return;
    }
    chrome.storage.local.set({ userID: val }, () => {
        userId = val;
        updateUserIdUI();
        showToast('userID 已恢復');
        hideRestoreUserIdForm();
        // 隱藏整個區塊
        const section = document.getElementById('restore-userid-section');
        if (section) section.classList.add('hidden');
    });
}

// 更新 userID 顯示
function updateUserIdUI() {
    const userIdSpan = document.getElementById('user-id');
    if (userIdSpan) {
        userIdSpan.textContent = maskUserId(userId);
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

    // 積分、貢獻、替換數
    document.getElementById('score').textContent = score;
    document.getElementById('contrib-count').textContent = contribCount;
    document.getElementById('replace-count').textContent = replaceCount;

    // 影片資訊
    document.getElementById('currentVideo').textContent = currentVideoId || '未偵測到影片';

    // 測試/調試模式
    const debugModeToggle = document.getElementById('debugModeToggle');
    if (debugModeToggle) debugModeToggle.checked = debugMode;
    const testModeToggle = document.getElementById('testModeToggle');
    if (testModeToggle) testModeToggle.checked = isTestModeEnabled;
}

// ===== Toast =====
function showToast(msg) {
    const toast = document.getElementById('success-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 1800);
}

// ===== 事件綁定 =====

document.addEventListener('DOMContentLoaded', async () => {
    // 取得 userID
    userId = await getUserId();
    // 註冊/初始化用戶到後端（可選 nickname，這裡以空字串為例）
    try {
        await registerUser(userId, '');
    } catch (e) {
        // 已於 registerUser 顯示錯誤
    }
    updateUserIdUI();

    // 複製 userID
    document.getElementById('copy-userid').addEventListener('click', copyUserId);

    // 重設 userID
    document.getElementById('reset-userid').addEventListener('click', resetUserId);

    // 主開關
    const mainToggle = document.getElementById('mainToggle');
    mainToggle.addEventListener('change', (e) => {
        isEnabled = e.target.checked;
        // 1. 更新本地存儲
        chrome.storage.local.set({ isEnabled });
        // 2. 更新 UI
        updateUI();
        // 3. 發送消息通知 background 和 content
        chrome.runtime.sendMessage({ type: 'TOGGLE_EXTENSION', isEnabled });
    });

    // 調試模式開關
    const debugModeToggle = document.getElementById('debugModeToggle');
    debugModeToggle.addEventListener('change', (e) => {
        debugMode = e.target.checked;
        // 1. 更新本地存儲
        chrome.storage.local.set({ debugMode });
        // 2. 更新 UI
        updateUI();
        // 3. 發送消息通知 background 和 content
        chrome.runtime.sendMessage({ type: 'TOGGLE_DEBUG_MODE', debugMode });
    });

    // 測試模式開關 (保留原有邏輯，如果需要同步也需添加 sendMessage)
    const testModeToggle = document.getElementById('testModeToggle');
    testModeToggle.addEventListener('change', (e) => {
        isTestModeEnabled = e.target.checked;
        chrome.storage.local.set({ isTestModeEnabled });
        updateUI();
        // 如果需要，添加: chrome.runtime.sendMessage({ type: 'TOGGLE_TEST_MODE', isTestModeEnabled });
    });

    // 恢復 userID 相關事件
    const restoreSection = document.getElementById('restore-userid-section');
    const showRestoreLink = document.getElementById('show-restore-userid-link');
    const restoreForm = document.getElementById('restore-userid-form');
    const restoreBtn = document.getElementById('restore-userid-btn');
    const restoreInput = document.getElementById('restore-userid-input');
    if (showRestoreLink) {
        showRestoreLink.addEventListener('click', (e) => {
            e.preventDefault();
            showRestoreUserIdForm();
        });
    }
    if (restoreBtn) {
        restoreBtn.addEventListener('click', restoreUserId);
    }
    if (restoreInput) {
        restoreInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') restoreUserId();
        });
    }

    // 初始化時從 background 獲取最新狀態
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS', keys: ['isEnabled', 'debugMode', 'isTestModeEnabled', 'currentVideoId', 'replacementCount'] }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('無法從 background 獲取初始設置:', chrome.runtime.lastError.message);
            // 使用本地存儲作為備用
            chrome.storage.local.get(['isEnabled', 'debugMode', 'isTestModeEnabled', 'currentVideoId', 'replacementCount'], (localResult) => {
                isEnabled = localResult.isEnabled !== undefined ? localResult.isEnabled : true;
                debugMode = localResult.debugMode || false;
                isTestModeEnabled = localResult.isTestModeEnabled || false;
                currentVideoId = localResult.currentVideoId || '';
                replaceCount = localResult.replacementCount || 0;
                updateUI();
            });
        } else if (response && response.success) {
            console.log('從 background 獲取初始設置:', response);
            isEnabled = response.isEnabled !== undefined ? response.isEnabled : true; // 預設啟用
            debugMode = response.debugMode || false;
            isTestModeEnabled = response.isTestModeEnabled || false;
            currentVideoId = response.currentVideoId || '';
            replaceCount = response.replacementCount || 0;
            updateUI(); // 使用從 background 獲取的最新狀態更新 UI
        } else {
            console.warn('從 background 獲取初始設置失敗:', response?.error);
            // 處理失敗情況，例如使用預設值或本地存儲
            chrome.storage.local.get(['isEnabled', 'debugMode', 'isTestModeEnabled', 'currentVideoId', 'replacementCount'], (localResult) => {
                isEnabled = localResult.isEnabled !== undefined ? localResult.isEnabled : true;
                debugMode = localResult.debugMode || false;
                isTestModeEnabled = localResult.isTestModeEnabled || false;
                currentVideoId = localResult.currentVideoId || '';
                replaceCount = localResult.replacementCount || 0;
                updateUI();
            });
        }
    });

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

    // 其他初始化（積分、貢獻可從 server 取得，這裡先 mock）
    // updateUI(); // 移到獲取設置後再調用
});
