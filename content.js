/**
 * Netflix 字幕優化擴充功能 - 內容腳本橋接器
 * 
 * 這個文件作為橋接器，負責動態加載模組化的內容腳本。
 * 由於 Chrome 擴充功能的 content_scripts 不直接支持 ES 模組，
 * 我們需要使用這種方式來加載我們的模組化代碼。
 */

// 創建一個腳本元素來加載模組化的入口點
function loadModularScript() {
  console.log('Netflix 字幕優化擴充功能 - 加載模組化腳本...');
  
  // 創建腳本元素
  const script = document.createElement('script');
  script.type = 'module';
  script.src = chrome.runtime.getURL('content/index.js');
  
  // 添加到文檔
  (document.head || document.documentElement).appendChild(script);
  
  // 腳本加載後移除元素（可選）
  script.onload = function() {
    script.remove();
  };
  
  // 處理加載錯誤
  script.onerror = function(error) {
    console.error('加載模組化腳本時出錯:', error);
  };
}

// 設置與模組化腳本的通信橋接
function setupCommunicationBridge() {
  // 監聽來自模組化腳本的消息
  window.addEventListener('message', function(event) {
    // 確保消息來自我們的擴充功能
    if (event.source !== window || !event.data || !event.data.type || !event.data.from || event.data.from !== 'NETFLIX_SUBTITLE_OPTIMIZER') {
      return;
    }
    
    // 處理消息
    const message = event.data;
    
    // 轉發消息到 background script
    if (message.target === 'BACKGROUND' || message.type === 'SEND_TO_BACKGROUND') {
      const dataToSend = message.type === 'SEND_TO_BACKGROUND' ? message.data : message.data;
      
      chrome.runtime.sendMessage(dataToSend, function(response) {
        // 檢查是否有錯誤
        if (chrome.runtime.lastError) {
          console.error('發送消息到 background script 時出錯:', chrome.runtime.lastError);
          
          // 將錯誤回應發送回模組化腳本
          window.postMessage({
            type: 'RESPONSE',
            from: 'NETFLIX_SUBTITLE_OPTIMIZER_BRIDGE',
            id: message.id,
            error: chrome.runtime.lastError.message
          }, '*');
          
          return;
        }
        
        // 將回應發送回模組化腳本
        window.postMessage({
          type: 'RESPONSE',
          from: 'NETFLIX_SUBTITLE_OPTIMIZER_BRIDGE',
          id: message.id,
          data: response
        }, '*');
      });
    }
  });
  
  // 監聽來自 background script 或 popup 的消息
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    // 轉發消息到模組化腳本
    window.postMessage({
      type: 'CHROME_MESSAGE',
      from: 'NETFLIX_SUBTITLE_OPTIMIZER_BRIDGE',
      data: message,
      sender: sender
    }, '*');
    
    // 返回 true 表示將異步發送回應
    return true;
  });
}

// 初始化
function initialize() {
  console.log('Netflix 字幕優化擴充功能 - 初始化橋接器...');
  
  // 加載模組化腳本
  loadModularScript();
  
  // 設置通信橋接
  setupCommunicationBridge();
  
  // 通知 background script 內容腳本已加載
  chrome.runtime.sendMessage({
    type: 'CONTENT_SCRIPT_LOADED'
  });
}

// 當頁面加載完成後初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
