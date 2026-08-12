# Netflix 片尾任務生命周期與視覺 QA 事故

返回[防錯索引](../error_experience.md)或[事故總表](README.md)。

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
- Extension final：focused panel **44/44**，full **289/289**（`node --experimental-vm-modules --test tests/*.test.mjs`）。
- 完整 289/289 僅對應 `tests/*.test.mjs` 測試檔；`tests/*.mjs` 這類更寬鬆的 glob 會包含支援模組與 harness，產生不同計數，不應視為同一結果。
- Visual final：**49/49** settled captures，**95/95** assertions，CTA 8px gap，hostile panel `x=24..366` at width 390，PASS_WITH_ACCEPTED_ENVIRONMENT_LIMITATION。本次 95 項斷言來自最終 canonical true-loading run。
- Manual live taxonomy scenarios 已通過：`type-a-next-episode` 不自動 seek、`type-b` State A countdown 點擊 timecode 正確跳轉並還原播放器 UI、`type-a-next-episode` 下一集啟動後不跳回舊任務。
- 當前 Netflix runtime 處於暫停／非片尾狀態，未看見任務面板，也無 feature-caused console errors。

### 已接受的限制

- 在同一 Netflix session 內返回 end-screen 後，Netflix 可能不會再次發出 end-screen 狀態，因此片尾字幕任務卡可能不會在同一 session 重複出現。這被視為可接受的非阻塞限制，未加入 persistent card/player controls。
- 測試主機沒有 CJK 字型，無法驗證中文／日文／韓文字形的可讀性；但幾何位置、DOM 結構與互動功能均通過。未安裝、未打包、未遠端載入任何字型。
- Phase 7 新鮮 live 觀察時播放處於暫停／非片尾狀態，未見任何 endscreen marker；兩種 endscreen 樣式已由 fresh fixture 覆蓋，Todo8 之前已認證的手動測試則涵蓋了卡片、quick-jump 與 stale guard。

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
- Extension full suite：**294/294** 通過；所有相關檔案 `node --check` 與 `git diff --check` 通過。

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
