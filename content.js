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
  let pageScriptReadinessPromise = null;
  let pageContextStartAttempted = false;
  let isolatedEndscreenStartPromise = null;
  let pageIngressPromise = null;
  let contributionsCapabilityPromise = null;
  let subtitleQueryCapabilityPromise = null;
  let settingsCapabilityPromise = null;
  let publicConfigKeys = new Set();

  const PAGE_SCRIPT_READY_EVENT = 'subpal-page-script-ready';
  const PAGE_SCRIPT_READY_REQUEST_EVENT = 'subpal-request-page-script-ready';
  const PAGE_SCRIPT_MARKER_SELECTOR = 'script[data-subpal-page-script-state]';
  const PAGE_SCRIPT_READY_TIMEOUT_MS = 5000;
  const PAGE_SCRIPT_POLL_INTERVAL_MS = 50;
  const PAGE_SCRIPT_RETRY_DELAY_MS = 500;
  const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);
  const PAGE_SCRIPT_ATTRIBUTES = {
    state: 'data-subpal-page-script-state',
    attempt: 'data-subpal-page-script-attempt',
    attemptId: 'data-subpal-page-script-attempt-id',
    deadline: 'data-subpal-page-script-deadline',
    retryNotBefore: 'data-subpal-page-script-retry-not-before'
  };

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
    publicConfigKeys = new Set(allConfigKeys);
    configManager.subscribe(allConfigKeys, (key, newValue, oldValue) => {
      debugLog('ConfigManager 配置變更:', key, newValue, oldValue);
      const change = projectPublicConfigChange(key, newValue, oldValue);
      if (!change) return;
      window.dispatchEvent(new CustomEvent('messageFromContentScript', {
        detail: { message: change }
      }));
    });

    debugMode = configManager.get('debugMode') || false;
    debugLog('從 ConfigManager 讀取初始 debugMode:', debugMode);

    configManager.subscribe('debugMode', (_key, newValue, oldValue) => {
      debugMode = newValue;
      debugLog('Content script debugMode 已更新:', oldValue, '->', newValue);
    });

    debugLog('ConfigManager 初始化完成');
    return true;
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

  function terminalIngressFailure(authorityEscalated) {
    return {
      terminal: authorityEscalated
        ? { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } }
        : { ok: false, error: { kind: 'invalid', code: 'malformed-page-observation', retryable: false } }
    };
  }

  function ownDataProperty(message, key) {
    const descriptor = Object.getOwnPropertyDescriptor(message, key);
    if (!descriptor) return { present: false };
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    return { present: true, value: descriptor.value };
  }

  function isOrdinaryObjectPrototype(prototype) {
    if (prototype === Object.prototype) return true;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (!constructor || !Object.prototype.hasOwnProperty.call(constructor, 'value') || typeof constructor.value !== 'function') return false;
    const constructorPrototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
    return constructorPrototype?.value === prototype &&
      Function.prototype.toString.call(constructor.value) === OBJECT_CONSTRUCTOR_SOURCE;
  }

  function isPublicConfigPrimitive(value) {
    return typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value));
  }

  function hasSafeConfigData(value, visited = new Set()) {
    if (value === null || isPublicConfigPrimitive(value)) return true;
    if (typeof value !== 'object' || visited.has(value)) return false;
    visited.add(value);
    try {
      if (!Array.isArray(value)) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && !isOrdinaryObjectPrototype(prototype)) return false;
      }
      if (Object.getOwnPropertySymbols(value).length !== 0) return false;
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !hasSafeConfigData(descriptor.value, visited)) return false;
      }
      if (typeof structuredClone === 'function') structuredClone(value);
      return true;
    } catch {
      return false;
    }
  }

  function projectPublicConfigEntry(key, value) {
    if (!publicConfigKeys.has(key) || !isPublicConfigPrimitive(value)) return null;
    return { key, value };
  }

  function parseSettingsSnapshotRequest(message, authorityEscalated) {
    try {
      if (authorityEscalated) return terminalIngressFailure(true).terminal;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
      if (typeof structuredClone === 'function') structuredClone(message);

      const prototype = Object.getPrototypeOf(message);
      if (prototype !== null && !isOrdinaryObjectPrototype(prototype)) return null;
      const keys = Object.getOwnPropertyNames(message);
      if (Object.getOwnPropertySymbols(message).length !== 0 ||
          keys.length !== 3 || keys.some((key) => !['category', 'variant', 'payload'].includes(key))) return null;

      const request = {};
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(message, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) return null;
        request[key] = descriptor.value;
      }
      if (request.category !== 'settings-read' || request.variant !== 'snapshot') return null;

      const payload = request.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      if (typeof structuredClone === 'function') structuredClone(payload);
      const payloadPrototype = Object.getPrototypeOf(payload);
      if (payloadPrototype !== null && !isOrdinaryObjectPrototype(payloadPrototype)) return null;
      if (Object.getOwnPropertyNames(payload).length !== 0 || Object.getOwnPropertySymbols(payload).length !== 0) return null;
      return request;
    } catch {
      return null;
    }
  }

  function projectPublicConfig(config) {
    if (!hasSafeConfigData(config)) return null;
    const projected = {};
    for (const key of Object.getOwnPropertyNames(config)) {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor?.enumerable) continue;
      const entry = projectPublicConfigEntry(key, descriptor.value);
      if (entry) projected[entry.key] = entry.value;
    }
    return projected;
  }

  function projectPublicConfigChange(key, newValue, oldValue) {
    const next = projectPublicConfigEntry(key, newValue);
    const previous = projectPublicConfigEntry(key, oldValue);
    if (!next || !previous) return null;
    return { type: 'CONFIG_CHANGED', key: next.key, newValue: next.value, oldValue: previous.value };
  }

  function hasAuthorityBearingKey(message) {
    const authorityKeys = ['destination', 'command', 'backgroundCommand', 'storage', 'storageKey',
      'endpoint', 'credential', 'credentials', 'sync', 'syncConfig', 'lifecycle', 'lifecycleConfig', 'config',
      'backendProfileId', 'backendProfiles', 'activeProfileId', 'profile',
      'jwt', 'token', 'auth', 'authorization', 'user', 'userId', 'debug', 'style', 'video', 'playback'
    ];
    for (const key of authorityKeys) {
      for (let target = message; target !== null; target = Object.getPrototypeOf(target)) {
        if (Object.getOwnPropertyDescriptor(target, key)) return true;
      }
    }
    return false;
  }

  function adaptPageIngressMessage(message) {
    if (!message || typeof message !== 'object') return terminalIngressFailure(false);
    let authorityEscalated = false;
    try {
      authorityEscalated = hasAuthorityBearingKey(message);
      const category = ownDataProperty(message, 'category');
      const type = ownDataProperty(message, 'type');
      if (category === null || type === null) return terminalIngressFailure(authorityEscalated);
      if (category?.value === 'backend-profile') {
        return { terminal: { ok: false, error: { kind: 'forbidden', code: 'page-profile-change', retryable: false } } };
      }
      if (category?.value === 'page-observation' || category?.value === 'subtitle-query' ||
          category?.value === 'contribution-intent' || category?.value === 'contribution-read' ||
          category?.value === 'settings-change' || category?.value === 'settings-read') {
        return { input: message, category: category.value, type: type.value, authorityEscalated };
      }
      if (type.value === 'SUBTITLE_READY') {
        return authorityEscalated ? terminalIngressFailure(true) : { internal: message, type: type.value };
      }
      if (type.value !== 'VIDEO_ID_CHANGED') {
        return type.present ? terminalIngressFailure(true) : terminalIngressFailure(authorityEscalated);
      }

      const payload = {};
      for (const key of ['oldVideoId', 'newVideoId', 'videoId']) {
        const value = ownDataProperty(message, key);
        if (value === null) return terminalIngressFailure(authorityEscalated);
        if (value.present) payload[key] = value.value;
      }
      return {
        input: {
          category: 'page-observation',
          variant: 'video-context-changed',
          payload
        },
        category: 'page-observation',
        type: type.value,
        authorityEscalated
      };
    } catch {
      return terminalIngressFailure(authorityEscalated);
    }
  }

  function getPageIngress() {
    if (!pageIngressPromise) {
      pageIngressPromise = import(chrome.runtime.getURL('content/system/capabilities/page-ingress.js'))
        .then(({ PageIngress }) => PageIngress);
    }
    return pageIngressPromise;
  }

  function getSettingsCapability() {
    if (!settingsCapabilityPromise) {
      settingsCapabilityPromise = import(chrome.runtime.getURL('content/system/capabilities/settings.js'))
        .then(({ createSettings }) => createSettings({
          write: (items) => configManager.setMultiple(items)
        }));
    }
    return settingsCapabilityPromise;
  }

  function getContributionsCapability() {
    if (!contributionsCapabilityPromise) {
      contributionsCapabilityPromise = Promise.all([
        getBackgroundPortTransport(),
        import(chrome.runtime.getURL('content/system/capabilities/contributions.js'))
      ]).then(([{ createEnvelope, transport }, { createContributions }]) => createContributions({
        persist(intent, options) {
          const requestId = generateUniqueMessageId('CONTRIBUTION_ENQUEUE');
          return transport.request(createEnvelope({
            requestId,
            kind: 'contribution-enqueue',
            payload: { type: 'CONTRIBUTION_ENQUEUE', intent }
          }), options);
        },
        readProjection(projection, options) {
          const requestId = generateUniqueMessageId('CONTRIBUTION_READ');
          return transport.request(createEnvelope({
            requestId,
            kind: 'contribution-read',
            payload: { type: 'CONTRIBUTION_READ', projection }
          }), options);
        },
        retryOperation(operationId, options) {
          const requestId = generateUniqueMessageId('CONTRIBUTION_RETRY');
          return transport.request(createEnvelope({
            requestId,
            kind: 'contribution-retry',
            payload: { type: 'CONTRIBUTION_RETRY', operationId }
          }), options);
        }
        }));
    }
    return contributionsCapabilityPromise;
  }

  function getSubtitleQueryCapability() {
    if (!subtitleQueryCapabilityPromise) {
      subtitleQueryCapabilityPromise = Promise.all([
        getBackgroundPortTransport(),
        import(chrome.runtime.getURL('content/system/capabilities/subtitles.js')),
        import(chrome.runtime.getURL('content/core/playback-context-manager.js'))
      ]).then(([{ createEnvelope, transport }, { createSubtitles }, { playbackContextManager }]) => createSubtitles({
        getCurrentContext: () => playbackContextManager.getCurrentContext(),
        request({ requestId, query, signal }) {
          return transport.request(createEnvelope({
            requestId,
            kind: 'subtitle-query',
            payload: { type: 'SUBTITLE_QUERY', query }
          }), { signal });
        }
      }));
    }
    return subtitleQueryCapabilityPromise;
  }

  function acceptPageIngress(messageId, observation) {
    getPageIngress().then(async (pageIngress) => {
      const options = {
        authorityEscalated: observation.authorityEscalated,
        dispatch: (message) => dispatchInternalMessage(messageId, message),
        query: (subtitleQuery) => getSubtitleQueryCapability().then((subtitles) => subtitles.query(subtitleQuery))
      };
      if (observation.category === 'contribution-intent' || observation.category === 'contribution-read') {
        options.contributions = await getContributionsCapability();
      }
      let result = await pageIngress.accept(observation.input, options);
      if (observation.category === 'settings-change' && !result.ok &&
          result.error.code === 'settings-unavailable') {
        options.settings = await getSettingsCapability();
        result = await pageIngress.accept(observation.input, options);
      }
      respondToPageObservation(messageId, result);
    });
  }

  // 1. 監聽來自 page context (messaging.js) 的消息事件
  window.addEventListener('messageToContentScript', (event) => {
    const { messageId, message: rawMessage } = event.detail;
    const pageIngressMessage = adaptPageIngressMessage(rawMessage);
    if (pageIngressMessage.terminal) {
      respondToPageObservation(messageId, pageIngressMessage.terminal);
      return;
    }
    debugLog('Received from page:', messageId, rawMessage);

    if (pageIngressMessage.category === 'settings-read') {
      const snapshotRequest = parseSettingsSnapshotRequest(rawMessage, pageIngressMessage.authorityEscalated);
      if (snapshotRequest?.ok === false) {
        respondToPageObservation(messageId, snapshotRequest);
        return;
      }
      if (!snapshotRequest) {
        respondToPageObservation(messageId, {
          ok: false,
          error: { kind: 'invalid', code: 'settings-read', retryable: false }
        });
        return;
      }
      if (!configManager) {
        respondToPageObservation(messageId, {
          ok: false,
          error: { kind: 'disconnected', code: 'settings-unavailable', retryable: true }
        });
        return;
      }
      try {
        respondToPageObservation(messageId, {
          ok: true,
          value: projectPublicConfig(configManager.getAll())
        });
      } catch {
        respondToPageObservation(messageId, {
          ok: false,
          error: { kind: 'domain-rejected', code: 'settings-snapshot-failed', retryable: false }
        });
      }
      return;
    }

    if (pageIngressMessage.internal) {
      dispatchInternalMessage(messageId, pageIngressMessage.internal);
      return;
    }

    if (pageIngressMessage.input) acceptPageIngress(messageId, pageIngressMessage);
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

  async function initializeAllManagers() {
    const pageScriptReady = ensureNetflixPageScriptReady();
    try {
      const configSuccess = await initializeConfigManager();
      if (!configSuccess) {
        console.error('[Content Script] ConfigManager 初始化失敗');
        if (await pageScriptReady) startPageContextOnce();
        return;
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
