// 擴充功能狀態
let isEnabled = true;
let replacementCount = 0;
let currentVideoId = '';

// 測試模式狀態
let isTestModeEnabled = false;
let testRules = []; // 格式: [{ original: '原文', replacement: '替換文' }]

// 更新UI狀態
function updateUI() {
    const statusDiv = document.querySelector('.status');
    const toggleButton = document.getElementById('toggleButton');
    const currentVideoSpan = document.getElementById('currentVideo');
    const replacementCountSpan = document.getElementById('replacementCount');
    const testModeToggle = document.getElementById('testModeToggle');
    const testModeContent = document.getElementById('testModeContent');

    // 更新狀態顯示
    statusDiv.className = `status ${isEnabled ? 'active' : 'inactive'}`;
    statusDiv.textContent = isEnabled ? 'Netflix 字幕優化功能已啟動' : 'Netflix 字幕優化功能已停用';
    
    // 更新按鈕文字
    toggleButton.textContent = isEnabled ? '停用功能' : '啟用功能';
    
    // 更新統計資訊
    currentVideoSpan.textContent = currentVideoId || '未偵測到影片';
    replacementCountSpan.textContent = replacementCount;
    
    // 更新測試模式狀態
    if (testModeToggle) {
        testModeToggle.checked = isTestModeEnabled;
        if (isTestModeEnabled) {
            testModeContent.classList.remove('hidden');
        } else {
            testModeContent.classList.add('hidden');
        }
    }
    
    // 更新測試規則列表
    renderTestRules();
}

// 渲染測試規則列表
function renderTestRules() {
    const testRulesList = document.getElementById('testRulesList');
    if (!testRulesList) return;
    
    // 清空列表
    testRulesList.innerHTML = '';
    
    // 添加每個規則項目
    testRules.forEach((rule, index) => {
        const ruleItem = document.createElement('div');
        ruleItem.className = 'test-rule-item';
        
        const ruleText = document.createElement('div');
        ruleText.textContent = `${rule.original} → ${rule.replacement}`;
        
        const deleteButton = document.createElement('button');
        deleteButton.textContent = '刪除';
        deleteButton.addEventListener('click', () => deleteTestRule(index));
        
        ruleItem.appendChild(ruleText);
        ruleItem.appendChild(deleteButton);
        testRulesList.appendChild(ruleItem);
    });
    
    // 如果沒有規則，顯示提示信息
    if (testRules.length === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.textContent = '尚未添加測試規則';
        emptyMessage.style.color = '#999';
        emptyMessage.style.padding = '5px';
        testRulesList.appendChild(emptyMessage);
    }
}

// 切換測試模式
function toggleTestMode() {
    isTestModeEnabled = !isTestModeEnabled;
    
    // 儲存狀態
    chrome.storage.local.set({ isTestModeEnabled }, () => {
        // 通知 background script 測試模式狀態變更
        chrome.runtime.sendMessage({
            type: 'TOGGLE_TEST_MODE',
            isTestModeEnabled
        });
        
        updateUI();
    });
}

// 添加測試規則
function addTestRule() {
    const originalText = document.getElementById('originalText').value.trim();
    const replacementText = document.getElementById('replacementText').value.trim();
    
    if (!originalText || !replacementText) {
        alert('請輸入原文和替換文本');
        return;
    }
    
    console.log('添加測試規則:', originalText, '->', replacementText);
    
    // 添加到規則列表
    testRules.push({
        original: originalText,
        replacement: replacementText
    });
    
    // 儲存規則
    saveTestRules();
    
    // 清空輸入框
    document.getElementById('originalText').value = '';
    document.getElementById('replacementText').value = '';
    
    // 更新 UI
    renderTestRules();
    
    // 顯示成功提示
    const statusDiv = document.querySelector('.status');
    const originalStatus = statusDiv.textContent;
    const originalClass = statusDiv.className;
    
    statusDiv.textContent = '測試規則已添加！';
    statusDiv.className = 'status active';
    
    setTimeout(() => {
        statusDiv.textContent = originalStatus;
        statusDiv.className = originalClass;
    }, 2000);
}

// 刪除測試規則
function deleteTestRule(index) {
    testRules.splice(index, 1);
    saveTestRules();
    renderTestRules();
}

// 儲存測試規則
function saveTestRules() {
    chrome.storage.local.set({ testRules }, () => {
        // 通知 background script 測試規則已更新
        chrome.runtime.sendMessage({
            type: 'UPDATE_TEST_RULES',
            testRules
        });
    });
}

// 切換擴充功能狀態
function toggleExtension() {
    isEnabled = !isEnabled;
    
    // 儲存狀態
    chrome.storage.local.set({ isEnabled }, () => {
        // 通知 content script 狀態變更
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { 
                    type: 'TOGGLE_EXTENSION',
                    isEnabled 
                });
            }
        });
        
        updateUI();
    });
}

// 監聽來自 content script 的訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'UPDATE_STATS') {
        console.log('彈出窗口收到更新統計信息:', request);
        currentVideoId = request.videoId;
        replacementCount = request.replacementCount;
        updateUI();
    }
});

// 主動獲取當前視頻信息
function fetchCurrentVideoInfo() {
    console.log('主動獲取當前視頻信息');
    
    // 從存儲中獲取最新的視頻 ID 和替換計數
    chrome.storage.local.get(['currentVideoId', 'replacementCount'], (result) => {
        console.log('從存儲中獲取的數據:', result);
        
        if (result.currentVideoId) {
            currentVideoId = result.currentVideoId;
            console.log('從存儲中獲取的視頻 ID:', currentVideoId);
        }
        
        if (result.replacementCount !== undefined) {
            replacementCount = result.replacementCount;
        }
        
        updateUI();
    });
    
    // 嘗試向當前活動標籤頁發送消息，請求最新的視頻 ID
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            try {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log('發送消息時出錯:', chrome.runtime.lastError);
                        return;
                    }
                    
                    if (response && response.videoId) {
                        console.log('從內容腳本獲取的視頻 ID:', response.videoId);
                        currentVideoId = response.videoId;
                        replacementCount = response.replacementCount || replacementCount;
                        updateUI();
                    }
                });
            } catch (error) {
                console.log('嘗試發送消息時出錯:', error);
            }
        }
    });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    console.log('彈出窗口已加載');
    
    // 載入儲存的狀態
    chrome.storage.local.get(['isEnabled', 'replacementCount', 'currentVideoId', 'isTestModeEnabled', 'testRules'], (result) => {
        console.log('初始化時從存儲中獲取的數據:', result);
        
        if (result.isEnabled !== undefined) {
            isEnabled = result.isEnabled;
        }
        if (result.replacementCount !== undefined) {
            replacementCount = result.replacementCount;
        }
        if (result.currentVideoId !== undefined) {
            currentVideoId = result.currentVideoId;
            console.log('初始化時從存儲中獲取的視頻 ID:', currentVideoId);
        }
        if (result.isTestModeEnabled !== undefined) {
            isTestModeEnabled = result.isTestModeEnabled;
            console.log('初始化時從存儲中獲取的測試模式狀態:', isTestModeEnabled);
        }
        if (result.testRules && Array.isArray(result.testRules)) {
            testRules = result.testRules;
            console.log('初始化時從存儲中獲取的測試規則:', testRules);
        }
        
        updateUI();
        
        // 主動獲取當前視頻信息
        fetchCurrentVideoInfo();
    });
    
    // 綁定按鈕點擊事件
    document.getElementById('toggleButton').addEventListener('click', toggleExtension);
    
    // 綁定測試模式相關事件
    const testModeToggle = document.getElementById('testModeToggle');
    if (testModeToggle) {
        testModeToggle.addEventListener('change', toggleTestMode);
    }
    
    const addTestRuleButton = document.getElementById('addTestRule');
    if (addTestRuleButton) {
        addTestRuleButton.addEventListener('click', addTestRule);
    }
    
    // 為輸入框添加回車鍵提交功能
    const originalTextInput = document.getElementById('originalText');
    const replacementTextInput = document.getElementById('replacementText');
    
    if (originalTextInput && replacementTextInput) {
        const handleEnterKey = (event) => {
            if (event.key === 'Enter') {
                addTestRule();
            }
        };
        
        originalTextInput.addEventListener('keypress', handleEnterKey);
        replacementTextInput.addEventListener('keypress', handleEnterKey);
    }
});
