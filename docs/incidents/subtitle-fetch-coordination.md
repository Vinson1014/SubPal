# 字幕 replacement fetch 與快取協調事故

返回[防錯索引](../error_experience.md)或[事故總表](README.md)。

## 2026-08 - 字幕 replacement fetch 因跨 world epoch 與片尾 owner 耦合失效

### 症狀

- messaging 重構後，MAIN 與 isolated world 的 `PlaybackContextManager` 各自遞增 epoch；把 MAIN epoch 傳到 isolated 比較時，即使 video/session 正確也可能回 `stale-context`。
- isolated context manager 曾由可停用的片尾任務擁有。片尾功能初始關閉、播放中 opt-out 或 owner cleanup 後，字幕 query 因 manager 不再 ready 而失效。
- 舊 fetch 邏輯把 interval、字幕 Map、prefetch 與 reconciliation 分散在 `SubtitleReplacer`，失敗 range、空結果、late response 與 cache 淘汰容易產生互相矛盾的 coverage。

### 根因與解法

- execution world 間的 epoch 不是共享 authority clock。MAIN query 改為只傳 video/range；isolated 在 strict `PageIngress` 後才綁定自己的 authoritative context，background 再驗證 trusted Netflix port 與 exact private schema。
- isolated `PlaybackContextManager` 改由 content startup 無條件 single-flight 初始化；片尾任務只借用，不得 initialize 或 cleanup。首次初始化失敗可由後續 subtitle demand 重試。
- 新增 session-memory `SubtitleFetchCoordinator`，集中管理 180 秒 request、interval-union coverage、兩筆 concurrency、latest-demand queue、negative cache、range snapshot、2/10/30/60 秒冷卻與 scope late-response suppression。
- backend source 變更只跨 world 發送 generation，不傳 profile ID、endpoint 或 credential；replacement response 全批驗證，顯示端一律把 fetched text 當純文字。

### 經驗

- 同名欄位不代表跨 realm 可比較；epoch 必須由產生它的 authority 進行判斷。
- optional feature 不應擁有其他核心能力依賴的 lifecycle resource。
- coverage metadata 與 cache data 必須由同一 owner 原子更新；不能淘汰資料卻保留 completed coverage。
- retryable 只代表 coordinator 可在未來 demand 再嘗試，不代表 transport 或 timer 可自行重送 request。
