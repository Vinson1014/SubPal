// content.js
// 內容腳本 - 作為 background 和 page context (content/index.js) 之間的消息橋樑
// 使用 chrome.runtime.connect 建立長連接以提高穩定性

(function() {
  let debugMode = false; // 控制調試日誌輸出

  function debugLog(...args) {
    if (debugMode) {
      console.log('[Content Script]', ...args);
    }
  }

  // 檢查 chrome.runtime 是否可用
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) {
    console.error('[Content Script] chrome.runtime is not available. Extension messaging will not work.');
    return;
  }
  debugLog('Initializing message bridge with long-lived connection...');

  let messageCounter = 0; // 用於生成唯一訊息 ID 的計數器
  let backgroundPortTransportPromise = null;
  let configManager = null; // ConfigManager 實例
  let submissionQueueManager = null; // SubmissionQueueManager 實例
  let pageScriptReadinessPromise = null;
  let pageContextStartAttempted = false;
  let isolatedEndscreenStartPromise = null;
  let pageIngressPromise = null;

  const PAGE_SCRIPT_READY_EVENT = 'subpal-page-script-ready';
  const PAGE_SCRIPT_READY_REQUEST_EVENT = 'subpal-request-page-script-ready';
  const PAGE_SCRIPT_MARKER_SELECTOR = 'script[data-subpal-page-script-state]';
  const PAGE_SCRIPT_READY_TIMEOUT_MS = 5000;
  const PAGE_SCRIPT_POLL_INTERVAL_MS = 50;
  const PAGE_SCRIPT_RETRY_DELAY_MS = 500;
  const PAGE_SCRIPT_ATTRIBUTES = {
    state: 'data-subpal-page-script-state',
    attempt: 'data-subpal-page-script-attempt',
    attemptId: 'data-subpal-page-script-attempt-id',
    deadline: 'data-subpal-page-script-deadline',
    retryNotBefore: 'data-subpal-page-script-retry-not-before'
  };

  // 隊列消息類型常數
  const QUEUE_MESSAGE_TYPES = [
    'VOTE_ENQUEUE', 'VOTE_GET_HISTORY', 'VOTE_GET_STATUS', 'VOTE_GET_AUTHORITY', 'VOTE_RETRY',
    'TRANSLATION_ENQUEUE', 'TRANSLATION_GET_HISTORY', 'TRANSLATION_GET_RECONCILIATION', 'TRANSLATION_RETRY',
    'GET_ALL_PENDING', 'GET_QUEUE_STATS', 'REPLACEMENT_EVENT_ENQUEUE', 
    'REPLACEMENT_EVENT_GET_HISTORY', 'REPLACEMENT_EVENT_RETRY'
  ];

  // 初始化 ConfigManager
  async function initializeConfigManager() {
    // 先直接從 storage 讀取 debugMode，以便早期的 debugLog 能正常工作
    try {
      const result = await chrome.storage.local.get('debugMode');
      if (result.debugMode !== undefined) {
        debugMode = result.debugMode;
      }
    } catch (error) {
      console.warn('[Content Script] 讀取 debugMode 失敗，使用預設值:', error);
    }

    debugLog('開始初始化 ConfigManager...');

    const { ConfigManager } = await import(chrome.runtime.getURL('content/system/config/config-manager.js'));
    const { getAllConfigKeys } = await import(chrome.runtime.getURL('content/system/config/config-schema.js'));
    configManager = new ConfigManager({ debug: debugMode });

    try {
      await configManager.initialize();
    } catch (error) {
      console.error('[Content Script] ConfigManager 初始化失敗:', error);
      return false;
    }

    const allConfigKeys = getAllConfigKeys();
    configManager.subscribe(allConfigKeys, (key, newValue, oldValue) => {
      debugLog('ConfigManager 配置變更:', key, newValue, oldValue);
      window.dispatchEvent(new CustomEvent('messageFromContentScript', {
        detail: {
          message: {
            type: 'CONFIG_CHANGED',
            key: key,
            newValue: newValue,
            oldValue: oldValue
          }
        }
      }));
    });

    debugMode = configManager.get('debugMode') || false;
    debugLog('從 ConfigManager 讀取初始 debugMode:', debugMode);

    configManager.subscribe('debugMode', (key, newValue, oldValue) => {
      debugMode = newValue;
      debugLog('Content script debugMode 已更新:', oldValue, '->', newValue);
    });

    debugLog('ConfigManager 初始化完成');
    return true;
  }

  // 初始化 SubmissionQueueManager
  async function initializeQueueManagers() {
    try {
      debugLog('開始初始化 SubmissionQueueManager...');

      // 動態導入 SubmissionQueueManager
      const { SubmissionQueueManager } = await import(chrome.runtime.getURL('content/core/submission-queue-manager.js'));

      // 創建實例
      submissionQueueManager = new SubmissionQueueManager({ debug: debugMode });

      // 初始化
      await submissionQueueManager.initialize();

      debugLog('SubmissionQueueManager 初始化完成');
      return true;
    } catch (error) {
      console.error('[Content Script] SubmissionQueueManager 初始化失敗:', error);
      return false;
    }
  }

  // 透過 DOM 注入，讓主模組在 MAIN world 執行並共享 page script handshake。
  function injectPageContextScript() {
    try {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = chrome.runtime.getURL('content/index.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
      debugLog('MAIN world 主模組注入完成。');
    } catch (e) {
      console.error('[Content Script] Error injecting MAIN world main module:', e);
    }
  }

  function startPageContextOnce() {
    if (pageContextStartAttempted) return;
    pageContextStartAttempted = true;
    injectPageContextScript();
  }

  async function initializeIsolatedEndscreenTasks() {
    const { initMessaging } = await import(chrome.runtime.getURL('content/system/messaging.js'));
    await initMessaging();
    const { startIsolatedEndscreenTasks } = await import(chrome.runtime.getURL('content/system/isolated-endscreen-tasks.js'));
    const { playbackContextManager } = await import(chrome.runtime.getURL('content/core/playback-context-manager.js'));
    await startIsolatedEndscreenTasks(configManager, playbackContextManager);
  }

  function startIsolatedEndscreenTasksOnce() {
    if (!isolatedEndscreenStartPromise) {
      isolatedEndscreenStartPromise = initializeIsolatedEndscreenTasks();
    }
    return isolatedEndscreenStartPromise;
  }

  // 處理配置相關訊息
  function handleConfigMessage(messageId, message) {
    if (!configManager) {
      debugLog('ConfigManager 尚未初始化，回應錯誤');
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: 'ConfigManager not initialized'
          }
        }
      }));
      return;
    }

    // 處理不同類型的配置訊息
    switch (message.type) {
      case 'CONFIG_GET_ALL':
        handleConfigGetAll(messageId);
        break;

      case 'CONFIG_GET':
        handleConfigGet(messageId, message.key);
        break;

      case 'CONFIG_SET':
        handleConfigSet(messageId, message.key, message.value);
        break;

      case 'CONFIG_SET_MULTIPLE':
        handleConfigSetMultiple(messageId, message.items);
        break;

      default:
        debugLog('未知的配置訊息類型:', message.type);
        window.dispatchEvent(new CustomEvent('responseFromContentScript', {
          detail: {
            messageId: messageId,
            response: {
              success: false,
              error: `Unknown config message type: ${message.type}`
            }
          }
        }));
    }
  }

  // CONFIG_GET_ALL 處理
  async function handleConfigGetAll(messageId) {
    try {
      const config = configManager.getAll();
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true,
            config: config
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_GET_ALL 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // CONFIG_GET 處理
  async function handleConfigGet(messageId, key) {
    try {
      const value = configManager.get(key);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true,
            value: value
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_GET 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // CONFIG_SET 處理
  async function handleConfigSet(messageId, key, value) {
    try {
      await configManager.set(key, value);

      // 回應成功
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_SET 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // CONFIG_SET_MULTIPLE 處理
  async function handleConfigSetMultiple(messageId, items) {
    try {
      await configManager.setMultiple(items);

      // 回應成功
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: true
          }
        }
      }));
    } catch (error) {
      debugLog('CONFIG_SET_MULTIPLE 失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            success: false,
            error: error.message
          }
        }
      }));
    }
  }

  // 處理隊列相關訊息
  async function handleQueueMessage(messageId, message) {
    if (!submissionQueueManager) {
      debugLog('SubmissionQueueManager 尚未初始化，回應錯誤');
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            error: 'SubmissionQueueManager not initialized'
          }
        }
      }));
      return;
    }

    const { type, payload } = message;

    try {
      let result;

      switch (type) {
        // 投票消息（支援 voteState 用於 translation-target 投票）
        case 'VOTE_ENQUEUE':
          result = await submissionQueueManager.enqueueVote(payload);
          break;

        case 'VOTE_GET_HISTORY':
          result = await submissionQueueManager.getVoteHistory(payload?.limit);
          result = { history: result };
          break;

        case 'VOTE_GET_STATUS':
          result = await submissionQueueManager.getVoteStatus(payload.itemId);
          break;

        case 'VOTE_GET_AUTHORITY':
          result = await submissionQueueManager.getVoteAuthority(payload.translationID);
          break;

        case 'VOTE_RETRY':
          result = await submissionQueueManager.retryVote(payload.itemId);
          result = { success: result };
          break;

        // 翻譯消息
        case 'TRANSLATION_ENQUEUE':
          result = await submissionQueueManager.enqueueTranslation(payload);
          break;

        case 'TRANSLATION_GET_HISTORY':
          result = await submissionQueueManager.getTranslationHistory(payload?.limit);
          result = { history: result };
          break;

        case 'TRANSLATION_GET_RECONCILIATION':
          result = await submissionQueueManager.getTranslationReconciliation(payload.itemIds);
          break;

        case 'TRANSLATION_RETRY':
          result = await submissionQueueManager.retryTranslation(payload.itemId);
          result = { success: result };
          break;

        // 替換事件消息
        case 'REPLACEMENT_EVENT_ENQUEUE':
          result = await submissionQueueManager.enqueueReplacementEvent(payload);
          break;

        case 'REPLACEMENT_EVENT_GET_HISTORY':
          result = await submissionQueueManager.getReplacementEventHistory(payload?.limit);
          result = { history: result };
          break;

        case 'REPLACEMENT_EVENT_RETRY':
          result = await submissionQueueManager.retryReplacementEvent(payload.itemId);
          result = { success: result };
          break;

        // 通用消息
        case 'GET_ALL_PENDING':
          result = await submissionQueueManager.getAllPending();
          break;

        case 'GET_QUEUE_STATS':
          result = await submissionQueueManager.getStats();
          break;

        default:
          window.dispatchEvent(new CustomEvent('responseFromContentScript', {
            detail: {
              messageId: messageId,
              response: {
                error: `未知的消息類型: ${type}`
              }
            }
          }));
          return;
      }

      // 回應成功
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: result
        }
      }));
    } catch (error) {
      debugLog('處理隊列消息失敗:', error);
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: {
          messageId: messageId,
          response: {
            error: error.message
          }
        }
      }));
    }
  }

  function getBackgroundPortTransport() {
    if (!backgroundPortTransportPromise) {
      backgroundPortTransportPromise = import(chrome.runtime.getURL('content/system/capabilities/private-transports.js')).then(({ createEnvelope, createPortTransport }) => ({
        createEnvelope,
        transport: createPortTransport({
          connect: () => chrome.runtime.connect({ name: 'subtitle-assistant-channel' }),
          isNotification: (message) => message?.messageId === 'subtitle-style-broadcast' || Boolean(message?.response?.type),
          onNotification: (message) => {
            window.dispatchEvent(new CustomEvent('messageFromContentScript', {
              detail: { message: message.response || message, messageId: message.messageId, sender: 'background' }
            }));
          }
        })
      }));
    }
    return backgroundPortTransportPromise;
  }

  function connectToBackground() {
    getBackgroundPortTransport().then(({ transport }) => transport.start());
  }

  function dispatchInternalMessage(messageId, message) {
    window.dispatchEvent(new CustomEvent('messageFromContentScript', {
      detail: { messageId, message }
    }));
  }

  function respondToPageObservation(messageId, response) {
    window.dispatchEvent(new CustomEvent('responseFromContentScript', {
      detail: { messageId, response }
    }));
  }

  function hasAuthorityBearingKey(message) {
    return ['destination', 'command', 'backgroundCommand', 'storage', 'storageKey',
      'endpoint', 'credential', 'credentials', 'sync', 'syncConfig', 'lifecycle', 'lifecycleConfig', 'config'
    ].some((key) => Object.prototype.hasOwnProperty.call(message, key));
  }

  function adaptPageVideoObservation(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.category === 'page-observation') return { input: message, authorityEscalated: false };
    if (message.type !== 'VIDEO_ID_CHANGED') return null;

    const payload = {};
    if (Object.prototype.hasOwnProperty.call(message, 'oldVideoId')) payload.oldVideoId = message.oldVideoId;
    if (Object.prototype.hasOwnProperty.call(message, 'newVideoId')) payload.newVideoId = message.newVideoId;
    if (Object.prototype.hasOwnProperty.call(message, 'videoId')) payload.videoId = message.videoId;
    return {
      input: {
        category: 'page-observation',
        variant: 'video-context-changed',
        payload
      },
      authorityEscalated: hasAuthorityBearingKey(message)
    };
  }

  function getPageIngress() {
    if (!pageIngressPromise) {
      pageIngressPromise = import(chrome.runtime.getURL('content/system/capabilities/page-ingress.js'))
        .then(({ PageIngress }) => PageIngress);
    }
    return pageIngressPromise;
  }

  function acceptPageVideoObservation(messageId, observation) {
    getPageIngress().then((pageIngress) => {
      const result = pageIngress.accept(observation.input, {
        authorityEscalated: observation.authorityEscalated,
        dispatch: (message) => dispatchInternalMessage(messageId, message)
      });
      respondToPageObservation(messageId, result);
    });
  }

  // 1. 監聽來自 page context (messaging.js) 的消息事件
  window.addEventListener('messageToContentScript', (event) => {
    const { messageId, message } = event.detail;
    debugLog('Received from page:', messageId, message);

    if (message?.type === 'GET_CROWDSOURCING_TASKS') return;

    const pageVideoObservation = adaptPageVideoObservation(message);
    if (pageVideoObservation) {
      acceptPageVideoObservation(messageId, pageVideoObservation);
      return;
    }

    // 檢查是否為配置相關訊息（由 content script 處理，不轉發到 background）
    const configMessages = ['CONFIG_GET_ALL', 'CONFIG_GET', 'CONFIG_SET', 'CONFIG_SET_MULTIPLE'];

    if (configMessages.includes(message.type)) {
      debugLog('處理配置訊息:', message.type);
      handleConfigMessage(messageId, message);
      return;
    }

    // 檢查是否為隊列相關訊息（由 content script 處理，不轉發到 background）
    if (QUEUE_MESSAGE_TYPES.includes(message.type)) {
      debugLog('處理隊列訊息:', message.type);
      handleQueueMessage(messageId, message);
      return;
    }

    // 檢查是否為內部消息（不需要發送到 background）
    const internalMessages = ['SUBTITLE_READY', 'RAW_TTML_INTERCEPTED'];

    if (internalMessages.includes(message.type)) {
      debugLog('處理內部消息:', message.type);

      dispatchInternalMessage(messageId, message);

      // 內部消息不需要回應，直接返回
      return;
    }

    // 生成唯一的訊息 ID，如果未提供
    const uniqueMessageId = messageId || generateUniqueMessageId(message.type);

    getBackgroundPortTransport().then(({ createEnvelope, transport }) => transport.request(createEnvelope({
      requestId: uniqueMessageId,
      kind: 'background-forward',
      payload: message
    }))).then((result) => {
      window.dispatchEvent(new CustomEvent('responseFromContentScript', {
        detail: { messageId: uniqueMessageId, response: result.ok ? result.value : result }
      }));
    });
  });

  // 移除舊的 chrome.runtime.onMessage 監聽器，因為我們現在使用 port
  // chrome.runtime.onMessage.addListener(...) // 這部分將被移除

  // 生成唯一訊息 ID 的輔助函數
  function generateUniqueMessageId(messageType) {
    messageCounter++;
    return `content_msg_${Date.now()}_${messageCounter}_${messageType}`;
  }

  function getPageScriptMarker() {
    return document.querySelector(PAGE_SCRIPT_MARKER_SELECTOR);
  }

  function readPageScriptRecord(marker = getPageScriptMarker()) {
    if (!marker) return null;
    return {
      marker,
      state: marker.getAttribute(PAGE_SCRIPT_ATTRIBUTES.state),
      attempt: Number(marker.getAttribute(PAGE_SCRIPT_ATTRIBUTES.attempt)),
      attemptId: marker.getAttribute(PAGE_SCRIPT_ATTRIBUTES.attemptId),
      deadline: Number(marker.getAttribute(PAGE_SCRIPT_ATTRIBUTES.deadline)),
      retryNotBefore: Number(marker.getAttribute(PAGE_SCRIPT_ATTRIBUTES.retryNotBefore))
    };
  }

  function markerMatches(marker, attemptId, state) {
    const current = getPageScriptMarker();
    return current === marker &&
      current.getAttribute(PAGE_SCRIPT_ATTRIBUTES.attemptId) === attemptId &&
      current.getAttribute(PAGE_SCRIPT_ATTRIBUTES.state) === state;
  }

  function transitionPageScriptState(marker, attemptId, expectedState, nextState) {
    if (!markerMatches(marker, attemptId, expectedState)) return false;
    marker.setAttribute(PAGE_SCRIPT_ATTRIBUTES.state, nextState);
    return true;
  }

  function createPageScriptAttempt(attempt, now) {
    const attemptId = crypto.randomUUID();
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('netflix-page-script.js');
    script.setAttribute(PAGE_SCRIPT_ATTRIBUTES.state, 'loading');
    script.setAttribute(PAGE_SCRIPT_ATTRIBUTES.attempt, String(attempt));
    script.setAttribute(PAGE_SCRIPT_ATTRIBUTES.attemptId, attemptId);
    script.setAttribute(PAGE_SCRIPT_ATTRIBUTES.deadline, String(now + PAGE_SCRIPT_READY_TIMEOUT_MS));
    script.setAttribute(PAGE_SCRIPT_ATTRIBUTES.retryNotBefore, '');
    script.onload = () => {
      if (transitionPageScriptState(script, attemptId, 'loading', 'loaded')) {
        debugLog(`Netflix page script 第 ${attempt} 次載入完成，等待 readiness 回應。`);
      }
    };
    script.onerror = (error) => {
      const nextState = attempt === 1 ? 'error' : 'failed-terminal';
      if (transitionPageScriptState(script, attemptId, 'loading', nextState)) {
        console.error(`Netflix page script 第 ${attempt} 次載入失敗:`, error);
      }
    };
    return script;
  }

  function appendInitialPageScriptAttempt(now) {
    const existing = getPageScriptMarker();
    if (existing) return existing;

    const script = createPageScriptAttempt(1, now);
    if (getPageScriptMarker()) return getPageScriptMarker();
    (document.head || document.documentElement).appendChild(script);
    return script;
  }

  function claimPageScriptRetry(record, now) {
    if (record.attempt !== 1 || !markerMatches(record.marker, record.attemptId, 'error')) return false;
    record.marker.setAttribute(PAGE_SCRIPT_ATTRIBUTES.retryNotBefore, String(now + PAGE_SCRIPT_RETRY_DELAY_MS));
    if (!markerMatches(record.marker, record.attemptId, 'error')) return false;
    record.marker.setAttribute(PAGE_SCRIPT_ATTRIBUTES.state, 'retry-claimed');
    return true;
  }

  function appendRetryPageScriptAttempt(record, now) {
    if (record.attempt !== 1 || !markerMatches(record.marker, record.attemptId, 'retry-claimed')) return null;
    const script = createPageScriptAttempt(2, now);
    if (!markerMatches(record.marker, record.attemptId, 'retry-claimed')) return null;
    record.marker.replaceWith(script);
    return script;
  }

  function failPageScriptAttempt(record) {
    if (!record || !['loading', 'loaded', 'error'].includes(record.state)) return false;
    return transitionPageScriptState(record.marker, record.attemptId, record.state, 'failed-terminal');
  }

  function ensureNetflixPageScriptReady() {
    if (pageScriptReadinessPromise) return pageScriptReadinessPromise;

    pageScriptReadinessPromise = new Promise((resolve) => {
      const probeId = crypto.randomUUID();
      let settled = false;
      let localAttemptId = null;
      let localDeadline = null;
      let pollTimer = null;
      let retryWakeTimer = null;
      let retryWakeAt = null;

      const finish = (ready) => {
        if (settled) return;
        settled = true;
        if (pollTimer !== null) clearTimeout(pollTimer);
        if (retryWakeTimer !== null) clearTimeout(retryWakeTimer);
        window.removeEventListener(PAGE_SCRIPT_READY_EVENT, handleReady);
        resolve(ready);
      };

      const schedulePoll = () => {
        if (settled || pollTimer !== null) return;
        pollTimer = setTimeout(() => {
          pollTimer = null;
          tick();
        }, PAGE_SCRIPT_POLL_INTERVAL_MS);
      };

      const scheduleRetryWake = (wakeAt) => {
        if (settled || (retryWakeTimer !== null && retryWakeAt === wakeAt)) return;
        if (retryWakeTimer !== null) clearTimeout(retryWakeTimer);
        retryWakeAt = wakeAt;
        retryWakeTimer = setTimeout(() => {
          retryWakeTimer = null;
          retryWakeAt = null;
          tick();
        }, Math.max(0, wakeAt - Date.now()));
      };

      const handleReady = (event) => {
        if (settled) return;
        const detail = event.detail;
        const now = Date.now();
        if (!detail || detail.attemptId !== localAttemptId || detail.probeId !== probeId ||
          detail.deadline !== localDeadline || !Number.isFinite(detail.readyAt) ||
          detail.readyAt > now || detail.readyAt > localDeadline || now > localDeadline) {
          return;
        }

        const record = readPageScriptRecord();
        if (!record || record.attemptId !== localAttemptId || record.deadline !== localDeadline ||
          !['loading', 'loaded'].includes(record.state)) return;
        if (transitionPageScriptState(record.marker, record.attemptId, record.state, 'ready')) finish(true);
      };

      const tick = () => {
        if (settled) return;
        const now = Date.now();
        let record = readPageScriptRecord();
        if (!record) {
          appendInitialPageScriptAttempt(now);
          record = readPageScriptRecord();
        }
        if (!record) {
          finish(false);
          return;
        }

        if (record.state === 'ready') {
          finish(true);
          return;
        }
        if (record.state === 'failed-terminal') {
          finish(false);
          return;
        }

        if (record.state === 'error') {
          if (record.attempt !== 1 || now > record.deadline) {
            failPageScriptAttempt(record);
          } else if (claimPageScriptRetry(record, now)) {
            record = readPageScriptRecord();
          }
        }

        if (record?.state === 'retry-claimed') {
          if (now >= record.retryNotBefore) {
            appendRetryPageScriptAttempt(record, now);
          } else {
            scheduleRetryWake(record.retryNotBefore);
          }
          schedulePoll();
          return;
        }

        record = readPageScriptRecord();
        if (!record) {
          finish(false);
          return;
        }
        if (record.state === 'failed-terminal') {
          finish(false);
          return;
        }
        if (!['loading', 'loaded'].includes(record.state) || !Number.isFinite(record.deadline)) {
          schedulePoll();
          return;
        }

        localAttemptId = record.attemptId;
        localDeadline = record.deadline;
        if (now > localDeadline) {
          failPageScriptAttempt(record);
          finish(false);
          return;
        }

        window.dispatchEvent(new CustomEvent(PAGE_SCRIPT_READY_REQUEST_EVENT, {
          detail: { attemptId: localAttemptId, probeId, deadline: localDeadline }
        }));
        if (settled) return;
        record = readPageScriptRecord();
        if (record?.state === 'ready') {
          finish(true);
          return;
        }
        if (Date.now() >= localDeadline) {
          failPageScriptAttempt(record);
          finish(false);
          return;
        }
        schedulePoll();
      };

      window.addEventListener(PAGE_SCRIPT_READY_EVENT, handleReady);
      tick();
    });
    return pageScriptReadinessPromise;
  }

  // 建立初始連接
  connectToBackground();

  // 初始化所有 Managers
  async function initializeAllManagers() {
    const pageScriptReady = ensureNetflixPageScriptReady();
    try {
      const configSuccess = await initializeConfigManager();
      if (!configSuccess) {
        console.error('[Content Script] ConfigManager 初始化失敗');
        if (await pageScriptReady) startPageContextOnce();
        return;
      }

      const queueSuccess = await initializeQueueManagers();
      if (!queueSuccess) {
        console.error('[Content Script] SubmissionQueueManager 初始化失敗');
      }

      debugLog('All managers initialized.');

      if (!await pageScriptReady) {
        console.warn('[Content Script] Netflix page script failed; skipping MAIN and isolated startup.');
        return;
      }
      startPageContextOnce();
      try {
        await startIsolatedEndscreenTasksOnce();
      } catch (error) {
        console.warn('[Content Script] 片尾任務模組初始化失敗:', error);
      }
    } catch (error) {
      console.error('[Content Script] Managers 初始化過程中發生錯誤:', error);
      if (!await pageScriptReady) {
        console.warn('[Content Script] Netflix page script failed; skipping MAIN and isolated startup.');
        return;
      }
      startPageContextOnce();
      if (!configManager) return;
      try {
        await startIsolatedEndscreenTasksOnce();
      } catch (isolatedError) {
        console.warn('[Content Script] 片尾任務模組初始化失敗:', isolatedError);
      }
    }
  }

  // 執行初始化
  initializeAllManagers();

  debugLog('Message bridge initialized.');
})();
