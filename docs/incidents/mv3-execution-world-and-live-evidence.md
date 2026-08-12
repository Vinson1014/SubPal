# MV3 execution world 與 live 證據事故

返回[防錯索引](../error_experience.md)或[事故總表](README.md)。另見 [contribution Port 的 stale worker 事故](authority-identity-and-transport-contracts.md)。

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

- 磁碟上的完整 MJS regression suite：**103/103 通過**；獨立 Oracle 亦從程式碼確認 MAIN/isolated ownership 拆分與嚴格 background 邊界。
- 有效 live 驗證只採計 **2026-07-12 18:59–19:00Z** 的 fresh session：以 `scripts/start-chrome-cdp.ps1` 完整重啟 Chrome，連線 **CDP 9662**，載入擴充功能 **`lemfjeiageplncmmlgmffjiapooboghh` / 0.3.5**。
- fresh session 中 MAIN page-script 與字幕 app 均完成初始化；primary/secondary cue 數分別為 **383 / 454**，畫面可見兩組字幕文字且幾何位置分離、無重疊。
- 偽造 task event 的觀測為 **0 request / 0 response**；console 未出現 port warning，證明舊 listener 的輸出未延續到 fresh execution world。
- 驗證後未保留臨時產品碼、測試 hook 或偽造事件資料；本次紀錄不改動既有 CDP 操作文件。

### 經驗

- MV3 live 證據必須同時證明擴充版本與 execution world 已更新；無法證明 reload 的結果應立即撤回，而非以 hard reload 推定有效。
- 涉及 MAIN/isolated world 的安全修正不可只驗證 privileged transport，還要驗證原有 page-script 可見性與完整初始化路徑。
- 延遲 callback 不應重新讀取可能在 cleanup 中被清空的 UI 狀態；排程前應擷取此次工作所需的 immutable snapshot。
