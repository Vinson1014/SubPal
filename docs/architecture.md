# SubPal 架構文檔

**文檔用途**: 專案架構完整說明，供開發者快速了解系統設計

---

## 目錄

1. [專案概述](#專案概述)
2. [系統架構](#系統架構)
3. [核心模組](#核心模組)
4. [數據流與通信](#數據流與通信)
5. [關鍵功能實現](#關鍵功能實現)
6. [配置系統](#配置系統)
7. [開發指南](#開發指南)

---

## 專案概述

### 專案目標
SubPal 是一個 Chrome 擴充功能，旨在通過社群協作改善 Netflix 字幕翻譯品質。主要功能包括：

- **字幕替換**: 自動偵測並替換品質較差的官方翻譯
- **社群貢獻**: 用戶可提交更準確的翻譯建議
- **投票機制**: 對字幕翻譯進行讚/倒讚投票
- **雙語字幕**: 同時顯示雙語字幕提升學習效果

### 技術棧

| 層級 | 技術 |
|------|------|
| **擴充功能** | Chrome Extension Manifest V3 |
| **前端** | Vanilla JavaScript (ES6+) |
| **樣式** | CSS3 (動態注入) |
| **後端 API** | https://subnfbackend.zeabur.app |
| **認證** | JWT Token |
| **存儲** | chrome.storage.local |

### 專案結構總覽

```
SubPal/
├── manifest.json              # Manifest V3 配置
├── content.js                 # Content Script 橋接層
├── background.js              # Service Worker
├── netflix-page-script.js     # Netflix 頁面注入腳本 (攔截 CDN、播放器管理)
├── popup.html/js              # 彈出窗口
├── options.html/js/css        # 設定頁面
├── tutorial.html/js/css       # 教學頁面
├── content/                   # 核心模組目錄（Page Context）
│   ├── index.js              # Page Context 入口
│   ├── system/               # 系統層模組（初始化、消息傳遞）
│   ├── core/                 # 核心業務邏輯（播放上下文、字幕替換、隊列）
│   ├── ui/                   # UI 組件（字幕顯示、樣式、互動面板）
│   ├── subtitle-modes/       # 字幕模式（攔截器、DOM 監聽、DOM overlap 匹配）
│   └── utils/                # 工具函數（解析器、語言代碼、slot key）
├── background/               # 背景服務模組（API、同步）
├── shared/                   # 跨 extension 頁面共享模組
│   └── subtitle-preview-renderer.js  # 字幕預覽渲染器（設定/教學頁面用）
├── icons/                    # 圖標資源
└── docs/                     # 技術文檔
```

---

## 系統架構

### 架構概覽

SubPal 採用 **多層架構設計**，以解決 Chrome Extension 與 Netflix 頁面的隔離限制：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Chrome Extension Architecture                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────┐     ┌──────────────────────┐                     │
│  │ Popup UI / active-profile stats one-shot sendMessage client │     │ Options Page / BackendProfiles port client │
│  │   (popup.html/js)                      │     │   (options.html/js)                    │
│  └──────────┬─────────────────────────────┘     └──────────┬────────────────┘             │
│             │ chrome.runtime.sendMessage                    │ options-page-channel            │
│             │                                              │                                 │
│                           ▼                                 ▼                                 │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │              Service Worker (background.js)                  │          │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐   │          │
│  │  │  api.js    │  │  sync.js   │  │  sync-listener.js    │   │          │
│  │  │  API通信   │  │  資料同步  │  │  同步監聽器          │   │          │
│  │  └────────────┘  └────────────┘  └──────────────────────┘   │          │
│  └──────────┬───────────────────────────────────────────────────┘          │
│             │ chrome.runtime.connect (Long-lived connection)               │
│             ▼                                                               │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │                 Content Script (content.js)                  │          │
│  │  - 消息橋接層                                                 │          │
│  │  - ConfigManager 初始化                                       │          │
│  │  - private Port / DOM transport 啟動                          │          │
│  │  - 注入 page context script                                   │          │
│  └──────────┬───────────────────────────────────────────────────┘          │
│             │ private DOM request/response (messageToContentScript / responseFromContentScript) │
│             ▼                                                               │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │                Page Context (content/index.js)               │          │
│  │  ┌────────────────────────────────────────────────────────┐ │          │
│  │  │           InitializationManager                       │ │          │
│  │  │  - 統一初始化流程                                      │ │          │
│  │  │  - 組件生命週期管理                                    │ │          │
│  │  └────────────────────────────────────────────────────────┘ │          │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │          │
│  │  │  Subtitle    │  │   UIManager  │  │  ConfigBridge   │   │          │
│  │  │ Coordinator  │  │              │  │                 │   │          │
│  │  └──────────────┘  └──────────────┘  └─────────────────┘   │          │
│  └──────────────────────────────────────────────────────────────┘          │
│             │                                                               │
│             │ window.postMessage                                             │
│             ▼                                                               │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │              Netflix Page Script                             │          │
│  │         (netflix-page-script.js)                             │          │
│  │  - 直接訪問 Netflix 內部 API                                 │          │
│  │  - 播放器實例管理                                             │          │
│  │  - 字幕請求攔截                                               │          │
│  └──────────────────────────────────────────────────────────────┘          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 層級說明

#### Layer 1: Service Worker (background.js)
- **職責**: API 通信、數據同步、用戶管理
- **生命週期**: 事件驅動，可能頻繁重啟
- **通信**: 使用 `chrome.runtime.connect` 建立長連接

#### Layer 2: Content Script (content.js)
- **職責**: 橋接擴充功能與頁面
- **隔離**: 運行在獨立沙箱，無法直接訪問頁面 JavaScript
- **唯一注入所有者**: `content.js` 是 `netflix-page-script.js` 的唯一 physical injector；readiness 成功後才注入 MAIN world 的 `content/index.js`
- **Page Script readiness marker**: 以 `script[data-subpal-page-script-state]` 保存跨 isolated globals 共用的 physical attempt。成功狀態是 `data-subpal-page-script-state="ready"`，`subpal-page-script-ready` 是相關聯的回應事件；終止重試時狀態為 `failed-terminal`
- **相關聯握手**: readiness request/response 必須同時匹配 `attemptId`、`probeId`、`deadline` 與 `readyAt`，避免接受前次 attempt、晚到或偽造的 ready 訊號

#### Layer 3: Page Context (content/index.js)
- **職責**: 核心業務邏輯、UI 管理、字幕處理
- **環境**: 運行在 Netflix 頁面的 JavaScript 環境
- **通信**: 通過 CustomEvent 與 Content Script 通信

#### Layer 4: Netflix Page Script (netflix-page-script.js)
- **職責**: 攔截 Netflix CDN 字幕請求、管理播放器實例、提供播放診斷快照
- **權限**: 完整訪問 `window.netflix` 對象與內部 API
- **通信**: 通過 `window.postMessage` 與 Page Context 通信
- **播放會話選擇**: `selectActivePlaybackSession()` 使用多層次信心評分
  - `confidence: 'high'` — playerApiVideoId 或 movieId 與 URL videoId 匹配
  - `confidence: 'medium'` — watch session 具有合理的 playback state（duration > 0, currentTime 合理）
  - `confidence: 'low'` — player-helper-session-fallback 或 first-open-session-fallback
  - `confidence: 'none'` — 無開放播放會話
  - `selectedSessionReason` current values: `watch-player-api-video-id-match`, `watch-movie-id-match`, `watch-reasonable-playback-state`, `player-helper-session-fallback`, `first-open-session-fallback`, `no-open-playback-session`
- **診斷快照**: `getDebugSnapshot()` 回傳完整播放狀態（session、track、currentTime、recent events）
- **trusted watch session**: 僅 sessionId 以 `watch-` 開頭且 confidence ≥ `medium` 且非 fallback 來源才算 trusted

#### UI 能力路由
- `Popup` 是封閉的 active-profile stats client，只送出 `chrome.runtime.sendMessage` 的 `POPUP_ACTIVE_PROFILE_STATS` one-shot request，回來的資料會先正規化成 `Result`，只保留 `active-backend-profile-user` scope 的 masked identity 與 totals。
- `Options` 是 privileged `BackendProfiles` client，透過 `options-page-channel` port 呼叫 `BACKEND_PROFILES_LIST`、`BACKEND_PROFILES_CREATE`、`BACKEND_PROFILES_ACTIVATE`、`BACKEND_PROFILES_DELETE`、`BACKEND_PROFILES_EXPORT_QUEUE`、`BACKEND_PROFILES_RETRY_FAILED`，回傳同樣維持 normalized `Result`。
- `content.js` 與 `background.js` 共享 `subtitle-assistant-channel` port，private transport source 是 `subpal-content-script`，內容腳本只負責 private DOM request/response 的橋接，不直接碰 Netflix page context 的內部狀態。
- `MAIN` world 只消費 content-local typed settings snapshot，`Content -> MAIN` 的 one-way projected `CONFIG_CHANGED` notification（`messageFromContentScript`），不直接讀 `chrome.storage.local`。
- `settings-read/snapshot` 由 `content.js` 直連的 private DOM request/response 處理，不屬於 `PageIngress.accept()` 的 sealed route；`SettingsSnapshot` 只有 `read()` 與 `dispose()`，snapshot 只透過這條私有路徑回來。
- `Playback` 走 page transport 的 `perform()`，支援 `context-snapshot`、`available-languages`、`current-language`、`switch-language`、`switch-track`、`jump-to-timecode`。
- `Subtitles` 只暴露 `query()`，把 `replacement-subtitle-query` 綁到目前 playback context。
- `Contributions` 暴露 `enqueue`、`getProjection` 與 `retry`，背景 owner 保持投票、翻譯與替換事件的持久化。
- `GET_CROWDSOURCING_TASKS` 是 background 承接的 direct privileged crowdsourcing 例外，僅限 Netflix content script 且通過 sender、watch、videoID、limit、languageCode guard。
- backend profile 的 `queueCounts` 是 profile-scoped，`exportQueue` 只允許 active profile，`deleteProfile` 預設會拒絕有 pending、syncing、failed 紀錄的 profile，`discard: true` 才會移除那些資料，`retryFailed` 需要 `confirmInactiveProfile` 才能碰 inactive profile。

---

## 核心模組

### 1. System Layer（系統層）

#### 1.1 InitializationManager (`content/system/initialization-manager.js`)

**職責**: 統一管理所有組件的初始化流程

**外層 Content Script 啟動閘門**:

```javascript
1. connectToBackground()
2. ensureNetflixPageScriptReady()       // 建立共享 readiness Promise 並由 content.js 負責 physical injection
3. initializeConfigManager()
4. await pageScriptReady                 // 等待 content.js 擁有的 readiness handshake
5. startPageContextOnce()                // 注入 MAIN world content/index.js
6. startIsolatedEndscreenTasksOnce()     // ConfigManager 可用時啟動 isolated owner
```

啟動失敗矩陣：

- Page Script 進入 `failed-terminal`：MAIN 與 isolated owners 都不啟動，不建立背景重試，保留 Netflix 原生字幕。
- ConfigManager 初始化失敗：若 Page Script ready，仍啟動 MAIN；沒有可用的 ConfigManager 時不啟動 isolated endscreen owner。
- isolated endscreen task 初始化失敗：不回滾已啟動的 MAIN，僅記錄該模組失敗。
- background contribution queue 不在 content.js 初始化；內容端只建立 private transport，持久化 queue 由 background 層的 queue owner 管理。
- 所有啟動入口都以共享 Promise 或 single-flight guard 去重，避免平行建立重複 owner。

**MAIN world InitializationManager 順序（7 階段並行優化流程）**:

```javascript
1. initializeMessaging()         // 建立消息通信（必須先完成）
2. initializeConfigBridge()      // 初始化配置橋接器（必須先完成）
3. initializePageScript() +      // 只等待既有 Netflix Page Script readiness（與配置並行）
   loadConfiguration()           // 載入配置（與 Page Script 並行）
4. waitForPlaybackPage()         // 等待用戶進入播放頁面，
                                 // 同時在內部啟動 setupVideoMonitoring()（視頻切換背景監控）
5. checkNetflixAPI()             // 檢查 Netflix API、初始化播放器助手、
                                 // 立即啟動字幕攔截器、初始化 PlaybackContextManager
6. initializeComponents()        // 初始化 UI 管理器、字幕樣式管理器、字幕協調器
7. integrateAndStart()           // 整合和啟動系統（事件流綁定、通知背景）
```

**設計要點**:
- **注入權限集中**: MAIN world 不要求或執行 Page Script 注入；`InitializationManager` 與 playback capability 只做最多 5 秒的 bounded readiness wait
- **階段 3 並行**: Page Script readiness wait 與 Config 載入同時進行，減少等待時間
- **攔截器提前啟動**: 階段 5 在 Page Script readiness 後初始化 player helper、字幕攔截器與 PlaybackContextManager，確保 Netflix 預設字幕請求在發生的當下即被攔截
- **PlaybackContextManager**: 階段 5 中初始化，追蹤播放 session/videoId/track 狀態並作為字幕處理 gate
- **安全初始化**: SubtitleCoordinator 不依賴語言列表決定生死；Netflix SPA 換片時 player/languages 可能短暫不可讀，由 coordinator 的 soft/hard 分類與背景回升處理
- **降級模式**: MAIN 元件初始化失敗時可嘗試基本 DOM 監聽；但 Page Script `failed-terminal` 發生在外層閘門，MAIN 不會啟動，因此不建立 DOM fallback

**生命週期管理**:
- 頁面加載時自動初始化
- 頁面隱藏時暫停字幕處理
- 頁面顯示時恢復運行
- 提供 `cleanup()` 方法進行清理
- 影片切換時清理並重新初始化 UI 組件
- 狀態包含 `messagingReady`、`pageScriptInjected`、`netflixAPIAvailable`、`playbackContextReady`、`configLoaded`、`componentsReady`

#### 1.2 Messaging System (`content/system/messaging.js`)

**職責**: 抽象化 Page Context 與 Content Script 之間的通信

**實際 exports**:
```javascript
initMessaging()
registerInternalEventHandler(type, handler)
dispatchInternalEvent(message)
isPageScriptAvailable()
waitForPageScript(timeout)
```

`initMessaging()` 以單一 `messagingInitializationPromise` 合併重複呼叫，確保 ConfigBridge 初始化與 window listener 只建立一次。它只接收 `messageFromContentScript` 的 guarded reverse-DOM event：`parseContentScriptBridgeMessage()` 先驗證 envelope，再由 `parseVideoIdChangedMessage()` 檢查允許欄位與 primitive 值，產生 fresh normalized `VIDEO_ID_CHANGED` 物件後才交給 `dispatchInternalEvent()`。

Messaging System 不提供 Page Script injection API. There is no generic public `sendMessage`/`onMessage`/register handler bus。跨 context 的 request/response 由各 capability 的 private typed envelope 負責；此模組只有內部事件分發與 Page Script readiness surface。

#### 1.3 Playback Capability (`content/system/capabilities/playback.js`)

**職責**: 封裝 Page Context 對 Netflix Page Script 的允許播放操作。

**Readiness 邊界**: `createPagePlayback()` 不負責注入 Page Script。它只在 `content.js` 完成 readiness handshake 後，以 private typed envelope 呼叫 Page Script。

**核心 surface**:
- `Playback.perform({ variant: 'context-snapshot' })` - 取得 strict `Result` 播放診斷快照
- `available-languages`、`current-language`、`switch-language`、`switch-track`、`jump-to-timecode` - 僅限既有 caller 的 typed variant

#### 1.4 Config System（配置系統）

**組件**:
- `config-schema.js` - Schema 定義與默認值
- `config-manager.js` - 中央配置管理器
- `config-bridge.js` - Page Context 配置橋接
- `storage-adapter.js` - Storage 訪問封裝

**設計特點**:
- **Observable Pattern**: 支持配置變更訂閱
- **類型安全**: 自動驗證配置值類型
- **批量操作**: 減少 Storage 訪問次數
- **扁平化鍵名**: 使用點記法（如 `subtitle.primaryLanguage`）
- **唯一權威通知**: changed-value write 只由 isolated `ConfigManager` 的 storage change 發布；content script 再轉送單一 `CONFIG_CHANGED` projected one-way notification 給 MAIN `ConfigBridge`。首次寫入原本不存在的 leaf 時，notification 的 `oldValue` is `undefined`；這是新值沒有舊 storage value 的正常語義。
- **本地通知語義**: same-value write 因 Chrome 不產生 storage change，由 `ConfigManager` 明確通知一次；失敗寫入回滾 cache 且不發布通知。這只描述本地通知，不宣稱任何 server effect 的 exactly-once delivery。

---

### 2. Core Layer（核心層）

#### 2.1 SubtitleReplacer (`content/core/subtitle-replacer.js`)

**職責**: 協調字幕替換、本地投稿 reconciliation 與安全渲染資料；網路 coverage/cache/retry 狀態交由其擁有的 `SubtitleFetchCoordinator`。

**Fetch 與 cache**:

- caller 不需要知道影片總長；每次固定查詢目前需求點往後 180 秒。
- coordinator 以 interval union 計算 `in-progress`/`completed` coverage；成功空批次是 negative cache，failed 不算 coverage。
- coverage 剩餘不足 60 秒時從最遠連續 endpoint prefetch。`play` 立即檢查，播放中每 15 秒檢查，`seeked` 250 ms debounce，字幕 render event 是漏接 fallback。
- session memory cache scope 為 `(videoId, sessionId, localEpoch, subtitleSourceGeneration)`，不持久化；換片、playback identity 或 backend source 改變即清除。
- 每批 response 是其 range 的權威快照，不使用獨立筆數上限淘汰字幕而保留虛假的 completed coverage。
- replacement 只以 canonical `slotKey` 精確命中，不使用舊的文字與時間容差組合 cache key。

**安全與流量限制**:

- 同時最多兩筆 request；滿載時只保留最新 demand，prefetch 不排隊。
- Retryable failure 使用 2/10/30/60 秒冷卻，下一次 tick/seek/render demand 才能重試；messaging 不 replay。
- Response 最多 1,000 筆、單一文字最多 10,000 字；wrong-video、out-of-range、非 canonical slot key 或欄位錯誤會整批拒絕且不污染 cache。
- fetched replacement 在單語與雙語路徑都使用 `textContent` 與 `white-space: pre-wrap`，不把 `suggestedSubtitle` 插入 `innerHTML`。

#### 2.2 Background Contribution Queues（背景貢獻隊列）

**職責**: 背景層管理投票、翻譯與替換事件的持久化佇列

**隊列類型**:
```javascript
{
  voteQueue: [],
  translationQueue: [],
  replacementEventQueue: []
}
```

**狀態語義**:
- `pending` - 等待同步
- `syncing` - 同步中
- `completed` - 已完成；同步成功後移入對應 history，不留在 queue
- `failed` - 失敗；可由背景 retry 路徑重新排回 `pending`，或標記為永久失敗

**公開面**:
- `enqueueVote`、`enqueueTranslation`、`enqueueReplacementEvent` 是內容端的提交動作，不是背景層公開 API。
- `background/contribution-queue.js` 才是真正的持久化 owner，負責 profile binding、projection 與 retry。
- `retryContribution()` 與 `retryFailedContributions()` 是背景內部重試輔助，不對 UI 暴露掃描式介面。

背景現在以 contribution queue 與 projection/retry 路徑為主。

#### 2.3 Bridge Modules（橋接器）

**VoteBridge** (`content/core/vote-bridge.js`):
```javascript
// 提交投票
voteBridge.enqueue({
  videoId: '12345',
  timestamp: 123.456,
  voteType: 'upvote',  // 'upvote' | 'downvote'
  translationID: 'abc123',
  originalSubtitle: 'Hello'
});
```

**TranslationBridge** (`content/core/translation-bridge.js`):
```javascript
// 提交翻譯建議
translationBridge.enqueue({
  videoId: '12345',
  timestamp: 123.456,
  original: 'Hello',
  translation: '你好',
  languageCode: 'zh-Hant',
  submissionReason: '語境不準確'
});
```

**ReplacementEventBridge** (`content/core/replacement-event-bridge.js`):
```javascript
// 記錄替換事件
replacementEventBridge.enqueue({
  translationID: 'abc123',
  contributorUserID: 'user456',
  occurredAt: Date.now()
});
```

**特點**:
- 15 分鐘去重窗口
- 異步記錄不阻塞字幕替換
- 自動批次提交（最多 100 個）
- `contributorUserID` 仍是 MAIN 送出的事件資料；background queue 會從 active profile atomically 補上 `beneficiaryUserID` 與 `backendProfileId`，再一起落庫。

#### 2.4 VideoInfo (`content/core/video-info.js`)

**職責**: 提取和管理影片信息

**提取的信息**:
```javascript
{
  videoId: '80234304',           // Netflix 影片 ID
  title: 'Stranger Things',      // 影片標題
  language: 'en',                // 主要語言
  episodeInfo: {                 // 劇集信息（如果是影集）
    season: 1,
    episode: 1,
    title: 'The Vanishing of Will Byers'
  }
}
```

**來源**:
- URL 解析
- Netflix API 響應
- DOM 元素提取

#### 2.5 PlaybackContextManager (`content/core/playback-context-manager.js`)

**職責**: 統一管理目前 Netflix 播放 session/videoId/track 狀態，作為字幕處理的 gate 與診斷來源。

**核心概念**:
- **Epoch**: 每次 videoId 或 sessionId 改變時遞增，用於判斷字幕資料是否屬於當前播放上下文
- **State**: `ready`（播放上下文就緒）或 `transitioning`（SPA 切換中，字幕處理暫緩）
- **Polling**: 以 `Playback.perform({ variant: 'context-snapshot' })` 經 private typed envelope 向 Page Script 取得 strict `Result` 診斷快照，從中提取播放會話資訊

**工作流程**:
```javascript
1. 初始化時以 `Playback.perform({ variant: 'context-snapshot' })` 向 Page Script 請求診斷快照
2. 從快照中提取播放 session、videoId、currentTrack
3. 使用信心評分（sessionSelectionConfidence）篩選有效的 watch session
4. 當 videoId 或 sessionId 改變時遞增 epoch 並轉為 transitioning 狀態
5. 狀態變更時觸發 PLAYBACK_CONTEXT_CHANGED 內部事件
6. SPA 切換後 1 秒延遲刷新一次，等待 player session ready
```

**PlaybackContext 結構**:
```javascript
{
  epoch: 3,                     // 上下文版本號
  videoId: '80234304',          // 當前影片 ID
  sessionId: 'watch-xxx',       // Netflix 播放會話 ID
  currentTrack: {               // 當前字幕軌道
    code: 'zh-Hant',
    name: '繁體中文',
    trackId: 12345,
    trackType: 'subtitle'
  },
  state: 'ready',               // 'ready' | 'transitioning'
  selectedSessionReason: 'watch-player-api-video-id-match',
  sessionSelectionConfidence: 'high'
}
```

**作為 Gate 的輸入來源**:
- PlaybackContextManager 提供 epoch、state、sessionId 等狀態，供 SubtitleInterceptor 的 `evaluateSubtitleGate()` 判斷字幕是否可進入處理流程
- transitioning 狀態下的字幕請求被暫緩（非拒絕），由 SubtitleInterceptor 的 `scheduleReloadAfterContextReady()` 在 ready 後重試
- 已解析字幕 cache 需通過 epoch 比對確保屬當前上下文
- 非 watch session（首頁 billboard/preview 字幕）被明確拒絕，避免污染同語言 cache

---

### 3. UI Layer（UI 層）

#### 3.1 UIManager (`content/ui/ui-manager-new.js`)

**職責**: 協調者角色，統一管理所有 UI 組件的生命週期與字幕顯示流程。

**管理的組件**:
- SubtitleDisplay（字幕顯示）
- InteractionPanel（交互面板）
- SubmissionDialog（提交對話框）
- FullscreenHandler（全螢幕處理）
- UIAvoidanceHandler（控制欄閃避）
- ToastManager（通知）
- **核心模組**: `UIManager` 會在 `initialize()` 內建立並管理 `SubtitleReplacer`，把字幕替換生命週期收進 UI 協調流程

**原生字幕可見性狀態機**:

UIManager 維護原生 Netflix 字幕的可見性狀態，透過注入/移除 CSS 規則（`subpal-hide-native-subtitles` style element）控制：
- `showNativeSubtitles(reason)`: 移除隱藏樣式，恢復 Netflix 原生字幕
- `hideNativeSubtitles(reason)`: 注入 CSS clip-path 規則隱藏原生字幕

**備援通知狀態機（fallback/recovery toast）**:
- `recoveryNotificationState`: 管理備援 toast 的顯示時機與類型
- `isFallbackActive()`: 判斷是否處於備援狀態（context ready + interceptor active + primary 未就緒）
- 轉場備援（3 秒）vs 初始載入備援（8 秒）: 根據 `_pendingRecoveryIsTransition` 標記選擇不同的倒數時間
- `scheduleLongRecoveryTimeout()`: 收到 `PRIMARY_DISCOVERY_DOM_SAMPLE_DETECTED` 後 15 秒顯示長時間復原通知

**影片切換處理**:
- 監聽 `VIDEO_ID_CHANGED` 內部事件
- 清理所有 UI 組件 → 重新初始化 → 發出 `UI_COMPONENTS_REINITIALIZED` 事件
- 通知 `SubtitleStyleManager` 重新套用樣式

**字幕可見性同步**:
- `syncNativeSubtitleVisibilityForSubtitle()`: 根據字幕數據與 render readiness 決定是否隱藏原生字幕
- `SUBTITLE_READINESS_CHANGED` 事件驅動主要邏輯

#### 3.2 SubtitleDisplay (`content/ui/subtitle-display.js`)

**職責**: 渲染字幕到 Netflix 播放器

**字幕容器結構**:
```html
<div id="subpal-region-container">
  <div id="subpal-primary-subtitle">主要字幕</div>
  <div id="subpal-secondary-subtitle">次要字幕</div>
</div>
```

**Region 容器設計**:
- `#subpal-region-container` 使用 `position: fixed`，由 Netflix 字幕 region 的 `left`、`top`、`width`、`height` 更新位置與大小。
- primary 與 secondary 是獨立的 fixed subtitle containers；需要 region-based positioning 時才移入 region container。
- 使用 Flexbox 進行垂直佈局，`displayAlign: 'after'` 對應靠下排列，其餘情況靠上排列。
- 單語模式則使用 `#subpal-subtitle-container` 與 `.subpal-subtitle-text`。

**字幕樣式**:
- 支援 `fontWeight`（400/700）、`fontPreset`（system/clearSans/serif/code）
- 支援 glyph text outline 與 `letterSpacing`，分別由 `subtitle.style.primary.*` 與 `subtitle.style.secondary.*` 經由 storage、ConfigBridge、SubtitleStyleManager 傳入 SubtitleDisplay
- 支援 `styleMode`：`custom`（自訂樣式）、`netflixPreset`（Netflix 原生風格）；另有內部運行時模式 `nativeInherit`（繼承 Netflix 計算樣式，非匯出 schema 值）
- 支援 `setStyleMode()`、`setDualModeStyles()` 接口
```javascript
// 動態應用樣式
{
  fontSize: '24px',
  color: '#ffffff',
  textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
  backgroundColor: 'transparent',
  fontFamily: 'Netflix Sans, Arial, sans-serif',
  fontWeight: '700'
}
```

#### 3.3 InteractionPanel (`content/ui/interaction-panel.js`)

**職責**: 顯示字幕操作面板（讚/倒讚/提交）

**功能**:
- 顯示當前字幕的投票狀態
- 提供讚/倒讚按鈕
- 提供提交新翻譯按鈕
- 顯示字幕貢獻者信息

**交互流程**:
```
用戶點擊讚按鈕 → InteractionPanel → VoteBridge → 背景 contribution queue → Storage → Background Sync → API
```

#### 3.4 SubmissionDialog (`content/ui/submission-dialog.js`)

**職責**: 翻譯提交對話框

**表單字段**:
- 原文（只讀）
- 翻譯（輸入框）
- 提交原因（選擇框）
- 語言選擇（下拉框）

**驗證**:
- 翻譯不可為空
- 語言必須選擇
- 防止重複提交

#### 3.5 FullscreenHandler (`content/ui/fullscreen-handler.js`)

**職責**: 處理全螢幕模式下的 UI 調整

**問題**: Netflix 使用 Shadow DOM 和自定義全螢幕實現

**解決方案**:
1. 監聽 `fullscreenchange` 事件
2. 檢測 Netflix 播放器容器
3. 將字幕容器移入播放器內部（全螢幕時）
4. 恢復到 body（退出全螢幕時）

```javascript
// 組件註冊
FullscreenHandler.registerUIComponent(component, options);

// 選項
{
  getElement: () => element,           // 獲取 DOM 元素
  shouldMove: () => boolean,           // 是否應該移動
  getFullscreenContainer: () => container  // 全螢幕容器
}
```

#### 3.6 UIAvoidanceHandler (`content/ui/ui-avoidance-handler.js`)

**職責**: 當 Netflix 控制欄出現時，自動調整字幕位置

**實現**:
```javascript
// 監聽控制欄可見性
const observer = new MutationObserver((mutations) => {
  const isControlVisible = controls.clientHeight > 0;
  const offset = isControlVisible ? -70 : 0;
  subtitleContainer.style.transform = `translateY(${offset}px)`;
});
```

#### 3.7 ToastManager (`content/ui/toast-manager.js`)

**職責**: 顯示通知消息

**API**:
```javascript
ToastManager.success('翻譯提交成功！');
ToastManager.error('提交失敗，請稍後重試');
ToastManager.info('正在同步數據...');
```

**特點**:
- 自動消失（3 秒）
- 支持不同類型（success/error/info/warning）
- 隊列管理避免重疊

#### 3.8 SubtitleStyleManager (`content/ui/subtitle-style-manager.js`)

**職責**: 統一管理單語和雙語字幕樣式，依賴注入模式接收現有 UIManager 實例。

**設計要點**:
- **ConfigBridge 驅動**: 不直接管理配置，只訂閱 ConfigBridge 的樣式配置變更
- **依賴注入**: `initialize(uiManager)` 接收外部 UIManager 實例
- **樣式模式**: 支援 `styleMode`（`custom`/`netflixPreset`；`nativeInherit` 為內部運行時模式）、`fontPreset`、`fontWeight`、`outlineEnabled`、`outlineWidth`、`outlineColor`、`letterSpacing`
- **雙語樣式**: 獨立管理 primary/secondary 兩組樣式配置，並把 outline 與 `letterSpacing` 轉成 `SubtitleDisplay` 可直接套用的 legacy style
- **UI 重建恢復**: 監聽 `UI_COMPONENTS_REINITIALIZED` 事件，在影片切換後重新套用樣式

**樣式應用路徑**:
```
ConfigBridge 配置變更 → SubtitleStyleManager.handleStyleChange()
  → applyCurrentStyle()
    → applySingleModeStyle() / applyDualModeStyle()
      → SubtitleDisplay.setSubtitleStyle() / setDualModeStyles()
        → glyph text outline + `letterSpacing`
```

#### 3.9 NetflixPlayerAdapter (`content/ui/netflix-player-adapter.js`)

**職責**: 適配 Netflix 播放器的各種狀態

**監聽的狀態**:
- 播放/暫停
- 時間更新
- 字幕軌道切換
- 影片切換

**API**:
```javascript
// 獲取播放器實例
getPlayer()

// 獲取當前時間（秒）
getCurrentTime()

// 獲取播放狀態
getPlayerState()  // 'playing' | 'paused' | 'buffering'

// 監聽時間更新
onTimeUpdate(callback)
```

---

### 4. Subtitle Modes（字幕模式）

#### 4.1 SubtitleCoordinator (`content/subtitle-modes/subtitle-coordinator.js`)

**職責**: 協調不同字幕模式之間的切換、管理模式健康度與背景重試。

**設計理念**:
- Netflix 的字幕系統複雜且多變
- 單一模式無法覆蓋所有場景
- 需要根據情況動態切換模式
- 攔截模式的不可用分為「短暫未就緒」（soft_not_ready）與「真正不可用」（hard_fail）

**支持的模式**:
1. **DOM Monitor Mode** - 監聽原生字幕 DOM 變化（降級模式）
2. **Interceptor Mode** - 攔截字幕請求（主模式，支持雙語）

**模式健康度 (`modeHealth`)**:
- `intercept_warming_up` — 攔截器剛啟動或短暫未就緒
- `intercept_ready` — 攔截器正常運作
- `intercept_degraded_retrying` — 攔截器連續失敗，背景重試中
- `dom_emergency` — 攔截器無法使用，降級到 DOM 模式

**協調策略** (三狀態決策):
```javascript
ModeDetector.detectInterceptModeStatus()
  status === 'ready'      → 啟用攔截模式，停止背景重試
  status === 'soft_not_ready' → 保持攔截模式，啟動背景升級重試
  status === 'hard_fail'  → 進入 DOM emergency 模式
```

**背景重試 (Background Upgrade)**:
- `startBackgroundUpgrade()`: 每 2 秒嘗試恢復攔截模式，最多 120 秒
- `silentUpgradeToInterceptor()`: 靜默升級回到攔截模式，用戶無感知
- 重試過程中保留 DOM 模式顯示字幕，不影響觀看

**DOM Emergency 降級**:
- 攔截連續失敗 `maxInterceptFailuresBeforeDom`（3 次）後觸發
- 切換到 DOM 模式同時在背景持續嘗試恢復攔截
- 顯示 toast 通知用戶

**未初始化時的狀態管理**:
- SubtitleCoordinator 的 `initialize()` 現在主要由 InitializationManager 的 `initializeSubtitleCoordinatorSafely()` 控制
- 攔截器初始化可能失敗（Netflix SPA 換片時），只記錄 `modeHealth = intercept_warming_up` 而不終止流程

#### 4.2 ModeDetector (`content/subtitle-modes/mode-detector.js`)

**職責**: 檢測攔截模式狀態，區分短暫未就緒與真正不可用。

**三狀態決策 (非二元)**:

`detectInterceptModeStatus()` 回傳三種 status：
- `ready` — 攔截模式可啟動（Page Script 已注入、Netflix API 可用、播放器就緒、字幕攔截功能正常）
- `soft_not_ready` — Netflix SPA/播放器/字幕資料仍在 warming up，應保持攔截重試（如 `player-not-ready`、`languages-unavailable`、`interceptor-not-active`）
- `hard_fail` — Page Script 或基本通訊不可用，才允許進入 DOM emergency（如 `not-netflix-page`、`page-script-unavailable`）

**檢測流程**:
```javascript
1. isNetflixPage()                     // 檢查是否在 Netflix 域名
2. ensurePageScriptInjected()          // 舊方法名；實際只送出最多 1 秒的 PING，不執行注入或 reinjection
3. checkNetflixAPIAvailability()       // 檢查 Netflix API 可用性
4. checkPlayerReadiness()              // 檢查播放器準備狀態
5. checkSubtitleInterceptCapability()  // 檢查字幕攔截功能（語言列表、攔截器活躍度）
```

#### 4.3 DOMMonitor (`content/subtitle-modes/dom-monitor.js`)

**職責**: 通過監聽 DOM 變化獲取字幕

**實現**:
```javascript
// 監聽 Netflix 字幕容器
const observer = new MutationObserver((mutations) => {
  const subtitleElements = document.querySelectorAll('.player-timedtext span');
  const text = Array.from(subtitleElements).map(el => el.textContent).join('\n');
  
  // 觸發字幕更新事件
  onSubtitleUpdate({
    text,
    timestamp: getCurrentTime()
  });
});
```

**特點**:
- 不依賴 Netflix 內部 API
- 兼容性最好
- 不支持雙語字幕（只能看到當前顯示的語言）

#### 4.4 SubtitleInterceptor (`content/subtitle-modes/subtitle-interceptor.js`)

**職責**: 攔截 Netflix 的字幕請求，管理 raw TTML 快取、語言獲取與 primary discovery 復原。

**實現原理**:
1. 使用已由 `content.js` 注入且通過 readiness 的 Page Script
2. 攔截 `XMLHttpRequest` 和 `fetch`
3. 識別字幕請求（TTML 格式）
4. 解析字幕數據並通過 postMessage 發送
5. 與 PlaybackContextManager 整合，依據影片歸屬與 epoch 進行嚴格門檻檢查

**主要流程**:

**A. Primary discovery / acquisition flow**:
```
loadInterceptedSubtitles()
  → checkExistingCache() (快取驗證與 gate 檢查)
  → recordDefaultLanguage()
  → ensureLanguageAvailable(primaryLanguage, 'primary')
    → tryLoadLanguageFromCaches() (快取優先)
    → refreshLanguageTrack() / switchLanguageAndWait() (切換或刷新字幕軌道)
    → waitForInterception() (等候 raw TTML 攔截事件)
    → parse & promote (解析並 promotion 到 active slot)
  → ensureSecondaryLanguageAvailableOnce() (次要語言，含 idempotent 去重)
  → restoreDefaultLanguage()
```

**B. Acquisition waiter 去重**:
- `ensureSecondaryLanguageAvailableOnce()` 利用 `_secondaryAcquisitionInFlight` 確保同 videoId/epoch/language 只進行一次 secondary 軌道切換
- `acquisitionWaiters` Map 管理 pending waiter，支援超時清理

**C. Epoch-based parsed cache invalidation**:
- `isSubtitleEntryCurrent()`: 比對 cache 中的 `playbackContext.epoch` 與目前 PlaybackContext epoch
- `ensureActiveSubtitleSlotsCurrent()`: 在每次渲染循環前檢查 active slot 是否仍屬當前 context

**D. Raw TTML pool management**:
- 透過 `interceptedSubtitles` Map 保留所有已解析的 raw TTML
- `cleanupOldVideoCache()`: 影片切換時清理不屬於當前影片的緩存（DOM match 歸屬的 entry 保留）
- `captureTtmlEvidence()`: 接收 `TtmlAcquisitionIngress` 驗證後的 raw TTML evidence，經過 gate/promotion guard 後決定是否 promotion 到 active slot

**E. 語言/情境過濾**:
- `evaluateSubtitleGate()`: 嚴格的多層次門檻檢查，包含：
  - 播放上下文狀態（transitioning 時暫緩）
  - transitioning 狀態下由 `scheduleReloadAfterContextReady()` 排程在 ready 後重試
  - request session 必須為 watch- 前綴（拒絕 billboard/preview）
  - cache-key/mismatch、evidence-confidence、session-mismatch 等多層次檢查
- `isSubtitleSlotMetaCurrent()`: slot lock-in 機制防止同影片短暫轉換閃爍

**F. DOM Overlap Recovery 整合**:
- `tryStartPrimaryDiscovery()`: 啟動 DOM overlap match recovery，繞過傳統 track switching
- 透過 `DOMOverlapMatcher` 收集原生字幕 DOM 文字並比對 raw TTML pool
- 匹配成功時以 `native-dom-match` attribution 通過 gate 豁免
- 匹配成功後自動觸發 secondary acquisition

**攔截的請求**:
```javascript
// 攔截包含以下特徵的請求
const subtitlePatterns = [
  /\.nflxvideo\.net.*\.ttml/,
  /\.oca\.nflxvideo\.net.*\/subtitles/
];
```

**特點**:
- 支持雙語字幕（獲取所有語言軌道）
- 精度更高（包含完整時間戳）
- 需要成功注入 Page Script
- 渲染循環每 100ms 更新一次，使用時間索引加速查找
- render-readiness gating 控制原生字幕隱藏時機（僅在 primary ready 後才隱藏）

#### 4.5 DOMOverlapMatcher (`content/subtitle-modes/dom-overlap-matcher.js`)

**職責**: 收集 Netflix 原生字幕 DOM 文字，與 page script raw TTML pool 中的候選做 overlap match，回傳最佳匹配的候選。

**角色**: 專用於 episode-change/SPA 字幕復原情境。當 track switching 無法取得正確影片的 TTML 時（例如 cache-key-video-mismatch），透過比對螢幕上實際顯示的文字與已攔截的 raw TTML，找出正確的字幕資料。

**核心流程**:
```
1. collectDOMSample() — 收集 Netflix 原生字幕 DOM 文字
   - 偏好 leaf spans（葉節點 span，最接近實際顯示文字）
   - 降級到 all-spans → container textContent
   - 去重（避免 karaoke 模式重複 span）與正規化
   - 使用 video element 即時時間戳（降級到 PlaybackContext snapshot）

2. fetchCandidates(languageCode) — 從 page script 取得 raw TTML pool
   - 語言過濾（支援 base-code fallback）
   - 排除非 watch session 的 TTML

3. findMatchingCues() — 從候選字幕中找出時間窗口 (±750ms) 內的 cue

4. scoreCandidate() — 計算 overlap score
   - score = matchedUnits / max(domUnits.length, minComparableUnits)
   - 門檻：≥6 chars 時 score ≥ 0.75；3-5 chars 時 score ≥ 0.90

5. rankResults() — 排名（score → subtitlesCount → requestTime）

6. findBestMatch() — 回傳最佳匹配結果
```

**Reactive DOM watching**:
- `startWatching(languageCode, onMatch)`: 啟動 MutationObserver，監聽 `.player-timedtext-text-container`
- 300ms debounce + 1000ms max-wait 計時器，避免高頻變動時重複執行
- body 觀察器處理容器未出現的情境（30 秒超時）
- root 觀察器偵測容器被替換（Netflix SPA 切換時常見）

**與 SubtitleInterceptor 整合**:
- 由 `SubtitleInterceptor.startPrimaryDiscovery()` 啟動
- match 結果經由 `handleDomMatchResult()` 或 `tryPrimaryDiscoveryMatch()` 處理
- 成功匹配的 entry 以 `native-dom-match` attribution 通過 `evaluateSubtitleGate()` 的豁免檢查

---

### 5. Utils（工具層）

#### 5.1 LanguageCode (`content/utils/language-code.js`)

**職責**: 統一前端設定值與 API 使用的語言代碼格式。

**核心映射**:
```javascript
// 前端設定 → API 格式
'zh-Hant' → 'zh-TW'
'zh-Hans' → 'zh-CN'
// 其餘語言代碼保持不變
```

**使用場景**: `SubtitleCoordinator.normalizeSubtitleData()` 中將 `primaryLanguageCode` 轉為 API 語言代碼，用於 `buildSlotKey()`。

#### 5.2 SlotKey (`content/utils/slot-key.js`)

**職責**: 統一前端字幕 slot 的識別規則，避免各模組各自重算造成 key 不一致。

**slotKey 格式**: `{videoID}::{originalSubtitle}::{languageCode}::{timestamp.toFixed(4)}`

**使用場景**: 用於投票 (`submitVote`) 與翻譯 (`submitTranslation`) 的 payload 中，作為後端比對同一字幕位置的唯一識別值。

#### 5.3 SubtitleParser (`content/utils/subtitle-parser.js`)

**職責**: 解析 TTML 格式的字幕

**TTML 格式示例**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
      <p begin="00:00:01.000" end="00:00:04.000" region="bottom">
        Hello World
      </p>
    </div>
  </body>
</tt>
```

**解析功能**:
```javascript
// 解析 TTML 字符串
const subtitles = SubtitleParser.parse(ttmlString);

// 返回結果
[
  {
    id: 'subtitle_0',
    startTime: 1.000,  // 開始時間（秒）
    endTime: 4.000,    // 結束時間（秒）
    text: 'Hello World',
    region: 'bottom'   // 位置
  }
]
```

---

### 6. Background Layer（背景層）

#### 6.1 Service Worker (`background.js`)

**職責**: 擴充功能的主入口，管理生命周期和消息路由

**初始化流程**:
```javascript
1. 建立僅供本次執行期日誌關聯的 Service Worker instance ID（不寫入 storage、不推斷重啟）
2. 註冊 onInstalled / onStartup、消息、port 與同步 listeners
3. onInstalled / onStartup 執行舊設定鍵遷移
4. 檢查 active profile 與 backendProfiles 是否存在，legacy api/user/jwt 只在 migration-only 路徑中讀取，缺少時才補齊 active profile credentials
5. sync module 載入時建立三個每 5 分鐘 alarms，並補跑現存 pending / failed queues
6. 後續受保護 API 的 401 才觸發 active profile JWT refresh
7. 解析 clientVersion（`frontend-{manifest.version}`）供後端 rollout 使用
```

**生命週期事件**:
- `onInstalled` - 首次安裝時顯示教學頁面
- `onStartup` - 瀏覽器啟動時初始化

#### 6.2 API Module (`background/api.js`)

**職責**: 封裝與後端 API 的通信

**核心 API**:
```javascript
// 用戶管理
registerUser(userId) → POST /users
fetchUserStats(userId) → GET /users/{id}

// 字幕數據
fetchSubtitles(videoId, language, startTime, endTime) → GET /translations?videoID=...

// 提交數據（可選欄位：slotKey, clientVersion, resolutionContext）
submitVote(voteData) → { success }
  // voteData: { videoID, timestamp, voteType, translationID?,
  //             originalSubtitle?, slotKey?, resolutionContext?, clientVersion? }
submitTranslation(translationData) → { success }
  // translationData: { videoId, timestamp, original, translation,
  //                    languageCode, submissionReason, slotKey?,
  //                    translationID?, sourceTranslationID?, resolutionContext?, clientVersion? }
submitReplacementEvents(events) → { success }
```

**新版 payload 欄位**:
- `slotKey`: 字幕 slot 識別值，格式 `{videoID}::{originalSubtitle}::{languageCode}::{timestamp}`
- `clientVersion`: 前端版本，格式 `frontend-{manifest.version}`，供後端 rollout 與行為觀測使用

**錯誤處理**:
```javascript
// 每個原始請求最多處理一次 401
if (response.status === 401 && autoRetryOn401) {
  if (jwtUsedForRequest === currentStorageJwt) {
    await refreshJwtTokenOnce(); // concurrent / staggered 401 共用 single-flight Promise
  }
  return retryRequestOnce();     // storage 已有較新 JWT 時直接用新值重試
}

// 請求超時（10 秒）
const timeout = setTimeout(() => abort(), 10000);
```

HTTP error 以 non-enumerable `jwtUsedForRequest` metadata 保存該 request 實際使用的 JWT，避免日誌序列化敏感 Token。`autoRetryOn401=false` 時不刷新也不重試；retry 再次得到 401 時直接失敗，不形成無限循環。

#### 6.3 Sync Module (`background/sync.js`)

**職責**: 管理數據同步隊列

**同步流程**:
```javascript
1. 從 Storage 讀取隊列
2. 過濾出 pending 狀態的項目
3. 分批發送到 API
4. 更新項目狀態（completed/failed）
5. 保存回 Storage
```

**重試策略**:
- 最大重試次數: 3 次
- 失敗項目由背景的 `retryContribution()` 與 `retryFailedContributions()` 路徑重新排程，沒有固定指數退避序列
- 永久錯誤標記（4xx 錯誤，除了 401）

**觸發邊界**:
- 一般 port 不再接受 `SYNC_DATA`、`SYNC_VOTES`、`SYNC_TRANSLATIONS`、`SYNC_REPLACEMENT_EVENTS`、`GET_SYNC_STATUS` 或三個 `TRIGGER_*` direct-sync commands。
- 對外只保留 Options 使用的 `BACKEND_PROFILES_RETRY_FAILED`，由 `BackendProfiles` client 針對指定 profile 觸發重試。
- `triggerVoteSync()`、`triggerTranslationSync()`、`triggerReplacementEventSync()` 只在 sync module 內部使用，不再對 Popup/Options 暴露成公開路由。

#### 6.4 SyncListener (`background/sync-listener.js`)

**職責**: 監聽 `voteQueue`、`translationQueue`、`replacementEventQueue` 的 storage 變化，並在 500ms 防抖後直接觸發對應同步

**觸發方式**:
- `chrome.storage.onChanged` 監聽 local storage
- 新增待同步項目時以 `debouncedTriggerSync()` 排程 `triggerVoteSync()`、`triggerTranslationSync()` 或 `triggerReplacementEventSync()`
- Service Worker 啟動時會先檢查現存隊列，再補跑一次同步

---

## 數據流與通信

### 數據流與 Gate 控制

```
                     PlaybackContextManager
                           │
                           │ (epoch / state / session)
                           ▼
              ┌──────────────────────────┐
              │   SubtitleInterceptor    │
              │     Gate Decision        │
              │ (evaluateSubtitleGate()) │
              └─────────────┬────────────┘
                              │
               accepted ──────┴────── rejected
                  │                         │
                  ▼                         ▼
           進入處理流程             暫緩/丟棄 (transitioning
                                      或非 watch session)

```

### 通信協議圖

```
┌─────────────────────────────────────────────────────────────────┐
│                      Data Flow Architecture                      │
└─────────────────────────────────────────────────────────────────┘

1. 配置與能力數據流：
   Popup active-profile stats client ──POPUP_ACTIVE_PROFILE_STATS──► background.js
   Options BackendProfiles client ──options-page-channel / BACKEND_PROFILES_*──► background.js
   MAIN settings caller ──► createPageSettings() ──private window event──► sealed PageIngress
      └──► Settings.change() ──► isolated ConfigManager
   isolated ConfigManager ──CONFIG_CHANGED──► subscribeSettingsChanges() ──► MAIN ConfigBridge ──► MAIN subscribers

   changed-value write 由 storage event 發布；same-value write 由 isolated ConfigManager 補發一次，
   MAIN 只消費 projected one-way `CONFIG_CHANGED`，不直接讀 `chrome.storage.local`。

2. 字幕數據流（正常路徑 — 含 PlaybackContext gating）：
    Netflix CDN ──intercept──► Page Script (攔截 + session 檢查)
                                    │
                                    ▼ `subpal-ttml-acquisition-captured`
                           TtmlAcquisitionIngress (validate)
                                    │
                                    ▼
                           SubtitleInterceptor (cache/gate/promotion)
                                    │
                                    ▼
                              SubtitleCoordinator
                                    │
                                    ▼
                              UIManager → SubtitleDisplay
                                      (native visibility / style)

    PlaybackContextManager ──Playback.perform(context-snapshot)──► gate context

2b. 字幕數據流（DOM Overlap Recovery / SPA 換片復原）：
   Netflix 原生字幕 DOM ──collect──► DOMOverlapMatcher
                                        │
                                        ▼ (findBestMatch)
                                   raw TTML pool (interceptedSubtitles)
                                        │ (native-dom-match attribution)
                                        ▼
                                    TtmlAcquisitionIngress.capture()
                                         │
                                         ▼ SubtitleInterceptor.captureTtmlEvidence()
                                         │ (native-dom-match attribution)
                                        ▼
                                   SubtitleCoordinator → UIManager → SubtitleDisplay

2c. PlaybackContext polling（診斷快照）：
   PlaybackContextManager ──Playback.perform({ variant: 'context-snapshot' })──► private page transport
        └──► Page Script ──strict Result playback session snapshot──► PlaybackContextManager
        │
        ├── epoch 管理（videoId/sessionId 改變時遞增）
        ├── transitioning ←→ ready 狀態切換
        └── gate 決策：transitioning 時暫緩字幕處理

3. 用戶操作數據流：
    contribution callers (VoteBridge/TranslationBridge/ReplacementEventBridge)
      ──► createPageContributions() ──private window event──► sealed PageIngress
      ──► Contributions ──private Port──► background contribution queue
      ──► chrome.storage.local ──► Background Sync ──► API Server

4. API 響應數據流：
    API Server ──► Background ──► Port ──► Content Script
                                                └──► CustomEvent ──► Page Context

5. Direct privileged crowdsourcing（獨立授權路徑）：
   isolated endscreen task client ──GET_CROWDSOURCING_TASKS runtime message──► background sender/watch/videoID/limit/languageCode guards
   此路徑不經過 `PageIngress`、`createPageContributions()` 或一般 Port broker。
```

### 消息傳遞詳情

#### 1. Page Context ↔ Content Script

**通信方式**: `window` CustomEvent；每個 request/response 都是 private typed envelope，回應必為 strict `Result`。

```javascript
// Page Context → Content Script（sealed PageIngress: page observation）
const event = new CustomEvent('messageToContentScript', {
  detail: {
    messageId: 'msg-123',
    message: {
      category: 'page-observation',
      variant: 'video-context-changed',
      payload: {
        oldVideoId: '81234567',
        newVideoId: '81234568',
        videoId: '81234568'
      }
    }
  }
});
window.dispatchEvent(event);

// Page Context MAIN → Content Script（sealed PageIngress: subtitle query / settings / contributions）
window.dispatchEvent(new CustomEvent('messageToContentScript', {
  detail: {
    messageId: 'msg-124',
    message: {
      category: 'subtitle-query',
      variant: 'replacement-subtitle-query',
      payload: {
        videoId: '81234568',
        originalSubtitle: 'Hello'
      }
    }
  }
}));

// Content Script → Page Context MAIN（回應，仍以 responseFromContentScript 傳回）
window.dispatchEvent(new CustomEvent('responseFromContentScript', {
  detail: {
    messageId: 'msg-124',
    response: { ok: true, value: {...} } // strict Result
  }
}));
```

`PageIngress.accept()` 目前接受的 sealed 路由是 `page-observation/video-context-changed`、`subtitle-query/replacement-subtitle-query`、`contribution-intent/enqueue-vote|enqueue-translation|enqueue-replacement-event|retry-operation`、`contribution-read/vote-authority|translation-reconciliation`、`settings-change`。
其中貢獻 caller 使用 `createPageContributions()`，由 sealed `PageIngress` 轉交 `Contributions`，再由 private Port 到 background；settings caller 使用 `createPageSettings()`，而 `subscribeSettingsChanges()` 只接收 content script 投影的 `CONFIG_CHANGED`。

`settings-read/snapshot` 是 content.js 直連的 private DOM request/response，不進入 `PageIngress.accept()`。

#### 2. Content Script ↔ Background

**通信方式**: chrome.runtime.connect (長連接)

```javascript
// Content Script → Background（sealed subtitle query；Subtitles.query() 透過 private Port 發送）
port.postMessage({
  messageId: 'msg-124',
  request: {
    type: 'SUBTITLE_QUERY',
    query: {
      videoId: '81234568',
      timestamp: 123.456,
      duration: 180,
      context: { videoId: '81234568', sessionId: 'watch-xxx', epoch: 3 }
    }
  }
});

// Background → Content Script
port.onMessage.addListener((message) => {
  if (message.messageId === 'msg-124') {
    // { messageId, response } 回到 content.js，再由 Subtitles.query() 做 normalized response 處理
  }
});
```

MAIN `Subtitles.query()` 只送 `{ videoId, timestamp, duration: 180 }`，並以 MAIN context 做本地 late-response suppression。isolated `Subtitles` 在 `PageIngress` 驗證後綁定自己的 authoritative `{ videoId, sessionId, epoch }` 再送出 `SUBTITLE_QUERY`；兩個 world 的 epoch 不可直接比較。background 只回 `{ messageId, response }`。

TTML acquisition 是另一條專用 ingress：Page Script 的 raw TTML evidence 由 `TtmlAcquisitionIngress.capture()` 接收、驗證並交給 `SubtitleInterceptor` 的 cache/gate/promotion 流程；它不經過 generic message bus 或 `PageIngress`。

#### 3. Page Context ↔ Netflix Page Script

**通信方式**: private typed playback envelope (`kind: 'playback'`)，由 `Playback.perform()` 發出。

```javascript
// Page Context → Page Script
Playback.perform({ variant: 'context-snapshot', payload: {} })
  // private envelope: { protocolVersion, requestId, kind, payload }
  // strict Result response carries the playback snapshot

// Page Script 回應的 Playback variants:
// - context-snapshot
// - available-languages
// - current-language
// - switch-language
// - switch-track
// - jump-to-timecode
```

### 數據格式

#### 字幕數據結構

```typescript
interface Subtitle {
  id: string;              // 唯一標識符
  startTime: number;       // 開始時間（秒）
  endTime: number;         // 結束時間（秒）
  text: string;            // 字幕文本
  region: 'top' | 'bottom' | 'center';  // 位置
}

interface TranslatedSubtitle extends Subtitle {
  translationId: string;   // 翻譯 ID
  contributorId: string;   // 貢獻者 ID
  votes: {
    up: number;           // 讚數
    down: number;         // 倒讚數
  };
  userVote: 'upvote' | 'downvote' | null;  // 當前用戶投票
}
```

#### 投票數據結構

```typescript
interface VoteData {
  videoId: string;         // 影片 ID
  timestamp: number;       // 時間戳（秒）
  voteType: 'upvote' | 'downvote'; // 投票類型
  translationID: string;   // 翻譯 ID
  originalSubtitle: string; // 原始字幕文本
}
```

#### 翻譯數據結構

```typescript
interface TranslationData {
  videoId: string;         // 影片 ID
  timestamp: number;       // 時間戳（秒）
  original: string;        // 原文
  translation: string;     // 翻譯
  languageCode: string;    // 語言代碼（如 'zh-Hant'）
  submissionReason: string; // 提交原因
}
```

---

## 關鍵功能實現

### 1. 字幕替換機制

#### 1.1 整體流程

```
1. Netflix 請求字幕文件 (CDN)
        ↓
2. Page Script 攔截請求 (判斷 session/playback context)
        ↓
3. 解析 TTML 獲取原始字幕 (含 gate 檢查)
        ↓
3a. [備援路徑] DOM 原生字幕出現 → DOMOverlapMatcher
    比對 raw TTML pool 找出正確字幕 (DOM overlap recovery)
        ↓
4. SubtitleCoordinator 統一字幕格式 (含 slotKey 產生)
        ↓
5. UIManager 處理可見性 (原生字幕隱藏時機控制)
        ↓
6. SubtitleDisplay 渲染到頁面 (樣式管理套用)
```

#### 1.2 緩存策略詳解

**為什麼需要緩存？**
- Netflix 字幕請求頻繁
- API 調用有延遲和配額限制
- 同一字幕會多次顯示

**現行緩存設計**:
```javascript
class SubtitleFetchCoordinator {
  // 以目前播放 context 與字幕來源世代隔離記憶體快取。
  scopeKey = `${videoId}:${sessionId}:${localEpoch}:${subtitleSourceGeneration}`;

  // 每次 demand 查詢目前需求點後固定 180 秒；coverage 以 interval union 管理。
  queryRange = { start: currentTime, end: currentTime + 180 };

  // 成功空批次可形成 negative cache；failed 不形成 completed coverage。
}
```

- `SubtitleReplacer` 擁有 `SubtitleFetchCoordinator`；它不再維護獨立的固定筆數字幕快取。
- replacement 只使用 canonical `slotKey` 精確命中，不使用舊的文字與時間容差組合 key。
- session memory cache scope 為 `(videoId, sessionId, localEpoch, subtitleSourceGeneration)`，不持久化；換片、playback identity 或 active backend source 改變即清除。
- 每批 response 是該查詢 range 的權威快照，不用獨立筆數上限淘汰字幕，避免保留虛假的 completed coverage。

#### 1.3 預加載策略

**為什麼需要預加載？**
- 避免播放時等待 API 響應
- 提供流暢的觀看體驗

**預加載邏輯**:
```javascript
const FETCH_DURATION_SECONDS = 180;
const PREFETCH_THRESHOLD_SECONDS = 60;

function shouldPrefetch(currentTime, completedCoverage) {
  const remaining = completedCoverage.end - currentTime;
  return remaining < PREFETCH_THRESHOLD_SECONDS;
}

function getNextDemand(currentTime) {
  return {
    start: currentTime,
    end: currentTime + FETCH_DURATION_SECONDS
  };
}
```

- `play` 會立即檢查 coverage；播放中每 15 秒檢查一次。
- `seeked` 使用 250ms debounce；字幕 render event 是漏接時的 fallback demand。
- 同時最多兩筆 request；滿載時只保留最新 demand，prefetch 不排隊。
- retryable failure 使用 2/10/30/60 秒冷卻，只有下一次 tick、seek 或 render demand 才會重試。

### 2. 雙語字幕實現

#### 2.1 架構設計

```
┌─────────────────────────────────────┐
│      SubtitleCoordinator            │
│  ┌───────────────────────────────┐  │
│  │      Interceptor Mode         │  │
│  │  ┌──────────┐ ┌──────────┐   │  │
│  │  │ Primary  │ │Secondary │   │  │
│  │  │ Track    │ │ Track    │   │  │
│  │  └────┬─────┘ └────┬─────┘   │  │
│  │       └─────────────┘         │  │
│  │            │                  │  │
│  │       Merge & Render          │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

#### 2.2 Region 容器設計

```javascript
// SubtitleDisplay 先建立兩個獨立容器，再依 position 移入 region container。
const regionContainer = document.createElement('div');
regionContainer.id = 'subpal-region-container';
regionContainer.style.cssText = `
  position: fixed;
  display: flex;
  flex-direction: column;
  align-items: center;
`;

const primaryContainer = document.createElement('div');
primaryContainer.id = 'subpal-primary-subtitle';
const secondaryContainer = document.createElement('div');
secondaryContainer.id = 'subpal-secondary-subtitle';

// 字幕文字一律以 textContent 更新，樣式由 SubtitleStyleManager 套用。
function renderBilingualSubtitle(primary, secondary) {
  primaryContainer.textContent = primary || '';
  secondaryContainer.textContent = secondary || '';
}
```

#### 2.3 語言配置

**支持的語言** (21 種):
- 繁體中文 (zh-Hant)
- 简体中文 (zh-Hans)
- English (en)
- 日本語 (ja)
- 한국어 (ko)
- Español (es)
- Français (fr)
- Deutsch (de)
- Italiano (it)
- Português (pt)
- Русский (ru)
- العربية (ar)
- ไทย (th)
- Tiếng Việt (vi)
- Bahasa Indonesia (id)
- Bahasa Melayu (ms)
- हिन्दी (hi)
- Türkçe (tr)
- Nederlands (nl)
- Polski (pl)
- Svenska (sv)

### 3. 離線隊列系統

#### 3.1 設計目標

- **離線支持**: 無網絡時可繼續操作
- **數據持久化**: 重啟瀏覽器不丟失
- **錯誤恢復**: 自動重試失敗的請求
- **批次處理**: 減少 API 調用次數

#### 3.2 隊列項目生命周期

```
┌─────────┐    enqueue     ┌─────────┐   background  ┌─────────┐
│  Init   │ ─────────────► │ Pending │ ─── sync ───► │ Syncing │
└─────────┘                └─────────┘               └────┬────┘
                                                          │
                    ┌─────────────────────────────────────┘
                    │
                    ▼
            ┌───────────────┐
            │  API Request  │
            └───────┬───────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
    ┌──────────────┐  ┌─────────┐  ┌─────────┐
    │Success       │  │ Retry   │  │ Failed  │
    │move to       │  └───┬─────┘  └───┬─────┘
    │history       │      │            │
    └──────┬───────┘      ▼            ▼
           ▼        ┌─────────┐  ┌─────────┐
   ┌────────────────┐│ Pending │  │ Failed  │
   │Completed       ││retry++ │  │retryable│
   │history record  │└─────────┘  └─────────┘
   └────────────────┘
```

#### 3.3 存儲結構

```javascript
// chrome.storage.local 存儲結構
{
  // 隊列與歷史數據
  voteQueue: [
    {
      id: 'uuid-v4',
      operationId: 'uuid-v4',
      backendProfileId: 'profile-id',
      videoId: '80234304',
      timestamp: 123.456,
      voteType: 'upvote',
      translationID: 'translation-id',
      originalSubtitle: 'Hello',
      slotKey: '80234304::Hello::zh-TW::123.4560',
      status: 'pending',  // queue: pending | syncing | failed
      syncedAt: null,
      retryCount: 0,
      error: null,
      createdAt: 1234567890,
      updatedAt: 1234567890
    }
  ],
  voteHistory: [
    {
      id: 'uuid-v4',
      operationId: 'uuid-v4',
      backendProfileId: 'profile-id',
      status: 'completed',
      syncedAt: 1234567890,
      videoId: '80234304',
      timestamp: 123.456,
      voteType: 'upvote',
      translationID: 'translation-id',
      originalSubtitle: 'Hello',
      slotKey: '80234304::Hello::zh-TW::123.4560'
    }
  ],
  translationQueue: [...],
  translationHistory: [...],
  replacementEventQueue: [...],
  replacementEventHistory: [...],
  voteStateByTranslation: {...},

  // 配置根
  debugMode: false,
  isEnabled: true,
  crowdsourcing: { endscreenTasksEnabled: true },
  subtitle: {...},
  video: {
    currentVideoId: '80234304',
    currentVideoTitle: 'Stranger Things',
    currentVideoLanguage: 'en'
  },
  storageSchemaVersion: 1,
  storageMigrationState: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 },
  backendProfiles: {
    schemaVersion: 1,
    activeProfileId: 'profile-id',
    byId: {
      'profile-id': { id: 'profile-id', endpoint: 'https://subnfbackend.zeabur.app', userId: 'uuid-v4', jwt: 'eyJhbGciOiJIUzI1NiIs...' }
    }
  }
}
```

同步成功時，background sync 會以同一個 `id` 與 `backendProfileId` 將 queue record 移除，建立 `status: 'completed'` 的 history record；history 依 profile 最多保留 100 筆。retryable failure 留在 queue 並更新 retry metadata，永久失敗則保留為 `failed`。

`video.*` 是 0.4.1 遺留資料，不再是 runtime-owned current playback metadata；目前播放狀態由記憶體中的 PlaybackContext 擁有，升級不讀取也不刪除這個 root。

`api`、`user` 與 top-level `jwt` 才是 legacy migration-only 轉換輸入。

### 3.1 Storage schema v1 升級閘門

- `storageSchemaVersion: 1` 與 `storageMigrationState` 是背景資料路徑共用的 readiness marker。
- 0.4.1 的 `api/user/jwt` 轉成 `backendProfiles.default`；六組 contribution queue/history 補上 `backendProfileId` 與 `operationId`，`voteStateByTranslation` 補上 profile binding。
- 轉換先在記憶體完成並驗證，再與 schema marker 一次寫入；失敗不快取 rejected readiness，後續可重試。
- 不符合目前安全規則的 legacy endpoint 進入 `needs-attention`。修復前註冊、API 與同步全部 fail closed，只有可信 Options Port 可查詢狀態並提交使用者確認的新 endpoint。
- 0.5.0 保留 legacy `api/user/jwt` 一個公開版本作回滾與救援來源；不得由 runtime 再直接使用。

### 4. 用戶認證與 JWT 管理

#### 4.1 認證流程

```
1. onInstalled / onStartup credential presence bootstrap
   └─► 讀取 backendProfiles.activeProfileId 與 byId
   └─► legacy api/user/top-level jwt migration-only，只有首次轉換舊資料時會讀
   └─► legacy `video.*` 保留但不作為目前播放狀態來源
   └─► active profile 缺少 userId 或 jwt 時，才補齊對應 credentials
   └─► 兩者已存在：不檢查有效期、不主動重新註冊

2. 受保護 API 回傳 401
   └─► 比較 request 實際使用的 JWT 與目前 storage JWT
   └─► storage 已有較新 JWT：直接使用新值重試一次
   └─► JWT 尚未更新：以 active profile 的 userId 重新註冊
   └─► concurrent / staggered 401 共用單一 in-flight refresh Promise
   └─► refresh settle 後清除共享 Promise，讓真正的新 401 可再次刷新
```

#### 4.2 JWT 存儲

```javascript
// 存儲結構
{
  backendProfiles: {
    activeProfileId: 'profile-id',
    byId: {
      'profile-id': { id: 'profile-id', endpoint: 'https://subnfbackend.zeabur.app', userId: 'uuid-v4', jwt: 'eyJhbGciOiJIUzI1NiIs...' }
    }
  }
}

// legacy api/user/top-level jwt migration-only
// 只在舊資料轉換時讀取，不再是 runtime-owned roots

// legacy video.* 僅保留供回滾，不再是 runtime authority

// 401 刷新去重
function refreshJwtTokenOnce() {
  if (!jwtRefreshPromise) {
    jwtRefreshPromise = refreshJwtToken().finally(() => {
      jwtRefreshPromise = null;
    });
  }
  return jwtRefreshPromise;
}
```

目前沒有 `lastJwtRefresh`、固定 24 小時 alarm 或啟動時 expiry probe。JWT 的有效性由實際 API 401 驅動處理。

---

### 5. 片尾字幕任務眾包

#### 5.1 整體設計

片尾字幕任務眾包功能只在 Netflix 可判定為 eligible end-screen 的畫面出現，針對「剛看完的影片」或其固定片尾狀態詢問使用者是否願意改善被社群標記有問題的官方字幕或候選翻譯。整個功能從後端計算、觸發時機、UI 顯示到動作提交都採用分層隔離設計，避免在正常播放期間干擾觀影。

核心原則：

- **後端即時計算**：沒有新增的持久化任務 collection，任務從既有 `Vote` 與 `AlternativeTranslation` 資料當場算出借以反映最新社群訊號。
- **官方字幕與候選翻譯語義分明**：官方字幕任務的 `translationID` 為 `null`，定位依賴 `videoID + slotKey/timestamp/originalSubtitle`；候選翻譯任務則帶有 `translationID` 與 `suggestedSubtitle`。
- **isolated world 專屬所有權**：片尾偵測、任務請求、面板渲染與動作處理全部放在獨立的 isolated execution world，不透過公開 DOM event 暴露 privileged request/response。
- **Boot readiness 與 runtime messaging 分離**：isolated `content.js` 擁有 Netflix Page Script 的 physical injection 與 correlated readiness handshake；字幕主應用進入 MAIN 後只使用既有 Page Script 的 runtime command/response。Page world 只額外暴露固定的 guarded quick-jump 命令，不自動 seek。
- **可逆的永久停用**：使用者可從面板或設定頁關閉片尾字幕任務，關閉後 startup、偵測與網路請求全部停止，且可隨時重新啟用。

固定 taxonomy 與 runtime truth：

- `type-a-next-episode`：有下一集的 end-screen。runtime observation 以這個 label 表示，畫面上的片尾任務 card 只在這個狀態啟用。
- `type-b`：沒有下一集的 shared label。runtime observation 也會使用這個 label，作為推薦流程的共同外層名稱，而不是再使用舊式拆分命名。
- `state-a-recommendation-countdown`：Type B 的倒數階段，原影片 mini player 仍在，推薦海報與倒數同時可見。
- `state-b-recommendation-trailer`：Type B 的推薦預告階段，原影片 mini player 已離開，畫面轉為播放推薦預告。

目前 runtime 只觀察 `type-a-next-episode` 與 shared `type-b` label。Type B 的 card acquisition 與 rendering 已刻意停用，因為推薦流程的 UX 仍未定案，現在不把它當成可啟用的產品路徑。

#### 5.2 後端計算任務 API

路由：`GET /crowdsourcing-tasks`

本 worktree 可直接確認的是此 route 的呼叫方式、參數驗證與 response 消費方式；後端資料表、任務計算與排序邏輯不在本 repository 內。以下任務模型與來源規則是 SubPal 目前依賴的後端整合契約，不表示後端實作已由本文件驗證。

查詢參數：

| 參數 | 說明 |
|------|------|
| `videoID` | 必要，Netflix 影片 ID |
| `languageCode` | 必要，API 語言代碼（如 `zh-TW`） |
| `limit` | 後端 API 可選，預設 5、最大 20；SubPal extension caller 固定只使用 `5` |

任務物件模型：

```javascript
{
  taskID: 'official:netflix-81234567:zh-TW:slot-000124',
  targetType: 'official-subtitle',        // 'official-subtitle' | 'candidate-translation'
  action: 'submit-improvement',           // 'submit-improvement' | 'review-candidate' | 'submit-better-candidate'
  videoID: 'netflix-81234567',
  translationID: null,                    // 官方字幕為 null；候選翻譯為 UUID
  timestamp: 124.5,                       // 字幕開始時間（秒）
  timecode: '02:04',
  slotKey: 'slot-000124',
  languageCode: 'zh-TW',
  originalSubtitle: '我會在十分鐘後回來。',
  suggestedSubtitle: null,                // 官方字幕為 null；候選翻譯為建議文字
  score: 72,
  rankReasons: ['no-approved-candidate', 'has-slot-key'],
  resolution: {
    kind: 'official-slot',                // 'official-slot' | 'candidate-translation'
    requiresTranslationID: false,
    voteTargetType: 'official-subtitle'
  },
  userState: {
    hasVoted: false,
    voteState: 'none',                    // 'like' | 'dislike' | 'none'
    isOwnContribution: false,
    excludedReason: null
  }
}
```

官方字幕任務來源：

- 既有 `Vote` 中 `voteTargetType: 'official-subtitle'` 且 `voteType: 'downvote'` 的紀錄。
- 使用 `slotKey` 定位；對於沒有 `slotKey` 的 legacy 資料則用 `videoID + originalSubtitle + timestamp` 比對。
- 若同一 slot 已有已核准的候選翻譯，則抑制該官方任務。

候選翻譯任務來源：

- `AlternativeTranslation` 中 `status: 'pending'` 且存在負評或接近拒絕門檻的紀錄。
- 排除使用者自己的貢獻與已經投過票的項目。
- 支援 `review-candidate`（需要更多評價）或 `submit-better-candidate`（提交更好的候選翻譯）。

背景腳本在 `chrome.runtime.onMessage` 中直接承接 `GET_CROWDSOURCING_TASKS`，這是唯一的 direct privileged crowdsourcing 例外。下列是 SubPal extension caller 的額外邊界檢查，不等同於後端 API 的一般參數範圍：

- 發送者必須是同一擴充功能實例的 Netflix `https://*.netflix.com` content script。
- 發送者網址必須符合 `/watch/<videoID>` 且與請求 `videoID` 一致。
- `limit` 必須等於 `5`。
- `languageCode` 必須在支援清單內。

一般長連接 port 不處理任務查詢，也不承接這條特權例外。

#### 5.3 Isolated World 所有權

`content/system/isolated-endscreen-tasks.js` 是片尾任務的單一所有者，負責：

1. **啟動門檻**：讀取 `crowdsourcing.endscreenTasksEnabled`；若為 `false` 則完全不初始化，產生零偵測與零網路請求。
2. **播放上下文**：可選擇持有獨立的 `PlaybackContextManager` 實例，透過診斷快照取得真實的 `videoId + watch-* sessionId + epoch`。推薦預覽切成 `background-*` session 時，只沿用同一路由、videoId 相符的最後可信 watch context，不把推薦影片歸為原影片任務。
3. **片尾偵測**：`EndscreenSignalAdapter` 監聽 DOM 與 media 事件。runtime 會把 `type-a-next-episode` 視為 Type A，並把 `type-b` 視為共享推薦流程 label。Type B 只保留結構觀察，不啟動 card acquisition 或 rendering。`state-a-recommendation-countdown` 以同一個 `watch-video` 下可見的 `background-video-container`、`promoted-video`、`postplay-background-play` 與 shared recommendation shell DOM 為結構證據，允許倒數期間的 paused media；`state-b-recommendation-trailer` 則代表預告已接手播放。
4. **去抖與一次性**：`EndscreenTaskController` 以 `videoId|sessionId|epoch` 為 key 記錄 `lastFinishedContexts`，每次符合條件的片尾只觸發一次任務請求。
5. **面板與動作**：`EndscreenTaskPanel` 渲染任務卡片；`EndscreenActionCoordinator` 處理投票、提交與 timecode 跳轉。僅 submit、vote 與 better-translation 路徑攜帶 `resolutionContext`（`taskID`、`targetType`、`action`、`slotKey`、`timestamp`）；quick-jump 使用預期的 `videoId`/`sessionId`/`epoch` 加上 trusted-click 請求封包，不帶 `resolutionContext`。
6. **生命週期清理與可見 ownership**：尚未顯示的 acquisition 仍可因 `ENDSCREEN_INACTIVE` 被取消並拒絕晚到的任務；但同一 `/watch/<videoId>` 與同一 active video 上已可見的卡片，必須保留其 DOM、pending action 與 action controller。一般 inactive 訊號經 500ms 重新確認時，若 shared recommendation shell DOM 仍存在則保留面板；同 route/video 的短暫 inactivity 與 seek aftermath 也不會隱藏或取消已可見卡片。硬 teardown 僅由明確 X 關閉、成功 opt-out、route/video/next-episode 變更、離開 `/watch`、`cleanup()` 或 `dispose()` 觸發。`VIDEO_ID_CHANGED` 會以事件中的純數字 video ID 立即失效舊卡片，不依賴 SPA URL 已先完成更新；稍後 URL 收斂時維持冪等，不重複 teardown。

Isolated world 與 MAIN world 的分工：

| 職責 | Isolated / Content Script | MAIN World |
|------|----------------|------------|
| Netflix Page Script physical injection / boot readiness | `content.js` 負責 | 只等待既有 readiness，不注入 |
| 字幕 runtime command / response | 不負責 | 負責 |
| 片尾 DOM 偵測、任務請求、面板渲染 | 負責 | 不負責 |
| 提交 / 投票動作 | 負責 | 不負責 |
| Netflix player seek | 發出 guarded 命令 | page script 執行並驗證 |

#### 5.4 MAIN/Page World 的 Guarded Quick-Jump

Timecode 跳轉是唯一需要 MAIN/page world 參與的片尾任務行為，且受到多層保護：

1. **使用者點擊唯一觸發**：只有真正的使用者點擊 `.subpal-endscreen-timecode` 才會在 page script 中建立 one-shot latch；合成點擊、直接 postMessage、過期或重複請求都會被忽略。
2. **信任上下文比對**：命令攜帶預期的 `videoId`、`sessionId`、`epoch`、`targetTimestamp`；page script 驗證當前 context 與預期一致才繼續。
3. **秒轉毫秒只做一次**：任務的 `timestamp` 以秒為單位，在 `videoPlayer.seek(ms)` 前於 page script 內乘以 `1000` 並 clamp 到目前 duration。
4. **有界驗證**：seek 前後進行身份與時間收斂檢查，若影片切換、session 不符或時間未收斂則 fail closed。
5. **原生播放器 UI 還原**：seek 成功後，若 Netflix 進入 minimized end-screen 導致控制項不可用，page script 會在預期 player 容器內尋找 credits 控制鈕並點擊一次。驗證只接受同一個唯一預期 player 內可見且 owned 的 `[data-uia="controls-standard"]`、timeline、play/pause control，或保留的 legacy `[data-uia="player-controls"]` fallback，作為恢復成功證據；其他 player 的全域控制項不能證明成功。若無法安全還原則回傳 `partial` 狀態並讓使用者使用原生控制。

Quick-jump 是獨立於提交與投票的動作：它只 dispatch `jump-to-timecode`，不提交翻譯、不投票，也不攜帶 submit/vote 用的 `resolutionContext`。面板上的 `跳至 HH:MM` 仍使用 native button 與可信使用者點擊/播放 context guard；不會因 seek 自動關閉卡片。

#### 5.5 可逆的永久停用

設定鍵：`crowdsourcing.endscreenTasksEnabled`（預設 `true`）。

停用機制：

- 面板提供「不再顯示字幕任務」按鈕，點擊後出現確認對話框說明「之後可在 SubPal 設定中重新啟用」。
- 確認後寫入 `crowdsourcing.endscreenTasksEnabled = false`，`IsolatedEndscreenTasks` 會立即清理偵測器、面板與 pending 動作。
- 設定頁提供對應的核取方塊，可隨時重新啟用。
- 停用狀態下不會初始化 `EndscreenSignalAdapter`，也不會發出 `GET_CROWDSOURCING_TASKS` 請求。

#### 5.6 面板佈局與回應式行為

`EndscreenTaskPanel` 目前只啟用 Type A-specific 的面板定位，固定於播放器左下角，避開 Netflix 主要的「下一集」CTA；Type B 的布局仍停用且未解決：

- 預設 `left: 24px`；最大寬度 `min(380px, calc(100vw - 48px))`；最小寬度 `min(280px, calc(100vw - 48px))`。
- 窄 viewport（寬度 <= 640px）時底部提高，避免覆蓋行動版控制列。
- `跳至 HH:MM` 是 action bar 前的 full-width quiet native button；timestamp 缺失、負值或非有限時 disabled。`下一題` 僅在兩個以上任務時顯示，採 modulo 循環並在正常/回繞後把 focus 還給新按鈕；單一任務省略此控制。loading 僅 disable next/action controls，success 或 error 會重新啟用。
- `提交翻譯` 或候選任務的 vote controls 依任務類型保留 primary action hierarchy，與次要動作保持 `8px` 間距；不渲染舊的 not-now/skip control。現階段啟用的 panel placement 只針對 Type A，Type B layout 仍停用且未定案。
- 面板使用 `box-sizing: border-box`、`overflow: hidden`、圓角與 backdrop blur，確保在 390px 寬度下仍完整位於視口內（左邊界 24px、右邊界不低於 24px）。
- 所有任務文字皆透過 `textContent` 寫入，不使用 `innerHTML`，防止字幕內容中的惡意標記被執行。

---

## 配置系統

### 1. 配置 Schema

#### 1.1 結構定義

```javascript
// content/system/config/config-schema.js — 更新版層次結構
export const CONFIG_SCHEMA = {
  // 系統層級（扁平化鍵名）
  debugMode:          { type: 'boolean', default: false },
  isEnabled:          { type: 'boolean', default: true },

  // 字幕設定
  subtitle: {
    dualModeEnabled:   { type: 'boolean', default: true },
    primaryLanguage:   { type: 'string', default: 'zh-Hant' },
    secondaryLanguage: { type: 'string', default: 'en' },

    // 字幕樣式配置（層次結構）
    style: {
      mode:            { type: 'string', default: 'custom' },     // 'custom' | 'netflixPreset'（'nativeInherit' 為內部運行時模式，非匯出 schema 值）
      fontPreset:      { type: 'string', default: 'clearSans' },  // 'system' | 'clearSans' | 'serif' | 'code'
      fontFamily:      { type: 'string', default: 'Arial, ...' },
      primary: {
        fontSize:      { type: 'number', default: 55 },
        fontWeight:    { type: 'string', default: '700' },        // '400' | '700'
        outlineEnabled: { type: 'boolean', default: false },
        outlineWidth:   { type: 'number', default: 2 },
        outlineColor:   { type: 'string', default: '#000000' },
        letterSpacing:  { type: 'number', default: 0 },
        textColor:     { type: 'string', default: '#ffffff' },
        backgroundColor: { type: 'string', default: 'rgba(0,0,0,0.6)' }
      },
      secondary: {
        fontSize:      { type: 'number', default: 24 },
        fontWeight:    { type: 'string', default: '400' },
        outlineEnabled: { type: 'boolean', default: false },
        outlineWidth:   { type: 'number', default: 2 },
        outlineColor:   { type: 'string', default: '#000000' },
        letterSpacing:  { type: 'number', default: 0 },
        textColor:     { type: 'string', default: '#ffff00' },
        backgroundColor: { type: 'string', default: 'rgba(0,0,0,0.6)' }
      },
      netflixPreset: {    // Netflix 原生風格參照（唯讀）
        fontFamily:   { type: 'string', default: 'Arial, Helvetica, sans-serif' },
        fontWeight:   { type: 'string', default: '700' },
        textColor:    { type: 'string', default: '#ffffff' },
        backgroundColor: { type: 'string', default: 'rgba(0,0,0,0.6)' },
        textShadow:   { type: 'string', default: '0 0 2px rgba(0,0,0,0.9)' }
      }
    }
  }
};
```

**外觀模式說明**:
- `custom`: 使用 SubPal 自訂樣式（預設）
- `netflixPreset`: 使用穩定的 Netflix 原生風格預設
- `nativeInherit`: 內部運行時模式，繼承 Netflix 計算樣式（SubtitleDisplay 渲染當下覆蓋可繼承欄位），非匯出 schema 值

**字體預設**:
- `system`: 系統預設字體（使用 system-ui 堆疊）
- `clearSans`: 清晰黑體（微軟正黑體、蘋方等堆疊）
- `serif`: 襯線字體
- `code`: 等寬字體

**字重選項**: `400`（一般）、`700`（粗體）

**樣式流向**: Options 寫入 storage 後，isolated ConfigManager 發布 projected one-way `CONFIG_CHANGED`，MAIN ConfigBridge 只消費 content-local typed settings snapshot，不直接讀 `chrome.storage.local`；SubtitleStyleManager 接著組合 glyph text outline 與 `letterSpacing`，最後下發給 SubtitleDisplay 套用到單語與雙語字幕。

### 2. 配置管理器

#### 2.1 API

```javascript
// 獲取配置
const value = await configManager.get('subtitle.dualModeEnabled');

// 設置配置
await configManager.set('subtitle.dualModeEnabled', true);

// 批量設置
await configManager.setMultiple({
  'subtitle.primaryLanguage': 'en',
  'subtitle.secondaryLanguage': 'zh-Hant'
});

// 訂閱配置變更
const unsubscribe = configManager.subscribe('subtitle.dualModeEnabled', (key, newValue, oldValue) => {
  console.log('雙語模式變更:', oldValue, '→', newValue);
});

// 取消訂閱
unsubscribe();

// 重置為默認值
await configManager.reset('subtitle.dualModeEnabled');

// 獲取所有配置
const allConfigs = await configManager.getAll();
```

#### 2.2 訂閱機制

```javascript
ConfigManager.set(key, value)
  → validation
  → optimistic isolated cache update
  → storage write
  → changed value: storage.onChanged 展開 root/leaf 並發布通知
  → same value: ConfigManager 明確發布一次通知

storage.onChanged(oldRoot, newRoot)
  → 依 schema 展開所有受影響 leaf keys
  → root deletion / partial replacement 的缺值套用 schema default
  → 先更新 cache，再以 callback(key, newValue, oldValue) 通知真正改變的 leaf

ConfigBridge 只消費 projected one-way CONFIG_CHANGED；由 isolated ConfigManager 完成 write 後，MAIN cache 才更新並以 callback(newValue) 通知。
```

`setMultiple()` 遵守相同契約：changed keys 等待 storage event，same-value keys 各發布一次；validation 或 storage failure 會回滾全部 isolated cache，並發布零通知。單一 subscriber 拋錯不會阻斷其他 subscriber。

### 3. 配置持久化

#### 3.1 存儲適配器

```javascript
// content/system/config/storage-adapter.js
class StorageAdapter {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  }
  
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }
  
  async getMultiple(keys) {
    return await chrome.storage.local.get(keys);
  }
  
  async setMultiple(items) {
    await chrome.storage.local.set(items);
  }
  
  async remove(key) {
    await chrome.storage.local.remove(key);
  }
}
```

### 4. 使用示例

```javascript
// MAIN UI 組件透過 ConfigBridge 使用配置
class SubtitleDisplay {
  constructor() {
    this.unsubscribeDualMode = configBridge.subscribe('subtitle.dualModeEnabled', (enabled) => {
      this.toggleDualMode(enabled);
    });

    this.unsubscribeStyleMode = configBridge.subscribe('subtitle.style.mode', (mode) => {
      this.updateStyleMode(mode);
    });
  }

  initialize() {
    // 獲取初始配置
    const dualMode = configBridge.get('subtitle.dualModeEnabled');
    this.toggleDualMode(dualMode);
  }

  cleanup() {
    this.unsubscribeDualMode?.();
    this.unsubscribeStyleMode?.();
  }
}
```

---

## 開發指南

### 1. 環境設置

#### 1.1 安裝擴充功能

1. 開啟 Chrome 擴充功能頁面：`chrome://extensions/`
2. 開啟「開發人員模式」
3. 點擊「載入未封裝項目」
4. 選擇專案目錄

### 2. 添加新功能

#### 2.1 添加新的 UI 組件

```javascript
// content/ui/my-new-component.js
class MyNewComponent {
  constructor() {
    this.element = null;
  }
  
  initialize() {
    this.element = document.createElement('div');
    this.element.className = 'subpal-my-component';
    // 初始化邏輯
  }
  
  destroy() {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }
}

    // 在 UIManager 內以協調流程接上新元件
    myUiManager.attachComponent('myNewComponent', myNewComponent);
```

#### 2.2 添加新的配置項

```javascript
// content/system/config/config-schema.js （層次結構模式）
export const CONFIG_SCHEMA = {
  // ... 現有配置（參考上方 CONFIG_SCHEMA 範例）

  myFeature: {
    enabled: { type: 'boolean', default: false },
    setting: { type: 'string',  default: 'default-value' }
  }
};
```

#### 2.3 添加新的 API 端點

```javascript
// background/api.js
async function myNewEndpoint(data) {
  return request('/my-new-endpoint', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

// 在 background.js 中添加路由
if (message.type === 'MY_NEW_ENDPOINT') {
  const result = await myNewEndpoint(message.data);
  port.postMessage({ type: 'MY_NEW_RESPONSE', data: result });
}
```

### 3. 調試技巧

#### 3.1 開啟調試模式

```javascript
// 在 Options 頁面開啟，或在 Console 執行：
chrome.storage.local.set({ debugMode: true });
```

#### 3.2 查看日誌

```javascript
// 各模組使用統一的日誌格式
console.log('[SubPal][ModuleName]', 'message', data);

// 示例
console.log('[SubPal][SubtitleReplacer]', 'Cache hit', cacheKey);
console.log('[SubPal][ConfigManager]', 'Config changed', { key, newValue });
```

#### 3.3 Service Worker 調試

1. 打開擴充功能頁面：`chrome://extensions/`
2. 找到 SubPal，點擊「Service Worker」
3. 在 DevTools 中查看日誌和斷點

#### 3.4 Content Script 調試

1. 在 Netflix 頁面按 F12 打開 DevTools
2. 切換到 Console 面板
3. 選擇「SubPal」context（如果有的話）

### 4. 常見問題

#### 4.1 字幕不顯示

1. 檢查 `isEnabled` 是否為 true
2. 檢查 Netflix 是否啟用了字幕
3. 查看 Console 是否有錯誤日誌
4. 嘗試重新載入頁面

#### 4.2 API 請求失敗

1. 檢查網絡連接
2. 查看 Background 的 Service Worker 日誌
3. 檢查 JWT 是否過期（應自動刷新）
4. 確認 API 基礎 URL 是否正確

#### 4.3 配置不生效

1. 檢查配置項名稱是否正確
2. 確認 Storage 中是否有該配置
3. 查看 ConfigManager 的訂閱是否正確

---

## 附錄

### A. 文件清單

#### 核心文件
- `manifest.json` - Manifest V3 配置
- `content.js` - Content Script 橋接
- `background.js` - Service Worker
- `content/index.js` - Page Context 入口

#### 系統層
- `content/system/initialization-manager.js`
- `content/system/messaging.js`
- `content/system/capabilities/playback.js`
- `content/system/isolated-endscreen-tasks.js`：片尾任務 isolated world 所有者（偵測/請求/面板/動作）
- `content/system/endscreen-action-coordinator.js`：片尾任務動作協調器（投票/提交/timecode 跳轉）
- `content/system/crowdsourcing-task-client.js`：片尾任務 runtime.sendMessage 客戶端
- `content/system/config/config-schema.js`
- `content/system/config/config-manager.js`
- `content/system/config/config-bridge.js`
- `content/system/config/storage-adapter.js`

#### 核心層
- `content/core/playback-context-manager.js` — 播放上下文管理（gate/videoId/session/epoch）
- `content/core/subtitle-replacer.js`
- `background/contribution-queue.js`
- `content/core/vote-bridge.js`
- `content/core/translation-bridge.js`
- `content/core/replacement-event-bridge.js`
- `content/core/video-info.js`
- `content/core/endscreen-signal-adapter.js`：片尾訊號偵測（DOM + media + Netflix UI 標記）
- `content/core/endscreen-task-controller.js`：片尾任務觸發控制器（context key、去抖、一次性請求）

#### UI 層
- `content/ui/ui-manager-new.js`
- `content/ui/subtitle-display.js`
- `content/ui/subtitle-style-manager.js` — 樣式管理器（ConfigBridge 驅動、UI 重建恢復）
- `content/ui/interaction-panel.js`
- `content/ui/submission-dialog.js`
- `content/ui/endscreen-task-panel.js`：片尾任務面板（時間碼、原字幕、候選翻譯、CTA、停用確認）
- `content/ui/fullscreen-handler.js`
- `content/ui/ui-avoidance-handler.js`
- `content/ui/toast-manager.js`
- `content/ui/netflix-player-adapter.js`

#### 字幕模式
- `content/subtitle-modes/subtitle-coordinator.js`
- `content/subtitle-modes/mode-detector.js`
- `content/subtitle-modes/dom-monitor.js`
- `content/subtitle-modes/subtitle-interceptor.js` — 攔截器（gate/acquisition/promotion/discovery）
- `content/subtitle-modes/dom-overlap-matcher.js` — DOM overlap 比對復原

#### 工具
- `content/utils/subtitle-parser.js`
- `content/utils/language-code.js` — 語言代碼格式轉換
- `content/utils/slot-key.js` — 字幕 slot 識別值產生

#### 共享模組
- `shared/subtitle-preview-renderer.js` — 字幕預覽渲染（options/tutorial 共用）

#### 背景層
- `background/api.js`
- `background/sync.js`
- `background/sync-listener.js`

### B. API 參考

#### 後端 API 端點

```
POST   /users               # 註冊新用戶
GET    /users/{id}          # 獲取用戶統計
GET    /translations?videoID=...  # 獲取字幕翻譯
GET    /crowdsourcing-tasks  # 獲取片尾眾包字幕任務
POST   /votes               # 提交投票
    PUT /votes/state           # 更新投票狀態
POST   /translations        # 提交翻譯
POST   /replacement-events  # 提交替換事件（批量）
```

### D. 驗證與診斷債

- 文件契約檢查使用 `tests/architecture-documentation-contract.test.mjs`，對照目前 source-backed 字串與文檔內容。
- Node 測試命令是 `node --experimental-vm-modules --test tests/*.test.mjs`。
- 仍需 live trace 的診斷債主要在 Netflix 播放會話切換、`subpal-page-script-ready` 失敗重試，以及片尾任務 Type B 的停用路徑，文件只保留現況描述，不把未驗證的推測寫成結論。

### C. 第三方依賴

本專案目前 **無第三方 runtime 依賴**，所有功能使用原生 JavaScript 實現。

**Chrome APIs 使用**:
- `chrome.storage.local` - 本地存儲
- `chrome.runtime` - 擴充功能運行時
- `chrome.alarms` - 定時任務

---

如有任何問題或需要進一步說明，請參考 `docs/` 目錄中的其他技術文檔，或於 GitHub 上提出 Issue。
