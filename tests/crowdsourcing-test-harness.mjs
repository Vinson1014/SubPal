import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadBackgroundWithApi(apiModule, options = {}) {
  return await loadBackground((specifier, context) => {
    if (specifier === './background/api.js') {
      return new vm.SyntheticModule(Object.keys(apiModule), function init() {
        for (const [name, value] of Object.entries(apiModule)) this.setExport(name, value);
      }, { context, identifier: 'api.js' });
    }
    if (specifier === './background/sync.js' && options.syncModule) {
      return new vm.SyntheticModule(Object.keys(options.syncModule), function init() {
        for (const [name, value] of Object.entries(options.syncModule)) this.setExport(name, value);
      }, { context, identifier: 'sync.js' });
    }
    return null;
  }, undefined, options);
}

export async function loadBackgroundWithRealApi(fetchImpl, options = {}) {
  return await loadBackground(async (specifier, context) => {
    if (specifier === './background/api.js') {
      const apiSource = await readFile(new URL('../background/api.js', import.meta.url), 'utf8');
      const apiModule = new vm.SourceTextModule(apiSource, { context, identifier: 'background/api.js' });
      await apiModule.link(() => {
        throw new Error('background/api.js should not import dependencies');
      });
      return apiModule;
    }
    return null;
  }, fetchImpl, options);
}

function createConsole(logs) {
  return Object.fromEntries(['log', 'warn', 'error'].map((level) => [level, (...args) => logs.push({ level, args })]));
}

async function loadBackground(resolveModule, fetchImpl = fetch, options = {}) {
  const onConnect = { listener: null };
  const onMessage = { listener: null };
  const onAlarm = { listener: null };
  const onInstalled = { listener: null };
  const onStartup = { listener: null };
  const alarmCalls = { clear: [], create: [] };
  const storageCalls = [];
  const logs = options.logs ?? [];
  const storage = options.storage ?? {
    jwt: 'jwt-token',
    user: { userId: 'user-1' },
    api: { baseUrl: 'https://api.example.test' }
  };
  const context = vm.createContext({
    AbortController,
    console: createConsole(logs),
    crypto: options.crypto ?? crypto,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    self: { addEventListener() {} },
    chrome: {
      alarms: {
        clear(name) { alarmCalls.clear.push(name); },
        create(name, alarmInfo) { alarmCalls.create.push({ name, alarmInfo }); },
        onAlarm: { addListener(listener) { onAlarm.listener = listener; } }
      },
      runtime: {
        id: 'subpal-extension-id',
        getManifest: () => ({ version: '0.0.0-test' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        onConnect: { addListener(listener) { onConnect.listener = listener; } },
        onInstalled: { addListener(listener) { onInstalled.listener = listener; } },
        onMessage: { addListener(listener) { onMessage.listener = listener; } },
        onStartup: { addListener(listener) { onStartup.listener = listener; } },
        sendMessage(_message, callback) { callback?.({ success: true }); }
      },
      storage: {
        local: {
          async get(keys, callback) {
            const requestedKeys = Array.isArray(keys) ? keys : [keys];
            const result = Object.fromEntries(requestedKeys.map((key) => [key, storage[key]]));
            storageCalls.push({ operation: 'get', keys: requestedKeys });
            callback?.(result);
            return result;
          },
          async set(values) {
            storageCalls.push({ operation: 'set', keys: Object.keys(values) });
            Object.assign(storage, values);
          },
          async remove(keys) {
            const removedKeys = Array.isArray(keys) ? keys : [keys];
            storageCalls.push({ operation: 'remove', keys: removedKeys });
            for (const key of removedKeys) delete storage[key];
          }
        }
      },
      tabs: { async create() {} }
    }
  });
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'background.js' });
  await module.link(async (specifier) => {
    const resolved = await resolveModule(specifier, context);
    if (resolved) return resolved;
    if (specifier === './background/sync.js') {
      return new vm.SyntheticModule(['handleMessage'], function init() {
        this.setExport('handleMessage', () => {});
      }, { context, identifier: 'sync.js' });
    }
    if (specifier === './background/sync-listener.js') {
      return new vm.SyntheticModule([], function init() {}, { context, identifier: 'sync-listener.js' });
    }
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  assert.equal(typeof onConnect.listener, 'function');
  assert.equal(typeof onMessage.listener, 'function');
  return {
    alarmCalls,
    connect: onConnect.listener,
    install: async (details = { reason: 'install' }) => {
      assert.equal(typeof onInstalled.listener, 'function');
      await onInstalled.listener(details);
    },
    logs,
    sendRuntimeMessage: onMessage.listener,
    startup: async () => {
      assert.equal(typeof onStartup.listener, 'function');
      await onStartup.listener();
    },
    storageCalls,
    storage,
    triggerAlarm: async (alarm) => {
      assert.equal(typeof onAlarm.listener, 'function');
      await onAlarm.listener(alarm);
    }
  };
}

export async function loadApiModule(fetchImpl, options = {}) {
  const logs = options.logs ?? [];
  const storage = options.storage ?? {
    jwt: 'jwt-token',
    user: { userId: 'user-1' },
    api: { baseUrl: 'https://api.example.test' }
  };
  const context = vm.createContext({
    AbortController,
    console: createConsole(logs),
    crypto: options.crypto ?? crypto,
    fetch: fetchImpl,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
            return { [keys]: storage[keys] };
          },
          async set(values) { Object.assign(storage, values); }
        }
      }
    }
  });
  const source = await readFile(new URL('../background/api.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'background/api.js' });
  await module.link(() => {
    throw new Error('background/api.js should not import dependencies');
  });
  await module.evaluate();
  return module.namespace;
}

export function createPort() {
  const sentMessages = [];
  const onMessage = { listener: null };
  return {
    sentMessages,
    port: {
      name: 'subtitle-assistant-channel',
      sender: { tab: { id: 7 } },
      postMessage(message) { sentMessages.push(message); },
      disconnect() {},
      onDisconnect: { addListener() {} },
      onMessage: { addListener(listener) { onMessage.listener = listener; } }
    },
    send(message) {
      assert.equal(typeof onMessage.listener, 'function');
      onMessage.listener(message);
    }
  };
}

export async function waitForResponse(sentMessages, messageId) {
  for (let i = 0; i < 20; i += 1) {
    const found = sentMessages.find((message) => message.messageId === messageId);
    if (found) return found.response;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`No response for ${messageId}`);
}

export function netflixSender(overrides = {}) {
  return {
    id: 'subpal-extension-id',
    tab: { id: 7, url: 'https://www.netflix.com/watch/82147770' },
    url: 'https://www.netflix.com/watch/82147770',
    ...overrides
  };
}

export async function sendRuntimeMessage(background, request, sender) {
  return await new Promise((resolve) => {
    const keepChannelOpen = background.sendRuntimeMessage(request, sender, resolve);
    if (keepChannelOpen !== true) setTimeout(() => resolve(undefined), 0);
  });
}

export async function loadRealContentTransport(background, sender = netflixSender()) {
  class TestCustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  }

  const window = new EventTarget();
  const portMessages = [];
  const runtimeMessages = [];
  const portMessageListeners = [];
  const port = {
    name: 'subtitle-assistant-channel',
    sender,
    postMessage(message) {
      portMessages.push(message);
      backgroundPortListener(message);
    },
    disconnect() {},
    onDisconnect: { addListener() {} },
    onMessage: { addListener(listener) { portMessageListeners.push(listener); } }
  };
  let backgroundPortListener = null;
  const connectedPort = createPort();
  connectedPort.port.sender = sender;
  connectedPort.port.postMessage = (message) => {
    for (const listener of portMessageListeners) listener(message);
  };
  background.connect(connectedPort.port);
  backgroundPortListener = connectedPort.send;
  const failedTerminalMarker = {
    getAttribute(name) {
      const attributes = {
        'data-subpal-page-script-state': 'failed-terminal',
        'data-subpal-page-script-attempt': '2',
        'data-subpal-page-script-attempt-id': '00000000-0000-4000-8000-000000000002',
        'data-subpal-page-script-deadline': '0',
        'data-subpal-page-script-retry-not-before': ''
      };
      return attributes[name] ?? null;
    }
  };

  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    crypto,
    CustomEvent: TestCustomEvent,
    document: {
      createElement() { return {}; },
      querySelector(selector) {
        return selector === 'script[data-subpal-page-script-state]' ? failedTerminalMarker : null;
      },
      documentElement: { appendChild() {} },
      head: { appendChild() {} }
    },
    Event,
    EventTarget,
    Math,
    setTimeout,
    window,
    chrome: {
      runtime: {
        connect() { return port; },
        getURL(path) { return `chrome-extension://test/${path}`; },
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          const keepOpen = background.sendRuntimeMessage(message, sender, callback);
          if (keepOpen !== true && callback) setTimeout(() => callback(undefined), 0);
        }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  new vm.Script(contentSource, { filename: 'content.js' }).runInContext(context);
  const messagingSource = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const messagingModule = new vm.SourceTextModule(messagingSource, { context, identifier: 'content/system/messaging.js' });
  await messagingModule.link(() => { throw new Error('messaging.js should not import dependencies'); });
  await messagingModule.evaluate();
  const controllerSource = await readFile(new URL('../content/core/endscreen-task-controller.js', import.meta.url), 'utf8');
  const controllerModule = new vm.SourceTextModule(controllerSource, { context, identifier: 'content/core/endscreen-task-controller.js' });
  await controllerModule.link(() => { throw new Error('endscreen-task-controller.js should not import dependencies'); });
  await controllerModule.evaluate();
  const taskClientSource = await readFile(new URL('../content/system/crowdsourcing-task-client.js', import.meta.url), 'utf8');
  const taskClientModule = new vm.SourceTextModule(taskClientSource, { context, identifier: 'content/system/crowdsourcing-task-client.js' });
  await taskClientModule.link(() => { throw new Error('crowdsourcing-task-client.js should not import dependencies'); });
  await taskClientModule.evaluate();

  return {
    EndscreenTaskController: controllerModule.namespace.EndscreenTaskController,
    sendMessage: taskClientModule.namespace.requestCrowdsourcingTasks,
    portMessages,
    runtimeMessages,
    window,
    dispatchPublicEvent(type, detail) {
      window.dispatchEvent(new TestCustomEvent(type, { detail }));
    }
  };
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
