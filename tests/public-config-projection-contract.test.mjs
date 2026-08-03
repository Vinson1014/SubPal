import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

function plain(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

async function createModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Unexpected synthetic dependency'); });
  await module.evaluate();
  return module;
}

async function settle() {
  for (let index = 0; index < 64; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

async function createContentHarness(initialConfig) {
  const listeners = new Map();
  const bridgeEvents = [];
  const responses = [];
  const subscriptions = [];
  let config = initialConfig;
  const window = {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    }
  };
  window.addEventListener('messageFromContentScript', (event) => bridgeEvents.push(event.detail));
  window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));
  const marker = { getAttribute: () => 'ready' };
  const context = vm.createContext({
    window,
    document: {
      querySelector: () => marker,
      createElement: () => ({ type: '', src: '', onload: null, setAttribute() {}, getAttribute() { return null; }, remove() {} }),
      head: { appendChild(node) { node.onload?.(); return node; } },
      documentElement: { appendChild(node) { node.onload?.(); return node; } }
    },
    console: { log() {}, warn() {}, error() {} },
    structuredClone: globalThis.structuredClone,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    chrome: {
      runtime: {
        connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; },
        getURL(path) { return `chrome-extension://test/${path}`; }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const modules = {
    config: await createModule(context, 'config-manager.js', {
      ConfigManager: class ConfigManager {
        async initialize() {}
        get(key) { return config[key]; }
        getAll() { return config; }
        subscribe(keys, callback) { subscriptions.push({ keys, callback }); }
      }
    }),
    schema: await createModule(context, 'config-schema.js', {
      getAllConfigKeys: () => ['debugMode', 'subtitle.primaryLanguage', 'subtitle.style.primary.fontSize']
    }),
    messaging: await createModule(context, 'messaging.js', { initMessaging: async () => {} }),
    isolated: await createModule(context, 'isolated-endscreen-tasks.js', { startIsolatedEndscreenTasks: async () => {} }),
    playback: await createModule(context, 'playback-context-manager.js', { playbackContextManager: {} }),
    transports: await createModule(context, 'private-transports.js', {
      createEnvelope: (value) => value,
      createPortTransport: ({ connect }) => ({ start: connect, request: async () => ({ ok: false }) })
    })
  };
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, {
    importModuleDynamically(specifier) {
      if (specifier.endsWith('config-manager.js')) return modules.config;
      if (specifier.endsWith('config-schema.js')) return modules.schema;
      if (specifier.endsWith('messaging.js')) return modules.messaging;
      if (specifier.endsWith('isolated-endscreen-tasks.js')) return modules.isolated;
      if (specifier.endsWith('playback-context-manager.js')) return modules.playback;
      if (specifier.endsWith('capabilities/private-transports.js')) return modules.transports;
      throw new Error(`Unexpected import: ${specifier}`);
    }
  });
  script.runInContext(context);
  await settle();
  const publicSubscription = subscriptions.find(({ keys }) => Array.isArray(keys));
  assert.ok(publicSubscription, 'content must capture the ConfigManager public subscription callback');
  return {
    bridgeEvents,
    emitChange(key, newValue, oldValue) { publicSubscription.callback(key, newValue, oldValue); },
    failChange() {},
    getConfig: () => config,
    async requestSnapshot() {
      window.dispatchEvent(new context.CustomEvent('messageToContentScript', {
        detail: { messageId: 'settings-snapshot', message: { category: 'settings-read', variant: 'snapshot', payload: {} } }
      }));
      await settle();
      return responses.at(-1);
    },
    setConfig(nextConfig) { config = nextConfig; }
  };
}

test('Given a public settings snapshot When legacy authority and unknown config data coexist Then MAIN receives only active-schema primitive settings', async () => {
  const harness = await createContentHarness({
    debugMode: false,
    'subtitle.primaryLanguage': 'zh-Hant',
    'subtitle.style.primary.fontSize': 55,
    'user.userId': 'legacy-user',
    JWT: 'legacy-jwt',
    profile: { id: 'private-profile' },
    backendProfiles: [{ endpoint: 'https://private.example.test' }],
    endpoint: 'https://private.example.test',
    credential: 'private-credential',
    'unknown.futureSetting': 'private-unknown',
    'subtitle.secondaryLanguage': { authorization: 'Bearer private-token' }
  });

  const snapshot = await harness.requestSnapshot();

  assert.deepEqual(plain(snapshot), {
    messageId: 'settings-snapshot',
    response: {
      ok: true,
      value: {
        debugMode: false,
        'subtitle.primaryLanguage': 'zh-Hant',
        'subtitle.style.primary.fontSize': 55
      }
    }
  });
});

test('Given the production ConfigManager subscription callback When authority, unsafe, unknown, stale, or failed changes occur Then content emits no public CONFIG_CHANGED event', async () => {
  const harness = await createContentHarness({ 'subtitle.primaryLanguage': 'zh-Hant' });
  const unsafeValues = [
    { authorization: 'Bearer private-token' },
    Object.defineProperty({}, 'value', { enumerable: true, get() { return 'private'; } }),
    Object.assign({}, { [Symbol('private')]: 'private' }),
    new Proxy({ value: 'private' }, {}),
    Object.create({ credential: 'private' })
  ];

  for (const [key, newValue, oldValue] of [
    ['user.userId', 'private-user', 'prior-user'],
    ['JWT', 'private-jwt', 'prior-jwt'],
    ['profile', { id: 'private-profile' }, null],
    ['backendProfiles', [{ endpoint: 'https://private.example.test' }], []],
    ['endpoint', 'https://private.example.test', 'https://old.example.test'],
    ['credential', 'private-credential', null],
    ['unknown.futureSetting', 'private-unknown', null],
    ...unsafeValues.map((value) => ['subtitle.primaryLanguage', value, 'zh-Hant'])
  ]) {
    harness.emitChange(key, newValue, oldValue);
  }
  harness.failChange('subtitle.primaryLanguage', 'ja', 'zh-Hant');

  assert.deepEqual(harness.bridgeEvents, []);
  assert.deepEqual(harness.getConfig(), { 'subtitle.primaryLanguage': 'zh-Hant' });
});

test('Given repeated valid active-schema changes When the production subscription callback emits them Then MAIN receives one fresh minimal event for each committed change', async () => {
  const harness = await createContentHarness({ 'subtitle.primaryLanguage': 'zh-Hant' });

  harness.emitChange('subtitle.primaryLanguage', 'ja', 'zh-Hant');
  harness.emitChange('subtitle.primaryLanguage', 'ko', 'ja');

  assert.equal(harness.bridgeEvents.length, 2);
  assert.deepEqual(plain(harness.bridgeEvents.map(({ message }) => message)), [
    { type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', newValue: 'ja', oldValue: 'zh-Hant' },
    { type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', newValue: 'ko', oldValue: 'ja' }
  ]);
  assert.notEqual(harness.bridgeEvents[0].message, harness.bridgeEvents[1].message);
  assert.deepEqual(Object.keys(harness.bridgeEvents[0].message).sort(), ['key', 'newValue', 'oldValue', 'type']);
});
