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
├── netflix-page-script.js     # Netflix 頁面注入腳本
├── popup.html/js              # 彈出窗口
├── options.html/js/css        # 設定頁面
├── tutorial.html/js/css       # 教學頁面
├── content/                   # 核心模組目錄
│   ├── index.js              # Page Context 入口
│   ├── system/               # 系統層模組
│   ├── core/                 # 核心業務邏輯
│   ├── ui/                   # UI 組件
│   ├── subtitle-modes/       # 字幕模式
│   └── utils/                # 工具函數
├── background/               # 背景服務模組
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
- **職責**: 攔截 Netflix API、訪問內部播放器
- **權限**: 完整訪問 `window.netflix` 對象
- **通信**: 通過 `window.postMessage` 與 Page Context 通信

---

## 核心模組

### 1. System Layer（系統層）

#### 1.1 InitializationManager (`content/system/initialization-manager.js`)

**職責**: 統一管理所有組件的初始化流程

**初始化順序**:
```javascript
1. initializeMessaging()      // 建立消息通信
2. initializeConfig()         // 加載配置
3. initializeVideoInfo()      // 獲取影片信息
4. initializeSubtitleModes()  // 初始化字幕模式
5. initializeUIManager()      // 初始化 UI
6. setupPageVisibilityHandler() // 頁面可見性處理
```

**生命週期管理**:
- 頁面加載時自動初始化
- 頁面隱藏時暫停字幕處理
- 頁面顯示時恢復運行
- 提供 `destroy()` 方法進行清理

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
  voteType: 'up',  // 'up' | 'down'
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

---

### 3. UI Layer（UI 層）

#### 3.1 UIManager (`content/ui/ui-manager-new.js`)

**職責**: 統一管理所有 UI 組件

**管理的組件**:
- SubtitleDisplay（字幕顯示）
- InteractionPanel（交互面板）
- SubmissionDialog（提交對話框）
- FullscreenHandler（全螢幕處理）
- ToastManager（通知）

**註冊機制**:
```javascript
// 組件向 UIManager 註冊
UIManager.registerComponent('subtitleDisplay', subtitleDisplay);

// UIManager 統一管理組件生命周期
UIManager.initializeAll();
UIManager.destroyAll();
```

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
```javascript
// 動態應用樣式
{
  fontSize: '24px',
  color: '#ffffff',
  textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
  backgroundColor: 'transparent',
  fontFamily: 'Netflix Sans, Arial, sans-serif'
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

#### 3.8 NetflixPlayerAdapter (`content/ui/netflix-player-adapter.js`)

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

**職責**: 協調不同字幕模式之間的切換

**設計理念**:
- Netflix 的字幕系統複雜且多變
- 單一模式無法覆蓋所有場景
- 需要根據情況動態切換模式

**支持的模式**:
1. **DOM Monitor Mode** - 監聽原生字幕 DOM 變化
2. **Interceptor Mode** - 攔截字幕請求（支持雙語）

**協調策略**:
```javascript
// 優先使用攔截模式（如果可用）
if (canIntercept()) {
  enableInterceptorMode();
} else {
  // 降級到 DOM 監聽模式
  enableDOMMonitorMode();
}

// 如果當前模式失敗，自動切換
onModeFailure(() => switchToAlternativeMode());
```

#### 4.2 ModeDetector (`content/subtitle-modes/mode-detector.js`)

**職責**: 檢測當前應該使用的字幕模式

**檢測邏輯**:
```javascript
function detectMode() {
  // 檢查是否支持攔截
  if (window.netflix && window.netflix.player) {
    return 'interceptor';
  }
  
  // 檢查是否存在字幕元素
  if (document.querySelector('.player-timedtext')) {
    return 'dom-monitor';
  }
  
  return 'none';
}
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

**職責**: 攔截 Netflix 的字幕請求

**實現原理**:
1. 注入 Page Script 到 Netflix 頁面
2. 攔截 `XMLHttpRequest` 和 `fetch`
3. 識別字幕請求（TTML 格式）
4. 解析字幕數據並通過 postMessage 發送

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

---

### 5. Utils（工具層）

#### 5.1 SubtitleParser (`content/utils/subtitle-parser.js`)

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
    begin: 1.000,      // 開始時間（秒）
    end: 4.000,        // 結束時間（秒）
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

// 提交數據
submitVote(voteData) → { success }
submitTranslation(translationData) → { success }
submitReplacementEvents(events) → { success }

// 統計
fetchUserStats(userId) → { stats }
```

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

### 通信協議圖

```
┌─────────────────────────────────────────────────────────────────┐
│                      Data Flow Architecture                      │
└─────────────────────────────────────────────────────────────────┘

1. 配置數據流：
   Options Page ──write──► chrome.storage.local ──watch──► ConfigManager
                                                          └──► 通知所有訂閱者

2. 字幕數據流：
   Netflix CDN ──intercept──► Page Script ──parse──► SubtitleCoordinator
                                                       └──► UIManager ──► SubtitleDisplay

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
  begin: number;           // 開始時間（秒）
  end: number;             // 結束時間（秒）
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
  userVote: 'up' | 'down' | null;  // 當前用戶投票
}
```

#### 投票數據結構

```typescript
interface VoteData {
  videoId: string;         // 影片 ID
  timestamp: number;       // 時間戳（秒）
  voteType: 'up' | 'down'; // 投票類型
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
1. Netflix 請求字幕文件
        ↓
2. Page Script 攔截請求
        ↓
3. 解析 TTML 獲取原始字幕
        ↓
4. SubtitleReplacer 查詢翻譯
        ↓
5. 如果有翻譯 → 替換並記錄事件
   如果無翻譯 → 使用原始字幕
        ↓
6. SubtitleDisplay 渲染到頁面
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
// content/system/config/config-schema.js
export const configSchema = {
  // 系統配置
  'system.debugMode': {
    type: 'boolean',
    default: false,
    description: '是否啟用調試模式'
  },
  'system.isEnabled': {
    type: 'boolean',
    default: true,
    description: '擴充功能是否啟用'
  },
  
  // 字幕配置
  'subtitle.dualModeEnabled': {
    type: 'boolean',
    default: false,
    description: '是否啟用雙語字幕'
  },
  'subtitle.primaryLanguage': {
    type: 'string',
    default: 'zh-Hant',
    description: '主要字幕語言'
  },
  'subtitle.secondaryLanguage': {
    type: 'string',
    default: 'en',
    description: '次要字幕語言'
  },
  
  // 樣式配置
  'style.primary.fontSize': {
    type: 'number',
    default: 24,
    description: '主要字幕字體大小'
  },
  'style.primary.color': {
    type: 'string',
    default: '#ffffff',
    description: '主要字幕顏色'
  },
  'style.secondary.fontSize': {
    type: 'number',
    default: 20,
    description: '次要字幕字體大小'
  },
  
  // API 配置
  'api.baseUrl': {
    type: 'string',
    default: 'https://subnfbackend.zeabur.app',
    description: 'API 基礎 URL'
  },
  
  // 用戶配置
  'user.userId': {
    type: 'string',
    default: null,
    description: '用戶唯一標識'
  }
};
```

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
// content/system/config/config-schema.js
export const configSchema = {
  // ... 現有配置
  
  'myFeature.enabled': {
    type: 'boolean',
    default: false,
    description: '啟用我的新功能'
  },
  'myFeature.setting': {
    type: 'string',
    default: 'default-value',
    description: '新功能的設定'
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
- `content/core/subtitle-replacer.js`
- `content/core/submission-queue-manager.js`
- `content/core/vote-bridge.js`
- `content/core/translation-bridge.js`
- `content/core/replacement-event-bridge.js`
- `content/core/video-info.js`

#### UI 層
- `content/ui/ui-manager-new.js`
- `content/ui/subtitle-display.js`
- `content/ui/subtitle-style-manager.js`
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
- `content/subtitle-modes/subtitle-interceptor.js`

#### 工具
- `content/utils/subtitle-parser.js`

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
