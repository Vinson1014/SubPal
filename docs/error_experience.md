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

## 2026-07 - Phase 6/7 片尾任務 runtime 驗證與視覺 QA 教訓

### 症狀與失敗嘗試
- 靜態測試與 Chromium fixture 均通過，但真實 Netflix 上第一次點擊 timecode 後播放時間雖然改變，end-screen 卻維持 minimized 狀態，原生控制項無法使用。
- 早期嘗試用單一 DOM selector 或 `HTMLMediaElement.currentTime` 直接操作，都因缺少 session 所有權保護與影片切換風險而被棄用。
- 視覺 QA 初期出現 false pass：截圖在 transition 尚未結束時就完成，導致面板位置或邊界看似正確；失敗截圖被後續執行覆蓋，無法追溯。
- 在 390px 寬度下，面板文字與按鈕都有足夠空間，但 1px border 仍因窄視口的內在寬度計算而部分被裁切。

### 根因與最終做法
- **靜態測試無法取代 live runtime 真相**。單元測試與 fixture 驗證的是程式碼路徑與模擬狀態，真實 Netflix 的 React 控制項、DOM ancestor 結構與播放生命週期仍須在實際頁面中確認。
- **合成 session 身份不可靠**。必須使用真正的 `PlaybackContextManager` 輸出：`videoId` + 不透明 `watch-*` `sessionId` + `epoch`，並在 quick-jump 命令與 page script 中雙重驗證，才能避免 route-derived 或僅靠 URL 的 synthetic identity。
- **Seek 成功與 endscreen UI 還原是兩件事**。`videoPlayer.seek(ms)` 改變播放時間後，Netflix 可能仍停留在 minimized end-screen；還需要偵測預期 player 容器與 `[data-uia="watch-video-player-view-minimized"]` 的 ancestor/descendant 關係，再點擊正確的 credits 控制鈕，才能恢復原生 UI。
- **Live DOM 是 ancestor 與 delayed React 控制的組合**。實際 minimized marker 並非 player 的兄弟元素，而是其祖先；React 也會在跳轉後延遲替換控制項，因此需要 bounded polling 與單次啟動邏輯。
- **Timecode 跳轉必須是使用者點擊觸發的一次性閂鎖**。page script 只在真實 `isTrusted` 點擊時建立 latch，並在處理後立即刪除；seconds-to-ms 轉換只在 page script 內部進行一次並 clamp 到 duration，防止重複或過期請求。
- **視覺 QA 必須對抗 transient state**。最終流程要求：使用 current-source 建置、等待 transition 結束後再截圖、每個斷言失敗即視為 fatal、保留歷史失敗截圖與報告、並在報告中明確揭露環境限制（例如 fontless Linux 無法驗證 CJK 字形可讀性）。

### 最終驗證與限制
- Backend fresh Phase 7：focused **13/13**，full **142 passed + 6 skipped**。
- Extension final：focused panel **44/44**，full **289/289**（``node --experimental-vm-modules --test tests/*.test.mjs``）。
- 完整 289/289 僅對應 `tests/*.test.mjs` 測試檔；``tests/*.mjs`` 這類更寬鬆的 glob 會包含支援模組與 harness，產生不同計數，不應視為同一結果。
- Visual final：**49/49** settled captures，**95/95** assertions，CTA 8px gap，hostile panel `x=24..366` at width 390，PASS_WITH_ACCEPTED_ENVIRONMENT_LIMITATION。本次 95 項斷言來自最終 canonical true-loading run。
- Manual live taxonomy scenarios 已通過：`type-a-next-episode` 不自動 seek、`type-b` State A countdown 點擊 timecode 正確跳轉並還原播放器 UI、`type-a-next-episode` 下一集啟動後不跳回舊任務。
- 當前 Netflix runtime 處於暫停/非片尾狀態，未看見任務面板，也無 feature-caused console errors。

### 已接受的限制
- 在同一 Netflix session 內返回 end-screen 後，Netflix 可能不會再次發出 end-screen 狀態，因此片尾字幕任務卡可能不會在同一 session 重複出現。這被視為可接受的非阻塞限制，未加入 persistent card/player controls。
- 測試主機沒有 CJK 字型，無法驗證中文/日文/韓文字形的可讀性；但幾何位置、DOM 結構與互動功能均通過。未安裝、未打包、未遠端載入任何字型。
- Phase 7 新鮮 live 觀察時播放處於暫停/非片尾狀態，未見任何 endscreen marker；兩種 endscreen 樣式已由 fresh fixture 覆蓋，Todo8 之前已認證的手動測試則涵蓋了卡片、quick-jump 與 stale guard。

### 經驗
- 單元測試與 browser fixture 可以鎖住行為，但無法證明 Netflix runtime 上的真實使用者體驗；任何涉及 private player API 的功能都應保留 live runtime 驗收步驟。
- 涉及 session 與身份的功能必須使用 opaque runtime identity，而不是 URL、mock ID 或推定狀態。
- Seek 類功能要分開驗證「時間是否到達」與「播放器 UI 是否可用」這兩個結果。
- 延遲載入的 React 控制項需要 bounded retry，且啟動控制項前必須先驗證所有權（ancestor/descendant）與 media 狀態。
- 視覺 QA 的斷言必須是 fatal 並保留歷史；transition 等待時間必須基於實際 transition duration 而非假設；測試報告應主動揭露無法驗證的環境限制。
- 即使文字與控制項都「放得下」，窄視口的內在寬度仍可能讓 1px border 被裁切；視覺斷言要包含實際邊界框而非僅檢查內容可見。

## 2026-07 - Type B: State A countdown transitioning to State B recommendation trailer task card disappears

### 症狀
- `type-b` State A countdown 開始時 card 可以短暫出現，但 Netflix 切到 State B recommendation trailer 後被移除；人工下 CDP 指令常錯過約 10 秒的 transient state。

### 根因
- 真實 preview `<video>` 位於 opacity 0 的 `background-video` wrapper；可見結構其實是 `background-video-container`，共同 owner 是 `watch-video` 而非 `player`。
- Netflix 會把 PlaybackContext 暫時切成 videoId 不同的 `background-*` session，不能直接當成可信 task context。
- 倒數期間 preview media 會 paused，React 還會短暫替換 media；舊邏輯立即觸發 `onInactive()`，把已顯示 card 拆掉。

### 解法與驗證
- 用三個可見 preview markers 與唯一 `watch-video` owner 判斷 recommendation shell；paused shell 可以觸發倒數任務，`type-a-next-episode` 仍維持 playing-only。
- 僅快取同一路由且 videoId 相符的最後可信 `watch-*` context；route change 與 cleanup 立即清除。
- inactive 延後 500ms 重新確認；即使 media/context transient，只要 recommendation shell 仍在就保留 card。
- Live CDP：card 於 0.633 秒出現，paused 倒數自 1.055 秒持續可見至 3.593 秒，推薦預覽播放後仍可見。
- Extension full suite：`294/294` 通過；所有相關檔案 `node --check` 與 `git diff --check` 通過。

## 2026-07 - 已顯示片尾任務卡被 inactive 訊號誤拆

### 原因與邊界
- 舊的 `onInactive` 路徑無條件取消 pending action、隱藏面板並發出 `ENDSCREEN_INACTIVE`，把「尚未顯示的 acquisition 失效」錯當成「已顯示卡片必須 teardown」。
- 修正以 production `isVisible` 作為最早 ownership boundary：卡片已在同一 route/video 可見後，ordinary inactivity、recommendation preview 替換與 seek aftermath 不再隱藏或取消它；尚未可見的 acquisition 仍照常失效並拒絕晚到回應。
- 沒有用刪除所有 inactive invalidation 或放寬 route/session/context guard 來掩蓋問題，因為這會讓 stale acquisition 重新進入畫面。X、成功 opt-out、route/video/next episode、離開 `/watch`、cleanup 與 dispose 仍是硬 teardown。

## 2026-07 - 換集事件早於 URL 與播放器 UI 恢復誤判

### 症狀與根因
- 已顯示的任務卡在下一集開始後仍停留。`VIDEO_ID_CHANGED` 雖已先到達 isolated owner，但 listener 丟掉事件中的新 video ID，只重新讀取尚未更新的 `location.pathname`；Netflix 後續使用 SPA history 收斂 URL 時，也不保證觸發既有的 `popstate` 或 `hashchange` listener。
- Timecode seek 已成功，Netflix 原生控制列也可使用，面板卻顯示「無法安全還原播放器介面」。舊驗證只接受 minimized marker 與 credits 控制都消失；Netflix 可在正常 controls 已出現時仍保留相關 React 節點，因此產生 false partial。

### 解法與驗證
- `VIDEO_ID_CHANGED` 直接把事件中的純數字 video ID 傳入既有 route invalidation seam，立即增加 generation、取消 stale work 並隱藏卡片；URL 稍後更新至同一 ID 時維持冪等。格式錯誤的內部 ID 不得改變 route 或隱藏面板。
- UI 恢復驗證新增正向證據：只查詢唯一 expected player 內可見的 `[data-uia="controls-standard"]`、timeline 與 play/pause；`[data-uia="player-controls"]` 僅作歷史 fallback 對照。marker ownership、video/session identity、單次 credits click、單次 seek 與全域控制項隔離仍維持 fail closed。
- 新增的兩個回歸測試先分別重現 panel 未隱藏與 `player-ui-restore-timeout`，修正後 lifecycle focused suite **52/52**、quick-jump suite **46/46**、完整 `tests/*.test.mjs` **321/321** 通過，相關 `node --check` 與 `git diff --check` 亦通過。
- 本次環境無法連接 Chrome DevTools，Playwright 也缺少 Chrome distribution，因此沒有宣稱 live Netflix 驗證通過；真實 runtime 仍應確認換集後卡片消失，且 timecode 跳轉後不再出現 false partial 訊息。

## 2026-07 - 文件契約與提案邊界

### 經驗
- 對跨 execution world 的擴充功能，應以凍結的來源到文件契約持續驗證目前行為；實作變更時補齊架構說明，並把尚未實作的整合設計明確標示為提案，可在不記錄使用者資料、工作階段識別或執行期細節的前提下防止文件漂移。
