import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as secondaryPreference from '../shared/secondary-language-preference.js';
import * as runtimeStatus from '../shared/secondary-runtime-status.js';

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

async function loadPopupHarness({ automaticResponse, secondaryLanguage = 'en', lastManual, snapshot } = {}) {
  const elements = new Map([
    'profile-user-id', 'score', 'contrib-count', 'replace-count', 'translation-views', 'upvotes-received',
    'success-toast', 'mainToggle', 'settings-btn', 'popup-primary-lang', 'popup-secondary-lang', 'popup-last-manual-language', 'popup-secondary-runtime-status'
  ].map((id) => [id, createElement()]));
  const documentListeners = new Map();
  const runtimeMessages = [];
  const runtimeListeners = [];
  const callbacks = [];
  const timers = new Map();
  let nextTimerId = 0;
  const configGets = [];
  const configWrites = [];
  const privateStorage = { [secondaryPreference.LAST_MANUAL_SECONDARY_LANGUAGE_KEY]: lastManual };
  privateStorage[runtimeStatus.SECONDARY_RUNTIME_STATUS_KEY] = snapshot;
  const configManager = {
    isInitialized: true,
    get(key) {
      configGets.push(key);
      return {
        isEnabled: true,
        'subtitle.dualModeEnabled': false,
        'subtitle.primaryLanguage': 'zh-Hant',
        'subtitle.secondaryLanguage': secondaryLanguage,
        'subtitle.style.primary.fontSize': 55
      }[key];
    },
    async set(key, value) { configWrites.push({ key, value }); if (key === 'subtitle.secondaryLanguage') secondaryLanguage = value; },
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
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    chrome: { runtime, tabs: { create() {} }, storage: { local: {
      async get() { return privateStorage; },
      async set(items) { Object.assign(privateStorage, items); }
    } } }
  });
  const source = await readFile(new URL('popup.js', root), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'popup.js' });
  const configModule = new vm.SyntheticModule(['configManager'], function initialize() {
    this.setExport('configManager', configManager);
  }, { context, identifier: 'config-manager.js' });
  const schemaModule = new vm.SyntheticModule(['SUPPORTED_LANGUAGES'], function initialize() {
    this.setExport('SUPPORTED_LANGUAGES', [{ code: 'en', name: 'English' }, { code: 'ja', name: '日本語' }]);
  }, { context, identifier: 'config-schema.js' });
  const preferenceModule = new vm.SyntheticModule(Object.keys(secondaryPreference), function initialize() {
    for (const [name, value] of Object.entries(secondaryPreference)) this.setExport(name, value);
  }, { context, identifier: 'secondary-language-preference.js' });
  const runtimeModule = new vm.SyntheticModule(Object.keys(runtimeStatus), function initialize() {
    for (const [name, value] of Object.entries(runtimeStatus)) this.setExport(name, value);
  }, { context, identifier: 'secondary-runtime-status.js' });
  await runtimeModule.link(() => { throw new Error('Unexpected runtime dependency'); });
  await runtimeModule.evaluate();
  await preferenceModule.link(() => { throw new Error('Unexpected preference dependency'); });
  await preferenceModule.evaluate();
  await configModule.link(() => { throw new Error('Unexpected config dependency'); });
  await schemaModule.link(() => { throw new Error('Unexpected schema dependency'); });
  await module.link((specifier) => {
    if (specifier.endsWith('config-manager.js')) return configModule;
    if (specifier.endsWith('config-schema.js')) return schemaModule;
    if (specifier.endsWith('secondary-language-preference.js')) return preferenceModule;
    if (specifier.endsWith('secondary-runtime-status.js')) return runtimeModule;
    throw new Error(`Unexpected popup dependency: ${specifier}`);
  });
  await configModule.evaluate();
  await schemaModule.evaluate();
  await module.evaluate();
  await documentListeners.get('DOMContentLoaded')();
  return {
    callbacks,
    configGets,
    configWrites,
    privateStorage,
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

test('Given popup language controls When secondary auto is selected Then only secondary offers auto and persists the mode with a readable label', async () => {
  const popup = await loadPopupHarness({ automaticResponse: statsResult() });
  const secondary = popup.elements.get('popup-secondary-lang');
  const primary = popup.elements.get('popup-primary-lang');
  assert.deepEqual(secondary.options.map(option => option.value), ['auto', 'manual', 'en', 'ja']);
  assert.equal(secondary.options[0].text, '自動（跟隨影片原始語言）');
  assert.deepEqual(primary.options.map(option => option.value), ['en', 'ja']);
  secondary.value = 'auto';
  await secondary.listener('change')({ target: secondary });
  assert.deepEqual(popup.configWrites, [{ key: 'subtitle.secondaryLanguage', value: 'auto' }]);
  assert.equal(popup.elements.get('success-toast').textContent, '次要語言: 自動（跟隨影片原始語言）');
});

test('popup reads runtime status on open, preserves last-manual hint and falls back to auto label without runtime data', async () => {
  const popup = await loadPopupHarness({ automaticResponse: statsResult(), secondaryLanguage: 'auto', lastManual: 'ja', snapshot: {
    videoId: '801', effectiveLanguage: 'ja', quality: { isCC: true, degraded: true },
    status: 'ready', reason: 'same-primary-track', isManualFallback: false, updatedAt: 1
  } });
  assert.equal(popup.elements.get('popup-secondary-runtime-status').textContent, '自動：日本語（CC、降級、與主要字幕同軌，已省略）');
  assert.equal(popup.elements.get('popup-last-manual-language').textContent, '上次手動語言：日本語');
  const fresh = await loadPopupHarness({ automaticResponse: statsResult(), secondaryLanguage: 'auto' });
  assert.equal(fresh.elements.get('popup-secondary-runtime-status').textContent, '自動（跟隨影片原始語言）');
  const select = fresh.elements.get('popup-secondary-lang');
  select.value = 'ja';
  await select.listener('change')({ target: select });
  assert.equal(fresh.elements.get('popup-secondary-runtime-status').textContent, '手動：日本語');
});

test('popup remembers Japanese before auto, shows readonly preference, restores manual and honors explicit language choices', async () => {
  const popup = await loadPopupHarness({ automaticResponse: statsResult(), secondaryLanguage: 'ja' });
  const secondary = popup.elements.get('popup-secondary-lang');
  const hint = popup.elements.get('popup-last-manual-language');
  secondary.value = 'auto';
  await secondary.listener('change')({ target: secondary });
  assert.equal(popup.privateStorage[secondaryPreference.LAST_MANUAL_SECONDARY_LANGUAGE_KEY], 'ja');
  assert.equal(hint.hidden, false);
  assert.equal(hint.textContent, '上次手動語言：日本語');
  secondary.value = 'manual';
  await secondary.listener('change')({ target: secondary });
  assert.equal(secondary.value, 'ja');
  assert.equal(popup.configWrites.at(-1).value, 'ja');
  assert.equal(hint.hidden, true);
  const fresh = await loadPopupHarness({ automaticResponse: statsResult(), secondaryLanguage: 'auto', lastManual: 'auto' });
  const freshSelect = fresh.elements.get('popup-secondary-lang');
  freshSelect.value = 'manual';
  await freshSelect.listener('change')({ target: freshSelect });
  assert.equal(fresh.configWrites.at(-1).value, 'en');
});

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
