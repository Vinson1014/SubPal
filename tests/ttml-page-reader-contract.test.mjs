import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function createEvents() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; }
  };
}

function createScheduler() {
  const timers = [];
  return {
    setTimeout(callback, delay) {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.active = false; },
    latestDelay() { return timers.at(-1)?.delay; },
    runLatest() { const timer = timers.at(-1); if (timer?.active) timer.callback(); }
  };
}

async function loadReader() {
  const paths = [
    'content/system/capabilities/result.js',
    'content/system/capabilities/private-transport-diagnostics.js',
    'content/system/capabilities/private-transports.js',
    'content/system/capabilities/ttml-acquisition-ingress.js'
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, root), 'utf8')));
  const context = vm.createContext({ AbortController, Promise, structuredClone, setTimeout, clearTimeout });
  const [result, diagnostics, transports, ingress] = sources.map((source, index) => new vm.SourceTextModule(source, {
    context,
    identifier: paths[index]
  }));
  await result.link(() => { throw new Error('result has no dependencies'); });
  await diagnostics.link(() => { throw new Error('diagnostics has no dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected transport dependency: ${specifier}`);
  });
  await ingress.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transports.js') return transports;
    throw new Error(`Unexpected ingress dependency: ${specifier}`);
  });
  await result.evaluate();
  await diagnostics.evaluate();
  await transports.evaluate();
  await ingress.evaluate();
  return ingress.namespace;
}

async function createSyntheticModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Synthetic modules have no dependencies'); });
  await module.evaluate();
  return module;
}

async function loadMatcher(readRawPool) {
  const source = await readFile(new URL('../content/subtitle-modes/dom-overlap-matcher.js', import.meta.url), 'utf8');
  const context = vm.createContext({ Date, Promise, console: { log() {} } });
  const matcher = new vm.SourceTextModule(source, { context, identifier: 'content/subtitle-modes/dom-overlap-matcher.js' });
  const modules = new Map([
    ['../core/video-info.js', await createSyntheticModule(context, 'video-info.js', {
      getCurrentTimestamp: () => 0, getVideoId: () => 'video-1'
    })],
    ['../utils/subtitle-parser.js', await createSyntheticModule(context, 'subtitle-parser.js', {
      parseSubtitle: () => ({ subtitles: [{ startTime: 0, endTime: 1, text: 'fixture' }] })
    })],
    ['../core/playback-context-manager.js', await createSyntheticModule(context, 'playback-context-manager.js', {
      playbackContextManager: { getCurrentContext: () => ({ videoId: 'video-1', epoch: 1 }) }
    })]
  ]);
  await matcher.link((specifier) => {
    const dependency = modules.get(specifier);
    if (!dependency) throw new Error(`Unexpected matcher dependency: ${specifier}`);
    return dependency;
  });
  await matcher.evaluate();
  return { DOMOverlapMatcher: matcher.namespace.DOMOverlapMatcher, readRawPool };
}

function rawEntry(rawContent = '<tt><body><p>complete body</p></body></tt>') {
  return {
    rawContent,
    requestInfo: { requestId: 'request-1', nested: { retained: true } },
    rawMetadata: { source: 'raw-metadata' },
    metadata: { source: 'metadata' },
    language: 'zh-Hant',
    timestamp: 1700000000000
  };
}

test('Given a page-owned TTML reader When it queries raw-pool and diagnostic-summary Then it sends typed envelopes with fixed deadlines and separates complete bodies from counts', async () => {
  const capability = await loadReader();
  assert.equal(typeof capability.createPageTtmlAcquisitionReader, 'function');
  const events = createEvents();
  const scheduler = createScheduler();
  const posts = [];
  let nextId = 0;
  const window = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage(message, targetOrigin) { posts.push({ message, targetOrigin }); }
  };
  const reader = capability.createPageTtmlAcquisitionReader({
    window,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    createRequestId: () => `ttml-${++nextId}`
  });
  const raw = reader.readRawPool();
  assert.equal(scheduler.latestDelay(), 5000);
  assert.deepEqual(plain(posts.at(-1)), {
    message: {
      source: 'subpal-content-script',
      target: 'subpal-page-script',
      envelope: {
        protocolVersion: 1,
        requestId: 'ttml-1',
        kind: 'ttml-acquisition-query',
        payload: { variant: 'raw-pool', payload: {} }
      }
    },
    targetOrigin: 'https://www.netflix.com'
  });
  const entry = rawEntry();
  events.emit('message', {
    source: window,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script',
      target: 'subpal-content-script',
      requestId: 'ttml-1',
      response: { ok: true, value: { variant: 'raw-pool', entries: { 'zh-Hant_1_track': entry } } }
    }
  });
  assert.deepEqual(plain(await raw), { ok: true, value: { entries: { 'zh-Hant_1_track': entry } } });

  const summary = reader.readDiagnosticSummary();
  assert.equal(scheduler.latestDelay(), 3000);
  events.emit('message', {
    source: window,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script',
      target: 'subpal-content-script',
      requestId: 'ttml-2',
      response: { ok: true, value: { variant: 'diagnostic-summary', count: 3 } }
    }
  });
  assert.deepEqual(plain(await summary), { ok: true, value: { recentNonTtmlCandidateCount: 3 } });
});

test('Given cancellation, timeout, disconnect, malformed payloads, and late page replies When the owned reader settles Then each query settles once without replay', async () => {
  const capability = await loadReader();
  const events = createEvents();
  const scheduler = createScheduler();
  const posts = [];
  let nextId = 0;
  const window = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage(message) { posts.push(message); }
  };
  const reader = capability.createPageTtmlAcquisitionReader({
    window,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    createRequestId: () => `ttml-${++nextId}`
  });
  const cancellation = new AbortController();
  const cancelled = reader.readRawPool(cancellation.signal);
  cancellation.abort();
  assert.deepEqual(plain(await cancelled), {
    ok: false,
    error: { kind: 'cancelled', code: 'ttml-raw-pool-cancelled', retryable: false }
  });
  assert.equal(events.listenerCount('message'), 0);

  const diagnostic = reader.readDiagnosticSummary();
  events.emit('message', {
    source: window,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'ttml-1',
      response: { ok: true, value: { variant: 'raw-pool', entries: { replay: rawEntry() } } }
    }
  });
  events.emit('message', {
    source: window,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'ttml-2',
      response: { ok: true, value: { variant: 'diagnostic-summary', count: 2 } }
    }
  });
  assert.deepEqual(plain(await diagnostic), { ok: true, value: { recentNonTtmlCandidateCount: 2 } });

  const malformed = reader.readRawPool();
  events.emit('message', {
    source: window,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'ttml-3',
      response: { ok: true, value: { variant: 'raw-pool', entries: {}, debugSnapshot: {} } }
    }
  });
  assert.deepEqual(plain(await malformed), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'ttml-raw-pool-invalid', retryable: false }
  });

  const diagnosticLeak = reader.readDiagnosticSummary();
  events.emit('message', {
    source: window,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'ttml-4',
      response: { ok: true, value: { variant: 'diagnostic-summary', count: 1, rawContent: '<tt>secret</tt>' } }
    }
  });
  assert.deepEqual(plain(await diagnosticLeak), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'ttml-diagnostic-summary-invalid', retryable: false }
  });

  const timedOut = reader.readRawPool();
  scheduler.runLatest();
  assert.deepEqual(plain(await timedOut), {
    ok: false,
    error: { kind: 'timeout', code: 'ttml-raw-pool-timeout', retryable: true }
  });

  const disconnected = reader.readRawPool();
  reader.dispose();
  assert.deepEqual(plain(await disconnected), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-raw-pool-disconnected', retryable: true }
  });
  assert.equal(events.listenerCount('message'), 0);
});

test('Given real raw-pool and diagnostic queries are in flight When the page reader is disposed Then both disconnect immediately and late replies are inert', async () => {
  const capability = await loadReader();
  const events = createEvents();
  const scheduler = createScheduler();
  let nextId = 0;
  const window = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage() {}
  };
  const reader = capability.createPageTtmlAcquisitionReader({
    window,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    createRequestId: () => `ttml-stop-${++nextId}`
  });
  const raw = reader.readRawPool();
  const diagnostic = reader.readDiagnosticSummary();
  assert.equal(events.listenerCount('message'), 2);

  reader.dispose();

  assert.deepEqual(plain(await raw), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-raw-pool-disconnected', retryable: true }
  });
  assert.deepEqual(plain(await diagnostic), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-diagnostic-summary-disconnected', retryable: true }
  });
  assert.equal(events.listenerCount('message'), 0);
  events.emit('message', {
    source: window,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'ttml-stop-1',
      response: { ok: true, value: { variant: 'raw-pool', entries: { late: rawEntry() } } }
    }
  });
  assert.deepEqual(plain(await reader.readRawPool()), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-raw-pool-disconnected', retryable: true }
  });
});

test('Given DOM overlap matching needs TTML candidates When a readRawPool dependency is injected Then it consumes normalized entries and bounds reader failures without generic page messaging', async () => {
  let reads = 0;
  const rawPool = {
    ok: true,
    value: {
      entries: {
        'zh-Hant_video-1_track': rawEntry()
      }
    }
  };
  const { DOMOverlapMatcher } = await loadMatcher(async () => { reads += 1; return rawPool; });
  const matcher = new DOMOverlapMatcher({ readRawPool: async () => { reads += 1; return rawPool; } });

  const candidates = await matcher.fetchCandidates('zh');

  assert.equal(reads, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].cacheKey, 'zh-Hant_video-1_track');
  const failing = new DOMOverlapMatcher({ readRawPool: async () => { throw new Error('reader unavailable'); } });
  assert.equal((await failing.fetchCandidates('zh-Hant')).length, 0);
  assert.equal(failing.debugEvents.at(-1).type, 'CANDIDATE_FETCH_ERROR');
});
