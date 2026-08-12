# Netflix SPA 與 UI 生命周期事故

返回[防錯索引](../error_experience.md)或[事故總表](README.md)。

## 2026-05 - Netflix 換片後自訂字幕樣式失效

### 症狀

- 第一部影片可正確套用 SubPal 自訂字幕樣式。
- 在 Netflix SPA 內切到第二部影片後，主要字幕樣式回到預設值或看起來像被 Netflix 原生字幕樣式覆蓋。

### 原因

- `UIManager` 收到 `VIDEO_ID_CHANGED` 後會清理並重建 `SubtitleDisplay`。
- `SubtitleStyleManager` 只在初始化與設定變更時把 config 注入 `SubtitleDisplay`。
- 換片後新建立的 `SubtitleDisplay` 沒有重新接收目前使用者樣式。

### 解法

- `UIManager` 在影片切換重建 UI 元件後分發 `UI_COMPONENTS_REINITIALIZED`。
- `SubtitleStyleManager` 監聽該事件並呼叫 `applyCurrentStyle()`，將目前 config 重新注入新的字幕顯示元件。
- 在 `window.subpalApp.getStatus()` 暴露 `subtitleStyleManager` 狀態，方便確認換片後樣式是否已重新下發。

### 經驗

- Netflix SPA 切頁會讓 UI DOM 和管理器生命週期不同步。
- 依賴 UI 元件引用的管理器，必須在 UI 重建後有明確的重新同步事件。

## 2026-07 - UIManager 在 Netflix SPA 換片後失去初始化狀態

### 症狀

- SPA 換片後 `UIManager` registry 仍存在，但 live instance 的 `isInitialized` 為 `false`，`components` 為空。
- 主要／次要字幕資料已分別取得 **383 / 454 cues** 並進入 ready 狀態，畫面流程卻持續回報「`UI 管理器未初始化`」。
- 重複切片期間亦觀察到事件 listener 累積；這些是修正前的 runtime 失敗證據，不代表修正後已通過實際換片驗收。

### 根因

- `VIDEO_ID_CHANGED` 觸發完整非同步 `cleanup()`，但 coordinator 未等待清理完成便繼續送出字幕 render，生命週期沒有序列化。
- 完整清理同時銷毀 `SubtitleReplacer`；清理與重建交錯後，registry 雖仍可找到 manager，live instance 卻處於未初始化且無元件的狀態。

### 解法

- 將影片擁有的元件重建與 terminal cleanup 分離；換片不再銷毀持久 handlers 與 `SubtitleReplacer`。
- 以共享的 in-flight promise 與 component generation 序列化重建，合併重複換片事件並淘汰 stale async render。
- 在分發重建完成事件前先設為 ready，且轉場期間安全地略過字幕 render，避免 coordinator 使用半初始化 UI。

### 驗證與限制

- focused regression：修正前 **7 項中 1 通過、6 失敗**；修正後 **7/7 通過**。
- 完整 MJS suite：**109/109 通過**；相關 syntax check 與 `git diff --check` 均乾淨。
- 重複執行真實 Netflix SPA 換片 QA 的自動化 Playwright 嘗試在取得結果前中止；依使用者要求取消後續自動化，以節省 tokens，改由使用者手動測試。因此目前**不得宣稱 runtime SPA 換片穩定性已通過**。

### 經驗

- SPA 換片屬於可重入的非同步生命週期；清理、重建與 render 必須共享明確的序列化與 generation 邊界。
- terminal cleanup 不應直接重用於影片切換，否則會連帶銷毀跨影片仍須存活的 listener、callback 與 replacer。
