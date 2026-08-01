import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const configManagerUrl = new URL('../content/system/config/config-manager.js', import.meta.url);
const configBridgeUrl = new URL('../content/system/config/config-bridge.js', import.meta.url);
const configSchemaUrl = new URL('../content/system/config/config-schema.js', import.meta.url);
const messagingUrl = new URL('../content/system/messaging.js', import.meta.url);

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
  const context = vm.createContext({ console });
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

  const [configManagerModule, configBridgeModule, configSchemaModule] = await Promise.all([
    loadModule(configManagerUrl),
    loadModule(configBridgeUrl),
    loadModule(configSchemaUrl)
  ]);
  await Promise.all([
    configManagerModule.evaluate(),
    configBridgeModule.evaluate(),
    configSchemaModule.evaluate()
  ]);

  return {
    ConfigManager: configManagerModule.namespace.ConfigManager,
    ConfigBridge: configBridgeModule.namespace.ConfigBridge,
    getAllConfigKeys: configSchemaModule.namespace.getAllConfigKeys
  };
}

async function createConfigHarness() {
  const messages = new Set();
  let manager;
  const transport = {
    async sendMessage(message) {
      switch (message.type) {
        case 'CONFIG_GET_ALL':
          return { success: true, config: manager.getAll() };
        case 'CONFIG_SET':
          await manager.set(message.key, message.value);
          return { success: true };
        case 'CONFIG_SET_MULTIPLE':
          await manager.setMultiple(message.items);
          return { success: true };
        default:
          return { success: false, error: `Unsupported message: ${message.type}` };
      }
    },
    onMessage(callback) {
      messages.add(callback);
      return () => messages.delete(callback);
    }
  };
  const { ConfigManager, ConfigBridge, getAllConfigKeys } = await loadConfigModules(transport);
  const storage = new ObservableStorage();
  manager = new ConfigManager({ storage });
  await manager.initialize();
  manager.subscribe(getAllConfigKeys(), (key, newValue, oldValue) => {
    for (const listener of messages) {
      listener({ type: 'CONFIG_CHANGED', key, newValue, oldValue });
    }
  });

  const bridge = new ConfigBridge();
  await bridge.initialize();
  return { bridge, manager, storage };
}

test('Given a deferred storage event When ConfigBridge sets a changed value Then subscribers stay quiet until it arrives once', async () => {
  const { bridge, storage } = await createConfigHarness();
  const values = [];
  const storageEvents = [];
  bridge.subscribe('debugMode', (value) => values.push(value));
  storage.watch((changes) => storageEvents.push(changes));

  storage.setDeferredEventDelivery(true);
  await bridge.set('debugMode', true);

  assert.deepEqual(values, []);
  assert.deepEqual(storageEvents, []);

  storage.flushDeferredEvents();

  assert.deepEqual(values, [true]);
  assert.equal(storageEvents.length, 1);
  assert.equal(bridge.get('debugMode'), true);
});

test('Given a same-value ConfigBridge write When storage emits no event Then it notifies once', async () => {
  const { bridge, storage } = await createConfigHarness();
  await bridge.set('debugMode', false);

  const values = [];
  const storageEvents = [];
  bridge.subscribe('debugMode', (value) => values.push(value));
  storage.watch((changes) => storageEvents.push(changes));

  await bridge.set('debugMode', false);

  assert.deepEqual(storageEvents, []);
  assert.deepEqual(values, [false]);
  assert.equal(bridge.get('debugMode'), false);
});

test('Given a deferred mixed ConfigBridge batch When one value changes and one stays equal Then each key notifies once', async () => {
  const { bridge, storage } = await createConfigHarness();
  await bridge.setMultiple({
    'subtitle.primaryLanguage': 'ja',
    'subtitle.secondaryLanguage': 'en'
  });

  const primaryValues = [];
  const secondaryValues = [];
  const storageEvents = [];
  bridge.subscribe('subtitle.primaryLanguage', (value) => primaryValues.push(value));
  bridge.subscribe('subtitle.secondaryLanguage', (value) => secondaryValues.push(value));
  storage.watch((changes) => storageEvents.push(changes));

  storage.setDeferredEventDelivery(true);
  await bridge.setMultiple({
    'subtitle.primaryLanguage': 'ko',
    'subtitle.secondaryLanguage': 'en'
  });

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
