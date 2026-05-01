# SubPal - 字幕助手

## 專案簡介

SubPal 是一個 Chrome 擴充功能，專注於改善 Netflix 字幕翻譯品質。主要功能包括：

- **字幕替換**: 自動偵測並替換不準確的字幕翻譯
- **社群貢獻**: 使用者可以提交更好的翻譯建議
- **投票機制**: 用戶可以對字幕翻譯進行讚/倒讚投票
- **品質改善**: 通過群眾智慧提升整體字幕翻譯品質
- **雙語字幕**: 提供用戶於 Netflix 的雙語字幕體驗

## 技術架構

- **Chrome Extension**: 使用 Manifest V3 開發
- **內容腳本 (`content.js`)**: 注入至 Netflix 頁面，負責 DOM 操作與字幕替換
- **頁面腳本 (`netflix-page-script.js`)**: 透過 web_accessible_resources 注入至 Netflix 主頁面 context，攔截字幕資料
- **背景服務 (`background.js`)**: Service Worker，處理 API 請求、資料同步、儲存與排程任務 (alarms)
- **UI 介面**: `popup.html` (工具列彈窗)、`options.html` (設定頁)、`tutorial.html` (使用教學)
- **API 整合**: 與 SubPal 後端社群貢獻平台連接，取得替換字幕與提交投票

### 權限說明
- `storage`: 儲存使用者設定與字幕快取
- `alarms`: 定期同步字幕資料
- `host_permissions`: 僅限 `*://*.netflix.com/*`

## 專案規範

- 中文註釋優先，重要邏輯需要詳細說明
- 修改 `manifest.json` 時請同步更新 `version` 欄位
- 發佈前確認移除測試用 log，且 `testcode/` 內容未被引用

### 文件結構
```
SubPal/
├── manifest.json              # 擴充功能 manifest (Manifest V3)
├── background.js              # 背景 Service Worker 入口
├── background/                # 背景服務模組
├── content.js                 # Content Script 入口
├── content/                   # 內容腳本模組
├── netflix-page-script.js     # 注入至 Netflix 頁面 context 的腳本
├── popup.html / popup.js      # 工具列彈窗 UI
├── options.html / options.js  # 設定頁
├── tutorial.html / tutorial.js# 使用教學頁
├── icons/                     # 擴充功能圖標資源
└── src/                       # 文檔相關資源文件
```

### 技術細節文檔
專案技術文件存放於 `docs/` 目錄，常用文件如下：
- 核心架構說明: `docs/architecture.md`

## 文檔撰寫與知識累積

### 何時記錄文檔
完成下列工作後，主動補上文檔：
1. 完成新功能或重大重構 — 記錄技術實作細節
2. 解決複雜 bug 或技術難題 — 記錄錯誤經驗和解決方案
3. 採用新技術或新架構模式 — 記錄使用指南
4. 完成重要配置變更 — 記錄配置說明
5. 發現重要技術細節 — 記錄以利後續參考

### 文檔類型
- **技術文檔** → `docs/[描述性檔名].md`：新功能實作、技術採用指南、架構設計
- **錯誤經驗** → `docs/error_experience.md`：以**附加方式**新增 bug 描述、解決方案、踩過的坑與失敗嘗試
