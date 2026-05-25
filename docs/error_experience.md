# 錯誤經驗紀錄

## 2026-05 - Queue 項目卡在 `syncing` 導致永遠不再重試

### 症狀
- 使用者的 queue 中出現少量資料長期停留在 `status: "syncing"`
- 後端沒有收到這些資料
- 手動「重試同步」與背景定時同步都不會重新送出這些資料

### 原因
- `background/sync.js` 只會處理 `pending` 狀態的 queue 項目
- 既有 retry 邏輯只會將 `failed` 項目重設後再重試
- 一旦 Service Worker 在項目已被標記為 `syncing` 後中途中止，該項目就不會再被任何流程接手

### 解法
- 新增 `syncStartedAt` 欄位，僅在正式進入 `syncing` 時寫入
- 新增 stale `syncing` recovery 邏輯：
  - 若 queue 項目 `status === "syncing"` 且 `createdAt` 已超過 30 分鐘
  - 則將其改回 `pending`，等待下一輪同步重新送出
- 在初始化、手動 retry、定時同步入口前先執行 recovery

### 相容策略
- 以 `createdAt` 判斷舊版殘留的 `syncing` 項目，不做額外 migration
- recovery 邏輯視為暫時性相容碼，待大部分使用者自然升級並清理舊資料後，可在未來版本移除

### 經驗
- `syncing` 不能只是「正在處理中」的表示，還必須有超時回收機制
- MV3 Service Worker 中的同步流程要假設自己可能在任何一步被中止，queue 狀態設計必須可恢復

## 2026-05 - Netflix 換片後自訂字幕樣式失效

### 症狀
- 第一部影片可正確套用 SubPal 自訂字幕樣式
- 在 Netflix SPA 內切到第二部影片後，主要字幕樣式回到預設值或看起來像被 Netflix 原生字幕樣式覆蓋

### 原因
- `UIManager` 收到 `VIDEO_ID_CHANGED` 後會清理並重建 `SubtitleDisplay`
- `SubtitleStyleManager` 只在初始化與設定變更時把 config 注入 `SubtitleDisplay`
- 換片後新建立的 `SubtitleDisplay` 沒有重新接收目前使用者樣式

### 解法
- `UIManager` 在影片切換重建 UI 元件後分發 `UI_COMPONENTS_REINITIALIZED`
- `SubtitleStyleManager` 監聽該事件並呼叫 `applyCurrentStyle()`，將目前 config 重新注入新的字幕顯示元件
- 在 `window.subpalApp.getStatus()` 暴露 `subtitleStyleManager` 狀態，方便確認換片後樣式是否已重新下發

### 經驗
- Netflix SPA 切頁會讓 UI DOM 和管理器生命週期不同步
- 依賴 UI 元件引用的管理器，必須在 UI 重建後有明確的重新同步事件
