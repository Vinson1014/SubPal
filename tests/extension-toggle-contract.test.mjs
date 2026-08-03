import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const rootUrl = new URL('../', import.meta.url);
const backgroundUrl = new URL('../background.js', import.meta.url);
const popupUrl = new URL('../popup.js', import.meta.url);
const contentUrl = new URL('../content.js', import.meta.url);
const configManagerUrl = new URL('../content/system/config/config-manager.js', import.meta.url);
const configBridgeUrl = new URL('../content/system/config/config-bridge.js', import.meta.url);
const initializationManagerUrl = new URL('../content/system/initialization-manager.js', import.meta.url);
const messagingUrl = new URL('../content/system/messaging.js', import.meta.url);
const subtitleReplacerUrl = new URL('../content/core/subtitle-replacer.js', import.meta.url);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class EventRegistry {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      listener(event);
    }
    return true;
  }

  getListeners(type) {
    return [...(this.listeners.get(type) || [])];
  }
}

function createElement() {
  const events = new EventRegistry();
  return {
    checked: true,
    className: '',
    textContent: '',
    value: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener: events.addEventListener.bind(events),
    getListener(type) {
      return events.getListeners(type)[0];
    },
    remove() {}
  };
}

function createChrome() {
  const storageListeners = new Set();
  const portMessages = [];
  const runtimeMessages = [];
  const state = {};
  let failNextWrite = false;

  const runtime = {
    lastError: undefined,
    getURL(path) {
      return new URL(path, rootUrl).href;
    },
    connect() {
      const messageListeners = new Set();
      return {
        name: 'subtitle-assistant-channel',
        onMessage: { addListener(listener) { messageListeners.add(listener); } },
        onDisconnect: { addListener() {} },
        postMessage(message) { portMessages.push(message); },
        disconnect() {}
      };
    },
    onMessage: { addListener() {} },
    sendMessage(message, callback) {
      runtimeMessages.push(message);
      callback?.({ success: true, data: { points: 0, statistics: {} } });
    },
    openOptionsPage() {}
  };

  function respond(callback, error) {
    runtime.lastError = error ? { message: error } : undefined;
    callback?.();
    runtime.lastError = undefined;
  }

  const chrome = {
    runtime,
    tabs: { create() {} },
    storage: {
      onChanged: { addListener(listener) { storageListeners.add(listener); } },
      local: {
        get(keys, callback) {
          const requestedKeys = keys == null ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
          const result = {};
          for (const key of requestedKeys) {
            if (key in state) result[key] = clone(state[key]);
          }
          if (typeof callback !== 'function') return Promise.resolve(result);
          respond(() => callback(result));
        },
        set(items, callback) {
          if (failNextWrite) {
            failNextWrite = false;
            respond(callback, 'storage write failed');
            return;
          }

          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            const oldValue = clone(state[key]);
            const newValue = clone(value);
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
              state[key] = newValue;
              changes[key] = { oldValue, newValue: clone(newValue) };
            }
          }
          for (const listener of storageListeners) listener(changes, 'local');
          respond(callback);
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
          respond(callback);
        }
      }
    },
    failNextWrite() {
      failNextWrite = true;
    },
    getState(key) {
      return clone(state[key]);
    },
    portMessages,
    runtimeMessages
  };

  return chrome;
}

function createTimer() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(callback) {
      const id = ++nextId;
      pending.set(id, callback);
      queueMicrotask(() => {
        const scheduled = pending.get(id);
        pending.delete(id);
        scheduled?.();
      });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    }
  };
}

async function createToggleHarness() {
  const chrome = createChrome();
  const windowEvents = new EventRegistry();
  const documentEvents = new EventRegistry();
  const statusBar = createElement();
  const elements = new Map([
    ['mainToggle', createElement()],
    ['settings-btn', createElement()],
    ['reset-userid', createElement()],
    ['copy-userid', createElement()],
    ['success-toast', createElement()],
    ['user-id', createElement()]
  ]);
  const timer = createTimer();
  let pageScriptMarker = null;
  const appendScript = (script) => {
    script.parentNode = scriptParent;
    if (script.src?.endsWith('/netflix-page-script.js')) {
      pageScriptMarker = script;
      script.onload?.();
    } else if (script.src?.endsWith('/content/index.js')) {
      script.onload?.();
    }
  };
  const scriptParent = {
    appendChild(script) { appendScript(script); },
    removeChild(script) {
      if (pageScriptMarker === script) pageScriptMarker = null;
      script.parentNode = null;
    }
  };
  const document = {
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    getElementById(id) { return elements.get(id) || null; },
    querySelector(selector) {
      if (selector === 'script[data-subpal-page-script-state]') return pageScriptMarker;
      return selector === '.status-bar' ? statusBar : null;
    },
    createElement() {
      const element = createElement();
      const attributes = new Map();
      Object.assign(element, {
        src: '', type: '', parentNode: null,
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        remove() { scriptParent.removeChild(element); },
        replaceWith(replacement) {
          if (pageScriptMarker === element) pageScriptMarker = null;
          appendScript(replacement);
          element.parentNode = null;
        }
      });
      return element;
    },
    head: scriptParent,
    documentElement: scriptParent
  };
  const CustomEvent = class {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  };
  const context = vm.createContext({
    chrome,
    console: { log() {}, warn() {}, error() {} },
    CustomEvent,
    Date,
    JSON,
    Map,
    Set,
    Promise,
    Math,
    crypto,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    setInterval: timer.setTimeout,
    clearInterval: timer.clearTimeout,
    window: Object.assign(windowEvents, { postMessage() {} }),
    document
  });
  windowEvents.addEventListener('subpal-request-page-script-ready', (event) => {
    windowEvents.dispatchEvent(new CustomEvent('subpal-page-script-ready', {
      detail: { ...event.detail, readyAt: Date.now() }
    }));
  });

  const moduleCache = new Map();
  async function syntheticModule(url, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: url.href });
    moduleCache.set(url.href, module);
    await module.link(() => {});
    return module;
  }

  async function loadModule(url) {
    if (moduleCache.has(url.href)) return moduleCache.get(url.href);
    if (url.pathname.endsWith('/content/system/isolated-endscreen-tasks.js')) {
      return syntheticModule(url, { startIsolatedEndscreenTasks: async () => {} });
    }
    if (url.pathname.endsWith('/content/core/playback-context-manager.js')) {
      return syntheticModule(url, { playbackContextManager: {} });
    }

    const source = await readFile(url, 'utf8');
    const module = new vm.SourceTextModule(source, {
      context,
      identifier: url.href,
      importModuleDynamically(specifier, referencingModule) {
        return importModule(new URL(specifier, referencingModule.identifier));
      }
    });
    moduleCache.set(url.href, module);
    await module.link((specifier, referencingModule) => loadModule(new URL(specifier, referencingModule.identifier)));
    return module;
  }

  async function importModule(url) {
    const module = await loadModule(url);
    if (module.status === 'linked') await module.evaluate();
    return module;
  }

  const contentSource = await readFile(contentUrl, 'utf8');
  const contentScript = new vm.Script(contentSource, {
    filename: contentUrl.pathname,
    importModuleDynamically(specifier) {
      return importModule(new URL(specifier));
    }
  });
  contentScript.runInContext(context);

  async function contentReady() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      let response;
      const listener = (event) => {
        if (event.detail.messageId === 'content-ready') response = event.detail.response;
      };
      windowEvents.addEventListener('responseFromContentScript', listener);
      windowEvents.dispatchEvent(new CustomEvent('messageToContentScript', {
        detail: { messageId: 'content-ready', message: { category: 'settings-read', variant: 'snapshot', payload: {} } }
      }));
      windowEvents.removeEventListener('responseFromContentScript', listener);
      if (response?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('content ConfigManager did not initialize');
  }

  await contentReady();
  const [messagingModule, configBridgeModule, initializationManagerModule, subtitleReplacerModule, configManagerModule] = await Promise.all([
    loadModule(messagingUrl),
    loadModule(configBridgeUrl),
    loadModule(initializationManagerUrl),
    loadModule(subtitleReplacerUrl),
    loadModule(configManagerUrl)
  ]);
  await messagingModule.evaluate();
  await configBridgeModule.evaluate();
  await initializationManagerModule.evaluate();
  await subtitleReplacerModule.evaluate();
  await configManagerModule.evaluate();
  const bridge = configBridgeModule.namespace.configBridge;
  await messagingModule.namespace.initMessaging();
  if (!bridge.isInitialized) await bridge.initialize();

  const popupModule = await loadModule(popupUrl);
  await popupModule.evaluate();
  const domReady = documentEvents.getListeners('DOMContentLoaded')[0];
  await domReady();

  const InitializationManager = initializationManagerModule.namespace.InitializationManager;
  const SubtitleReplacer = subtitleReplacerModule.namespace.SubtitleReplacer;
  const manager = new InitializationManager();
  const uiCalls = [];
  manager.configBridge = bridge;
  manager.components.uiManager = {
    hideSubtitle() { uiCalls.push('hide'); },
    showNativeSubtitles() { uiCalls.push('native'); }
  };
  manager.components.subtitleCoordinator = {
    stopCurrentMode() { uiCalls.push('stop'); },
    startCurrentMode() { uiCalls.push('start'); },
    onSubtitleDetected() {},
    onModeChanged() {},
    onError() {}
  };
  manager.setupEventFlow();

  const replacer = new SubtitleReplacer();
  await replacer.initialize();
  const mainTransitions = [];
  bridge.subscribe('isEnabled', (value) => mainTransitions.push(value));
  const mainToggle = elements.get('mainToggle');

  return {
    bridge,
    chrome,
    mainToggle,
    mainTransitions,
    manager,
    popupConfigManager: configManagerModule.namespace.configManager,
    replacer,
    uiCalls,
    async setPopupToggle(value) {
      mainToggle.checked = value;
      await mainToggle.getListener('change')({ target: mainToggle });
    },
    async setExternalEnabled(value) {
      await new Promise((resolve) => chrome.storage.local.set({ isEnabled: value }, resolve));
    },
    resetObservedEffects() {
      mainTransitions.length = 0;
      uiCalls.length = 0;
      chrome.portMessages.length = 0;
      chrome.runtimeMessages.length = 0;
    }
  };
}

test('Given the configuration-only contract When runtime routes are inspected Then the legacy route is absent and popup writes configuration', async () => {
  const legacyType = ['TOGGLE', 'EXTENSION'].join('_');
  const [backgroundSource, popupSource] = await Promise.all([
    readFile(backgroundUrl, 'utf8'),
    readFile(popupUrl, 'utf8')
  ]);

  assert.doesNotMatch(backgroundSource, new RegExp(legacyType));
  assert.doesNotMatch(popupSource, new RegExp(legacyType));
  assert.match(popupSource, /configManager\.set\('isEnabled', newValue\)/);
  assert.match(popupSource, /configManager\.subscribe\('isEnabled'/);
});

test('Given a popup isEnabled transition When storage notifies the isolated world Then MAIN transitions once, restores native subtitles, and disables the replacer', async () => {
  const harness = await createToggleHarness();
  harness.resetObservedEffects();

  await harness.setPopupToggle(false);

  assert.equal(harness.popupConfigManager.get('isEnabled'), false);
  assert.equal(harness.bridge.get('isEnabled'), false);
  assert.deepEqual(harness.mainTransitions, [false]);
  assert.deepEqual(harness.uiCalls, ['stop', 'hide', 'native']);
  assert.equal(harness.replacer.getStatus().isEnabled, false);
  assert.deepEqual(harness.chrome.portMessages, []);
  assert.deepEqual(harness.chrome.runtimeMessages, []);
});

test('Given an external config change and a rejected popup write When isEnabled is changed Then the popup subscription updates and failure rolls back with no MAIN transition', async () => {
  const harness = await createToggleHarness();

  await harness.setExternalEnabled(false);
  assert.equal(harness.mainToggle.checked, false);
  await harness.setExternalEnabled(true);
  assert.equal(harness.mainToggle.checked, true);

  harness.resetObservedEffects();
  harness.chrome.failNextWrite();
  await harness.setPopupToggle(false);

  assert.equal(harness.mainToggle.checked, true);
  assert.equal(harness.popupConfigManager.get('isEnabled'), true);
  assert.equal(harness.bridge.get('isEnabled'), true);
  assert.deepEqual(harness.mainTransitions, []);
  assert.deepEqual(harness.uiCalls, []);
  assert.deepEqual(harness.chrome.portMessages, []);
});
