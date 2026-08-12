# 同步佇列恢復與完成狀態事故

返回[防錯索引](../error_experience.md)或[事故總表](README.md)。

## 2026-05 - Queue 項目卡在 `syncing` 導致永遠不再重試

### 症狀

- 使用者的 queue 中出現少量資料長期停留在 `status: "syncing"`。
- 後端沒有收到這些資料。
- 手動「重試同步」與背景定時同步都不會重新送出這些資料。

### 原因

- `background/sync.js` 只會處理 `pending` 狀態的 queue 項目。
- 既有 retry 邏輯只會將 `failed` 項目重設後再重試。
- 一旦 Service Worker 在項目已被標記為 `syncing` 後中途中止，該項目就不會再被任何流程接手。

### 解法

- 新增 `syncStartedAt` 欄位，僅在正式進入 `syncing` 時寫入。
- 新增 stale `syncing` recovery：若 queue 項目 `status === "syncing"` 且 `createdAt` 已超過 30 分鐘，則改回 `pending`，等待下一輪同步重新送出。
- 在初始化、手動 retry、定時同步入口前先執行 recovery。

### 相容策略與經驗

- 以 `createdAt` 判斷舊版殘留的 `syncing` 項目，不做額外 migration。
- recovery 視為暫時性相容碼，待大部分使用者自然升級並清理舊資料後，可在未來版本移除。
- `syncing` 不能只是「正在處理中」的表示，還必須有超時回收機制。
- MV3 Service Worker 中的同步流程要假設自己可能在任何一步被中止，queue 狀態設計必須可恢復。

## 2026-08 - 本地 queue 已持久化卻仍顯示 UI 假失敗

### 症狀

- 本地 queue 已成功持久化，但 UI 端仍顯示失敗，讓使用者以為這次動作沒有成功。
- `queued-locally` 與 `success` 的狀態語意出現漂移，producer 和 consumer 對「已完成」的判定不一致。

### 根因

- producer 先把結果記成 `queued-locally`，consumer 卻只在 `success` 才做 canonical acknowledgement，兩邊的契約沒有對齊。
- producer 與 dialog 的測試分開驗證，沒有一起覆蓋同一條確認路徑；endscreen fake 也複製了錯誤的 predicate，讓假失敗沒有在整合層被抓到。

### 解法

- 讓 consumer 依 canonical acknowledgement 的語意收斂判定，只有 `status === 'queued-locally'` 的本地持久化 acknowledgement 才同步更新 UI，而不是等單一字面狀態字串。
- 補齊 producer 與 dialog 的對照測試，並把 copied endscreen fake 的 predicate 一起修正，讓跨元件路徑對同一個完成語意一致。

### 風險與限制

- 這次修補沒有改動 background queue、sync、API、Port 或 bridge contract。
- 若 UI 還把這種假失敗當成真失敗再觸發 retry，可能造成 duplicate submission，因此重試邏輯也要持續以 canonical acknowledgement 為準。
