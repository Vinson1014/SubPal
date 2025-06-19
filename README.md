<div align="center">
  <img src="icons/SubPal_rc.png" alt="SubPal Icon" width="128"/>
  <h1>SubPal - 字幕助手</h1>
</div>

## 🎯 專案概述
SubPal 是一個由公眾貢獻驅動的 Chrome 擴充功能，旨在改善 Netflix 等串流平台的字幕翻譯品質。由於官方字幕無法即時修正且用戶難以參與改進，SubPal 提供了一個平台讓用戶可以提交和投票選擇更好的字幕翻譯，從而提升觀影體驗。

## ✨ 功能特色
- **即時字幕替換**：自動偵測 Netflix 影片字幕並替換為社群提供的更好翻譯
- **社群貢獻機制**：用戶可以提交自己認為更好的翻譯，並對他人的翻譯進行投票
- **用戶統計面板**：在彈出視窗中顯示貢獻統計數據
- **進階設定選項**：提供資料備份、同步管理等功能
- **積分系統**（未來功能）：計劃用於鼓勵用戶貢獻

<!-- 效果圖 -->
![效果圖](/src/screenshots/SubPal_宣傳圖1.png)

## ⚙️ 安裝指南
### 從 Chrome 瀏覽器商店安裝
1. 使用Chrome 瀏覽器點擊此連結：
[Chrome Web Store](https://chrome.google.com/webstore/detail/lemfjeiageplncmmlgmffjiapooboghh)
2. 點擊「加到 Chrome」
3. 完成 !


### 手動安裝
1. 下載專案：`git clone https://github.com/Vinson1014/SubPal.git`
2. 在 Chrome 瀏覽器中開啟擴充功能管理頁面（網址列輸入 `chrome://extensions`）
3. 啟用右上角的「開發人員模式」
4. 點擊「載入未封裝擴充功能」按鈕，選擇專案目錄

## 🖥 使用說明
### 彈出視窗功能

![popup](/src/screenshots/popup.png)

- **擴充功能開關**：打開或關閉擴充功能
- **積分狀態**：目前尚未啟用（開發中功能）


## 🤝 貢獻方式
1. **提交翻譯**：觀看影片時，若發現翻譯不佳，可提交更好的翻譯建議

  ![submit_translation](/src/screenshots/submit%20translations.png)

2. **投票機制**：對他人提交的翻譯進行投票，幫助選出最佳翻譯

  ![vote](/src/screenshots/interaction%20buttons.png)


3. **積分系統**（未來功能）：貢獻翻譯可獲得積分，用於解鎖更多功能

## 💬 加入討論
- [Discord](https://discord.gg/Z5KPr2yPfq)：加入我們的 Discord 伺服器，討論開發細節及分享想法

  ![Discord Banner 2](https://discord.com/api/guilds/1385161094921977938/widget.png?style=banner2)

- [GitHub Issues](https://github.com/Vinson1014/SubPal/issues)：提出問題或建議


## 🧠 技術架構
- 使用 Manifest V3 開發 Chrome 擴充功能
- 內容腳本即時修改 Netflix 頁面中的字幕
- 背景服務處理數據同步與儲存
- 基於 Web API 的社群貢獻平台整合
