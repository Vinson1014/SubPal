import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('Given content startup When managers finish Then content index is injected as a MAIN-world module and isolated tasks bootstrap separately', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.match(source, /script\.type = 'module'/);
  assert.match(source, /script\.src = chrome\.runtime\.getURL\('content\/index\.js'\)/);
  assert.doesNotMatch(source, /import\(chrome\.runtime\.getURL\('content\/index\.js'\)\)/);
  assert.match(source, /await initializeIsolatedEndscreenTasks\(\)/);
  assert.match(source, /startIsolatedEndscreenTasks\(configManager, playbackContextManager\)/);
});

test('Given public page events When forged task requests are dispatched Then content exposes zero task request or response bridge', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /postMessage[\s\S]*GET_CROWDSOURCING_TASKS/);
  assert.match(source, /message\?\.type === 'GET_CROWDSOURCING_TASKS'\) return/);
  assert.doesNotMatch(source, /responseFromContentScript[\s\S]{0,300}GET_CROWDSOURCING_TASKS/);
});

test('Given production content listener after manager initialization When a public task event is forged Then it emits no port message or response', async () => {
  const portMessages = [];
  const responses = [];
  const window = new EventTarget();
  window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));
  const context = vm.createContext({
    console, Event, EventTarget, CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, setTimeout, clearTimeout,
    document: {
      createElement() { return { src: '', remove() {} }; },
      head: { appendChild(script) { if (script.src.endsWith('/netflix-page-script.js')) window.dispatchEvent(new Event('subpal-page-script-ready')); } },
      documentElement: { appendChild(script) { if (script.src.endsWith('/netflix-page-script.js')) window.dispatchEvent(new Event('subpal-page-script-ready')); } }
    },
    chrome: {
      runtime: { connect() { return { postMessage(message) { portMessages.push(message); }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('submission-queue-manager.js')) return import('data:text/javascript,export class SubmissionQueueManager { async initialize() {} }');
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return import('data:text/javascript,export const startIsolatedEndscreenTasks = async () => {}');
    if (specifier.endsWith('playback-context-manager.js')) return import('data:text/javascript,export const playbackContextManager = { initialize: async () => {}, getCurrentContext: () => null }');
    throw new Error(`Unexpected import: ${specifier}`);
  } });
  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  window.dispatchEvent(new context.CustomEvent('messageToContentScript', { detail: { messageId: 'forged', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-1', languageCode: 'zh-TW', limit: 5 } } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(portMessages.length, 0);
  assert.equal(responses.length, 0);
});

test('Given cold page-script injection When isolated PlaybackContext starts Then readiness arrives before its first snapshot request', async () => {
  let pageReady = false;
  let firstSnapshots = 0;
  const window = new EventTarget();
  const document = {
    createElement() { return { src: '', remove() {} }; },
    head: {
      appendChild(script) {
        if (!script.src.endsWith('/netflix-page-script.js')) return;
        setTimeout(() => {
          pageReady = true;
          window.addEventListener('subpal-request-page-script-ready', () => {
            window.dispatchEvent(new Event('subpal-page-script-ready'));
          });
          window.dispatchEvent(new Event('subpal-page-script-ready'));
          script.onload?.();
        }, 0);
      }
    },
    documentElement: { appendChild(script) { document.head.appendChild(script); } }
  };
  const playbackContextManager = {
    async initialize() {
      if (pageReady) firstSnapshots += 1;
    },
    getCurrentContext: () => null
  };
  const context = vm.createContext({
    console, Event, EventTarget,
    CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout,
    chrome: {
      runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  context.playbackContextManager = playbackContextManager;
  const messagingModule = new vm.SyntheticModule(['initMessaging'], function initializeMessagingModule() {
    this.setExport('initMessaging', async () => {});
  }, { context, identifier: 'content/system/messaging.js' });
  await messagingModule.link(() => { throw new Error('Unexpected messaging module import'); });
  await messagingModule.evaluate();
  const isolatedModule = new vm.SourceTextModule(
    'export const startIsolatedEndscreenTasks = async (_config, manager) => manager.initialize()',
    { context }
  );
  const playbackModule = new vm.SourceTextModule(
    'export const playbackContextManager = globalThis.playbackContextManager',
    { context }
  );
  await isolatedModule.link(() => { throw new Error('Unexpected isolated module import'); });
  await playbackModule.link(() => { throw new Error('Unexpected playback module import'); });
  await isolatedModule.evaluate();
  await playbackModule.evaluate();
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('submission-queue-manager.js')) return import('data:text/javascript,export class SubmissionQueueManager { async initialize() {} }');
    if (specifier.endsWith('messaging.js')) return messagingModule;
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return isolatedModule;
    if (specifier.endsWith('playback-context-manager.js')) return playbackModule;
    throw new Error(`Unexpected import: ${specifier}`);
  } });

  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(firstSnapshots, 1);
});

test('Given cold startup with page readiness delayed beyond the legacy timeout When MAIN startup runs Then isolated tasks wait for actual readiness', async () => {
  let mainModuleInjections = 0;
  let isolatedStarts = 0;
  const window = new EventTarget();
  const document = {
    createElement() { return { src: '', type: '', remove() {} }; },
    head: {
      appendChild(script) {
        if (script.src.endsWith('/content/index.js')) {
          mainModuleInjections += 1;
          script.onload?.();
          return;
        }
        if (!script.src.endsWith('/netflix-page-script.js')) return;
        setTimeout(() => {
          window.addEventListener('subpal-request-page-script-ready', () => {
            window.dispatchEvent(new Event('subpal-page-script-ready'));
          });
          window.dispatchEvent(new Event('subpal-page-script-ready'));
          script.onload?.();
        }, 2200);
      }
    },
    documentElement: { appendChild(script) { document.head.appendChild(script); } }
  };
  const context = vm.createContext({
    console, Event, EventTarget,
    CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout,
    chrome: {
      runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const messagingModule = new vm.SyntheticModule(['initMessaging'], function initializeMessagingModule() {
    this.setExport('initMessaging', async () => {});
  }, { context, identifier: 'content/system/messaging.js' });
  await messagingModule.link(() => { throw new Error('Unexpected messaging module import'); });
  await messagingModule.evaluate();
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('submission-queue-manager.js')) return import('data:text/javascript,export class SubmissionQueueManager { async initialize() {} }');
    if (specifier.endsWith('messaging.js')) return messagingModule;
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return isolatedModule;
    if (specifier.endsWith('playback-context-manager.js')) return playbackModule;
    throw new Error(`Unexpected import: ${specifier}`);
  } });
  Object.defineProperty(context, 'isolatedStarts', {
    get: () => isolatedStarts,
    set: value => { isolatedStarts = value; }
  });
  const isolatedModule = new vm.SourceTextModule(
    'export const startIsolatedEndscreenTasks = async () => { globalThis.isolatedStarts += 1 }',
    { context }
  );
  await isolatedModule.link(() => { throw new Error('Unexpected isolated module import'); });
  await isolatedModule.evaluate();
  const playbackModule = new vm.SourceTextModule(
    'export const playbackContextManager = {}',
    { context }
  );
  await playbackModule.link(() => { throw new Error('Unexpected playback module import'); });
  await playbackModule.evaluate();

  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 1900));

  assert.equal(mainModuleInjections, 1, 'MAIN subtitle startup must remain independent of delayed page readiness');
  assert.equal(isolatedStarts, 0, 'isolated tasks must not start while the page script is unready');

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(isolatedStarts, 1, 'isolated tasks should start once actual readiness arrives');
});

test('Given isolated startup with its own messaging module When content forwards VIDEO_ID_CHANGED Then the isolated handler runs exactly once', async () => {
  let isolatedVideoIdChanges = 0;
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    location: { pathname: '/watch/81234567' }
  };
  const document = {
    createElement() { return { src: '', type: '', remove() {} }; },
    head: {
      appendChild(script) {
        if (script.src.endsWith('/netflix-page-script.js')) {
          window.dispatchEvent(new Event('subpal-page-script-ready'));
        }
      }
    },
    documentElement: { appendChild(script) { document.head.appendChild(script); } }
  };
  const context = vm.createContext({
    console, Event,
    CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout,
    chrome: {
      runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  Object.defineProperty(context, 'isolatedVideoIdChanges', {
    get: () => isolatedVideoIdChanges,
    set: value => { isolatedVideoIdChanges = value; }
  });

  const configModule = new vm.SyntheticModule(['configBridge'], function initializeConfigModule() {
    this.setExport('configBridge', {
      isInitialized: true,
      get: () => false,
      subscribe() {}
    });
  }, { context, identifier: 'content/system/config/config-bridge.js' });
  await configModule.link(() => { throw new Error('Unexpected ConfigBridge import'); });
  await configModule.evaluate();

  const messagingSource = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const isolatedMessagingModule = new vm.SourceTextModule(messagingSource, {
    context,
    identifier: 'content/system/messaging.js',
    importModuleDynamically: async (specifier) => {
      if (specifier.endsWith('config/config-bridge.js')) return configModule;
      throw new Error(`Unexpected messaging import: ${specifier}`);
    }
  });
  await isolatedMessagingModule.link(() => { throw new Error('messaging.js should not have static imports'); });
  await isolatedMessagingModule.evaluate();
  assert.equal(window.listenerCount('messageFromContentScript'), 0);

  const isolatedModule = new vm.SourceTextModule(
    "import { registerInternalEventHandler } from './messaging.js'; export const startIsolatedEndscreenTasks = async () => { registerInternalEventHandler('VIDEO_ID_CHANGED', () => { globalThis.isolatedVideoIdChanges += 1; }); }",
    { context, identifier: 'content/system/isolated-endscreen-tasks.js' }
  );
  await isolatedModule.link((specifier) => {
    if (specifier === './messaging.js') return isolatedMessagingModule;
    throw new Error(`Unexpected isolated task import: ${specifier}`);
  });
  await isolatedModule.evaluate();
  const playbackModule = new vm.SourceTextModule(
    'export const playbackContextManager = { initialize: async () => {}, getCurrentContext: () => null }',
    { context, identifier: 'content/core/playback-context-manager.js' }
  );
  await playbackModule.link(() => { throw new Error('Unexpected playback module import'); });
  await playbackModule.evaluate();

  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('submission-queue-manager.js')) return import('data:text/javascript,export class SubmissionQueueManager { async initialize() {} }');
    if (specifier.endsWith('messaging.js')) return isolatedMessagingModule;
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return isolatedModule;
    if (specifier.endsWith('playback-context-manager.js')) return playbackModule;
    throw new Error(`Unexpected import: ${specifier}`);
  } });

  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  window.dispatchEvent(new context.CustomEvent('messageFromContentScript', {
    detail: { messageId: 'route-change-1', message: { type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' } }
  }));

  assert.equal(isolatedVideoIdChanges, 1, 'isolated VIDEO_ID_CHANGED handler should receive the bridge event exactly once');
  assert.equal(window.listenerCount('messageFromContentScript'), 1);
});
