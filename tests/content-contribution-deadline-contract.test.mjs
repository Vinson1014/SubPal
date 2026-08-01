import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

import { loadBackgroundWithApi, netflixSender } from './crowdsourcing-test-harness.mjs';

const root = new URL('../', import.meta.url);
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

class FakeScheduler {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
  setTimeout(callback, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, at: this.now + Math.max(0, Number(delay) || 0) });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  async advanceBy(duration) {
    const target = this.now + duration;
    while (true) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

async function settle() {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

async function moduleFromSource(context, path) {
  return new vm.SourceTextModule(await readFile(new URL(path, root), 'utf8'), { context, identifier: path });
}

async function syntheticModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error(`Unexpected dependency from ${identifier}`); });
  await module.evaluate();
  return module;
}

function contributionIntent() {
  return {
    category: 'contribution-intent',
    variant: 'enqueue-vote',
    payload: { videoId: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote', translationID: 'translation-1', voteState: 'like' }
  };
}

async function loadContentContributionHarness({ connect } = {}) {
  const scheduler = new FakeScheduler();
  const listeners = new Map();
  const responses = [];
  const ports = [];
  const requests = [];
  let transport;
  let nextRequestId = 0;
  const window = {
    location: { pathname: '/watch/81234567' },
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
    setTimeout: scheduler.setTimeout.bind(scheduler),
    clearTimeout: scheduler.clearTimeout.bind(scheduler)
  };
  window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    Date,
    Promise,
    clearTimeout: scheduler.clearTimeout.bind(scheduler),
    setTimeout: scheduler.setTimeout.bind(scheduler),
    window,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextRequestId).padStart(12, '0')}` },
    document: {
      querySelector() { return { getAttribute(name) { return name === 'data-subpal-page-script-state' ? 'ready' : ''; } }; },
      createElement() { return { setAttribute() {}, getAttribute() { return null; }, remove() {}, type: '', src: '' }; },
      head: { appendChild(node) { node.onload?.(); return node; } },
      documentElement: { appendChild(node) { node.onload?.(); return node; } }
    },
    chrome: {
      runtime: {
        connect() {
          if (connect) return connect();
          const messages = [];
          const disconnects = [];
          const sent = [];
          const port = {
            postMessage(message) { sent.push(message); },
            onMessage: { addListener(listener) { messages.push(listener); } },
            onDisconnect: { addListener(listener) { disconnects.push(listener); } }
          };
          ports.push({ sent, emit(message) { for (const listener of messages) listener(message); }, disconnect() { for (const listener of disconnects) listener(); } });
          return port;
        },
        getURL(path) { return `chrome-extension://test/${path}`; }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const [result, diagnostics, adapters, contributions, subtitles, ingress] = await Promise.all([
    moduleFromSource(context, 'content/system/capabilities/result.js'),
    moduleFromSource(context, 'content/system/capabilities/private-transport-diagnostics.js'),
    moduleFromSource(context, 'content/system/capabilities/private-transports.js'),
    moduleFromSource(context, 'content/system/capabilities/contributions.js'),
    moduleFromSource(context, 'content/system/capabilities/subtitles.js'),
    moduleFromSource(context, 'content/system/capabilities/page-ingress.js')
  ]);
  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await diagnostics.link(() => { throw new Error('diagnostics.js has no dependencies'); });
  await adapters.link((specifier) => specifier === './result.js' ? result : diagnostics);
  await contributions.link((specifier) => specifier === './result.js' ? result : Promise.reject(new Error(`Unexpected Contributions dependency: ${specifier}`)));
  await subtitles.link((specifier) => specifier === './result.js' ? result : adapters);
  await ingress.link((specifier) => specifier === './result.js' ? result : subtitles);
  await result.evaluate();
  await diagnostics.evaluate();
  await adapters.evaluate();
  await contributions.evaluate();
  await subtitles.evaluate();
  await ingress.evaluate();
  const observedAdapters = await syntheticModule(context, 'content/system/capabilities/observed-private-transports.js', {
    createEnvelope: adapters.namespace.createEnvelope,
    createPortTransport(options) {
      const actual = adapters.namespace.createPortTransport(options);
      transport = { ...actual, request(envelope, requestOptions) {
        requests.push({ envelope, options: requestOptions });
        return actual.request(envelope, requestOptions);
      } };
      return transport;
    }
  });
  const modules = {
    config: await syntheticModule(context, 'config-manager.js', { ConfigManager: class { async initialize() {} get() { return false; } subscribe() {} } }),
    schema: await syntheticModule(context, 'config-schema.js', { getAllConfigKeys: () => [] }),
    messaging: await syntheticModule(context, 'messaging.js', { initMessaging: async () => {} }),
    isolated: await syntheticModule(context, 'isolated-endscreen-tasks.js', { startIsolatedEndscreenTasks: async () => {} }),
    playback: await syntheticModule(context, 'playback-context-manager.js', { playbackContextManager: {} })
  };
  const content = new vm.Script(await readFile(new URL('content.js', root), 'utf8'), {
    importModuleDynamically: async (specifier) => {
      if (specifier.endsWith('config-manager.js')) return modules.config;
      if (specifier.endsWith('config-schema.js')) return modules.schema;
      if (specifier.endsWith('messaging.js')) return modules.messaging;
      if (specifier.endsWith('isolated-endscreen-tasks.js')) return modules.isolated;
      if (specifier.endsWith('playback-context-manager.js')) return modules.playback;
      if (specifier.endsWith('capabilities/private-transports.js')) return observedAdapters;
      if (specifier.endsWith('capabilities/contributions.js')) return contributions;
      if (specifier.endsWith('capabilities/page-ingress.js')) return ingress;
      throw new Error(`Unexpected content import: ${specifier}`);
    }
  });
  content.runInContext(context);
  await settle();
  return {
    ports, requests, responses, scheduler,
    pendingCount: () => transport.pendingCount(),
    dispatch(messageId, message = contributionIntent()) {
      return new Promise((resolve) => {
        const listener = (event) => {
          if (event.detail.messageId !== messageId) return;
          window.removeEventListener('responseFromContentScript', listener);
          resolve(event.detail.response);
        };
        window.addEventListener('responseFromContentScript', listener);
        window.dispatchEvent(new context.CustomEvent('messageToContentScript', { detail: { messageId, message } }));
      });
    }
  };
}

function createLinkedContributionPort(background, sent) {
  const contentListeners = [];
  const backgroundListeners = [];
  const backgroundPort = {
    name: 'subtitle-assistant-channel',
    sender: netflixSender(),
    postMessage(message) { for (const listener of contentListeners) listener(message); },
    onMessage: { addListener(listener) { backgroundListeners.push(listener); } },
    onDisconnect: { addListener() {} }
  };
  background.connect(backgroundPort);
  return {
    postMessage(message) {
      sent.push(plain(message));
      for (const listener of backgroundListeners) listener(message);
    },
    onMessage: { addListener(listener) { contentListeners.push(listener); } },
    onDisconnect: { addListener() {} }
  };
}

test('Given a content contribution uses the private Port When persistence times out and reconnects Then Contributions owns the deadline and later work stays independent', async () => {
  const harness = await loadContentContributionHarness();
  const expired = harness.dispatch('contribution-expired');
  await settle();

  assert.equal(harness.ports.length, 1);
  assert.equal(harness.ports[0].sent.length, 1);
  assert.deepEqual(plain(harness.requests[0].options), { deadlineMs: 10_000 });
  assert.equal(Object.hasOwn(harness.requests[0].options, 'signal'), false);
  assert.equal(harness.requests[0].envelope.kind, 'contribution-enqueue');
  await harness.scheduler.advanceBy(10_000);
  assert.deepEqual(plain(await expired), { ok: false, error: { kind: 'timeout', code: 'local-persistence-timeout', retryable: true } });
  assert.equal(harness.pendingCount(), 0);

  harness.ports[0].emit({ messageId: harness.ports[0].sent[0].messageId, response: { status: 'queued-locally', operationId: 'late' } });
  await settle();
  assert.equal(harness.responses.length, 1);
  harness.ports[0].disconnect();
  await harness.scheduler.advanceBy(1000);
  assert.equal(harness.ports.length, 2);
  assert.equal(harness.ports[1].sent.length, 0);

  const fresh = harness.dispatch('contribution-fresh');
  await settle();
  assert.equal(harness.ports[1].sent.length, 1);
  harness.ports[1].emit({ messageId: harness.ports[1].sent[0].messageId, response: { status: 'queued-locally', operationId: 'fresh' } });
  assert.deepEqual(plain(await fresh), { ok: true, value: { status: 'queued-locally', operationId: 'fresh' } });
});

test('Given MAIN requests approved contribution projections or retries When content forwards them Then only closed private commands and the caller operation ID cross the Port', async () => {
  const harness = await loadContentContributionHarness();
  const read = harness.dispatch('contribution-read', {
    category: 'contribution-read', variant: 'vote-authority', payload: { translationID: 'translation-1' }
  });
  await settle();

  assert.equal(harness.requests.length, 1);
  assert.deepEqual(plain(harness.requests[0]), {
    envelope: {
      protocolVersion: 1,
      requestId: harness.requests[0].envelope.requestId,
      kind: 'contribution-read',
      payload: {
        type: 'CONTRIBUTION_READ',
        projection: { variant: 'vote-authority', payload: { translationID: 'translation-1' } }
      }
    },
    options: { deadlineMs: 10_000 }
  });
  harness.ports[0].emit({
    messageId: harness.ports[0].sent[0].messageId,
    response: { authority: null, hasPendingVote: false, permanentFailure: null }
  });
  assert.deepEqual(plain(await read), {
    ok: true,
    value: { authority: null, hasPendingVote: false, permanentFailure: null }
  });

  const retry = harness.dispatch('contribution-retry', {
    category: 'contribution-intent', variant: 'retry-operation', payload: { operationId: 'operation-1' }
  });
  await settle();
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(plain(harness.requests[1]), {
    envelope: {
      protocolVersion: 1,
      requestId: harness.requests[1].envelope.requestId,
      kind: 'contribution-retry',
      payload: { type: 'CONTRIBUTION_RETRY', operationId: 'operation-1' }
    },
    options: { deadlineMs: 10_000 }
  });
  harness.ports[0].emit({
    messageId: harness.ports[0].sent[1].messageId,
    response: { retryScheduled: true, operationId: 'operation-1' }
  });
  assert.deepEqual(plain(await retry), {
    ok: true,
    value: { retryScheduled: true, operationId: 'operation-1' }
  });
});

test('Given MAIN reads and retries through the real private Port When background owns the queue Then strict wires and request-bound results agree end to end', async () => {
  const sent = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'default',
      byId: { default: { id: 'default', endpoint: 'https://api.example.test', userId: 'user-1', jwt: null } }
    },
    voteQueue: [{
      id: 'operation-1', operationId: 'operation-1', backendProfileId: 'default', status: 'failed', retryCount: 3,
      error: 'temporary failure', errorMetadata: { isPermanent: false }, translationID: 'translation-1', syncedAt: null
    }],
    translationQueue: [],
    replacementEventQueue: [],
    voteStateByTranslation: {
      'translation-1': { backendProfileId: 'default', myVote: 'like', upvotes: 4, downvotes: 1 }
    }
  };
  const background = await loadBackgroundWithApi({}, { realContributionQueue: true, storage });
  const harness = await loadContentContributionHarness({
    connect: () => createLinkedContributionPort(background, sent)
  });

  const [read, retry] = await Promise.all([
    harness.dispatch('integrated-read', {
      category: 'contribution-read', variant: 'vote-authority', payload: { translationID: 'translation-1' }
    }),
    harness.dispatch('integrated-retry', {
      category: 'contribution-intent', variant: 'retry-operation', payload: { operationId: 'operation-1' }
    })
  ]);
  assert.deepEqual({
    wires: sent.map(({ message }) => message),
    results: plain([read, retry]),
    retried: storage.voteQueue[0].status
  }, {
    wires: [
      { type: 'CONTRIBUTION_READ', projection: { variant: 'vote-authority', payload: { translationID: 'translation-1' } } },
      { type: 'CONTRIBUTION_RETRY', operationId: 'operation-1' }
    ],
    results: [
      { ok: true, value: { authority: { myVote: 'like', upvotes: 4, downvotes: 1 }, hasPendingVote: false, permanentFailure: null } },
      { ok: true, value: { retryScheduled: true, operationId: 'operation-1' } }
    ],
    retried: 'pending'
  });
});
