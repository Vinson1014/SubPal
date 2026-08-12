# 權限、身份與 transport 契約事故

返回[防錯索引](../error_experience.md)或[事故總表](README.md)。與 stale runtime 證據相關的通則另見 [`mv3-execution-world-and-live-evidence.md`](mv3-execution-world-and-live-evidence.md)。

## 2026-08 - 權限與身份邊界誤判讓設定、隊列與字幕投影互相污染

### 症狀

- Options 的大範圍 restore 看起來能回復資料，卻把 profile、queue、credential 的權威邊界一起繞過。
- settings snapshot 只過濾資料欄位，沒有同步過濾 change-event，身份就被投影到不該看到的地方。
- replacement beneficiary 讓 MAIN 持有，enqueue 當下的 profile 綁定會跟著漂移。

### 根因

- 把能力當成資料欄位，沒有先封閉 authority。
- 只做 snapshot 淨化，沒有處理事件投影。
- 把背景交易責任交給 MAIN，讓 enqueue-time identity 失去 canonical 來源。

### 失敗嘗試

- 嘗試靠 Options restore 後補寫 profile 與 credential，只是在錯誤邊界外再補一次錯誤。
- 嘗試只修 settings snapshot 的欄位白名單，沒有連 change-event 一起管，身份外洩仍在。
- 嘗試讓 MAIN 直接算 beneficiary，再由背景 queue 事後對齊，仍會碰到舊 profile。

### 解法

- 改成 closed capability，UI 只能透過受限能力發出請求。
- 用 canonical projection 承接 snapshot 與通知，避免把 identity 混進事件流。
- 由 background transaction owner 持有 queue、profile binding 與 beneficiary 寫入。
- 補上 hostile tests，專門驗證 restore、snapshot、enqueue 與 identity 漂移路徑。

### 預防

- 任何 restore 或 projection 變更都要先問清楚 authority 邊界。
- snapshot 與 event 都要一起測，不只看資料欄位。
- 牽涉身份與 queue 的邏輯，預設由 background 持有寫入權。

## 2026-08 - contribution-input 契約修補教訓

### 症狀

- vote、translation、replacement-event 從 page 送到 content，再進 background 時，前段看起來都是正常的 normalized `{ variant, payload }`，但 background 實際只接受完整 `{ category, variant, payload }` 信封，結果三種 enqueue 都落到 `invalid/contribution-input`。
- 真正的問題不是單一欄位缺失，而是 page→content 的 normalized adapter 與 background 的 full-envelope gate 對不上。

### 根因

- `content.js` 的 trusted adapter 把 caller-controlled category 拿掉後，沒有在 `persist()` 重新補回 authoritative `contribution-intent`。
- `Contributions` 內部維持 normalized shape 本來就是對的，問題出在 transport seam 沒有把 category ownership 收回可信邊界。

### 解法與失敗方案

- 採 Option A，讓 `content.js` `persist()` 在 trusted adapter 內重建完整信封，再交給 background。
- 拒絕 dual-shape parser 與 generic fallback，因為那會把 strict contract 變成多入口兼容，讓 authority 邊界再次模糊，也會掩蓋真正的 mismatch。
- 跨層測試要直接打到真實 background parser 和 queue owner，不能只 mock 邊界，否則只會驗到假綠燈。

### 驗證與操作限制

- RED/GREEN focused command：`node --experimental-vm-modules --test tests/content-contribution-deadline-contract.test.mjs tests/background-contribution-port-contract.test.mjs tests/contribution-queue-contract.test.mjs tests/contributions-enqueue-contract.test.mjs`。
- 全量 command：`node --experimental-vm-modules --test tests/*.test.mjs`。
- 也保留 `node --experimental-vm-modules --check content.js` 作為語法檢查。
- live vote 不能靠 plan 內的檢查清單默認通過，必須在實際點擊前重新取得 fresh explicit authorization。
- 這次只做文件 append，沒有執行任何 Netflix 貢獻操作。

## 2026-08 - contribution Port 同源漂移、stale worker 與非持久探針邊界

### 症狀

- 這次 live probe 一開始回傳 `forbidden/contribution-port-access`，不是預期的 `invalid/contribution-input`。
- 觸發條件是同一個 Netflix SPA 來源下的 path 或 query 漂移，`sender` 與 tab 仍是同源，但完整 URL 已不相等。
- 這個失敗不是實際貢獻流程的副作用，因為當時只做了 malformed probe，沒有送出任何真實 vote、submission 或 retry。

### 根因

- 執行中的 Service Worker 仍是舊編譯，`isTrustedContributionPort` 裡還留著 `sender.url === tab.url`。
- DevTools breakpoint 顯示目前 live call frame 的其他 trust 條件都為真，只有完整 URL 相等為假。
- `Debugger.getScriptSource` 看到的是正在執行的 worker 內容，和 fetchable 的 extension resource 不同，這才暴露了 stale worker。

### 最小修復

- 只移除完整 URL 相等，改回 origin-level trust。
- 保留 extension identity、tab id、HTTPS Netflix host、sender-origin 一致與 sender/tab origin 一致這些守門。
- 這樣同源 SPA 的路徑或 query 漂移才會進入既有的 malformed-input 驗證，不會擴張權限邊界。

### 驗證與邊界

- `chrome.runtime.reload()` 先替換掉 stale worker，之後再重新取得 page、content script 和 worker handles。
- fresh handles 下，同一個 malformed probe 才回到 `invalid/contribution-input`。
- 整個流程只碰到一次非持久的測試探針，沒有任何設定、storage、profile、queue、投票或其他 durable action。

### 經驗

- fetchable source 不代表 executing worker，live 驗證一定要把 runtime reload 和 fresh handles 算進去。
- 同源 SPA 的漂移應該只放進 payload 驗證，不該被舊 worker 的 false failure 誤導成產品邏輯。

## 2026-08 - 舊自訂端點遷移不可靜默改道

### 症狀與風險

- 0.4.1 只要求 `api.baseUrl` 可被 `URL` 解析，新版則只允許 HTTPS 或 localhost HTTP，且拒絕 userinfo、query 與 fragment。
- 舊 migration 在端點不符合新規則時改用官方端點，卻沿用原 userId、JWT 並把待同步 queue 綁到 default profile，可能把自架後端資料送到錯誤服務。

### 解法

- storage schema v1 對不安全 legacy endpoint 採 fail closed：只留下不含敏感內容的 `needs-attention` 狀態，修復前不註冊、不呼叫 API、不啟動同步。
- 只有可信 Options Port 能提交使用者明確確認的新安全 endpoint；確認後才把身份與 queue 一次遷移。
- 來源 `api/user/jwt` 在 0.5.0 保留供回滾，不在 migration 成功時立即刪除。

### 備份版本教訓

- 0.4.1 與重構後的備份曾同樣標為 v3，實際 roots 卻不同，造成舊檔被新版 strict parser 拒絕。
- 新匯出格式升為 v4；legacy v3 importer 只恢復經 schema 驗證的字幕、開關與 crowdsourcing 設定，明確忽略 endpoint、身份與 video，避免備份覆寫 runtime authority。
