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

    if (Object.keys(changes).length > 0) this.emit(changes);
  }

  watch(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit(changes) {
    for (const listener of this.listeners) listener(changes);
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

test('Given ConfigBridge local writes When values change or stay equal Then each successful key reaches MAIN once', async () => {
  const { bridge } = await createConfigHarness();
  const values = [];
  bridge.subscribe('debugMode', (value) => values.push(value));

  await bridge.set('debugMode', true);
  await bridge.set('debugMode', true);

  assert.deepEqual(values, [true, true]);
  assert.equal(bridge.get('debugMode'), true);
});

test('Given ConfigBridge batch writes When keys change or stay equal Then each successful key reaches MAIN once', async () => {
  const { bridge } = await createConfigHarness();
  const primaryValues = [];
  const secondaryValues = [];
  bridge.subscribe('subtitle.primaryLanguage', (value) => primaryValues.push(value));
  bridge.subscribe('subtitle.secondaryLanguage', (value) => secondaryValues.push(value));

  await bridge.setMultiple({
    'subtitle.primaryLanguage': 'ja',
    'subtitle.secondaryLanguage': 'ko'
  });
  await bridge.setMultiple({
    'subtitle.primaryLanguage': 'ja',
    'subtitle.secondaryLanguage': 'ko'
  });

  assert.deepEqual(primaryValues, ['ja', 'ja']);
  assert.deepEqual(secondaryValues, ['ko', 'ko']);
  assert.equal(bridge.get('subtitle.primaryLanguage'), 'ja');
  assert.equal(bridge.get('subtitle.secondaryLanguage'), 'ko');
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
