import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const configManagerUrl = new URL('../content/system/config/config-manager.js', import.meta.url);
const configBridgeUrl = new URL('../content/system/config/config-bridge.js', import.meta.url);
const configSchemaUrl = new URL('../content/system/config/config-schema.js', import.meta.url);
const messagingUrl = new URL('../content/system/messaging.js', import.meta.url);
const settingsUrl = new URL('../content/system/capabilities/settings.js', import.meta.url);
const subtitleInterceptorUrl = new URL('../content/subtitle-modes/subtitle-interceptor.js', import.meta.url);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getNestedValue(value, path) {
  if (!path) return value;

  let current = value;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function setNestedValue(value, path, nextValue) {
  const keys = path.split('.');
  const lastKey = keys.pop();
  let current = value;

  for (const key of keys) {
    current[key] ||= {};
    current = current[key];
  }
  current[lastKey] = nextValue;
}

class ObservableStorage {
  constructor() {
    this.roots = {};
    this.listeners = new Set();
    this.failNextWrite = false;
    this.deferEvents = false;
    this.pendingChanges = [];
  }

  async initialize() {}

  async getBatch(keys) {
    const values = {};
    for (const key of keys) {
      const value = getNestedValue(this.roots, key);
      if (value !== undefined) values[key] = clone(value);
    }
    return values;
  }

  async setBatch(items) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('storage write failed');
    }

    const previousRoots = clone(this.roots);
    for (const [key, value] of Object.entries(items)) {
      setNestedValue(this.roots, key, clone(value));
    }

    const changes = {};
    const roots = new Set(Object.keys(items).map((key) => key.split('.')[0]));
    for (const root of roots) {
      const oldValue = previousRoots[root];
      const newValue = this.roots[root];
      if (!isDeepStrictEqual(oldValue, newValue)) {
        changes[root] = { oldValue: clone(oldValue), newValue: clone(newValue) };
      }
    }

    if (Object.keys(changes).length > 0) {
      if (this.deferEvents) {
        this.pendingChanges.push(changes);
      } else {
        this.emit(changes);
      }
    }
  }

  watch(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit(changes) {
    for (const listener of this.listeners) listener(changes);
  }

  setDeferredEventDelivery(deferEvents) {
    this.deferEvents = deferEvents;
  }

  flushDeferredEvents() {
    const pendingChanges = this.pendingChanges;
    this.pendingChanges = [];
    for (const changes of pendingChanges) this.emit(changes);
  }

  getStats() {
    return {};
  }

  cleanup() {}
}

async function loadConfigModules(transport) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, structuredClone });
  const moduleCache = new Map();
  const messagingModule = new vm.SyntheticModule(
    ['sendMessage', 'onMessage'],
    function initializeMessagingExports() {
      this.setExport('sendMessage', transport.sendMessage);
      this.setExport('onMessage', transport.onMessage);
    },
    { context, identifier: messagingUrl.href }
  );
  await messagingModule.link(() => {});
  await messagingModule.evaluate();

  async function loadModule(url) {
    if (url.href === messagingUrl.href) return messagingModule;
    if (moduleCache.has(url.href)) return moduleCache.get(url.href);

    const source = await readFile(url, 'utf8');
    const module = new vm.SourceTextModule(source, {
      context,
      identifier: url.href
    });
    moduleCache.set(url.href, module);
    await module.link((specifier, referencingModule) => {
      return loadModule(new URL(specifier, referencingModule.identifier));
    });
    return module;
  }

  const [configManagerModule, configBridgeModule, configSchemaModule, settingsModule] = await Promise.all([
    loadModule(configManagerUrl),
    loadModule(configBridgeUrl),
    loadModule(configSchemaUrl),
    loadModule(settingsUrl)
  ]);
  await Promise.all([
    configManagerModule.evaluate(),
    configBridgeModule.evaluate(),
    configSchemaModule.evaluate(),
    settingsModule.evaluate()
  ]);

  return {
    ConfigManager: configManagerModule.namespace.ConfigManager,
    ConfigBridge: configBridgeModule.namespace.ConfigBridge,
    createSettings: settingsModule.namespace.createSettings,
    getAllConfigKeys: configSchemaModule.namespace.getAllConfigKeys
  };
}

async function createConfigHarness() {
  const messages = new Set();
  const requests = [];
  let manager;
  let settings;
  const transport = {
    async sendMessage(message) {
      requests.push(clone(message));
      switch (message.type || message.category) {
        case 'CONFIG_GET_ALL':
          return { success: true, config: manager.getAll() };
        case 'settings-change': {
          const result = await settings.change(message);
          if (!result.ok) throw Object.assign(new Error(result.error.code), result.error);
          return result.value;
        }
        default:
          return { success: false, error: `Unsupported message: ${message.type}` };
      }
    },
    onMessage(callback) {
      messages.add(callback);
      return () => messages.delete(callback);
    }
  };
  const { ConfigManager, ConfigBridge, createSettings, getAllConfigKeys } = await loadConfigModules(transport);
  const storage = new ObservableStorage();
  manager = new ConfigManager({ storage });
  await manager.initialize();
  settings = createSettings({
    write: (items) => manager.setMultiple(items),
    setTimeout,
    clearTimeout
  });
  manager.subscribe(getAllConfigKeys(), (key, newValue, oldValue) => {
    for (const listener of messages) {
      listener({ type: 'CONFIG_CHANGED', key, newValue, oldValue });
    }
  });

  const bridge = new ConfigBridge();
  await bridge.initialize();
  return { bridge, manager, requests, storage };
}

async function createSyntheticModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Unexpected synthetic dependency'); });
  await module.evaluate();
  return module;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function createSubtitleInterceptorHarness({ languageWrite, dualWrite }) {
  const sandbox = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date,
    Promise,
    clearTimeout,
    document: { getElementById() { return null; }, querySelector() { return null; } },
    setTimeout,
    window: { addEventListener() {}, removeEventListener() {} }
  });
  const dependencies = new Map([
    ['../utils/subtitle-parser.js', await createSyntheticModule(sandbox, 'subtitle-parser.js', {
      buildTimeIndex() { return []; }, findSubtitleByTime() { return null; }, findSubtitleByTimeIndex() { return null; }, parseSubtitle() { return { subtitles: [], regionConfigs: {} }; }
    })],
    ['../system/messaging.js', await createSyntheticModule(sandbox, 'messaging.js', {
      dispatchInternalEvent() {}, registerInternalEventHandler: () => () => {}, sendMessage: async () => ({}), sendMessageToPageScript: async () => ({})
    })],
    ['../core/video-info.js', await createSyntheticModule(sandbox, 'video-info.js', {
      getCurrentTimestamp: () => 0, getVideoId: () => 'test-video'
    })],
    ['../core/playback-context-manager.js', await createSyntheticModule(sandbox, 'playback-context-manager.js', {
      playbackContextManager: { getCurrentContext: () => null }
    })],
    ['../ui/netflix-player-adapter.js', await createSyntheticModule(sandbox, 'netflix-player-adapter.js', {
      getPlayerAdapter: () => ({ calculatePosition: () => null }), setRegionConfigs() {}
    })],
    ['./dom-overlap-matcher.js', await createSyntheticModule(sandbox, 'dom-overlap-matcher.js', {
      DOMOverlapMatcher: class DOMOverlapMatcher {}
    })],
    ['../system/capabilities/ttml-acquisition-ingress.js', await createSyntheticModule(sandbox, 'ttml-acquisition-ingress.js', {
      bindTtmlAcquisitionCapture: () => () => {}, TtmlAcquisitionIngress: class TtmlAcquisitionIngress {}
    })]
  ]);
  const source = await readFile(subtitleInterceptorUrl, 'utf8');
  const module = new vm.SourceTextModule(source, {
    context: sandbox,
    identifier: subtitleInterceptorUrl.href
  });
  await module.link((specifier) => {
    const dependency = dependencies.get(specifier);
    if (!dependency) throw new Error(`Unexpected import: ${specifier}`);
    return dependency;
  });
  await module.evaluate();

  const bridgeCalls = [];
  let reloads = 0;
  const interceptor = new module.namespace.SubtitleInterceptor();
  interceptor.isActive = true;
  interceptor.isInitialized = true;
  interceptor.configBridge = {
    setDualSubtitleEnabled(enabled) {
      bridgeCalls.push({ method: 'setDualSubtitleEnabled', args: [enabled] });
      return dualWrite;
    },
    setSubtitleLanguages(primaryLanguage, secondaryLanguage) {
      bridgeCalls.push({ method: 'setSubtitleLanguages', args: [primaryLanguage, secondaryLanguage] });
      return languageWrite;
    }
  };
  interceptor.loadInterceptedSubtitles = () => { reloads += 1; };

  return { bridgeCalls, interceptor, reloadCount: () => reloads };
}

test('Given a deferred storage event When ConfigBridge changes dual subtitles Then it sends the exact typed envelope and subscribers stay quiet until it arrives once', async () => {
  const { bridge, requests, storage } = await createConfigHarness();
  const values = [];
  const storageEvents = [];
  bridge.subscribe('subtitle.dualModeEnabled', (value) => values.push(value));
  storage.watch((changes) => storageEvents.push(changes));

  storage.setDeferredEventDelivery(true);
  const result = await bridge.setDualSubtitleEnabled(false);

  assert.deepEqual(clone(result), { variant: 'dual-subtitles', enabled: false });
  assert.deepEqual(requests.at(-1), {
    category: 'settings-change', variant: 'dual-subtitles', payload: { enabled: false }
  });
  assert.deepEqual(values, []);
  assert.deepEqual(storageEvents, []);

  storage.flushDeferredEvents();

  assert.deepEqual(values, [false]);
  assert.equal(storageEvents.length, 1);
  assert.equal(bridge.get('subtitle.dualModeEnabled'), false);
});

test('Given a same-value typed language change When storage emits no event Then it notifies once', async () => {
  const { bridge, requests, storage } = await createConfigHarness();
  await bridge.setSubtitleLanguages('ja', 'en');

  const values = [];
  const storageEvents = [];
  bridge.subscribe('subtitle.primaryLanguage', (value) => values.push(value));
  storage.watch((changes) => storageEvents.push(changes));

  const result = await bridge.setSubtitleLanguages('ja', 'en');

  assert.deepEqual(clone(result), { variant: 'subtitle-languages', primaryLanguage: 'ja', secondaryLanguage: 'en' });
  assert.deepEqual(requests.at(-1), {
    category: 'settings-change',
    variant: 'subtitle-languages',
    payload: { primaryLanguage: 'ja', secondaryLanguage: 'en' }
  });
  assert.deepEqual(storageEvents, []);
  assert.deepEqual(values, ['ja']);
  assert.equal(bridge.get('subtitle.primaryLanguage'), 'ja');
});

test('Given a deferred typed language change When one value changes and one stays equal Then each key notifies once', async () => {
  const { bridge, storage } = await createConfigHarness();
  await bridge.setSubtitleLanguages('ja', 'en');

  const primaryValues = [];
  const secondaryValues = [];
  const storageEvents = [];
  bridge.subscribe('subtitle.primaryLanguage', (value) => primaryValues.push(value));
  bridge.subscribe('subtitle.secondaryLanguage', (value) => secondaryValues.push(value));
  storage.watch((changes) => storageEvents.push(changes));

  storage.setDeferredEventDelivery(true);
  await bridge.setSubtitleLanguages('ko', 'en');

  assert.deepEqual(primaryValues, []);
  assert.deepEqual(secondaryValues, ['en']);
  assert.deepEqual(storageEvents, []);

  storage.flushDeferredEvents();

  assert.equal(storageEvents.length, 1);
  assert.deepEqual(primaryValues, ['ko']);
  assert.deepEqual(secondaryValues, ['en']);
  assert.equal(bridge.get('subtitle.primaryLanguage'), 'ko');
  assert.equal(bridge.get('subtitle.secondaryLanguage'), 'en');
});

test('Given a rejected typed language change When Settings rejects the manager batch Then ConfigBridge propagates the normalized error without notifying or changing its cache', async () => {
  const { bridge, storage } = await createConfigHarness();
  const values = [];
  bridge.subscribe('subtitle.primaryLanguage', (value) => values.push(value));
  storage.failNextWrite = true;

  await assert.rejects(
    bridge.setSubtitleLanguages('ja', 'en'),
    (error) => error.kind === 'domain-rejected' && error.code === 'settings-write-failed' && error.retryable === true
  );

  assert.deepEqual(values, []);
  assert.equal(bridge.get('subtitle.primaryLanguage'), 'zh-Hant');
});

test('Given a rejecting typed language bridge write When SubtitleInterceptor sets languages Then both fields and reload state remain unchanged', async () => {
  const error = new Error('language write failed');
  const languageWrite = createDeferred();
  const { bridgeCalls, interceptor, reloadCount } = await createSubtitleInterceptorHarness({
    languageWrite: languageWrite.promise,
    dualWrite: Promise.resolve()
  });

  const pending = interceptor.setLanguages('ja', 'ko');
  languageWrite.reject(error);
  await assert.rejects(pending, (actual) => actual === error);

  assert.deepEqual(bridgeCalls, [{ method: 'setSubtitleLanguages', args: ['ja', 'ko'] }]);
  assert.equal(interceptor.primaryLanguage, 'zh-Hant');
  assert.equal(interceptor.secondaryLanguage, 'en');
  assert.equal(reloadCount(), 0);
});

test('Given a deferred typed language bridge write When SubtitleInterceptor sets languages Then it updates both fields and reloads only after settlement', async () => {
  const languageWrite = createDeferred();
  const { bridgeCalls, interceptor, reloadCount } = await createSubtitleInterceptorHarness({
    languageWrite: languageWrite.promise,
    dualWrite: Promise.resolve()
  });

  const pending = interceptor.setLanguages('ja', 'ko');

  assert.deepEqual(bridgeCalls, [{ method: 'setSubtitleLanguages', args: ['ja', 'ko'] }]);
  assert.equal(interceptor.primaryLanguage, 'zh-Hant');
  assert.equal(interceptor.secondaryLanguage, 'en');
  assert.equal(reloadCount(), 0);

  languageWrite.resolve();
  await pending;

  assert.equal(interceptor.primaryLanguage, 'ja');
  assert.equal(interceptor.secondaryLanguage, 'ko');
  assert.equal(reloadCount(), 1);
});

test('Given a rejecting typed dual-subtitle bridge write When SubtitleInterceptor changes the mode Then it preserves the field and skips reload', async () => {
  const error = new Error('dual write failed');
  const dualWrite = createDeferred();
  const { bridgeCalls, interceptor, reloadCount } = await createSubtitleInterceptorHarness({
    languageWrite: Promise.resolve(),
    dualWrite: dualWrite.promise
  });

  const pending = interceptor.setDualSubtitleEnabled(false);
  dualWrite.reject(error);
  await assert.rejects(pending, (actual) => actual === error);

  assert.deepEqual(bridgeCalls, [{ method: 'setDualSubtitleEnabled', args: [false] }]);
  assert.equal(interceptor.dualSubtitleEnabled, true);
  assert.equal(reloadCount(), 0);
});

test('Given a deferred typed dual-subtitle bridge write When SubtitleInterceptor changes the mode Then it updates and reloads only after settlement', async () => {
  const dualWrite = createDeferred();
  const { bridgeCalls, interceptor, reloadCount } = await createSubtitleInterceptorHarness({
    languageWrite: Promise.resolve(),
    dualWrite: dualWrite.promise
  });

  const pending = interceptor.setDualSubtitleEnabled(false);

  assert.deepEqual(bridgeCalls, [{ method: 'setDualSubtitleEnabled', args: [false] }]);
  assert.equal(interceptor.dualSubtitleEnabled, true);
  assert.equal(reloadCount(), 0);

  dualWrite.resolve();
  await pending;

  assert.equal(interceptor.dualSubtitleEnabled, false);
  assert.equal(reloadCount(), 1);
});

test('Given a storage root event When siblings change Then values and old values come from the event and unaffected siblings stay quiet', async () => {
  const { manager, storage } = await createConfigHarness();
  const primaryEvents = [];
  const secondaryEvents = [];
  manager.subscribe('subtitle.primaryLanguage', (key, newValue, oldValue) => {
    primaryEvents.push([key, newValue, oldValue, manager.get(key)]);
  });
  manager.subscribe('subtitle.secondaryLanguage', (key, newValue, oldValue) => {
    secondaryEvents.push([key, newValue, oldValue]);
  });

  storage.emit({
    subtitle: {
      oldValue: { primaryLanguage: 'ja', secondaryLanguage: 'en' },
      newValue: { primaryLanguage: 'ko', secondaryLanguage: 'en' }
    }
  });

  assert.deepEqual(primaryEvents, [['subtitle.primaryLanguage', 'ko', 'ja', 'ko']]);
  assert.deepEqual(secondaryEvents, []);
});

test('Given a storage root deletion or partial replacement When leaves are absent Then defaults are restored and published once', async () => {
  const { manager, storage } = await createConfigHarness();
  const primaryEvents = [];
  const secondaryEvents = [];
  manager.subscribe('subtitle.primaryLanguage', (key, newValue, oldValue) => {
    primaryEvents.push([key, newValue, oldValue]);
  });
  manager.subscribe('subtitle.secondaryLanguage', (key, newValue, oldValue) => {
    secondaryEvents.push([key, newValue, oldValue]);
  });

  storage.emit({
    subtitle: {
      oldValue: { primaryLanguage: 'ja', secondaryLanguage: 'ko' },
      newValue: { primaryLanguage: 'en' }
    }
  });
  storage.emit({
    subtitle: {
      oldValue: { primaryLanguage: 'en' },
      newValue: undefined
    }
  });

  assert.deepEqual(primaryEvents, [
    ['subtitle.primaryLanguage', 'en', 'ja'],
    ['subtitle.primaryLanguage', 'zh-Hant', 'en']
  ]);
  assert.deepEqual(secondaryEvents, [['subtitle.secondaryLanguage', 'en', 'ko']]);
  assert.equal(manager.get('subtitle.primaryLanguage'), 'zh-Hant');
  assert.equal(manager.get('subtitle.secondaryLanguage'), 'en');
});

test('Given validation or storage failures When ConfigManager rejects Then it publishes nothing', async () => {
  const { manager, storage } = await createConfigHarness();
  const values = [];
  manager.subscribe('subtitle.primaryLanguage', (key, value) => values.push([key, value]));

  await assert.rejects(manager.set('subtitle.primaryLanguage', 'not-a-language'));
  storage.failNextWrite = true;
  await assert.rejects(manager.set('subtitle.primaryLanguage', 'ja'), /storage write failed/);

  assert.deepEqual(values, []);
  assert.equal(manager.get('subtitle.primaryLanguage'), 'zh-Hant');
});

test('Given a rejected mixed ConfigManager batch When optimistic cache entries roll back Then every prior value remains and subscribers stay quiet', async () => {
  const { manager, storage } = await createConfigHarness();
  await manager.setMultiple({
    debugMode: true,
    'subtitle.primaryLanguage': 'ja'
  });

  const values = [];
  manager.subscribe(['debugMode', 'subtitle.primaryLanguage'], (key, value) => values.push([key, value]));
  storage.failNextWrite = true;

  await assert.rejects(
    manager.setMultiple({
      debugMode: false,
      'subtitle.primaryLanguage': 'ja'
    }),
    /storage write failed/
  );

  assert.deepEqual(values, []);
  assert.equal(manager.get('debugMode'), true);
  assert.equal(manager.get('subtitle.primaryLanguage'), 'ja');
});

test('Given a throwing ConfigManager subscriber When another subscriber observes a change Then the observer still receives it', async () => {
  const { manager, storage } = await createConfigHarness();
  const values = [];
  manager.subscribe('debugMode', () => {
    throw new Error('subscriber failure');
  });
  manager.subscribe('debugMode', (key, value) => values.push([key, value]));

  storage.emit({ debugMode: { oldValue: false, newValue: true } });

  assert.deepEqual(values, [['debugMode', true]]);
  assert.equal(manager.get('debugMode'), true);
});
