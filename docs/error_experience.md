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

## 2026-07 - Phase 4 跨執行世界回歸與失效的瀏覽器驗證

### 症狀與失敗嘗試
- 曾把完整 `content/index.js` 啟動圖移到 isolated world，雖隔離了任務傳輸，卻使它看不到 MAIN world 的 `window.subpalPageScript`，字幕應用因 page-script 等待逾時而無法正常啟動。
- `InitializationManager.notifyInitializationComplete()` 的 `sendMessage` import 在拆分期間遺失，整合通知走到該路徑時拋出 `ReferenceError`。
- `UIManager.handleUIAvoidanceChange()` 在延遲 callback 內重讀可變的 `currentSubtitle`；cleanup 先將其清空時，callback 會讀取 `null.position`。
- 先前聲稱完成的 live runtime 證據沒有證明擴充功能已 reload，仍可能來自舊 content-script execution world；該批證據已撤回，不作為驗收依據。僅 reload 擴充功能或頁面不足以排除 stale session，最後改用完整關閉並重啟 Chrome。

### 根因與最終架構
- 字幕主應用保留在 **MAIN world**，維持 page-script handshake 與既有字幕生命週期。
- endscreen 任務由 **isolated world** 的獨立 owner 負責，不透過公開 DOM event 暴露 privileged request/response。
- background 嚴格驗證 Netflix sender、sender tab 的 `/watch/<id>` 與 request video ID 一致、固定 `limit: 5`，以及支援的 API language；generic port 不承接任務查詢。
- 恢復 notifier 所需的 `sendMessage` import；UI avoidance callback 改為排程前擷取字幕與 position snapshot，避免延遲期間的 mutable-state null race。

### 最終驗證與清理
- 磁碟上的完整 MJS regression suite：**103/103 通過**；獨立 Oracle 亦從程式碼確認 MAIN/isolated ownership拆分與嚴格 background 邊界。
- 有效 live 驗證只採計 **2026-07-12 18:59–19:00Z** 的 fresh session：以 `scripts/start-chrome-cdp.ps1` 完整重啟 Chrome，連線 **CDP 9662**，載入擴充功能 **`lemfjeiageplncmmlgmffjiapooboghh` / 0.3.5**。
- fresh session 中 MAIN page-script 與字幕 app 均完成初始化；primary/secondary cue 數分別為 **383 / 454**，畫面可見兩組字幕文字且幾何位置分離、無重疊。
- 偽造 task event 的觀測為 **0 request / 0 response**；console 未出現 port warning，證明舊 listener 的輸出未延續到 fresh execution world。
- 驗證後未保留臨時產品碼、測試 hook 或偽造事件資料；本次紀錄不改動既有 CDP 操作文件。

### 經驗
- MV3 live 證據必須同時證明擴充版本與 execution world 已更新；無法證明 reload 的結果應立即撤回，而非以 hard reload 推定有效。
- 涉及 MAIN/isolated world 的安全修正不可只驗證 privileged transport，還要驗證原有 page-script 可見性與完整初始化路徑。
- 延遲 callback 不應重新讀取可能在 cleanup 中被清空的 UI 狀態；排程前應擷取此次工作所需的 immutable snapshot。

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
