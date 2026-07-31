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

async function loadMessagingModuleWithMainOnlyPageScript(pageResponse = {
  success: false,
  status: 'error',
  action: 'jump-to-timecode',
  reason: 'session-mismatch'
}) {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const posts = [];
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    postMessage(message) {
      posts.push(message);
      for (const listener of listeners.get('message') || []) listener({ source: window, data: {
        source: 'subpal-page-script', messageId: message.messageId, ...pageResponse
      } });
    }
  };
  const context = vm.createContext({ console, window, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/system/messaging.js' });
  const transports = await loadPrivateTransportModule(context);
  await module.link((specifier) => {
    assert.equal(specifier, './capabilities/private-transports.js');
    return transports;
  });
  await module.evaluate();
  return { messaging: module.namespace, posts };
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

async function loadMessagingTimeoutHarness({ pageResponse } = {}) {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const timers = new Map();
  let nextTimerId = 0;
  const window = {
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event); return true; },
    postMessage(message) {
      if (!pageResponse) return;
      for (const listener of [...(listeners.get('message') ?? [])]) listener({ data: { source: 'subpal-page-script', messageId: message.messageId, ...pageResponse } });
    }
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

test('Given an isolated world without visible MAIN objects When a page command is sent Then postMessage transport reaches MAIN and preserves structured failure', async () => {
  const { messaging, posts } = await loadMessagingModuleWithMainOnlyPageScript();

  const result = await messaging.sendMessageToPageScript({
    type: 'JUMP_TO_TIMECODE',
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 }
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].target, 'subpal-page-script');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'session-mismatch');
});

test('Given a parseable partial page response with diagnostics When transported Then it resolves without collapsing into a transport rejection', async () => {
  const partial = {
    success: false,
    status: 'partial',
    partial: true,
    action: 'jump-to-timecode',
    reason: 'player-ui-restore-timeout',
    error: '已跳轉至字幕時間點，但無法安全還原播放器介面，請使用 Netflix 原生控制。',
    playerUiRestore: { status: 'failed', reason: 'player-ui-restore-timeout', activated: true }
  };
  const { messaging } = await loadMessagingModuleWithMainOnlyPageScript(partial);

  const result = await messaging.sendMessageToPageScript({ type: 'JUMP_TO_TIMECODE', intent: 'jump-to-timecode' });

  assert.equal(result.status, 'partial');
  assert.equal(result.reason, partial.reason);
  assert.deepEqual(result.playerUiRestore, partial.playerUiRestore);
});

test('Given legacy DOM and page callers When private transports terminate Then they reject safe Errors while partial page values remain raw', async () => {
  const dom = await loadMessagingTimeoutHarness();
  const domPending = dom.messaging.sendMessage({ type: 'PING' });
  dom.run(10000);
  await assert.rejects(domPending, (error) => error?.kind === 'timeout' && error.code === 'dom-response-timeout' && error.retryable === true && error.message === 'dom-response-timeout');

  const page = await loadMessagingTimeoutHarness();
  const pagePending = page.messaging.sendMessageToPageScript({ type: 'PING' });
  page.run(10000);
  await assert.rejects(pagePending, (error) => error?.kind === 'timeout' && error.code === 'page-response-timeout' && error.retryable === true && error.message === 'page-response-timeout');

  const partial = { success: false, status: 'partial', reason: 'player-ui-restore-timeout' };
  const partialPage = await loadMessagingTimeoutHarness({ pageResponse: partial });
  const partialResult = await partialPage.messaging.sendMessageToPageScript({ type: 'PING' });
  assert.equal(partialResult.status, partial.status);
  assert.equal(partialResult.reason, partial.reason);
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
