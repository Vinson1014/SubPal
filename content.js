/**
 * 字幕助手擴充功能 - 內容腳本橋接器
 * 
 * 這個文件作為橋接器，負責動態加載模組化的內容腳本。
 * 由於 Chrome 擴充功能的 content_scripts 不直接支持 ES 模組，
 * 我們需要使用這種方式來加載我們的模組化代碼。
 */

// 創建一個腳本元素來加載模組化的入口點
function loadModularScript() {
  console.log('字幕助手擴充功能 - 加載模組化腳本...');
  
  // 創建腳本元素
  const script = document.createElement('script');
  script.type = 'module';
  script.src = chrome.runtime.getURL('content/index.js');
  
  // 添加到文檔
  console.log('將模組化腳本添加到文檔...');
  (document.head || document.documentElement).appendChild(script);
  
  // 腳本加載後確認
  script.onload = function() {
    console.log('模組化腳本加載成功');
    
    // 不要立即移除腳本，確保它有足夠時間執行
    setTimeout(() => {
      console.log('移除模組化腳本元素');
      script.remove();
    }, 1000);
  };
  
  // 處理加載錯誤
  script.onerror = function(error) {
    console.error('加載模組化腳本時出錯:', error);
    
    // 嘗試重新加載
    console.log('嘗試重新加載模組化腳本...');
    setTimeout(loadModularScript, 2000);
  };
}

// 設置與模組化腳本的通信橋接
function setupCommunicationBridge() {
  console.log('設置與模組化腳本的通信橋接...');
  
  // 監聽來自模組化腳本的消息
  window.addEventListener('message', function(event) {
    // 確保消息來自我們的擴充功能
    if (event.source !== window || !event.data || !event.data.type || !event.data.from || event.data.from !== 'SUBTITLE_ASSISTANT') {
      return;
    }
    
    // 處理消息
    const message = event.data;
    console.log('收到來自模組化腳本的消息:', message.type, message);
    
    // 轉發消息到 background script
    if (message.target === 'BACKGROUND' || message.type === 'SEND_TO_BACKGROUND') {
      const dataToSend = message.type === 'SEND_TO_BACKGROUND' ? message.data : message.data;
      console.log('轉發消息到 background script:', dataToSend);
      
      chrome.runtime.sendMessage(dataToSend, function(response) {
        // 檢查是否有錯誤
        if (chrome.runtime.lastError) {
          console.error('發送消息到 background script 時出錯:', chrome.runtime.lastError);
          
          // 將錯誤回應發送回模組化腳本
          window.postMessage({
            type: 'RESPONSE',
            from: 'SUBTITLE_ASSISTANT_BRIDGE',
            id: message.id,
            error: chrome.runtime.lastError.message
          }, '*');
          
          return;
        }
        
        console.log('收到來自 background script 的回應:', response);
        
        // 將回應發送回模組化腳本
        window.postMessage({
          type: 'RESPONSE',
          from: 'SUBTITLE_ASSISTANT_BRIDGE',
          id: message.id,
          data: response
        }, '*');
      });
    }
  });
  
  // 監聽來自 background script 或 popup 的消息
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    console.log('收到來自 Chrome 的消息:', message);
    
    // 轉發消息到模組化腳本
    window.postMessage({
      type: 'CHROME_MESSAGE',
      from: 'SUBTITLE_ASSISTANT_BRIDGE',
      data: message,
      sender: sender
    }, '*');
    
    // 返回 true 表示將異步發送回應
    return true;
  });
  
  console.log('通信橋接設置完成');
}

// 初始化
function initialize() {
  console.log('字幕助手擴充功能 - 初始化橋接器...');
  
  try {
    // 確保 chrome.runtime 可用
    if (!chrome || !chrome.runtime) {
      console.error('chrome.runtime 不可用，可能是擴充功能上下文問題');
      return;
    }
    
    // 加載模組化腳本
    console.log('開始加載模組化腳本...');
    loadModularScript();
    
    // 設置通信橋接
    console.log('開始設置通信橋接...');
    setupCommunicationBridge();
    
    // 通知 background script 內容腳本已加載
    console.log('通知 background script 內容腳本已加載...');
    chrome.runtime.sendMessage({
      type: 'CONTENT_SCRIPT_LOADED'
    }, function(response) {
      if (chrome.runtime.lastError) {
        console.error('通知 background script 時出錯:', chrome.runtime.lastError);
      } else {
        console.log('background script 已確認內容腳本加載:', response);
      }
    });
    
    console.log('字幕助手擴充功能初始化完成');
  } catch (error) {
    console.error('初始化過程中發生錯誤:', error);
    
    // 嘗試重新初始化
    console.log('嘗試重新初始化...');
    setTimeout(initialize, 3000);
  }
}

// 確保在頁面加載完成後初始化
console.log('檢查文檔加載狀態:', document.readyState);
if (document.readyState === 'loading') {
  console.log('文檔正在加載中，等待 DOMContentLoaded 事件...');
  document.addEventListener('DOMContentLoaded', function() {
    console.log('DOMContentLoaded 事件觸發，開始初始化');
    initialize();
  });
} else {
  console.log('文檔已加載完成，立即初始化');
  initialize();
}

// 添加頁面加載完成事件監聽器，確保在頁面完全加載後初始化
window.addEventListener('load', function() {
  console.log('頁面完全加載完成，確保初始化已執行');
  // 檢查是否已經初始化
  if (!document.querySelector('#subtitle-assistant-container')) {
    console.log('未檢測到字幕容器，重新初始化');
    initialize();
  }
});
