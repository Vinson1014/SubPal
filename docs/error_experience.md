# 錯誤經驗：每次必讀防錯索引

本文件只保留開工前需要反覆確認的規則。事故背景、失敗嘗試、一次性驗證數據與環境限制統一收錄於 [`incidents/`](incidents/README.md)；新增經驗時先更新此索引，只有需要追查脈絡時才補 incident。

## 同步佇列與完成狀態

- **觸發／風險**：調整 queue 狀態機、Service Worker 同步、retry 或 UI 完成提示時，可能留下永不重試的工作，或把已持久化動作誤報為失敗並造成重複提交。
- **不可違反規則**：所有處理中狀態都必須可逾時回收；producer 與 consumer 必須共用 canonical acknowledgement 語意；retry 只能依權威完成狀態決定。
- **常見錯誤做法**：只重試 `failed`、把 `syncing` 當終身所有權、以單一字面狀態判斷成功，或在各元件複製不同完成 predicate。
- **必要驗證提醒**：覆蓋 worker 中止後 recovery、初始化／手動／排程入口、queue 持久化到 UI acknowledgement 的整條路徑，以及不會 duplicate submission。
- **延伸事故**：[`queue-recovery-and-acknowledgement.md`](incidents/queue-recovery-and-acknowledgement.md)

## Netflix SPA 與 UI 生命周期

- **觸發／風險**：換片、route 變更、UI component 重建或延遲 callback 可能讓 manager registry、live instance、字幕樣式與 render generation 失去同步。
- **不可違反規則**：影片切換與 terminal cleanup 必須分離；重建需 single-flight／generation 序列化；依賴 UI 引用的 manager 必須在元件重建後重新注入狀態；延遲工作應擷取 immutable snapshot。
- **常見錯誤做法**：換片直接呼叫完整 cleanup、未等待重建就 render、只保留 registry 引用便視為 ready，或在 callback 執行時重讀可能已清空的 mutable state。
- **必要驗證提醒**：實際連續換片並確認樣式重套、manager ready、元件存在、舊 render 被淘汰、listener 不累積；無 live 證據時不得宣稱 SPA runtime 已通過。
- **延伸事故**：[`netflix-spa-ui-lifecycle.md`](incidents/netflix-spa-ui-lifecycle.md)

## MV3 execution world 與 live 驗證

- **觸發／風險**：搬移 MAIN／isolated world 邊界、修改 page-script handshake、重載擴充功能或採集瀏覽器證據時，可能驗到 stale worker／stale execution world，或切斷原有字幕啟動路徑。
- **不可違反規則**：需要 page globals 的字幕主流程留在 MAIN；privileged owner 與 transport 留在 isolated/background；live 證據必須證明 executing source、擴充版本與 execution world 都是新鮮的。
- **常見錯誤做法**：把整個啟動圖移入 isolated、只驗 privileged transport、不重新取得 runtime handles，或把可讀取的 extension resource 當成正在執行的 worker source。
- **必要驗證提醒**：完整重啟或可靠 reload 後取得 fresh handles，同時檢查 page-script 可見性、完整初始化、字幕呈現、安全邊界與舊 listener／訊息未殘留；無法證明新鮮度的結果應撤回。
- **延伸事故**：[`mv3-execution-world-and-live-evidence.md`](incidents/mv3-execution-world-and-live-evidence.md)

## 片尾任務與視覺 QA

- **觸發／風險**：片尾卡片 acquisition、recommendation preview、quick jump、下一集切換或 responsive UI 可能受 transient React DOM、播放 context 漂移與非同步 teardown 影響。
- **不可違反規則**：使用 opaque runtime identity 與明確 ownership；已顯示卡和未完成 acquisition 使用不同失效規則；route／video／next episode 等硬邊界仍須 fail closed；seek 成功與播放器 UI 恢復必須分開判定。
- **常見錯誤做法**：只看 URL 或單一 selector、用合成 session、對 ordinary inactivity 無條件拆卡、以負向節點消失判斷 UI 恢復，或在 transition 未穩定時截圖並覆蓋失敗證據。
- **必要驗證提醒**：以 live Netflix 覆蓋片尾類型、paused preview、換集、stale guard 與播放器控制恢復；視覺斷言需等待 settled state、失敗即 fatal、保存歷史產物並揭露字型等環境限制。
- **延伸事故**：[`netflix-endscreen-lifecycle-and-visual-qa.md`](incidents/netflix-endscreen-lifecycle-and-visual-qa.md)

## 權限身份與 transport 契約

- **觸發／風險**：restore、settings projection、profile 綁定、contribution envelope、Port trust 或 legacy endpoint migration 可能造成身份外洩、錯誤權威來源或跨服務送出資料。
- **不可違反規則**：能力預設封閉；snapshot 與 change-event 共用 canonical projection；background transaction owner 持有 queue、profile binding 與 beneficiary；trusted adapter 重建 authoritative envelope；不安全遷移 fail closed。
- **常見錯誤做法**：只過濾 snapshot、不管 event；讓 MAIN 決定 beneficiary；接受 dual-shape／generic fallback；要求同源 SPA 的完整 URL 相等；把不安全舊端點靜默改到官方服務並沿用身份。
- **必要驗證提醒**：以 hostile tests 覆蓋 restore、projection、enqueue、identity drift、真實 background parser／queue owner、同源 path/query 漂移、stale worker 與 legacy backup；任何真實貢獻操作都需 fresh explicit authorization。
- **延伸事故**：[`authority-identity-and-transport-contracts.md`](incidents/authority-identity-and-transport-contracts.md)

## 字幕 replacement fetch 與快取協調

- **觸發／風險**：跨 world context、片尾功能開關、range prefetch、negative cache、late response 或 cache eviction 可能讓字幕查詢誤判 stale，或讓 coverage metadata 與實際資料矛盾。
- **不可違反規則**：epoch 只能由其 authority 判斷；核心 playback context 不得由 optional feature 擁有；coverage 與 cache data 由同一 coordinator 原子更新；跨 world 只傳必要的非敏感 generation／query 資訊。
- **常見錯誤做法**：跨 realm 比較同名 epoch、由片尾 owner 初始化或 cleanup 共用 context、把 interval／Map／prefetch 分散管理，或把 retryable 當成 transport 自動重送授權。
- **必要驗證提醒**：覆蓋功能關閉與 opt-out、初始化失敗重試、range union、並發上限、negative cache、冷卻、淘汰後 coverage、scope 切換與 late-response suppression；完整驗證 response 並以純文字呈現。
- **延伸事故**：[`subtitle-fetch-coordination.md`](incidents/subtitle-fetch-coordination.md)

文件本身的維護契約與提案邊界另見 [`documentation-contracts.md`](incidents/documentation-contracts.md)。
