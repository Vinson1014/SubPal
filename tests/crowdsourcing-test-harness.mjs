import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadBackgroundWithApi(apiModule) {
  return await loadBackground((specifier, context) => {
    if (specifier === './background/api.js') {
      return new vm.SyntheticModule(Object.keys(apiModule), function init() {
        for (const [name, value] of Object.entries(apiModule)) this.setExport(name, value);
      }, { context, identifier: 'api.js' });
    }
    return null;
  });
}

export async function loadBackgroundWithRealApi(fetchImpl) {
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
  }, fetchImpl);
}

async function loadBackground(resolveModule, fetchImpl = fetch) {
  const onConnect = { listener: null };
  const onMessage = { listener: null };
  const storage = {
    jwt: 'jwt-token',
    user: { userId: 'user-1' },
    api: { baseUrl: 'https://api.example.test' }
  };
  const context = vm.createContext({
    AbortController,
    console,
    crypto,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    self: { addEventListener() {} },
    chrome: {
      alarms: { clear() {}, create() {}, onAlarm: { addListener() {} } },
      runtime: {
        id: 'subpal-extension-id',
        getManifest: () => ({ version: '0.0.0-test' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        onConnect: { addListener(listener) { onConnect.listener = listener; } },
        onInstalled: { addListener() {} },
        onMessage: { addListener(listener) { onMessage.listener = listener; } },
        onStartup: { addListener() {} },
        sendMessage(_message, callback) { callback?.({ success: true }); }
      },
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
            return { [keys]: storage[keys] };
          },
          async set(values) { Object.assign(storage, values); },
          async remove() {}
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
  return { connect: onConnect.listener, sendRuntimeMessage: onMessage.listener };
}

export async function loadApiModule(fetchImpl) {
  const storage = {
    jwt: 'jwt-token',
    user: { userId: 'user-1' },
    api: { baseUrl: 'https://api.example.test' }
  };
  const context = vm.createContext({
    AbortController,
    console,
    crypto,
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
    tab: { id: 7, url: 'https://www.netflix.com/watch/81234567' },
    url: 'https://www.netflix.com/watch/81234567',
    ...overrides
  };
}

export async function sendRuntimeMessage(background, request, sender) {
  return await new Promise((resolve) => {
    const keepChannelOpen = background.sendRuntimeMessage(request, sender, resolve);
    if (keepChannelOpen !== true) setTimeout(() => resolve(undefined), 0);
  });
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
