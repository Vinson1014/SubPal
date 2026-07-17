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
  await module.link(() => {
    throw new Error('messaging.js should not import dependencies for this test');
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
  await module.link(() => { throw new Error('messaging.js should not import dependencies for this test'); });
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
  await module.link(() => { throw new Error('messaging.js should only dynamically import ConfigBridge'); });
  await module.evaluate();
  await module.namespace.initMessaging();
  return { messaging: module.namespace, window, CustomEvent };
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

test('Given a caller that ignores the disposer When it registers and dispatches Then existing behavior remains unchanged', async () => {
  const messaging = await loadMessagingModule();
  const events = [];

  messaging.registerInternalEventHandler('RAW_TTML_INTERCEPTED', (message) => {
    events.push(message.type);
  });

  messaging.dispatchInternalEvent({ type: 'RAW_TTML_INTERCEPTED' });

  assert.deepEqual(events, ['RAW_TTML_INTERCEPTED']);
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
