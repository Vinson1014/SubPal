import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const rootUrl = new URL('../', import.meta.url);

function plain(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

async function sourceOrNull(path) {
  try { return await readFile(new URL(path, rootUrl), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function createModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Unexpected synthetic dependency'); }); await module.evaluate();
  return module;
}

async function createPrivateTransportModule(context) {
  const module = new vm.SyntheticModule(['createEnvelope', 'createPortTransport'], function initializePrivateTransports() {
    this.setExport('createEnvelope', ({ requestId, kind, payload, context: contextValue }) => ({ protocolVersion: 1, requestId, kind, payload, ...(contextValue === undefined ? {} : { context: contextValue }) }));
    this.setExport('createPortTransport', ({ connect }) => {
      let port = null;
      return {
        start() { if (!port) port = connect(); return port; },
        request: async () => ({ ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } })
      };
    });
  }, { context, identifier: 'content/system/capabilities/private-transports.js' });
  await module.link(() => { throw new Error('Unexpected private transport dependency'); });
  await module.evaluate();
  return module;
}

async function loadPageIngressModule(context = vm.createContext({})) {
  const [resultSource, ingressSource] = await Promise.all([
    sourceOrNull('content/system/capabilities/result.js'),
    sourceOrNull('content/system/capabilities/page-ingress.js')
  ]);
  if (!resultSource || !ingressSource) return null;
  const result = new vm.SourceTextModule(resultSource, { context, identifier: 'content/system/capabilities/result.js' });
  const ingress = new vm.SourceTextModule(ingressSource, { context, identifier: 'content/system/capabilities/page-ingress.js' });
  await result.link(() => { throw new Error('result.js must not import dependencies'); });
  await ingress.link((specifier) => {
    assert.equal(specifier, './result.js');
    return result;
  });
  await result.evaluate(); await ingress.evaluate();
  return ingress;
}

async function loadPageIngress(context) { return (await loadPageIngressModule(context))?.namespace ?? null; }

async function settle() { for (let index = 0; index < 64; index += 1) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); for (let index = 0; index < 16; index += 1) await Promise.resolve(); }

async function createContentHarness() {
  const listeners = new Map();
  const bridgeEvents = [];
  const portMessages = [];
  const errors = [];
  let storageReads = 0;
  const window = {
    location: { pathname: '/watch/81234567' },
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
  const marker = {
    getAttribute(name) {
      return name === 'data-subpal-page-script-state' ? 'ready' : '';
    }
  };
  const document = {
    querySelector() { return marker; },
    createElement() {
      return { type: '', src: '', onload: null, setAttribute() {}, getAttribute() { return null; }, remove() {} };
    },
    head: { appendChild(node) { node.onload?.(); return node; } },
    documentElement: { appendChild(node) { node.onload?.(); return node; } }
  };
  const context = vm.createContext({
    window,
    document,
    console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
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
        connect() {
          return { postMessage(message) { portMessages.push(message); }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
        },
        getURL(path) { return `chrome-extension://test/${path}`; }
      },
      storage: { local: { async get() { storageReads += 1; return {}; } } }
    }
  });
  const modules = {
    config: await createModule(context, 'config-manager.js', {
      ConfigManager: class ConfigManager { async initialize() {} get() { return false; } subscribe() {} }
    }),
    schema: await createModule(context, 'config-schema.js', { getAllConfigKeys: () => [] }),
    queue: await createModule(context, 'submission-queue-manager.js', { SubmissionQueueManager: class SubmissionQueueManager { async initialize() {} } }),
    messaging: await createModule(context, 'messaging.js', { initMessaging: async () => {} }),
    isolated: await createModule(context, 'isolated-endscreen-tasks.js', { startIsolatedEndscreenTasks: async () => {} }),
    playback: await createModule(context, 'playback-context-manager.js', { playbackContextManager: {} })
  };
  const privateTransports = await createPrivateTransportModule(context);
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, {
    importModuleDynamically: async (specifier) => {
      if (specifier.endsWith('config-manager.js')) return modules.config;
      if (specifier.endsWith('config-schema.js')) return modules.schema;
      if (specifier.endsWith('submission-queue-manager.js')) return modules.queue;
      if (specifier.endsWith('messaging.js')) return modules.messaging;
      if (specifier.endsWith('isolated-endscreen-tasks.js')) return modules.isolated;
      if (specifier.endsWith('playback-context-manager.js')) return modules.playback;
      if (specifier.endsWith('capabilities/page-ingress.js')) {
        const ingress = await loadPageIngressModule(context);
        if (!ingress) throw new Error('PageIngress capability is missing');
        return ingress;
      }
      if (specifier.endsWith('capabilities/private-transports.js')) return privateTransports;
      throw new Error(`Unexpected import: ${specifier}`);
    }
  });
  script.runInContext(context);
  await settle();
  const baseline = () => ({ storageReads, portMessages: portMessages.length, errors: errors.length });
  return {
    baseline,
    bridgeEvents,
    dispatchAndWait(messageId, message) {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          window.removeEventListener('responseFromContentScript', listener);
          reject(new Error(`No page observation response for ${messageId}`));
        }, 1000);
        const listener = (event) => {
          if (event.detail.messageId !== messageId) return;
          clearTimeout(timeoutId);
          window.removeEventListener('responseFromContentScript', listener);
          resolve(event.detail);
        };
        window.addEventListener('responseFromContentScript', listener);
        window.dispatchEvent(new context.CustomEvent('messageToContentScript', { detail: { messageId, message } }));
      });
    },
    listenForUnresolvedBusinessWork() {
      window.addEventListener('messageFromContentScript', () => new Promise(() => {}));
    }
  };
}

function acceptedInput(payload = { oldVideoId: 81234567, newVideoId: 87654321 }) {
  return { category: 'page-observation', variant: 'video-context-changed', payload };
}

test('Given an allowlisted page observation When accepted Then PageIngress dispatches one normalized internal event and returns accepted', async () => {
  const ingress = await loadPageIngress();
  assert.ok(ingress, 'PageIngress capability is missing');
  const dispatched = [];

  const result = ingress.PageIngress.accept(acceptedInput(), { dispatch(event) { dispatched.push(event); } });

  assert.deepEqual(plain(result), { ok: true, value: { status: 'accepted' } });
  assert.deepEqual(plain(dispatched), [{ type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' }]);
});

test('Given malformed, unknown, or authority-bearing page observations When PageIngress receives them Then it fails closed without dispatching', async () => {
  const ingress = await loadPageIngress();
  assert.ok(ingress, 'PageIngress capability is missing');
  const dispatched = [];
  const reject = (input, expected) => {
    const result = ingress.PageIngress.accept(input, { dispatch(event) { dispatched.push(event); } });
    assert.deepEqual(plain(result), { ok: false, error: expected });
  };

  reject({ category: 'page-observation', variant: 'video-context-changed', payload: null }, {
    kind: 'invalid', code: 'malformed-page-observation', retryable: false
  });
  reject({ category: 'page-observation', variant: 'subtitle-query', payload: {} }, {
    kind: 'forbidden', code: 'page-ingress-variant', retryable: false
  });
  for (const key of ['destination', 'command', 'storageKey', 'endpoint', 'credential', 'sync', 'lifecycleConfig']) {
    reject({ ...acceptedInput(), [key]: `${key}-attempt` }, {
      kind: 'forbidden', code: 'page-ingress-variant', retryable: false
    });
  }
  assert.deepEqual(dispatched, []);
});

test('Given a non-coercible ID When PageIngress parses a page observation Then it returns invalid without dispatching or throwing', async () => {
  const ingress = await loadPageIngress();
  const dispatched = [];

  const result = ingress.PageIngress.accept({
    category: 'page-observation', variant: 'video-context-changed', payload: { newVideoId: Object.create(null) }
  }, { dispatch(event) { dispatched.push(event); } });

  assert.deepEqual(plain(result), {
    ok: false, error: { kind: 'invalid', code: 'malformed-page-observation', retryable: false }
  });
  assert.deepEqual(dispatched, []);
});

test('Given legacy and sealed page route envelopes When the content adapter accepts them Then it bridges each normalized internal event once and ACKs without waiting for business work', async () => {
  const harness = await createContentHarness();
  harness.listenForUnresolvedBusinessWork();
  const envelopes = [
    { id: 'legacy-route', message: { type: 'VIDEO_ID_CHANGED', oldVideoId: 81234567, newVideoId: 87654321, source: 'netflix-page-script', ignored: 'private' } },
    { id: 'sealed-route', message: acceptedInput({ oldVideoId: 87654321, videoId: 89999999 }) }
  ];

  for (const envelope of envelopes) {
    const before = { events: harness.bridgeEvents.length, effects: harness.baseline() };
    const response = await harness.dispatchAndWait(envelope.id, envelope.message);
    assert.equal(harness.bridgeEvents.length, before.events + 1);
    assert.deepEqual(plain(response), {
      messageId: envelope.id,
      response: { ok: true, value: { status: 'accepted' } }
    });
    assert.deepEqual(harness.baseline(), before.effects);
  }
  assert.deepEqual(plain(harness.bridgeEvents), [
    { messageId: 'legacy-route', message: { type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' } },
    { messageId: 'sealed-route', message: { type: 'VIDEO_ID_CHANGED', oldVideoId: '87654321', videoId: '89999999' } }
  ]);
});

test('Given spoofed or legitimate video-info legacy envelopes When content receives them Then both use PageIngress and only the allowlisted one dispatches', async () => {
  const harness = await createContentHarness();
  const effects = harness.baseline();

  const spoofed = await harness.dispatchAndWait('spoofed-video-info', {
    type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321', source: 'video-info-manager', destination: 'background'
  });
  assert.deepEqual(plain(spoofed), {
    messageId: 'spoofed-video-info',
    response: { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } }
  });
  assert.deepEqual(harness.bridgeEvents, []);
  assert.deepEqual(harness.baseline(), effects);

  const legitimate = await harness.dispatchAndWait('legitimate-video-info', {
    type: 'VIDEO_ID_CHANGED', oldVideoId: 81234567, newVideoId: 87654321, source: 'video-info-manager'
  });
  assert.deepEqual(plain(legitimate), {
    messageId: 'legitimate-video-info', response: { ok: true, value: { status: 'accepted' } }
  });
  assert.deepEqual(plain(harness.bridgeEvents), [{
    messageId: 'legitimate-video-info', message: { type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' }
  }]);
});

test('Given malformed, unknown, or authority-bearing public page envelopes When content receives them Then it emits a failure ACK without storage, Port, runtime, or internal-event effects', async () => {
  const harness = await createContentHarness();
  const inputs = [
    { id: 'malformed', message: { category: 'page-observation', variant: 'video-context-changed', payload: [] }, kind: 'invalid', code: 'malformed-page-observation' },
    { id: 'unknown', message: { category: 'page-observation', variant: 'subtitle-query', payload: {} }, kind: 'forbidden', code: 'page-ingress-variant' },
    { id: 'authority', message: { type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321', source: 'netflix-page-script', destination: 'background' }, kind: 'forbidden', code: 'page-ingress-variant' }
  ];

  for (const input of inputs) {
    const before = { events: harness.bridgeEvents.length, effects: harness.baseline() };
    const response = await harness.dispatchAndWait(input.id, input.message);
    assert.equal(harness.bridgeEvents.length, before.events);
    assert.deepEqual(plain(response), {
      messageId: input.id,
      response: { ok: false, error: { kind: input.kind, code: input.code, retryable: false } }
    });
    assert.deepEqual(harness.baseline(), before.effects);
  }
});
