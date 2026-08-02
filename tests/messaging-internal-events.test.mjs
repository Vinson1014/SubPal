import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadPrivateTransportModule(context) {
  const paths = [
    '../content/system/capabilities/result.js',
    '../content/system/capabilities/private-transport-diagnostics.js',
    '../content/system/capabilities/private-transports.js'
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const [result, diagnostics, transports] = sources.map((source, index) => new vm.SourceTextModule(source, {
    context, identifier: paths[index]
  }));
  await result.link(() => { throw new Error('result.js should not import dependencies'); });
  await diagnostics.link(() => { throw new Error('diagnostics should not import dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected private transport dependency: ${specifier}`);
  });
  await result.evaluate(); await diagnostics.evaluate(); await transports.evaluate();
  return transports;
}

async function loadMessagingModule() {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/system/messaging.js'
  });
  const transports = await loadPrivateTransportModule(context);
  await module.link((specifier) => {
    assert.equal(specifier, './capabilities/private-transports.js');
    return transports;
  });
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
  const transports = await loadPrivateTransportModule(context);
  await module.link((specifier) => {
    assert.equal(specifier, './capabilities/private-transports.js');
    return transports;
  });
  await module.evaluate();
  await module.namespace.initMessaging();
  return { messaging: module.namespace, window, CustomEvent };
}

async function loadMessagingTimeoutHarness() {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const timers = new Map();
  let nextTimerId = 0;
  const window = {
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event); return true; },
  };
  const setTimeout = (callback, delay) => { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const context = vm.createContext({ console, window, CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/system/messaging.js' });
  const transports = await loadPrivateTransportModule(context);
  await module.link((specifier) => {
    assert.equal(specifier, './capabilities/private-transports.js');
    return transports;
  });
  await module.evaluate();
  return {
    messaging: module.namespace,
    run(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } }
  };
}

async function loadMessagingRequestCaptureHarness() {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const requests = [];
  const timers = new Map();
  let nextTimerId = 0;
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      if (event.type === 'messageToContentScript') requests.push(event.detail);
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      return true;
    }
  };
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const setTimeout = (callback, delay) => { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const context = vm.createContext({ console, window, CustomEvent, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/system/messaging.js' });
  const transports = await loadPrivateTransportModule(context);
  await module.link((specifier) => {
    assert.equal(specifier, './capabilities/private-transports.js');
    return transports;
  });
  await module.evaluate();
  return {
    messaging: module.namespace,
    requests,
    run(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } }
  };
}

test('Given an internal event handler When it is registered Then a disposer is returned and removes only that handler', async () => {
  const messaging = await loadMessagingModule();
  const events = [];
  const firstHandler = (message) => events.push(`first:${message.type}`);
  const secondHandler = (message) => events.push(`second:${message.type}`);

  const firstDisposer = messaging.registerInternalEventHandler('SUBTITLE_READY', firstHandler);
  const secondDisposer = messaging.registerInternalEventHandler('SUBTITLE_READY', secondHandler);

  assert.equal(typeof firstDisposer, 'function');
  assert.equal(typeof secondDisposer, 'function');

  messaging.dispatchInternalEvent({ type: 'SUBTITLE_READY' });
  firstDisposer();
  firstDisposer();
  messaging.dispatchInternalEvent({ type: 'SUBTITLE_READY' });

  assert.deepEqual(events, [
    'first:SUBTITLE_READY',
    'second:SUBTITLE_READY',
    'second:SUBTITLE_READY'
  ]);
});

test('Given a caller that ignores the disposer When it registers and dispatches an allowed internal event Then existing behavior remains unchanged', async () => {
  const messaging = await loadMessagingModule();
  const events = [];

  messaging.registerInternalEventHandler('SUBTITLE_READY', (message) => {
    events.push(message.type);
  });

  messaging.dispatchInternalEvent({ type: 'SUBTITLE_READY' });

  assert.deepEqual(events, ['SUBTITLE_READY']);
});

test('Given an initialized messaging module When its public interface is loaded Then generic page commands are absent', async () => {
  const messaging = await loadMessagingModule();

  assert.equal(Object.hasOwn(messaging, 'sendMessageToPageScript'), false);
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

test('Given content forwards VIDEO_ID_CHANGED When messaging receives the existing bridge event Then the internal handler receives it', async () => {
  const { messaging, window, CustomEvent } = await loadMessagingContentBridgeHarness();
  const events = [];
  messaging.registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => events.push(message));
  const message = { type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' };

  window.dispatchEvent(new CustomEvent('messageFromContentScript', {
    detail: { messageId: 'route-change-1', message }
  }));

  assert.deepEqual(events, [message]);
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

test('Given a legacy DOM caller When its private transport terminates Then it rejects a safe Error', async () => {
  const dom = await loadMessagingTimeoutHarness();
  const domPending = dom.messaging.sendMessage({ type: 'PING' });
  dom.run(10000);
  await assert.rejects(domPending, (error) => error?.kind === 'timeout' && error.code === 'dom-response-timeout' && error.retryable === true && error.message === 'dom-response-timeout');
});

test('Given current messaging and no DOM response When important messages are sent Then each send dispatches once and times out without replay', async () => {
  const { messaging, requests, run } = await loadMessagingRequestCaptureHarness();

  const first = messaging.sendMessage({ type: 'SUBMIT_TRANSLATION', text: 'first' });
  const second = messaging.sendMessage({ type: 'PROCESS_VOTE', text: 'second' });

  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].messageId, requests[1].messageId);
  assert.equal(requests[0].message.type, 'SUBMIT_TRANSLATION');
  assert.equal(requests[1].message.type, 'PROCESS_VOTE');

  run(20000);
  run(15000);

  await assert.rejects(first, (error) => error?.kind === 'timeout' && error.code === 'dom-response-timeout' && error.retryable === true && error.message === 'dom-response-timeout');
  await assert.rejects(second, (error) => error?.kind === 'timeout' && error.code === 'dom-response-timeout' && error.retryable === true && error.message === 'dom-response-timeout');
  assert.equal(requests.length, 2);
});
