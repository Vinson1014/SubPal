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
│  │     Popup UI         │     │    Options Page      │                     │
│  │   (popup.html/js)    │     │   (options.html/js)  │                     │
│  └──────────┬───────────┘     └──────────┬───────────┘                     │
│             │                            │                                  │
│             │  chrome.runtime.sendMessage │                                  │
│             └─────────────┬──────────────┘                                  │
│                           ▼                                                 │
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
│  │  - SubmissionQueueManager 初始化                             │          │
│  │  - 注入 page context script                                   │          │
│  └──────────┬───────────────────────────────────────────────────┘          │
│             │ CustomEvent (messageToContentScript)                         │
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
- **注入**: 動態注入 Page Context Script

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
- **診斷快照**: `getDebugSnapshot()` 回傳完整播放狀態（session、track、currentTime、recent events）
- **trusted watch session**: 僅 sessionId 以 `watch-` 開頭且 confidence ≥ `medium` 且非 fallback 來源才算 trusted

---

## 核心模組

### 1. System Layer（系統層）

#### 1.1 InitializationManager (`content/system/initialization-manager.js`)

**職責**: 統一管理所有組件的初始化流程

**初始化順序（8 階段並行優化流程）**:

```javascript
1. initializeMessaging()         // 建立消息通信（必須先完成）
2. initializeConfigBridge()      // 初始化配置橋接器（必須先完成）
3. initializePageScript() +      // 注入 Netflix Page Script（與配置並行）
   loadConfiguration()           // 載入配置（與 Page Script 並行）
4. waitForPlaybackPage()         // 等待用戶進入播放頁面，
                                 // 同時在內部啟動 setupVideoMonitoring()（視頻切換背景監控）
5. checkNetflixAPI()             // 檢查 Netflix API、初始化播放器助手、
                                 // 立即啟動字幕攔截器、初始化 PlaybackContextManager
6. initializeComponents()        // 初始化 UI 管理器、字幕樣式管理器、字幕協調器
7. integrateAndStart()           // 整合和啟動系統（事件流綁定、通知背景）
```

**設計要點**:
- **階段 3 並行**: Page Script 注入與 Config 載入同時進行，減少等待時間
- **攔截器提前啟動**: 階段 5 中 `checkNetflixAPI()` 立即啟動字幕攔截器，確保 Netflix 預設字幕請求在發生的當下即被攔截
- **PlaybackContextManager**: 階段 5 中初始化，追蹤播放 session/videoId/track 狀態並作為字幕處理 gate
- **安全初始化**: SubtitleCoordinator 不依賴語言列表決定生死；Netflix SPA 換片時 player/languages 可能短暫不可讀，由 coordinator 的 soft/hard 分類與背景回升處理
- **降級模式**: 初始化失敗時嘗試只初始化基本的 DOM 監聽功能

**生命週期管理**:
- 頁面加載時自動初始化
- 頁面隱藏時暫停字幕處理
- 頁面顯示時恢復運行
- 提供 `cleanup()` 方法進行清理
- 影片切換時清理並重新初始化 UI 組件
- 狀態包含 `messagingReady`、`pageScriptInjected`、`netflixAPIAvailable`、`playbackContextReady`、`configLoaded`、`componentsReady`

#### 1.2 Messaging System (`content/system/messaging.js`)

**職責**: 抽象化 Page Context 與 Content Script 之間的通信

**API**:
```javascript
// 發送消息到 Content Script
messaging.sendToContentScript(type, data)

// 發送消息到 Background（通過 Content Script 轉發）
messaging.sendToBackground(type, data)

// 註冊消息處理器
messaging.onMessage(type, handler)

// 一次性監聽
messaging.once(type, handler)
```

**消息類型**:
- `CONFIG_GET`, `CONFIG_SET`, `CONFIG_CHANGED` - 配置操作
- `QUEUE_*` - 隊列操作（投票、翻譯、事件）
- `API_*` - API 相關（獲取字幕、提交數據）

#### 1.3 Netflix API Bridge (`content/system/netflix-api-bridge.js`)

**職責**: 封裝 Netflix 內部 API 的調用

**核心功能**:
- `getCurrentVideoMetadata()` - 獲取當前影片元數據
- `getSubtitleTracks()` - 獲取可用字幕軌道
- `switchSubtitleTrack(trackId)` - 切換字幕軌道
- `getPlayerState()` - 獲取播放器狀態（播放/暫停、時間等）

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

---

### 2. Core Layer（核心層）

#### 2.1 SubtitleReplacer (`content/core/subtitle-replacer.js`)

**職責**: 字幕替換的核心邏輯

**緩存策略**:
```javascript
// 緩存配置
const CACHE_LIMIT = 500;           // 最大緩存條目
const TIMESTAMP_TOLERANCE = 2000;  // 時間戳容差（毫秒）
const PRELOAD_THRESHOLD = 60000;   // 預加載閾值（毫秒）

// 緩存鍵生成
const cacheKey = `${text}_${Math.floor(timestamp / 2)}`;
```

**匹配邏輯**:
1. **精確匹配**: 文本 + 時間戳（2 秒容差）
2. **模糊匹配**: 時間戳範圍內的文本匹配
3. **預加載**: 提前加載後續 3 分鐘字幕

**批次獲取**:
- 每次獲取 3 分鐘字幕數據
- 追蹤已請求時間區間避免重複
- 當播放接近區間結束時自動觸發預加載

#### 2.2 SubmissionQueueManager (`content/core/submission-queue-manager.js`)

**職責**: 管理離線隊列（投票、翻譯、替換事件）

**隊列類型**:
```javascript
{
  voteQueue: [],           // 投票隊列
  translationQueue: [],    // 翻譯隊列
  replacementEventQueue: [] // 替換事件隊列
}
```

**隊列項目狀態**:
- `pending` - 等待同步
- `syncing` - 同步中
- `completed` - 已完成
- `failed` - 失敗（超過最大重試次數）

**API 接口**:
```javascript
// 添加項目到隊列
enqueue(type, data, priority = 'normal')

// 獲取隊列狀態
getQueueStatus(type)

// 手動觸發同步
sync()

// 清空隊列
clear(type)
```

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
  beneficiaryUserID: 'current_user',
  occurredAt: Date.now()
});
```

**特點**:
- 15 分鐘去重窗口
- 異步記錄不阻塞字幕替換
- 自動批次提交（最多 100 個）

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
- **Polling**: 每 3 秒向 Page Script 請求診斷快照（`GET_SUBPAL_DEBUG_SNAPSHOT`），從中提取播放會話資訊

**工作流程**:
```javascript
1. 初始化時向 Page Script 請求診斷快照
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
<div id="subpal-subtitle-container">
  <div class="subpal-region" data-align="bottom">
    <div class="subpal-primary">主要字幕</div>
    <div class="subpal-secondary">次要字幕</div>
  </div>
</div>
```

**Region 容器設計**:
- 統一管理雙語字幕位置
- 支持 `displayAlign` 屬性（top/bottom/center）
- 使用 Flexbox 進行垂直佈局

**字幕樣式**:
- 支援 `fontWeight`（400/700）、`fontPreset`（system/clearSans/serif/code）
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
用戶點擊讚按鈕 → InteractionPanel → VoteBridge → SubmissionQueueManager → Storage → Background Sync → API
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
- **樣式模式**: 支援 `styleMode`（`custom`/`netflixPreset`；`nativeInherit` 為內部運行時模式）、`fontPreset`、`fontWeight`
- **雙語樣式**: 獨立管理 primary/secondary 兩組樣式配置
- **UI 重建恢復**: 監聽 `UI_COMPONENTS_REINITIALIZED` 事件，在影片切換後重新套用樣式

**樣式應用路徑**:
```
ConfigBridge 配置變更 → SubtitleStyleManager.handleStyleChange()
  → applyCurrentStyle()
    → applySingleModeStyle() / applyDualModeStyle()
      → SubtitleDisplay.setSubtitleStyle() / setDualModeStyles()
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
2. ensurePageScriptInjected()          // 確保 Page Script 已注入
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
1. 注入 Page Script 到 Netflix 頁面
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
- `handleRawTTMLIntercepted()`: 處理 Page Script 送來的 raw TTML，經過 gate/promotion guard 後決定是否 promotion 到 active slot

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
1. 檢查 Service Worker 是否重啟
2. 初始化用戶註冊
3. 設置 JWT 刷新定時器（每 24 小時）
4. 設置同步定時器（每 5 分鐘）
5. 監聽消息和連接
6. 解析 clientVersion（`frontend-{manifest.version}`）供後端 rollout 使用
```

**生命週期事件**:
- `onInstalled` - 首次安裝時顯示教學頁面
- `onStartup` - 瀏覽器啟動時初始化

#### 6.2 API Module (`background/api.js`)

**職責**: 封裝與後端 API 的通信

**核心 API**:
```javascript
// 用戶管理
registerUser(userId) → { token, user }
refreshToken(token) → { token }

// 字幕數據
fetchSubtitles(videoId, language, startTime, endTime) → [subtitles]

// 提交數據（可選欄位：slotKey, clientVersion）
submitVote(voteData) → { success }
  // voteData: { videoID, timestamp, voteType, translationID?,
  //             originalSubtitle?, slotKey?, clientVersion? }
submitTranslation(translationData) → { success }
  // translationData: { videoId, timestamp, original, translation,
  //                    languageCode, submissionReason, slotKey?, clientVersion? }
submitReplacementEvents(events) → { success }

// 統計
fetchUserStats(userId) → { stats }
```

**新版 payload 欄位**:
- `slotKey`: 字幕 slot 識別值，格式 `{videoID}::{originalSubtitle}::{languageCode}::{timestamp}`
- `clientVersion`: 前端版本，格式 `frontend-{manifest.version}`，供後端 rollout 與行為觀測使用

**錯誤處理**:
```javascript
// 401 錯誤自動刷新 Token 並重試
if (response.status === 401) {
  await refreshToken();
  return retryRequest();
}

// 請求超時（10 秒）
const timeout = setTimeout(() => abort(), 10000);
```

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
- 重試間隔: 指數退避（1s, 2s, 4s）
- 永久錯誤標記（4xx 錯誤，除了 401）

#### 6.4 SyncListener (`background/sync-listener.js`)

**職責**: 監聽來自 Content Script 的同步請求

**處理的消息**:
- `QUEUE_SYNC` - 手動觸發同步
- `QUEUE_STATUS` - 獲取隊列狀態
- `FORCE_SYNC` - 強制立即同步

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

1. 配置數據流：
   Options Page ──write──► chrome.storage.local ──watch──► ConfigManager
                                                           └──► 通知所有訂閱者

2. 字幕數據流（正常路徑 — 含 PlaybackContext gating）：
   Netflix CDN ──intercept──► Page Script (攔截 + session 檢查)
                                   │
                                   ▼ postMessage
                          PlaybackContextManager ──gate──► SubtitleInterceptor
                                                             │ (parse + promotion)
                                                             ▼
                                                         SubtitleCoordinator
                                                             │
                                                             ▼
                                                         UIManager
                                                          (native visibility)
                                                             │
                                                             ▼
                                                         SubtitleDisplay
                                                          (style applied)

2b. 字幕數據流（DOM Overlap Recovery / SPA 換片復原）：
   Netflix 原生字幕 DOM ──collect──► DOMOverlapMatcher
                                        │
                                        ▼ (findBestMatch)
                                   raw TTML pool (interceptedSubtitles)
                                        │ (native-dom-match attribution)
                                        ▼
                                   SubtitleInterceptor.handleRawTTMLIntercepted
                                        │ (bypass gate via attribution)
                                        ▼
                                   SubtitleCoordinator → UIManager → SubtitleDisplay

2c. PlaybackContext polling（診斷快照）：
   PlaybackContextManager ──GET_SUBPAL_DEBUG_SNAPSHOT──► Page Script
       ◄── playback session snapshot ─────────────────── 
       │ 
       ├── epoch 管理（videoId/sessionId 改變時遞增）
       ├── transitioning ←→ ready 狀態切換
       └── gate 決策：transitioning 時暫緩字幕處理

3. 用戶操作數據流：
    用戶點擊 ──► UIManager ──► VoteBridge/TranslationBridge
                                 └──► sendMessage ──► Content Script
                                       └──► SubmissionQueueManager
                                             └──► chrome.storage.local
                                                   └──► Background Sync
                                                         └──► API Server

4. API 響應數據流：
   API Server ──► Background ──► Port ──► Content Script
                                               └──► CustomEvent ──► Page Context
```

### 消息傳遞詳情

#### 1. Page Context ↔ Content Script

**通信方式**: CustomEvent

```javascript
// Page Context → Content Script
const event = new CustomEvent('messageToContentScript', {
  detail: { type: 'API_REQUEST', data: {...} }
});
document.dispatchEvent(event);

// Content Script → Page Context
const event = new CustomEvent('messageToPageContext', {
  detail: { type: 'API_RESPONSE', data: {...} }
});
document.dispatchEvent(event);
```

#### 2. Content Script ↔ Background

**通信方式**: chrome.runtime.connect (長連接)

```javascript
// 建立連接
const port = chrome.runtime.connect({ name: 'subpal-port' });

// Content Script → Background
port.postMessage({ type: 'FETCH_SUBTITLES', data: {...} });

// Background → Content Script
port.onMessage.addListener((message) => {
  if (message.type === 'SUBTITLES_DATA') {
    // 處理字幕數據
  }
});
```

#### 3. Page Context ↔ Netflix Page Script

**通信方式**: window.postMessage

```javascript
// Page Context → Page Script
window.postMessage({
  source: 'subpal-page-context',
  type: 'GET_PLAYER_STATE'
}, '*');

// Page Script → Page Context
window.postMessage({
  source: 'subpal-page-script',
  type: 'PLAYER_STATE',
  data: {...}
}, '*');
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

**緩存設計**:
```javascript
class SubtitleCache {
  constructor() {
    this.cache = new Map();           // 主緩存
    this.accessOrder = [];            // 訪問順序（LRU）
    this.maxSize = 500;               // 最大條目數
  }
  
  // 生成緩存鍵
  generateKey(text, timestamp) {
    // 使用 2 秒時間窗口
    return `${text}_${Math.floor(timestamp / 2)}`;
  }
  
  // 獲取緩存
  get(text, timestamp) {
    // 1. 精確匹配
    const key = this.generateKey(text, timestamp);
    if (this.cache.has(key)) {
      this.updateAccessOrder(key);
      return this.cache.get(key);
    }
    
    // 2. 模糊匹配（時間容差）
    for (const [k, v] of this.cache) {
      if (v.originalSubtitle === text && 
          Math.abs(v.timestamp - timestamp) <= 2) {
        this.updateAccessOrder(k);
        return v;
      }
    }
    
    return null;
  }
  
  // 添加緩存
  set(key, value) {
    // 如果滿了，移除最舊的
    if (this.cache.size >= this.maxSize) {
      const oldest = this.accessOrder.shift();
      this.cache.delete(oldest);
    }
    
    this.cache.set(key, value);
    this.accessOrder.push(key);
  }
}
```

#### 1.3 預加載策略

**為什麼需要預加載？**
- 避免播放時等待 API 響應
- 提供流暢的觀看體驗

**預加載邏輯**:
```javascript
// 當播放接近當前區間結束時預加載
const PRELOAD_THRESHOLD = 60;  // 提前 60 秒

function shouldPreload(currentTime, currentRange) {
  const timeToEnd = currentRange.end - currentTime;
  return timeToEnd < PRELOAD_THRESHOLD;
}

// 獲取下一個區間
function getNextRange(currentRange) {
  return {
    start: currentRange.end,
    end: currentRange.end + 180  // 3 分鐘
  };
}
```

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
// 創建 Region 容器
function createRegionContainer(region) {
  const container = document.createElement('div');
  container.className = `subpal-region subpal-region-${region}`;
  container.style.cssText = `
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    ${region === 'top' ? 'top: 10%;' : 'bottom: 10%;'}
  `;
  return container;
}

// 渲染雙語字幕
function renderBilingualSubtitle(primary, secondary, region) {
  const container = getOrCreateRegionContainer(region);
  
  container.innerHTML = `
    <div class="subpal-primary" style="${getPrimaryStyles()}">
      ${primary}
    </div>
    <div class="subpal-secondary" style="${getSecondaryStyles()}">
      ${secondary}
    </div>
  `;
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
┌─────────┐    enqueue     ┌─────────┐    sync()     ┌─────────┐
│  Init   │ ─────────────► │ Pending │ ────────────► │ Syncing │
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
   ┌────────┐  ┌────────┐  ┌────────┐
   │Success │  │ Retry  │  │ Failed │
   └───┬────┘  └───┬────┘  └───┬────┘
       │           │           │
       ▼           ▼           ▼
  ┌─────────┐  ┌─────────┐  ┌─────────┐
  │Completed│  │ Pending │  │  Failed │
  │         │  │(retry++)│  │(max ret)│
  └─────────┘  └─────────┘  └─────────┘
```

#### 3.3 存儲結構

```javascript
// chrome.storage.local 存儲結構
{
  // 隊列數據
  'queue:vote': [
    {
      id: 'uuid-v4',
      data: { videoId, timestamp, voteType, ... },
      status: 'pending',  // pending | syncing | completed | failed
      retryCount: 0,
      createdAt: 1234567890,
      updatedAt: 1234567890
    }
  ],
  'queue:translation': [...],
  'queue:replacementEvent': [...],
  
  // 配置數據
  'config:debugMode': false,
  'config:dualModeEnabled': true,
  'config:userId': 'user-uuid',
  
  // 用戶數據
  'user:userId': 'user-uuid',
  'user:jwt': 'eyJhbGciOiJIUzI1NiIs...',
  'user:lastJwtRefresh': 1234567890
}
```

### 4. 用戶認證與 JWT 管理

#### 4.1 認證流程

```
1. 首次安裝
   └─► 生成 userId (UUID v4)
   └─► 調用 POST /users 註冊
   └─► 保存 JWT 到 storage

2. 瀏覽器重啟
   └─► 讀取 storage 中的 userId
   └─► 檢查 JWT 是否過期
   └─► 如果過期，調用 POST /users/refresh 刷新

3. JWT 刷新
   └─► 每 24 小時自動刷新
   └─► 401 錯誤時自動刷新並重試
```

#### 4.2 JWT 存儲

```javascript
// 存儲結構
{
  userId: 'uuid-v4',
  jwt: 'eyJhbGciOiJIUzI1NiIs...',
  lastJwtRefresh: 1234567890
}

// 刷新邏輯
async function refreshTokenIfNeeded() {
  const lastRefresh = await getLastJwtRefresh();
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  
  if (now - lastRefresh > oneDay) {
    await refreshToken();
  }
}
```

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
        textColor:     { type: 'string', default: '#ffffff' },
        backgroundColor: { type: 'string', default: 'rgba(0,0,0,0.6)' }
      },
      secondary: {
        fontSize:      { type: 'number', default: 24 },
        fontWeight:    { type: 'string', default: '400' },
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
configManager.subscribe('subtitle.dualModeEnabled', (newValue, oldValue) => {
  console.log('雙語模式變更:', oldValue, '→', newValue);
});

// 取消訂閱
configManager.unsubscribe('subtitle.dualModeEnabled', callback);

// 重置為默認值
await configManager.reset('subtitle.dualModeEnabled');

// 獲取所有配置
const allConfigs = await configManager.getAll();
```

#### 2.2 訂閱機制

```javascript
class ConfigManager {
  constructor() {
    this.subscribers = new Map(); // key -> Set(callbacks)
    this.cache = new Map();       // 緩存
    
    // 監聽 storage 變化
    chrome.storage.onChanged.addListener((changes) => {
      for (const [key, change] of Object.entries(changes)) {
        this.notifySubscribers(key, change.newValue, change.oldValue);
      }
    });
  }
  
  subscribe(key, callback) {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key).add(callback);
  }
  
  notifySubscribers(key, newValue, oldValue) {
    const callbacks = this.subscribers.get(key);
    if (callbacks) {
      callbacks.forEach(cb => cb(newValue, oldValue));
    }
  }
}
```

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
// 在 UI 組件中使用配置
class SubtitleDisplay {
  constructor() {
    // 訂閱配置變更
    configManager.subscribe('subtitle.dualModeEnabled', (enabled) => {
      this.toggleDualMode(enabled);
    });
    
    configManager.subscribe('style.primary.fontSize', (size) => {
      this.updatePrimaryFontSize(size);
    });
  }
  
  async initialize() {
    // 獲取初始配置
    const dualMode = await configManager.get('subtitle.dualModeEnabled');
    this.toggleDualMode(dualMode);
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

// 在 UIManager 中註冊
UIManager.registerComponent('myNewComponent', myNewComponent);
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
chrome.storage.local.set({ 'system.debugMode': true });
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

1. 檢查 `system.isEnabled` 是否為 true
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
- `content/system/netflix-api-bridge.js`
- `content/system/config/config-schema.js`
- `content/system/config/config-manager.js`
- `content/system/config/config-bridge.js`
- `content/system/config/storage-adapter.js`

#### 核心層
- `content/core/playback-context-manager.js` — 播放上下文管理（gate/videoId/session/epoch）
- `content/core/subtitle-replacer.js`
- `content/core/submission-queue-manager.js`
- `content/core/vote-bridge.js`
- `content/core/translation-bridge.js`
- `content/core/replacement-event-bridge.js`
- `content/core/video-info.js`

#### UI 層
- `content/ui/ui-manager-new.js`
- `content/ui/subtitle-display.js`
- `content/ui/subtitle-style-manager.js` — 樣式管理器（ConfigBridge 驅動、UI 重建恢復）
- `content/ui/interaction-panel.js`
- `content/ui/submission-dialog.js`
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
POST   /users              # 註冊新用戶
POST   /users/refresh      # 刷新 JWT
GET    /subtitles          # 獲取字幕翻譯
POST   /votes              # 提交投票
POST   /translations       # 提交翻譯
POST   /replacement-events # 提交替換事件（批量）
GET    /users/{id}/stats   # 獲取用戶統計
```

### C. 第三方依賴

本專案目前 **無第三方 runtime 依賴**，所有功能使用原生 JavaScript 實現。

**Chrome APIs 使用**:
- `chrome.storage.local` - 本地存儲
- `chrome.runtime` - 擴充功能運行時
- `chrome.alarms` - 定時任務
- `chrome.tabs` - 標籤頁管理

---

如有任何問題或需要進一步說明，請參考 `docs/` 目錄中的其他技術文檔，或於 GitHub 上提出 Issue。
