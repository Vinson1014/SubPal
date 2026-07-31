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

async function createPrivateTransportModule(context, { onRequest = () => {} } = {}) {
  const module = new vm.SyntheticModule(['createDomTransport', 'createEnvelope', 'createPortTransport'], function initializePrivateTransports() {
    this.setExport('createDomTransport', () => ({ request: async () => ({ ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } }) }));
    this.setExport('createEnvelope', ({ requestId, kind, payload, context: contextValue }) => ({ protocolVersion: 1, requestId, kind, payload, ...(contextValue === undefined ? {} : { context: contextValue }) }));
    this.setExport('createPortTransport', ({ connect }) => {
      let port = null;
      return {
        start() { if (!port) port = connect(); return port; },
        request: async (envelope) => {
          const response = onRequest(envelope);
          return response ?? { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } };
        }
      };
    });
  }, { context, identifier: 'content/system/capabilities/private-transports.js' });
  await module.link(() => { throw new Error('Unexpected private transport dependency'); });
  await module.evaluate();
  return module;
}

async function loadPageIngressModule(context = vm.createContext({})) {
  const [resultSource, subtitlesSource, ingressSource] = await Promise.all([
    sourceOrNull('content/system/capabilities/result.js'),
    sourceOrNull('content/system/capabilities/subtitles.js'),
    sourceOrNull('content/system/capabilities/page-ingress.js')
  ]);
  if (!resultSource || !subtitlesSource || !ingressSource) return null;
  const result = new vm.SourceTextModule(resultSource, { context, identifier: 'content/system/capabilities/result.js' });
  const privateTransports = await createPrivateTransportModule(context);
  const subtitles = new vm.SourceTextModule(subtitlesSource, { context, identifier: 'content/system/capabilities/subtitles.js' });
  const ingress = new vm.SourceTextModule(ingressSource, { context, identifier: 'content/system/capabilities/page-ingress.js' });
  await result.link(() => { throw new Error('result.js must not import dependencies'); });
  await subtitles.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transports.js') return privateTransports;
    throw new Error(`Unexpected subtitles dependency: ${specifier}`);
  });
  await ingress.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './subtitles.js') return subtitles;
    throw new Error(`Unexpected PageIngress dependency: ${specifier}`);
  });
  await result.evaluate(); await subtitles.evaluate(); await ingress.evaluate();
  return ingress;
}

async function loadPageIngress(context) { return (await loadPageIngressModule(context))?.namespace ?? null; }

async function loadContributionsModule(context) {
  const [resultSource, contributionsSource] = await Promise.all([
    sourceOrNull('content/system/capabilities/result.js'),
    sourceOrNull('content/system/capabilities/contributions.js')
  ]);
  const result = new vm.SourceTextModule(resultSource, { context });
  const contributions = new vm.SourceTextModule(contributionsSource, { context });
  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await contributions.link((specifier) => {
    if (specifier === './result.js') return result;
    throw new Error(`Unexpected Contributions dependency: ${specifier}`);
  });
  await result.evaluate(); await contributions.evaluate();
  return contributions;
}

async function settle() { for (let index = 0; index < 64; index += 1) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); for (let index = 0; index < 16; index += 1) await Promise.resolve(); }

async function createContentHarness({ backendProfiles = {}, queueWrites = [] } = {}) {
  const listeners = new Map();
  const bridgeEvents = [];
  const responses = [];
  const portMessages = [];
  const errors = [];
  const configCalls = [];
  let storageReads = 0;
  let portRequests = 0;
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
  window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));
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
      storage: { local: { async get() { storageReads += 1; return { backendProfiles }; } } }
    }
  });
  const modules = {
    config: await createModule(context, 'config-manager.js', {
      ConfigManager: class ConfigManager {
        async initialize() {}
        get(key) {
          configCalls.push({ type: 'get', key });
          return {
            'subtitle.primaryLanguage': 'zh-Hant',
            'user.userId': 'private-user',
            jwt: 'private-token',
            backendProfiles: [{ id: 'private-profile' }]
          }[key];
        }
        getAll() {
          configCalls.push({ type: 'get-all' });
          return {
            'subtitle.primaryLanguage': 'zh-Hant',
            'user.userId': 'private-user',
            jwt: 'private-token',
            backendProfiles: [{ id: 'private-profile' }]
          };
        }
        async set(key, value) { configCalls.push({ type: 'set', key, value }); }
        async setMultiple(items) { configCalls.push({ type: 'set-multiple', items }); }
        subscribe() {}
      }
    }),
    schema: await createModule(context, 'config-schema.js', { getAllConfigKeys: () => [] }),
    queue: await createModule(context, 'submission-queue-manager.js', { SubmissionQueueManager: class SubmissionQueueManager {
      async initialize() {}
      async enqueueVote(payload, backendProfileId) { queueWrites.push({ payload, backendProfileId }); return { operationId: 'queued-vote-1' }; }
    } }),
    messaging: await createModule(context, 'messaging.js', { initMessaging: async () => {} }),
    isolated: await createModule(context, 'isolated-endscreen-tasks.js', { startIsolatedEndscreenTasks: async () => {} }),
    playback: await createModule(context, 'playback-context-manager.js', { playbackContextManager: {} })
  };
  const privateTransports = await createPrivateTransportModule(context, { onRequest(envelope) {
    portRequests += 1;
    if (envelope?.payload?.type === 'CONTRIBUTION_ENQUEUE') {
      return { ok: true, value: { status: 'queued-locally', operationId: 'queued-vote-1' } };
    }
  } });
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
      if (specifier.endsWith('capabilities/contributions.js')) return loadContributionsModule(context);
      if (specifier.endsWith('capabilities/private-transports.js')) return privateTransports;
      throw new Error(`Unexpected import: ${specifier}`);
    }
  });
  script.runInContext(context);
  await settle();
  const baseline = () => ({ storageReads, portMessages: portMessages.length, portRequests, configCalls: configCalls.length, errors: errors.length });
  return {
    baseline,
    bridgeEvents,
    queueWrites,
    responses,
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

test('Given a MAIN contribution intent When PageIngress accepts it Then it waits for Contributions durable enqueue before returning the queued-local ACK', async () => {
  const ingress = await loadPageIngress();
  assert.ok(ingress, 'PageIngress capability is missing');
  let resolvePersistence;
  const persistence = new Promise((resolve) => { resolvePersistence = resolve; });
  const intent = {
    category: 'contribution-intent',
    variant: 'enqueue-vote',
    payload: { videoId: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote' }
  };
  const result = ingress.PageIngress.accept(intent, {
    contributions: { enqueue: () => persistence }
  });

  assert.equal(await Promise.race([result, Promise.resolve('pending')]), 'pending');
  resolvePersistence({ ok: true, value: { status: 'queued-locally', operationId: 'operation-1' } });
  assert.deepEqual(plain(await result), {
    ok: true,
    value: { status: 'queued-locally', operationId: 'operation-1' }
  });
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

test('Given profile, authentication, endpoint, sync, or lifecycle authority in a public envelope or payload When PageIngress receives it Then it denies the attempt before dispatching or querying', async () => {
  const ingress = await loadPageIngress();
  assert.ok(ingress, 'PageIngress capability is missing');
  const dispatched = [];
  let queries = 0;
  const forbidden = { kind: 'forbidden', code: 'page-ingress-variant', retryable: false };
  const options = {
    dispatch(event) { dispatched.push(event); },
    query() { queries += 1; return { ok: true, value: { subtitles: [] } }; }
  };
  const authorityKeys = [
    'backendProfileId', 'backendProfiles', 'activeProfileId', 'profile', 'jwt', 'token', 'auth', 'user', 'userId',
    'destination', 'command', 'backgroundCommand', 'storage', 'storageKey',
    'endpoint', 'credential', 'credentials', 'sync', 'syncConfig', 'lifecycle', 'lifecycleConfig', 'config'
  ];

  for (const key of authorityKeys) {
    for (const input of [
      { ...acceptedInput(), [key]: { attempted: key } },
      acceptedInput({ oldVideoId: '81234567', [key]: { attempted: key } }),
      {
        category: 'subtitle-query', variant: 'replacement-subtitle-query',
        payload: {
          videoId: '81234567', timestamp: 12, duration: 180,
          context: { videoId: '81234567', sessionId: 'session-1', epoch: 1 },
          [key]: { attempted: key }
        }
      }
    ]) {
      assert.deepEqual(plain(ingress.PageIngress.accept(input, options)), { ok: false, error: forbidden });
    }
  }

  assert.deepEqual(dispatched, []);
  assert.equal(queries, 0);
});

test('Given an explicit backend-profile category When PageIngress receives it Then it returns the terminal profile-change denial without dispatching or querying', async () => {
  const ingress = await loadPageIngress();
  assert.ok(ingress, 'PageIngress capability is missing');
  const dispatched = [];
  let queries = 0;

  const result = ingress.PageIngress.accept({
    category: 'backend-profile', variant: 'activate',
    payload: { backendProfileId: 'profile-secret', jwt: 'private-token' }
  }, {
    dispatch(event) { dispatched.push(event); },
    query() { queries += 1; return { ok: true, value: { subtitles: [] } }; }
  });

  assert.deepEqual(plain(result), {
    ok: false, error: { kind: 'forbidden', code: 'page-profile-change', retryable: false }
  });
  assert.deepEqual(dispatched, []);
  assert.equal(queries, 0);
});

test('Given an inspectable authority-bearing Proxy that throws on has When PageIngress receives it Then it preserves a forbidden result without dispatching or querying', async () => {
  const ingress = await loadPageIngress();
  assert.ok(ingress, 'PageIngress capability is missing');
  const dispatched = [];
  let queries = 0;
  const input = new Proxy({ ...acceptedInput(), destination: 'background' }, {
    has() { throw new Error('has trap'); }
  });

  const result = ingress.PageIngress.accept(input, {
    dispatch(event) { dispatched.push(event); },
    query() { queries += 1; return { ok: true, value: { subtitles: [] } }; }
  });

  assert.deepEqual(plain(result), {
    ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false }
  });
  const opaqueResult = ingress.PageIngress.accept({
    get category() { throw new Error('category getter'); }
  }, {
    dispatch(event) { dispatched.push(event); },
    query() { queries += 1; return { ok: true, value: { subtitles: [] } }; }
  });
  assert.deepEqual(plain(opaqueResult), {
    ok: false, error: { kind: 'invalid', code: 'malformed-page-observation', retryable: false }
  });
  assert.deepEqual(dispatched, []);
  assert.equal(queries, 0);
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

test('Given repeated explicit backend-profile envelopes When the isolated bridge receives them Then it emits only terminal profile-change denials without forwarding profile data', async () => {
  const harness = await createContentHarness();
  const attempts = [
    { id: 'backend-profile-activate', message: { category: 'backend-profile', variant: 'activate', payload: { backendProfileId: 'profile-secret', jwt: 'private-token' } } },
    { id: 'backend-profile-snapshot', message: { category: 'backend-profile', variant: 'snapshot', payload: { profile: { userId: 'private-user' }, token: 'private-token' } } }
  ];

  for (const attempt of attempts) {
    const before = { events: harness.bridgeEvents.length, effects: harness.baseline() };
    const response = await harness.dispatchAndWait(attempt.id, attempt.message);
    assert.deepEqual(plain(response), {
      messageId: attempt.id,
      response: { ok: false, error: { kind: 'forbidden', code: 'page-profile-change', retryable: false } }
    });
    assert.equal(harness.bridgeEvents.length, before.events);
    assert.deepEqual(harness.baseline(), before.effects);
  }
});

test('Given legacy video messages inherit destination, jwt, or profile authority When the isolated bridge receives them Then it denies each without sanitizing it into an observation', async () => {
  const harness = await createContentHarness();
  const authorityKeys = ['destination', 'jwt', 'profile'];
  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } };

  for (const key of authorityKeys) {
    const message = Object.assign(Object.create({ [key]: { attempted: key } }), {
      type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321'
    });
    const before = { events: harness.bridgeEvents.length, responses: harness.responses.length, effects: harness.baseline() };
    const response = await harness.dispatchAndWait(`inherited-${key}`, message);
    assert.deepEqual(plain(response), { messageId: `inherited-${key}`, response: forbidden });
    assert.equal(harness.bridgeEvents.length, before.events);
    assert.equal(harness.responses.length, before.responses + 1);
    assert.deepEqual(harness.baseline(), before.effects);
  }
});

test('Given hostile category or type accessors and Proxy traps When the isolated bridge receives them Then it emits one controlled terminal response without privileged effects', async () => {
  const harness = await createContentHarness();
  const invalid = { ok: false, error: { kind: 'invalid', code: 'malformed-page-observation', retryable: false } };
  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } };
  const legacyTarget = (key) => Object.assign(Object.create({ [key]: { attempted: key } }), {
    type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321'
  });
  const attempts = [
    { id: 'throwing-category', message: { get category() { throw new Error('category getter'); } }, expected: invalid },
    { id: 'throwing-type', message: { get type() { throw new Error('type getter'); } }, expected: invalid },
    { id: 'throwing-has', message: new Proxy(legacyTarget('destination'), { has() { throw new Error('has trap'); } }), expected: forbidden },
    { id: 'throwing-own-keys', message: new Proxy(legacyTarget('profile'), { ownKeys() { throw new Error('ownKeys trap'); } }), expected: forbidden }
  ];

  for (const attempt of attempts) {
    const before = { events: harness.bridgeEvents.length, responses: harness.responses.length, effects: harness.baseline() };
    const response = await harness.dispatchAndWait(attempt.id, attempt.message);
    assert.deepEqual(plain(response), { messageId: attempt.id, response: attempt.expected });
    assert.equal(harness.bridgeEvents.length, before.events);
    assert.equal(harness.responses.length, before.responses + 1);
    assert.deepEqual(harness.baseline(), before.effects);
  }
});

test('Given MAIN legacy retry or raw contribution enqueue commands When the isolated bridge receives them Then it denies each before Port forwarding or persistence work', async () => {
  const harness = await createContentHarness();
  const retryTypes = [
    'RETRY_FAILED_VOTES', 'RETRY_FAILED_TRANSLATIONS', 'RETRY_FAILED_REPLACEMENT_EVENTS',
    'VOTE_ENQUEUE', 'TRANSLATION_ENQUEUE', 'REPLACEMENT_EVENT_ENQUEUE'
  ];
  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } };

  for (const type of retryTypes) {
    const before = { events: harness.bridgeEvents.length, responses: harness.responses.length, effects: harness.baseline() };
    const response = await harness.dispatchAndWait(`main-${type}`, { type });
    assert.deepEqual(plain(response), { messageId: `main-${type}`, response: forbidden });
    assert.equal(harness.bridgeEvents.length, before.events);
    assert.equal(harness.responses.length, before.responses + 1);
    assert.deepEqual(harness.baseline(), before.effects);
  }
});

test('Given any content-local profile record When MAIN submits a contribution intent through PageIngress Then it reaches only the private durable queue command', async () => {
  const valid = { activeProfileId: 'profile-a', byId: { 'profile-a': { id: 'profile-a' } } };
  const intent = { category: 'contribution-intent', variant: 'enqueue-vote', payload: { videoId: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote' } };
  const validHarness = await createContentHarness({ backendProfiles: valid });
  const before = validHarness.baseline();
  const validResponse = await validHarness.dispatchAndWait('valid-profile-contribution', intent);
  assert.deepEqual(plain(validResponse.response), { ok: true, value: { status: 'queued-locally', operationId: 'queued-vote-1' } });
  assert.equal(validHarness.queueWrites.length, 0);
  assert.equal(validHarness.baseline().storageReads, before.storageReads);
  assert.equal(validHarness.baseline().portRequests, before.portRequests + 1);

  for (const profile of [null, [], { id: 'other-profile' }, { get id() { return 'profile-a'; } }]) {
    const harness = await createContentHarness({ backendProfiles: { activeProfileId: 'profile-a', byId: { 'profile-a': profile } } });
    const invalidBefore = harness.baseline();
    const response = await harness.dispatchAndWait('invalid-profile-contribution', intent);
    assert.deepEqual(plain(response.response), { ok: true, value: { status: 'queued-locally', operationId: 'queued-vote-1' } });
    assert.deepEqual(harness.queueWrites, []);
    assert.equal(harness.baseline().storageReads, invalidBefore.storageReads);
    assert.equal(harness.baseline().portRequests, invalidBefore.portRequests + 1);
  }
});

test('Given MAIN CONFIG messages target identity fields When the isolated bridge receives them Then forbidden requests reach neither config nor storage and GET_ALL projects identity away', async () => {
  const harness = await createContentHarness();
  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } };
  const deniedAttempts = [
    { id: 'get-user-id', message: { type: 'CONFIG_GET', key: 'user.userId' } },
    { id: 'set-jwt', message: { type: 'CONFIG_SET', key: 'jwt', value: 'private-token' } },
    { id: 'set-multiple-auth', message: { type: 'CONFIG_SET_MULTIPLE', items: { 'subtitle.primaryLanguage': 'ja', 'auth.token': 'private-token' } } },
    { id: 'inherited-profile', message: Object.assign(Object.create({ key: 'profile.endpoint' }), { type: 'CONFIG_GET' }) },
    { id: 'proxy-identity', message: new Proxy({ type: 'CONFIG_GET', key: 'backendProfiles' }, { has() { throw new Error('has trap'); }, ownKeys() { throw new Error('ownKeys trap'); } }) }
  ];

  for (const attempt of deniedAttempts) {
    const before = { events: harness.bridgeEvents.length, responses: harness.responses.length, effects: harness.baseline() };
    const response = await harness.dispatchAndWait(attempt.id, attempt.message);
    assert.deepEqual(plain(response), { messageId: attempt.id, response: forbidden });
    assert.equal(harness.bridgeEvents.length, before.events);
    assert.equal(harness.responses.length, before.responses + 1);
    assert.deepEqual(harness.baseline(), before.effects);
  }

  const before = { events: harness.bridgeEvents.length, responses: harness.responses.length, effects: harness.baseline() };
  const response = await harness.dispatchAndWait('get-all-public-config', { type: 'CONFIG_GET_ALL' });
  assert.deepEqual(plain(response), {
    messageId: 'get-all-public-config',
    response: { success: true, config: { 'subtitle.primaryLanguage': 'zh-Hant' } }
  });
  assert.equal(harness.bridgeEvents.length, before.events);
  assert.equal(harness.responses.length, before.responses + 1);
  assert.deepEqual(harness.baseline(), { ...before.effects, configCalls: before.effects.configCalls + 1 });
});
