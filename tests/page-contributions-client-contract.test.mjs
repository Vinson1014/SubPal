import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const plain = (value) => JSON.parse(JSON.stringify(value));

function createEvents() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event) { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); },
    count(type) { return listeners.get(type)?.size ?? 0; }
  };
}

function createScheduler() {
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = ++nextId; tasks.set(id, { callback, delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    run(delay) { for (const [id, task] of [...tasks]) if (task.delay === delay) { tasks.delete(id); task.callback(); } },
    count() { return tasks.size; }
  };
}

async function loadPageContributions() {
  const paths = [
    'content/system/capabilities/result.js',
    'content/system/capabilities/private-transport-diagnostics.js',
    'content/system/capabilities/private-transports.js',
    'content/system/capabilities/contributions.js'
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
  const context = vm.createContext({
    structuredClone,
    CustomEvent: class CustomEvent {
      constructor(type, options) { this.type = type; this.detail = options.detail; }
    }
  });
  const modules = sources.map((source, index) => new vm.SourceTextModule(source, { context, identifier: paths[index] }));
  const [result, diagnostics, transports, contributions] = modules;

  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await diagnostics.link(() => { throw new Error('diagnostics has no dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected transport dependency: ${specifier}`);
  });
  await contributions.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transports.js') return transports;
    throw new Error(`Unexpected contribution dependency: ${specifier}`);
  });
  await result.evaluate();
  await diagnostics.evaluate();
  await transports.evaluate();
  await contributions.evaluate();
  return contributions.namespace.createPageContributions;
}

function votePayload() {
  return { videoId: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote' };
}

function authorityProjection() {
  return { variant: 'vote-authority', payload: { translationID: 'translation-1' } };
}

test('Given contribution operations When the page client sends them Then it emits only fixed PageIngress DOM envelopes and normalized Results', async () => {
  const createPageContributions = await loadPageContributions();
  assert.equal(typeof createPageContributions, 'function', 'page contribution client is missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const envelopes = [];
  let requestNumber = 0;
  const responses = [
    { ok: true, value: { status: 'queued-locally', operationId: 'vote-1' } },
    { ok: true, value: { authority: { myVote: 'like', upvotes: 4, downvotes: 1 }, hasPendingVote: false, permanentFailure: null } },
    { ok: true, value: { retryScheduled: true, operationId: 'vote-1' } }
  ];
  const window = {
    ...events,
    dispatchEvent(event) {
      envelopes.push(event.detail);
      events.emit('responseFromContentScript', {
        detail: { messageId: event.detail.messageId, response: responses[envelopes.length - 1] }
      });
      return true;
    }
  };
  const client = createPageContributions({
    window,
    createRequestId: () => `contribution-${++requestNumber}`,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout
  });

  assert.deepEqual(Object.keys(client).sort(), ['enqueue', 'getProjection', 'retry']);
  assert.equal(Object.isFrozen(client), true);
  const results = plain(await Promise.all([
    client.enqueue({ variant: 'enqueue-vote', payload: votePayload() }),
    client.getProjection(authorityProjection()),
    client.retry('vote-1')
  ]));

  assert.deepEqual(plain(envelopes), [
    { messageId: 'contribution-1', message: { category: 'contribution-intent', variant: 'enqueue-vote', payload: votePayload() } },
    { messageId: 'contribution-2', message: { category: 'contribution-read', variant: 'vote-authority', payload: { translationID: 'translation-1' } } },
    { messageId: 'contribution-3', message: { category: 'contribution-intent', variant: 'retry-operation', payload: { operationId: 'vote-1' } } }
  ]);
  assert.deepEqual(results, [
    { ok: true, value: { status: 'queued-locally', operationId: 'vote-1' } },
    { ok: true, value: { authority: { myVote: 'like', upvotes: 4, downvotes: 1 }, hasPendingVote: false, permanentFailure: null } },
    { ok: true, value: { retryScheduled: true, operationId: 'vote-1' } }
  ]);
  assert.equal(events.count('responseFromContentScript'), 0);
  assert.equal(scheduler.count(), 0);
});

test('Given malformed or authority-bearing contribution input When the page client receives it Then it rejects before dispatching a DOM request', async () => {
  const createPageContributions = await loadPageContributions();
  const events = createEvents();
  const envelopes = [];
  const client = createPageContributions({
    window: { ...events, dispatchEvent(event) { envelopes.push(event.detail); return true; } },
    createRequestId: () => 'hostile'
  });
  const inherited = Object.create(authorityProjection());
  const accessor = { variant: 'vote-authority' };
  Object.defineProperty(accessor, 'payload', { enumerable: true, get: () => ({ translationID: 'translation-1' }) });
  const symbol = authorityProjection();
  symbol[Symbol('opaque')] = true;
  const authority = { variant: 'enqueue-vote', payload: { ...votePayload(), endpoint: 'https://forged.example.test' } };

  const results = plain(await Promise.all([
    client.enqueue({ variant: 'enqueue-vote', payload: { ...votePayload(), profileId: 'forged-profile' } }),
    client.enqueue({ category: 'contribution-intent', variant: 'enqueue-vote', payload: votePayload() }),
    client.getProjection({}),
    client.getProjection(inherited),
    client.getProjection(accessor),
    client.getProjection(symbol),
    client.enqueue(authority),
    client.retry({ operationId: 'vote-1' })
  ]));

  assert.deepEqual(results, [
    { ok: false, error: { kind: 'invalid', code: 'contribution-payload', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'contribution-payload', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'contribution-projection', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'contribution-projection', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'contribution-projection', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'contribution-projection', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'contribution-payload', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'contribution-retry', retryable: false } }
  ]);
  assert.deepEqual(envelopes, []);
  assert.equal(events.count('responseFromContentScript'), 0);
});

test('Given raw or nested transport successes When the page client enqueues Then neither becomes a normalized success', async () => {
  const createPageContributions = await loadPageContributions();
  const events = createEvents();
  const scheduler = createScheduler();
  const responses = [
    { status: 'queued-locally', operationId: 'raw-1' },
    { ok: true, value: { ok: true, value: { status: 'queued-locally', operationId: 'nested-1' } } }
  ];
  const client = createPageContributions({
    window: {
      ...events,
      dispatchEvent(event) {
        events.emit('responseFromContentScript', {
          detail: { messageId: event.detail.messageId, response: responses.shift() }
        });
        return true;
      }
    },
    createRequestId: () => crypto.randomUUID(),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout
  });

  const results = plain([
    await client.enqueue({ variant: 'enqueue-vote', payload: votePayload() }),
    await client.enqueue({ variant: 'enqueue-vote', payload: votePayload() })
  ]);

  assert.deepEqual(results, [
    { ok: false, error: { kind: 'domain-rejected', code: 'dom-response-result-required', retryable: false } },
    { ok: false, error: { kind: 'domain-rejected', code: 'local-persistence-failed', retryable: true } }
  ]);
});

test('Given a page contribution request times out When a late response follows Then its normalized deadline Result and listener cleanup are preserved', async () => {
  const createPageContributions = await loadPageContributions();
  const events = createEvents();
  const scheduler = createScheduler();
  const envelopes = [];
  const client = createPageContributions({
    window: { ...events, dispatchEvent(event) { envelopes.push(event.detail); return true; } },
    createRequestId: () => 'late-retry',
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout
  });

  const pending = client.retry('vote-1');
  await Promise.resolve();
  assert.equal(events.count('responseFromContentScript'), 1);
  scheduler.run(10_000);
  assert.deepEqual(plain(await pending), {
    ok: false, error: { kind: 'timeout', code: 'dom-response-timeout', retryable: true }
  });
  assert.equal(events.count('responseFromContentScript'), 0);
  assert.equal(scheduler.count(), 0);
  events.emit('responseFromContentScript', {
    detail: { messageId: envelopes[0].messageId, response: { ok: true, value: { retryScheduled: true, operationId: 'vote-1' } } }
  });
  assert.equal(envelopes.length, 1);
});
