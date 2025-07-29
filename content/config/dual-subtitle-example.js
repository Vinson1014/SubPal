/**
 * 雙語字幕配置使用示例
 * 
 * 這個文件展示如何使用雙語字幕配置 API
 */

import { dualSubtitleConfig } from './dual-subtitle-config.js';

// 示例：初始化和基本使用
async function initializeDualSubtitleExample() {
  try {
    // 1. 初始化配置
    await dualSubtitleConfig.initialize();
    console.log('雙語字幕配置初始化完成');
    
    // 2. 獲取當前設置
    const currentSettings = dualSubtitleConfig.getSettings();
    console.log('當前設置:', currentSettings);
    
    // 3. 獲取支持的語言
    const supportedLanguages = dualSubtitleConfig.getSupportedLanguages();
    console.log('支持的語言數量:', supportedLanguages.length);
    console.log('前10種語言:', supportedLanguages.slice(0, 10));
    
    // 4. 獲取設置摘要
    const summary = dualSubtitleConfig.getSettingsSummary();
    console.log('設置摘要:', summary);
    
  } catch (error) {
    console.error('初始化雙語字幕配置時出錯:', error);
  }
}

// 示例：設置語言
async function setLanguageExample() {
  try {
    // 設置中文為主要語言，英文為次要語言
    await dualSubtitleConfig.setLanguages('zh-Hant', 'en');
    console.log('語言設置成功');
    
    // 獲取更新後的設置
    const summary = dualSubtitleConfig.getSettingsSummary();
    console.log('更新後的設置:', summary);
    
  } catch (error) {
    console.error('設置語言時出錯:', error);
  }
}

// 示例：切換雙語字幕開關
async function toggleDualSubtitleExample() {
  try {
    const currentSettings = dualSubtitleConfig.getSettings();
    const newState = !currentSettings.dualSubtitleEnabled;
    
    await dualSubtitleConfig.setDualSubtitleEnabled(newState);
    console.log(`雙語字幕已${newState ? '啟用' : '停用'}`);
    
    const summary = dualSubtitleConfig.getSettingsSummary();
    console.log('更新後的設置:', summary);
    
  } catch (error) {
    console.error('切換雙語字幕開關時出錯:', error);
  }
}

// 示例：重置為預設值
async function resetToDefaultsExample() {
  try {
    await dualSubtitleConfig.resetToDefaults();
    console.log('已重置為預設值');
    
    const summary = dualSubtitleConfig.getSettingsSummary();
    console.log('重置後的設置:', summary);
    
  } catch (error) {
    console.error('重置設置時出錯:', error);
  }
}

// 示例：創建簡單的控制介面
function createDualSubtitleControlPanel() {
  const panel = document.createElement('div');
  panel.id = 'dual-subtitle-control-panel';
  panel.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 15px;
    border-radius: 5px;
    z-index: 99999;
    font-family: Arial, sans-serif;
    font-size: 12px;
    min-width: 200px;
  `;
  
  // 創建開關按鈕
  const toggleButton = document.createElement('button');
  toggleButton.textContent = '切換雙語字幕';
  toggleButton.style.cssText = `
    background: #007cba;
    color: white;
    border: none;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    margin: 5px 0;
    width: 100%;
  `;
  
  toggleButton.addEventListener('click', async () => {
    try {
      await toggleDualSubtitleExample();
      updateStatusDisplay();
    } catch (error) {
      console.error('切換雙語字幕時出錯:', error);
    }
  });
  
  // 創建語言選擇器
  const languageSelector = document.createElement('select');
  languageSelector.style.cssText = `
    width: 100%;
    margin: 5px 0;
    padding: 3px;
  `;
  
  // 填充語言選項
  const supportedLanguages = dualSubtitleConfig.getSupportedLanguages();
  supportedLanguages.forEach(lang => {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.name;
    languageSelector.appendChild(option);
  });
  
  languageSelector.addEventListener('change', async (e) => {
    try {
      const currentSettings = dualSubtitleConfig.getSettings();
      await dualSubtitleConfig.setLanguages(currentSettings.primaryLanguage, e.target.value);
      updateStatusDisplay();
    } catch (error) {
      console.error('設置語言時出錯:', error);
    }
  });
  
  // 創建狀態顯示
  const statusDisplay = document.createElement('div');
  statusDisplay.id = 'dual-subtitle-status';
  statusDisplay.style.cssText = `
    margin: 10px 0;
    padding: 5px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    font-size: 11px;
  `;
  
  // 更新狀態顯示函數
  const updateStatusDisplay = () => {
    const summary = dualSubtitleConfig.getSettingsSummary();
    statusDisplay.innerHTML = `
      <strong>雙語字幕狀態:</strong><br>
      啟用: ${summary.enabled ? '是' : '否'}<br>
      主要語言: ${summary.primaryLanguage.name}<br>
      次要語言: ${summary.secondaryLanguage.name}
    `;
  };
  
  // 創建關閉按鈕
  const closeButton = document.createElement('button');
  closeButton.textContent = '關閉';
  closeButton.style.cssText = `
    background: #dc3545;
    color: white;
    border: none;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    float: right;
    font-size: 10px;
  `;
  
  closeButton.addEventListener('click', () => {
    panel.remove();
  });
  
  // 組裝面板
  panel.appendChild(closeButton);
  panel.appendChild(document.createElement('br'));
  panel.appendChild(document.createElement('br'));
  panel.appendChild(document.createTextNode('雙語字幕控制面板'));
  panel.appendChild(document.createElement('br'));
  panel.appendChild(toggleButton);
  panel.appendChild(document.createTextNode('次要語言:'));
  panel.appendChild(languageSelector);
  panel.appendChild(statusDisplay);
  
  // 添加到頁面
  document.body.appendChild(panel);
  
  // 初始化狀態顯示
  updateStatusDisplay();
  
  return panel;
}

// 自動初始化示例（用於測試）
async function autoInitialize() {
  console.log('=== 雙語字幕配置示例 ===');
  
  // 初始化配置
  await initializeDualSubtitleExample();
  
  // 顯示控制面板（僅在調試模式）
  if (window.location.hostname.includes('netflix.com')) {
    // 延遲3秒後顯示控制面板，避免與頁面加載衝突
    setTimeout(() => {
      createDualSubtitleControlPanel();
    }, 3000);
  }
}

// 導出函數供其他模組使用
export {
  initializeDualSubtitleExample,
  setLanguageExample,
  toggleDualSubtitleExample,
  resetToDefaultsExample,
  createDualSubtitleControlPanel,
  autoInitialize
};

// 自動運行示例（如果直接載入此文件）
if (typeof window !== 'undefined' && window.location) {
  autoInitialize().catch(console.error);
}