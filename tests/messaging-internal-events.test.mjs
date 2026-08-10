import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadMessagingModule() {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/system/messaging.js'
  });
  await module.link(() => { throw new Error('messaging.js should not import dependencies'); });
  await module.evaluate();
  return module.namespace;
}

async function loadMessagingContentBridgeHarness() {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    }
  };
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const context = vm.createContext({ console, window, CustomEvent, setTimeout, clearTimeout });
  const configModule = new vm.SyntheticModule(['configBridge'], function initializeConfigModule() {
    this.setExport('configBridge', {
      isInitialized: true,
      get: () => false,
      subscribe() {}
    });
  }, { context });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/system/messaging.js',
    importModuleDynamically: async () => {
      if (configModule.status === 'unlinked') await configModule.link(() => {});
      if (configModule.status !== 'evaluated') await configModule.evaluate();
      return configModule;
    }
  });
  await module.link(() => { throw new Error('messaging.js should not import static dependencies'); });
  await module.evaluate();
  await module.namespace.initMessaging();
  return { messaging: module.namespace, window, CustomEvent };
}

function dispatchContentDetail(window, CustomEvent, detail) {
  window.dispatchEvent(new CustomEvent('messageFromContentScript', {
    detail
  }));
}

function dispatchContentMessage(window, CustomEvent, message) {
  dispatchContentDetail(window, CustomEvent, { message });
}

test('Given an internal event handler When it is registered Then a disposer is returned and removes only that handler', async () => {
  const messaging = await loadMessagingModule();
  const events = [];
  const firstHandler = (message) => events.push(`first:${message.type}`);
  const secondHandler = (message) => events.push(`second:${message.type}`);
  const eventType = 'INTERNAL_TEST_EVENT';

  const firstDisposer = messaging.registerInternalEventHandler(eventType, firstHandler);
  const secondDisposer = messaging.registerInternalEventHandler(eventType, secondHandler);

  assert.equal(typeof firstDisposer, 'function');
  assert.equal(typeof secondDisposer, 'function');

  messaging.dispatchInternalEvent({ type: eventType });
  firstDisposer();
  firstDisposer();
  messaging.dispatchInternalEvent({ type: eventType });

  assert.deepEqual(events, [
    'first:INTERNAL_TEST_EVENT',
    'second:INTERNAL_TEST_EVENT',
    'second:INTERNAL_TEST_EVENT'
  ]);
});

test('Given a caller that ignores the disposer When it registers and dispatches a generic internal event Then existing behavior remains unchanged', async () => {
  const messaging = await loadMessagingModule();
  const events = [];
  const eventType = 'INTERNAL_TEST_EVENT';

  messaging.registerInternalEventHandler(eventType, (message) => {
    events.push(message.type);
  });

  messaging.dispatchInternalEvent({ type: eventType });

  assert.deepEqual(events, [eventType]);
});

test('Given an initialized messaging module When its public interface is loaded Then only approved internal and readiness APIs remain', async () => {
  const messaging = await loadMessagingModule();

  for (const name of [
    'initMessaging',
    'registerInternalEventHandler',
    'dispatchInternalEvent',
    'isPageScriptAvailable',
    'waitForPageScript'
  ]) {
    assert.equal(typeof messaging[name], 'function', `${name} must remain exported`);
  }

  for (const name of [
    'sendMessage',
    'onMessage',
    'registerMessageHandler',
    'registerAutoForwardingToInternalEvent',
    'sendMessageToPageScript'
  ]) {
    assert.equal(Object.hasOwn(messaging, name), false, `${name} must not be exported`);
  }
});

test('Given a VIDEO_ID_CHANGED internal handler When its disposer repeats Then it remains removed', async () => {
  const messaging = await loadMessagingModule();
  const events = [];
  const dispose = messaging.registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => events.push(message));

  messaging.dispatchInternalEvent({ type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' });
  dispose();
  dispose();
  messaging.dispatchInternalEvent({ type: 'VIDEO_ID_CHANGED', oldVideoId: '87654321', newVideoId: '81234567' });

  assert.deepEqual(events, [{ type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' }]);
});

test('Given hostile reverse-DOM bridge wrappers When messaging receives them Then no getter runs and no internal event dispatches', async () => {
  const { messaging, window, CustomEvent } = await loadMessagingContentBridgeHarness();
  const events = [];
  let getterReads = 0;
  messaging.registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => events.push(message));

  const message = { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567' };
  const accessor = {};
  Object.defineProperty(accessor, 'message', { enumerable: true, get() { getterReads += 1; return message; } });
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'message', { enumerable: false, value: message });
  const inherited = Object.create({ message });
  const custom = Object.create({});
  custom.message = message;
  const spoofedPrototype = Object.create(null);
  spoofedPrototype.constructor = Object;
  const spoofed = Object.create(spoofedPrototype);
  spoofed.message = message;
  const symbolBearing = { message, [Symbol('authority')]: 'forged' };
  const throwingProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('detail trap must not escape'); } });
  const { proxy: revokedProxy, revoke } = Proxy.revocable({ message }, {});
  revoke();

  for (const detail of [
    accessor,
    nonEnumerable,
    inherited,
    custom,
    spoofed,
    symbolBearing,
    { message, destination: 'background' },
    { message, jwt: 'forged' },
    { message, profileId: 'profile-1' },
    throwingProxy,
    revokedProxy
  ]) {
    assert.doesNotThrow(() => dispatchContentDetail(window, CustomEvent, detail));
  }

  assert.deepEqual(events, []);
  assert.equal(getterReads, 0);
});

test('Given a reverse-DOM VIDEO_ID_CHANGED with authority or structural violations When messaging receives it Then it does not dispatch or execute getters', async () => {
  const { messaging, window, CustomEvent } = await loadMessagingContentBridgeHarness();
  const events = [];
  let getterReads = 0;
  messaging.registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => events.push(message));

  const accessor = { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567' };
  Object.defineProperty(accessor, 'jwt', { enumerable: true, get() { getterReads += 1; return 'secret'; } });
  const proxy = new Proxy({ type: 'VIDEO_ID_CHANGED', newVideoId: '81234567' }, {
    get() { getterReads += 1; throw new Error('proxy getter must not run'); },
    getOwnPropertyDescriptor() { throw new Error('proxy descriptor must not run'); }
  });
  const inherited = Object.create({ type: 'VIDEO_ID_CHANGED' });
  inherited.newVideoId = '81234567';
  const symbolBearing = { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', [Symbol('authority')]: 'forged' };

  for (const message of [
    { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', destination: 'background' },
    { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', command: 'DELETE' },
    { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', storageKey: 'jwt' },
    { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', jwt: 'forged' },
    { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', profileId: 'profile-1' },
    { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', sync: true },
    { type: 'VIDEO_ID_CHANGED', newVideoId: '81234567', lifecycle: 'startup' },
    { type: 'VIDEO_ID_CHANGED', newVideoId: true },
    { type: 'VIDEO_ID_CHANGED', newVideoId: {} },
    { type: 'VIDEO_ID_CHANGED', videoId: Number.NaN },
    accessor,
    proxy,
    inherited,
    symbolBearing
  ]) {
    assert.doesNotThrow(() => dispatchContentMessage(window, CustomEvent, message));
  }

  assert.deepEqual(events, []);
  assert.equal(getterReads, 0);
});

test('Given content forwards an exact VIDEO_ID_CHANGED wrapper When messaging receives it Then it preserves permitted ID values without semantic range decisions and fans out once', async () => {
  const { messaging, window, CustomEvent } = await loadMessagingContentBridgeHarness();
  const events = [];
  messaging.registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => events.push({ handler: 'first', message }));
  messaging.registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => events.push({ handler: 'second', message }));
  const firstMessage = { type: 'VIDEO_ID_CHANGED', oldVideoId: 81234567, newVideoId: '87654321', videoId: null };
  const secondMessage = { type: 'VIDEO_ID_CHANGED', oldVideoId: null, newVideoId: -99, videoId: '' };
  const nullPrototypeDetail = Object.create(null);
  nullPrototypeDetail.message = secondMessage;

  dispatchContentDetail(window, CustomEvent, { messageId: 'route-change-1', message: firstMessage });
  dispatchContentDetail(window, CustomEvent, nullPrototypeDetail);

  const expectedFirst = { type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321', videoId: null };
  const expectedSecond = { type: 'VIDEO_ID_CHANGED', oldVideoId: null, newVideoId: '-99', videoId: '' };
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { handler: 'first', message: expectedFirst },
    { handler: 'second', message: expectedFirst },
    { handler: 'first', message: expectedSecond },
    { handler: 'second', message: expectedSecond }
  ]);
  assert.notStrictEqual(events[0].message, firstMessage);
  assert.notStrictEqual(events[2].message, secondMessage);
});

test('Given content forwards a sealed subtitle source generation When messaging receives it Then only the generation is dispatched', async () => {
  const { messaging, window, CustomEvent } = await loadMessagingContentBridgeHarness();
  const events = [];
  messaging.registerInternalEventHandler('SUBTITLE_SOURCE_CHANGED', (message) => events.push(message));

  dispatchContentMessage(window, CustomEvent, { type: 'SUBTITLE_SOURCE_CHANGED', generation: 3 });
  for (const message of [
    { type: 'SUBTITLE_SOURCE_CHANGED', generation: -1 },
    { type: 'SUBTITLE_SOURCE_CHANGED', generation: 4, activeProfileId: 'private' },
    { type: 'SUBTITLE_SOURCE_CHANGED', generation: 4, endpoint: 'https://private.example' },
    { type: 'SUBTITLE_SOURCE_CHANGED', generation: 4, credential: 'secret' }
  ]) {
    dispatchContentMessage(window, CustomEvent, message);
  }

  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ type: 'SUBTITLE_SOURCE_CHANGED', generation: 3 }]);
});

test('Given initialized messaging receives a forged legacy RAW message When bridge auto-routing runs Then it does not dispatch internally while direct dispatch remains generic', async () => {
  const { messaging, window, CustomEvent } = await loadMessagingContentBridgeHarness();
  const events = [];
  const raw = { type: 'RAW_TTML_INTERCEPTED', cacheKey: 'forged' };
  messaging.registerInternalEventHandler(raw.type, (message) => events.push(message));

  window.dispatchEvent(new CustomEvent('messageFromContentScript', {
    detail: { messageId: 'forged-raw', message: raw, sender: 'forged-page' }
  }));
  assert.deepEqual(events, []);

  messaging.dispatchInternalEvent(raw);
  assert.deepEqual(events, [raw]);
});
