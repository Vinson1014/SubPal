// 模擬資料庫
let mockDatabase = {
    // 格式: { videoId: { timestamp: { original: '原文', replacement: '替換文' } } }
    '81757600': {
        '15.3': {
            original: '你好',
            replacement: 'Hello'
        }
    }
};

// 測試模式狀態
let isTestModeEnabled = false;
let testRules = []; // 格式: [{ original: '原文', replacement: '替換文' }]

// 監聽來自 content script 的訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'CHECK_SUBTITLE') {
        const { videoId, timestamp, text } = request;
        
        // 檢查是否有需要替換的字幕
        const replacement = checkSubtitleReplacement(videoId, timestamp, text);
        sendResponse({ replacement });
        
        return true; // 保持連接開啟，等待非同步回應
    } else if (request.type === 'TOGGLE_TEST_MODE') {
        isTestModeEnabled = request.isTestModeEnabled;
        console.log('測試模式已' + (isTestModeEnabled ? '啟用' : '停用'));
        
        // 保存設置到 storage
        chrome.storage.local.set({ isTestModeEnabled });
        
        sendResponse({ success: true });
    } else if (request.type === 'UPDATE_TEST_RULES') {
        testRules = request.testRules;
        console.log('測試規則已更新:', testRules);
        
        // 保存設置到 storage
        chrome.storage.local.set({ testRules });
        
        sendResponse({ success: true });
    } else if (request.type === 'GET_SETTINGS') {
        // 處理獲取設置的請求
        const keys = request.keys || ['isEnabled', 'debugMode', 'isTestModeEnabled', 'testRules'];
        
        chrome.storage.local.get(keys, (result) => {
            console.log('獲取設置:', result);
            
            // 如果沒有找到 isEnabled 設置，默認為 true
            if (result.isEnabled === undefined) {
                result.isEnabled = true;
            }
            
            // 如果沒有找到 debugMode 設置，默認為 false
            if (result.debugMode === undefined) {
                result.debugMode = false;
            }
            
            // 添加測試模式狀態
            if (result.isTestModeEnabled === undefined) {
                result.isTestModeEnabled = isTestModeEnabled;
            }
            
            // 添加測試規則
            if (result.testRules === undefined) {
                result.testRules = testRules;
            }
            
            sendResponse(result);
        });
        
        return true; // 保持連接開啟，等待非同步回應
    } else if (request.type === 'CONTENT_SCRIPT_LOADED') {
        console.log('內容腳本已加載:', sender.tab ? sender.tab.url : '未知頁面');
        sendResponse({ success: true });
    } else if (request.type === 'SAVE_VIDEO_INFO') {
        // 處理保存視頻信息的請求
        const videoInfo = request.data;
        console.log('保存視頻信息:', videoInfo);
        
        chrome.storage.local.set(videoInfo, () => {
            if (chrome.runtime.lastError) {
                console.error('保存視頻信息時出錯:', chrome.runtime.lastError);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                console.log('視頻信息已保存到存儲中');
                sendResponse({ success: true });
            }
        });
        
        return true; // 保持連接開啟，等待非同步回應
    }
});

// 檢查字幕是否需要替換
function checkSubtitleReplacement(videoId, timestamp, text) {
    console.log(`檢查字幕替換: videoId=${videoId}, timestamp=${timestamp}, text="${text}"`);
    
    // 如果測試模式已啟用，優先使用測試規則
    if (isTestModeEnabled && testRules.length > 0) {
        console.log('測試模式已啟用，測試規則數量:', testRules.length);
        
        // 在測試模式下，只匹配文本內容，不考慮時間戳和視頻 ID
        for (const rule of testRules) {
            console.log(`比較測試規則: "${rule.original}" vs "${text}"`);
            
            // 使用精確匹配
            if (rule.original === text) {
                console.log('測試模式精確匹配成功:', text, '->', rule.replacement);
                return rule.replacement;
            }
            
            // 使用包含匹配（如果原文包含在字幕中）
            if (text.includes(rule.original)) {
                console.log('測試模式包含匹配成功:', rule.original, '在', text, '中，替換為', rule.replacement);
                // 只替換匹配的部分
                return text.replace(rule.original, rule.replacement);
            }
        }
        
        console.log('沒有找到匹配的測試規則');
    }
    
    // 如果測試模式未啟用或沒有匹配的測試規則，使用模擬資料庫
    // TODO: 實現與後端資料庫的通訊
    // 目前使用模擬資料
    if (mockDatabase[videoId]) {
        console.log(`檢查模擬資料庫: videoId=${videoId} 存在`);
        
        if (mockDatabase[videoId][timestamp]) {
            console.log(`檢查模擬資料庫: timestamp=${timestamp} 存在`);
            
            if (mockDatabase[videoId][timestamp].original === text) {
                console.log('模擬資料庫匹配成功:', text, '->', mockDatabase[videoId][timestamp].replacement);
                return mockDatabase[videoId][timestamp].replacement;
            }
        }
        
        // 嘗試匹配任何時間戳
        if (mockDatabase[videoId]['*']) {
            console.log('檢查通配符時間戳');
            
            if (mockDatabase[videoId]['*'].original === text) {
                console.log('通配符時間戳匹配成功:', text, '->', mockDatabase[videoId]['*'].replacement);
                return mockDatabase[videoId]['*'].replacement;
            }
        }
    }
    
    // 嘗試匹配通用視頻 ID
    if (mockDatabase['*']) {
        console.log('檢查通用視頻 ID');
        
        if (mockDatabase['*'][timestamp] && mockDatabase['*'][timestamp].original === text) {
            console.log('通用視頻 ID 匹配成功:', text, '->', mockDatabase['*'][timestamp].replacement);
            return mockDatabase['*'][timestamp].replacement;
        }
        
        // 嘗試匹配任何時間戳
        if (mockDatabase['*']['*']) {
            console.log('檢查通用視頻 ID 和通配符時間戳');
            
            if (mockDatabase['*']['*'].original === text) {
                console.log('通用匹配成功:', text, '->', mockDatabase['*']['*'].replacement);
                return mockDatabase['*']['*'].replacement;
            }
        }
    }
    
    console.log('沒有找到匹配的替換規則');
    return null;
}

// 載入儲存的測試模式狀態和測試規則
chrome.storage.local.get(['isTestModeEnabled', 'testRules'], (result) => {
    if (result.isTestModeEnabled !== undefined) {
        isTestModeEnabled = result.isTestModeEnabled;
        console.log('載入測試模式狀態:', isTestModeEnabled);
    }
    
    if (result.testRules && Array.isArray(result.testRules)) {
        testRules = result.testRules;
        console.log('載入測試規則:', testRules);
    }
});

// 初始化擴充功能
chrome.runtime.onInstalled.addListener(() => {
    console.log('Netflix 字幕優化擴充功能已安裝');
    
    // 初始化模擬資料 - 添加更多測試數據
    mockDatabase = {
        // 使用 'unknown' 作為通用視頻 ID，這樣在任何視頻上都可能匹配
        'unknown': {
            // 添加多個時間點，增加命中的可能性
            '10.0': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.0)' },
            '10.1': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.1)' },
            '10.2': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.2)' },
            '10.3': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.3)' },
            '10.4': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.4)' },
            '10.5': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.5)' },
            '10.6': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.6)' },
            '10.7': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.7)' },
            '10.8': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.8)' },
            '10.9': { original: '這是測試字幕', replacement: '這是優化後的字幕 (10.9)' },
            '20.0': { original: '另一個測試字幕', replacement: '另一個優化後的字幕 (20.0)' },
            '30.0': { original: '第三個測試字幕', replacement: '第三個優化後的字幕 (30.0)' }
        },
        // 保留原來的示例，以防用戶想要測試特定視頻 ID
        'example-video-id': {
            '10.5': {
                original: '這是測試字幕',
                replacement: '這是優化後的字幕'
            }
        },
        // 添加通用匹配規則，適用於任何視頻和任何時間點
        '*': {
            '*': {
                original: '哇，好酷',
                replacement: 'Wow, that\'s cool!'
            }
        }
    };
});

// 添加一個通用的字幕匹配函數，用於測試模式
function addUniversalTestRule(original, replacement) {
    // 確保 mockDatabase 中有通用視頻 ID
    if (!mockDatabase['*']) {
        mockDatabase['*'] = {};
    }
    
    // 添加通用時間戳的匹配規則
    mockDatabase['*']['*'] = {
        original: original,
        replacement: replacement
    };
    
    console.log('添加通用測試規則:', original, '->', replacement);
}
