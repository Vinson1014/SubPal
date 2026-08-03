import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

function createElement() {
  const listeners = new Map();
  return {
    checked: true,
    className: '',
    textContent: '',
    value: '',
    classList: { add() {}, remove() {}, toggle() {} },
    add(option) { this.options ||= []; this.options.push(option); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    listener(type) { return listeners.get(type); }
  };
}

function statsResult(points = 5) {
  return {
    ok: true,
    value: {
      scope: 'active-backend-profile-user',
      backendProfileId: 'profile-a',
      userIdMasked: 'us...-a',
      totals: {
        points,
        translationSubmissions: points + 1,
        translationViews: points + 2,
        upvotesReceived: points + 3,
        subtitlesReplaced: points + 4
      }
    }
  };
}

async function loadPopupHarness({ automaticResponse } = {}) {
  const elements = new Map([
    'profile-user-id', 'score', 'contrib-count', 'replace-count', 'translation-views', 'upvotes-received',
    'success-toast', 'mainToggle', 'settings-btn'
  ].map((id) => [id, createElement()]));
  const documentListeners = new Map();
  const runtimeMessages = [];
  const runtimeListeners = [];
  const callbacks = [];
  const timers = new Map();
  let nextTimerId = 0;
  const configGets = [];
  const configManager = {
    isInitialized: true,
    get(key) {
      configGets.push(key);
      return {
        isEnabled: true,
        'subtitle.dualModeEnabled': false,
        'subtitle.primaryLanguage': 'zh-Hant',
        'subtitle.secondaryLanguage': 'en',
        'subtitle.style.primary.fontSize': 55
      }[key];
    },
    async set() {},
    subscribe() {}
  };
  const runtime = {
    lastError: undefined,
    getURL(path) { return `chrome-extension://test/${path}`; },
    onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
    openOptionsPage() {},
    sendMessage(message, callback) {
      runtimeMessages.push(JSON.parse(JSON.stringify(message)));
      callbacks.push(callback);
      if (automaticResponse !== undefined) callback(automaticResponse);
    }
  };
  const context = vm.createContext({
    Promise,
    console: { error() {}, log() {}, warn() {} },
    document: {
      addEventListener(type, listener) { documentListeners.set(type, listener); },
      getElementById(id) { return elements.get(id) || null; },
      querySelector(selector) { return selector === '.status-bar' ? createElement() : null; }
    },
    setInterval() { return 1; },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    Option: class {},
    chrome: { runtime, tabs: { create() {} }, storage: { local: {} } }
  });
  const source = await readFile(new URL('popup.js', root), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'popup.js' });
  const configModule = new vm.SyntheticModule(['configManager'], function initialize() {
    this.setExport('configManager', configManager);
  }, { context, identifier: 'config-manager.js' });
  const schemaModule = new vm.SyntheticModule(['SUPPORTED_LANGUAGES'], function initialize() {
    this.setExport('SUPPORTED_LANGUAGES', []);
  }, { context, identifier: 'config-schema.js' });
  await configModule.link(() => { throw new Error('Unexpected config dependency'); });
  await schemaModule.link(() => { throw new Error('Unexpected schema dependency'); });
  await module.link((specifier) => {
    if (specifier.endsWith('config-manager.js')) return configModule;
    if (specifier.endsWith('config-schema.js')) return schemaModule;
    throw new Error(`Unexpected popup dependency: ${specifier}`);
  });
  await configModule.evaluate();
  await schemaModule.evaluate();
  await module.evaluate();
  await documentListeners.get('DOMContentLoaded')();
  return {
    callbacks,
    configGets,
    elements,
    runtime,
    runtimeListeners,
    runtimeMessages,
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    }
  };
}

test('Given Popup startup When active-profile stats succeed Then it sends only the sealed request, renders the fixed projection, and never reads raw identity or active-tab state', async () => {
  const popup = await loadPopupHarness({ automaticResponse: statsResult() });

  assert.deepEqual(popup.runtimeMessages, [{ type: 'POPUP_ACTIVE_PROFILE_STATS' }]);
  assert.deepEqual(popup.configGets.filter((key) => key === 'user.userId' || key === 'video.currentVideoId'), []);
  assert.equal(popup.elements.get('profile-user-id').textContent, 'us...-a');
  assert.equal(popup.elements.get('score').textContent, 5);
  assert.equal(popup.elements.get('contrib-count').textContent, 6);
  assert.equal(popup.elements.get('replace-count').textContent, 9);
  assert.equal(popup.runtimeListeners.length, 1);
});

test('Given popup stats time out or disconnect and a late result follows When the request settles Then it keeps prior totals and renders only a sanitized failure', async () => {
  const timedOut = await loadPopupHarness();
  timedOut.runTimers(5000);
  timedOut.callbacks[0](statsResult(99));
  assert.equal(timedOut.elements.get('success-toast').textContent, '無法取得設定檔貢獻統計資料。');
  assert.equal(timedOut.elements.get('score').textContent, 0);

  const disconnected = await loadPopupHarness();
  disconnected.runtime.lastError = { message: 'private transport details' };
  disconnected.callbacks[0]();
  disconnected.callbacks[0](statsResult(99));
  assert.equal(disconnected.elements.get('success-toast').textContent, '無法取得設定檔貢獻統計資料。');
  assert.equal(disconnected.elements.get('score').textContent, 0);
});
