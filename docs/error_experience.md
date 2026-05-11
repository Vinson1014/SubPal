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
