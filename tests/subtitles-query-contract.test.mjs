import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadApiModule } from './crowdsourcing-test-harness.mjs';

const rootUrl = new URL('../', import.meta.url);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  advanceBy(delay) {
    for (const [id, task] of [...this.tasks]) {
      if (task.delay <= delay) {
        this.tasks.delete(id);
        task.callback();
      }
    }
  }
}

function context(videoId = 'netflix-81234567', sessionId = 'watch-session-1', epoch = 7) {
  return { videoId, sessionId, epoch, state: 'ready' };
}

function query(videoId = 'netflix-81234567', timestamp = 12) {
  return { videoId, timestamp, duration: 180 };
}

function replacement(timestamp = 12, overrides = {}) {
  return {
    videoID: 'netflix-81234567',
    timestamp,
    originalSubtitle: 'Original',
    suggestedSubtitle: 'Replacement',
    languageCode: 'zh-TW',
    slotKey: `Original:${timestamp}`,
    translationID: 'translation-1',
    ...overrides
  };
}

async function sourceOrNull(path) {
  try {
    return await readFile(new URL(path, rootUrl), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadCapabilityModules() {
  const [resultSource, subtitlesSource, ingressSource] = await Promise.all([
    sourceOrNull('content/system/capabilities/result.js'),
    sourceOrNull('content/system/capabilities/subtitles.js'),
    sourceOrNull('content/system/capabilities/page-ingress.js')
  ]);
  if (!resultSource || !subtitlesSource || !ingressSource) return null;

  const runtime = vm.createContext({ AbortController, Promise, setTimeout, clearTimeout });
  const resultModule = new vm.SourceTextModule(resultSource, {
    context: runtime,
    identifier: 'content/system/capabilities/result.js'
  });
  const privateTransportModule = new vm.SyntheticModule(
    ['createDomTransport', 'createEnvelope'],
    function initialize() {
      this.setExport('createDomTransport', () => ({ request: () => Promise.resolve(null) }));
      this.setExport('createEnvelope', (value) => value);
    },
    { context: runtime, identifier: 'content/system/capabilities/private-transports.js' }
  );
  const subtitlesModule = new vm.SourceTextModule(subtitlesSource, {
    context: runtime,
    identifier: 'content/system/capabilities/subtitles.js'
  });
  const ingressModule = new vm.SourceTextModule(ingressSource, {
    context: runtime,
    identifier: 'content/system/capabilities/page-ingress.js'
  });

  await resultModule.link(() => { throw new Error('result.js has no dependencies'); });
  await privateTransportModule.link(() => { throw new Error('private transport test stub has no dependencies'); });
  await subtitlesModule.link((specifier) => {
    if (specifier === './result.js') return resultModule;
    if (specifier === './private-transports.js') return privateTransportModule;
    throw new Error(`Unexpected subtitles dependency: ${specifier}`);
  });
  await ingressModule.link((specifier) => {
    if (specifier === './result.js') return resultModule;
    if (specifier === './subtitles.js') return subtitlesModule;
    throw new Error(`Unexpected PageIngress dependency: ${specifier}`);
  });
  await resultModule.evaluate();
  await privateTransportModule.evaluate();
  await subtitlesModule.evaluate();
  await ingressModule.evaluate();
  return { ingress: ingressModule.namespace, subtitles: subtitlesModule.namespace };
}

async function loadSubtitleReplacer({ queryResult, playbackContext = context() }) {
  const [source, coordinatorSource] = await Promise.all([
    readFile(new URL('../content/core/subtitle-replacer.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/core/subtitle-fetch-coordinator.js', import.meta.url), 'utf8')
  ]);
  const runtime = vm.createContext({
    AbortController, Date, Promise,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: {}
  });
  const internalHandlers = new Map();
  const messagingModule = new vm.SyntheticModule(['registerInternalEventHandler'], function initialize() {
    this.setExport('registerInternalEventHandler', (type, handler) => {
      internalHandlers.set(type, handler);
      return () => internalHandlers.delete(type);
    });
  }, { context: runtime, identifier: 'content/system/messaging.js' });
  const slotKeyModule = new vm.SyntheticModule(['buildSlotKey'], function initialize() {
    this.setExport('buildSlotKey', ({ originalSubtitle, timestamp }) => `${originalSubtitle}:${timestamp}`);
  }, { context: runtime, identifier: 'content/utils/slot-key.js' });
  const queries = [];
  const queryCalls = [];
  const subtitlesModule = new vm.SyntheticModule(['createPageSubtitles'], function initialize() {
    this.setExport('createPageSubtitles', () => ({ query: async (value, cancellation) => {
      queries.push(value);
      queryCalls.push({ value, cancellation });
      const result = typeof queryResult === 'function'
        ? queryResult(value, cancellation)
        : Array.isArray(queryResult)
          ? queryResult.shift()
          : queryResult;
      return result?.promise ?? result;
    } }));
  }, { context: runtime, identifier: 'content/system/capabilities/subtitles.js' });
  const playbackModule = new vm.SyntheticModule(['playbackContextManager'], function initialize() {
    this.setExport('playbackContextManager', { getCurrentContext: () => playbackContext });
  }, { context: runtime, identifier: 'content/core/playback-context-manager.js' });
  const coordinatorModule = new vm.SourceTextModule(coordinatorSource, {
    context: runtime,
    identifier: 'content/core/subtitle-fetch-coordinator.js'
  });
  const module = new vm.SourceTextModule(source, { context: runtime, identifier: 'content/core/subtitle-replacer.js' });

  for (const dependency of [messagingModule, slotKeyModule, subtitlesModule, playbackModule]) {
    await dependency.link(() => { throw new Error('test dependency has no imports'); });
    await dependency.evaluate();
  }
  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messagingModule;
    if (specifier === '../utils/slot-key.js') return slotKeyModule;
    if (specifier === '../system/capabilities/subtitles.js') return subtitlesModule;
    if (specifier === './playback-context-manager.js') return playbackModule;
    if (specifier === './subtitle-fetch-coordinator.js') return coordinatorModule;
    if (specifier === '../utils/slot-key.js') return slotKeyModule;
    throw new Error(`Unexpected SubtitleReplacer dependency: ${specifier}`);
  });
  await module.evaluate();
  return { SubtitleReplacer: module.namespace.SubtitleReplacer, internalHandlers, queries, queryCalls };
}

test('Given a subtitle range When the API fetches translations Then the backend request and normalized subtitles retain their established shape', async () => {
  let requestedUrl = null;
  const api = await loadApiModule(async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      async json() {
        return {
          success: true,
          data: {
            translations: [{
              videoID: 'netflix-81234567',
              timestamp: 12,
              translationID: 'translation-1',
              originalSubtitle: 'Original',
              suggestedSubtitle: 'Replacement',
              contributorUserID: 'user-1',
              languageCode: 'zh-TW',
              slotKey: 'slot-1',
              slotKeySource: 'server',
              clientVersion: '0.4.1',
              upvotes: 3,
              downvotes: 1,
              status: 'active'
            }]
          }
        };
      }
    };
  });

  const subtitles = await api.fetchSubtitles({
    videoId: 'netflix-81234567',
    startTime: 12,
    duration: 180
  });

  assert.equal(
    requestedUrl,
    'https://api.example.test/translations?videoID=netflix-81234567&startTime=12&duration=180'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(subtitles)), [{
    videoID: 'netflix-81234567',
    timestamp: 12,
    translationID: 'translation-1',
    originalSubtitle: 'Original',
    suggestedSubtitle: 'Replacement',
    contributorUserID: 'user-1',
    languageCode: 'zh-TW',
    slotKey: 'slot-1',
    slotKeySource: 'server',
    clientVersion: '0.4.1',
    upvotes: 3,
    downvotes: 1,
    myVote: null,
    status: 'active'
  }]);
});

test('Given a current playback context When Subtitles queries a valid range Then it returns normalized subtitles and SubtitleReplacer processes them', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const requests = [];
  const subtitles = modules.subtitles.createSubtitles({
    getCurrentContext: () => context(),
    request(command) {
      requests.push(command);
      return Promise.resolve({ ok: true, value: { subtitles: [{ translationID: 'translation-1' }] } });
    },
    createRequestId: () => 'query-1'
  });

  const result = await subtitles.query(query());

  assert.deepEqual(plain(result), { ok: true, value: { subtitles: [{ translationID: 'translation-1' }] } });
  assert.deepEqual(plain(requests.map(({ requestId, query: subtitleQuery, deadlineMs }) => ({ requestId, query: subtitleQuery, deadlineMs }))), [{
    requestId: 'query-1',
    query: { ...query(), context: { videoId: 'netflix-81234567', sessionId: 'watch-session-1', epoch: 7 } },
    deadlineMs: 30_000
  }]);

  const replacerResult = { ok: true, value: { subtitles: [replacement()] } };
  const { SubtitleReplacer, queries } = await loadSubtitleReplacer({ queryResult: replacerResult });
  const replacer = new SubtitleReplacer();
  const processed = [];
  replacer.processSubtitleBatch = async (items) => { processed.push(items); };

  await replacer.fetchSubtitleBatch('netflix-81234567', 12);

  assert.deepEqual(plain(processed), [[replacement()]]);
  assert.deepEqual(plain(queries), [query()]);
  assert.equal(replacer.requestedIntervals[0].status, 'completed');
});

test('Given MAIN and isolated worlds have different epochs When PageIngress forwards a query Then isolated authority is bound without comparing caller epoch', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const requests = [];
  const isolated = modules.subtitles.createSubtitles({
    getCurrentContext: () => context('netflix-81234567', 'watch-isolated-session', 42),
    request(command) {
      requests.push(command.query);
      return { ok: true, value: { subtitles: [] } };
    },
    createRequestId: () => 'cross-world-query'
  });

  const result = await modules.ingress.PageIngress.accept({
    category: 'subtitle-query',
    variant: 'replacement-subtitle-query',
    payload: query()
  }, {
    query: (value) => isolated.query(value)
  });

  assert.deepEqual(plain(result), { ok: true, value: { subtitles: [] } });
  assert.deepEqual(plain(requests), [{
    ...query(),
    context: { videoId: 'netflix-81234567', sessionId: 'watch-isolated-session', epoch: 42 }
  }]);
});

test('Given MAIN-facing subtitle input When it is accepted by PageIngress Then only the allowlisted subtitle-query capability receives it', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const received = [];

  const accepted = await modules.ingress.PageIngress.accept({
    category: 'subtitle-query',
    variant: 'replacement-subtitle-query',
    payload: query()
  }, {
    query(value) {
      received.push(value);
      return { ok: true, value: { subtitles: [] } };
    }
  });

  assert.deepEqual(plain(accepted), { ok: true, value: { subtitles: [] } });
  assert.deepEqual(plain(received), [query()]);
});

test('Given malformed, authority-bearing, or raw subtitle messages from MAIN When PageIngress receives them Then it rejects them without invoking Subtitles', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  let calls = 0;
  const options = { query() { calls += 1; return { ok: true, value: { subtitles: [] } }; } };
  const inputs = [
    { category: 'subtitle-query', variant: 'replacement-subtitle-query', payload: { ...query(), context: null } },
    { category: 'subtitle-query', variant: 'replacement-subtitle-query', payload: { ...query(), destination: 'background' } },
    { type: 'CHECK_SUBTITLE', videoId: 'netflix-81234567', timestamp: 12 }
  ];

  const results = await Promise.all(inputs.map((input) => modules.ingress.PageIngress.accept(input, options)));

  assert.deepEqual(results.map(plain).map((result) => result.ok), [false, false, false]);
  assert.equal(calls, 0);
});

test('Given an unresolved subtitle request When thirty seconds elapse Then Subtitles returns its fixed timeout without extending the deadline', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const clock = new FakeClock();
  const subtitles = modules.subtitles.createSubtitles({
    getCurrentContext: () => context(),
    request: () => new Promise(() => {}),
    createRequestId: () => 'timeout-query',
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock)
  });

  const pending = subtitles.query(query(), { deadlineMs: 90_000 });
  clock.advanceBy(30_000);

  assert.deepEqual(plain(await pending), {
    ok: false,
    error: { kind: 'timeout', code: 'subtitles-query-timeout', retryable: true }
  });
});

test('Given a disconnected private Port When Subtitles queries Then it returns the normalized disconnect failure immediately', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const subtitles = modules.subtitles.createSubtitles({
    getCurrentContext: () => context(),
    request: async () => ({ ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } }),
    createRequestId: () => 'disconnect-query'
  });

  assert.deepEqual(plain(await subtitles.query(query())), {
    ok: false,
    error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true }
  });
});

test('Given a synchronous subtitle adapter fault When Subtitles queries Then it returns a domain failure and SubtitleReplacer fails the interval once', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const subtitles = modules.subtitles.createSubtitles({
    getCurrentContext: () => context(),
    request: () => { throw new Error('adapter fault'); },
    createRequestId: () => 'adapter-fault-query'
  });

  await assert.doesNotReject(() => subtitles.query(query()));
  const result = await subtitles.query(query());

  assert.deepEqual(plain(result), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'subtitle-fetch-failed', retryable: false }
  });

  const { SubtitleReplacer } = await loadSubtitleReplacer({ queryResult: result });
  const replacer = new SubtitleReplacer();
  await assert.doesNotReject(() => replacer.fetchSubtitleBatch('netflix-81234567', 12));
  assert.equal(replacer.requestedIntervals.length, 1);
  assert.equal(replacer.requestedIntervals[0].status, 'failed');
});

test('Given a caller cancels a subtitle request When the Port has not responded Then Subtitles returns the capability cancellation failure', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const request = deferred();
  const controller = new AbortController();
  const subtitles = modules.subtitles.createSubtitles({
    getCurrentContext: () => context(),
    request: () => request.promise,
    createRequestId: () => 'cancel-query'
  });

  const pending = subtitles.query(query(), controller.signal);
  controller.abort();

  assert.deepEqual(plain(await pending), {
    ok: false,
    error: { kind: 'cancelled', code: 'subtitle-query-cancelled', retryable: false }
  });
});

test('Given playback context changes before a subtitle response When the prior query resolves Then Subtitles rejects the stale response', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const response = deferred();
  let current = context();
  const subtitles = modules.subtitles.createSubtitles({
    getCurrentContext: () => current,
    request: () => response.promise,
    createRequestId: () => 'stale-query'
  });

  const pending = subtitles.query(query());
  current = context('netflix-87654321', 'watch-session-2', 8);
  response.resolve({ ok: true, value: { subtitles: [{ translationID: 'stale' }] } });

  assert.deepEqual(plain(await pending), {
    ok: false,
    error: { kind: 'stale-context', code: 'subtitle-query-stale-context', retryable: false }
  });
});

test('Given an old subtitle query responds after a newer query When both complete Then the old response cannot replace the newer result', async () => {
  const modules = await loadCapabilityModules();
  assert.ok(modules, 'Subtitles capability is missing');
  const responses = new Map();
  let requestCounter = 0;
  const subtitles = modules.subtitles.createSubtitles({
    getCurrentContext: () => context(),
    request(command) {
      const response = deferred();
      responses.set(command.requestId, response);
      return response.promise;
    },
    createRequestId: () => `query-${++requestCounter}`
  });

  const oldRequest = subtitles.query(query('netflix-81234567', 12));
  const newRequest = subtitles.query(query('netflix-81234567', 192));
  responses.get('query-2').resolve({ ok: true, value: { subtitles: [{ translationID: 'new' }] } });
  const newResult = await newRequest;
  responses.get('query-1').resolve({ ok: true, value: { subtitles: [{ translationID: 'old' }] } });

  assert.deepEqual(plain(newResult), { ok: true, value: { subtitles: [{ translationID: 'new' }] } });
  assert.deepEqual(plain(await oldRequest), { ok: true, value: { subtitles: [{ translationID: 'old' }] } });
});

test('Given every terminal Subtitle capability failure When SubtitleReplacer fetches a batch Then it marks the interval failed without throwing', async () => {
  const terminalFailures = [
    { kind: 'invalid', code: 'subtitle-query', retryable: false },
    { kind: 'timeout', code: 'subtitles-query-timeout', retryable: true },
    { kind: 'disconnected', code: 'background-port-disconnected', retryable: true },
    { kind: 'cancelled', code: 'subtitle-query-cancelled', retryable: false },
    { kind: 'stale-context', code: 'subtitle-query-stale-context', retryable: false },
    { kind: 'domain-rejected', code: 'subtitle-fetch-failed', retryable: false }
  ];

  for (const error of terminalFailures) {
    const { SubtitleReplacer, queries } = await loadSubtitleReplacer({ queryResult: { ok: false, error } });
    const replacer = new SubtitleReplacer();
    await replacer.fetchSubtitleBatch('netflix-81234567', 12);
    assert.deepEqual(plain(queries), [query()]);
    assert.equal(replacer.requestedIntervals[0].status, error.kind === 'stale-context' ? 'stale' : 'failed');
  }
});

test('Given a failed same-start fetch When a forced retry succeeds Then each request settles its own interval attempt', async () => {
  const retryResponse = deferred();
  const { SubtitleReplacer, queries, queryCalls } = await loadSubtitleReplacer({
    queryResult: [
      { ok: false, error: { kind: 'timeout', code: 'subtitles-query-timeout', retryable: true } },
      retryResponse
    ]
  });
  const replacer = new SubtitleReplacer();

  await replacer.fetchSubtitleBatch('netflix-81234567', 12);
  const retry = replacer.fetchSubtitleBatch('netflix-81234567', 12, { force: true });
  assert.deepEqual(plain(replacer.requestedIntervals.map((interval) => interval.status)), ['failed', 'in-progress']);
  retryResponse.resolve({ ok: true, value: { subtitles: [] } });
  await retry;

  assert.deepEqual(plain(queries), [query(), query()]);
  assert.deepEqual(queryCalls.map(({ value, cancellation }) => ({ value, cancellation })), [
    { value: queries[0], cancellation: undefined },
    { value: queries[1], cancellation: undefined }
  ]);
  assert.deepEqual(plain(replacer.requestedIntervals.map((interval) => interval.status)), ['failed', 'completed']);
  assert.equal(replacer.requestedIntervals.filter((interval) => interval.status === 'in-progress').length, 0);
});

test('Given a retryable failed range When demand repeats before cooldown Then messaging does not replay it', async () => {
  const { SubtitleReplacer, queries } = await loadSubtitleReplacer({
    queryResult: { ok: false, error: { kind: 'timeout', code: 'subtitles-query-timeout', retryable: true } }
  });
  const replacer = new SubtitleReplacer();

  await replacer.fetchSubtitleBatch('netflix-81234567', 12);
  const retry = await replacer.fetchSubtitleBatch('netflix-81234567', 12);
  await replacer.fetchSubtitleBatch('netflix-81234567', 12);

  assert.deepEqual(plain(queries), [query()]);
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, 'subtitle-fetch-cooldown');
  assert.deepEqual(plain(replacer.requestedIntervals.map((interval) => interval.status)), ['failed']);
});

test('Given failed-first interval history When active coverage is evaluated for prefetch Then it ignores failures and uses the furthest active end', async () => {
  const { SubtitleReplacer, queries } = await loadSubtitleReplacer({
    queryResult: { ok: true, value: { subtitles: [] } }
  });
  const replacer = new SubtitleReplacer();
  replacer.currentVideoId = 'netflix-81234567';
  replacer.activateFetchContext();
  replacer.requestedIntervals = [
    { start: 12, end: 192, status: 'failed' },
    { start: 12, end: 192, status: 'completed' }
  ];

  replacer.checkAndTriggerPrefetch(100);
  assert.deepEqual(plain(queries), []);

  replacer.requestedIntervals = [
    { start: 12, end: 192, status: 'failed' },
    { start: 12, end: 50, status: 'completed' },
    { start: 20, end: 70, status: 'completed' }
  ];
  replacer.checkAndTriggerPrefetch(20);

  assert.deepEqual(plain(queries), [query('netflix-81234567', 70)]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(replacer.requestedIntervals.filter((interval) => interval.status === 'in-progress').length, 0);
});

test('Given a deferred initial video-change query When initialization starts Then it does not wait for the query before returning', async () => {
  const response = deferred();
  const { SubtitleReplacer, queries } = await loadSubtitleReplacer({ queryResult: response });
  const replacer = new SubtitleReplacer();

  await replacer.handleVideoChange('netflix-81234567', 12);

  assert.deepEqual(plain(queries), [query()]);
  assert.equal(replacer.requestedIntervals[0].status, 'in-progress');

  response.resolve({ ok: true, value: { subtitles: [] } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(replacer.requestedIntervals[0].status, 'completed');
});

test('Given a deferred initial video-change query When it completes after initialization Then it has no caller cancellation and completes its interval', async () => {
  const response = deferred();
  const { SubtitleReplacer, queries, queryCalls } = await loadSubtitleReplacer({ queryResult: response });
  const replacer = new SubtitleReplacer();

  await replacer.handleVideoChange('netflix-81234567', 12);

  assert.deepEqual(plain(queries), [query()]);
  assert.equal(queryCalls[0].cancellation, undefined);
  assert.equal(replacer.requestedIntervals[0].status, 'in-progress');

  response.resolve({ ok: true, value: { subtitles: [] } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(replacer.requestedIntervals[0].status, 'completed');
});

test('Given a deferred initial query fails retryably When demand repeats inside cooldown Then the failed range remains uncovered without replay', async () => {
  const response = deferred();
  const { SubtitleReplacer, queries, queryCalls } = await loadSubtitleReplacer({
    queryResult: [
      response,
      { ok: true, value: { subtitles: [] } }
    ]
  });
  const replacer = new SubtitleReplacer();

  await replacer.handleVideoChange('netflix-81234567', 12);

  assert.deepEqual(plain(queries), [query()]);
  assert.equal(queryCalls[0].cancellation, undefined);
  assert.equal(replacer.requestedIntervals[0].status, 'in-progress');

  response.resolve({
    ok: false,
    error: { kind: 'timeout', code: 'subtitles-query-timeout', retryable: true }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(replacer.requestedIntervals[0].status, 'failed');
  await replacer.fetchSubtitleBatch('netflix-81234567', 12);

  assert.deepEqual(plain(queries), [query()]);
  assert.deepEqual(plain(replacer.requestedIntervals.map((interval) => interval.status)), ['failed']);
});

test('Given player and source events When SubtitleReplacer handles them Then playback demand is wired and source changes clear scoped cache', async () => {
  const { SubtitleReplacer, internalHandlers, queries } = await loadSubtitleReplacer({
    queryResult: { ok: true, value: { subtitles: [replacement()] } }
  });
  const replacer = new SubtitleReplacer();
  replacer.setupEventHandlers();

  internalHandlers.get('PLAYER_STATE_CHANGED')({
    type: 'PLAYER_STATE_CHANGED', state: 'play', timestamp: 12, videoId: 'netflix-81234567'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(plain(queries), [query()]);
  assert.equal(replacer.subtitleCache.size, 1);

  internalHandlers.get('SUBTITLE_SOURCE_CHANGED')({ type: 'SUBTITLE_SOURCE_CHANGED', generation: 2 });
  assert.equal(replacer.subtitleSourceGeneration, 2);
  assert.equal(replacer.subtitleCache.size, 0);
  assert.equal(replacer.requestedIntervals.length, 0);

  internalHandlers.get('PLAYER_STATE_CHANGED')({
    type: 'PLAYER_STATE_CHANGED', state: 'pause', timestamp: 12, videoId: 'netflix-81234567'
  });
  replacer.cleanup();
  assert.equal(internalHandlers.size, 0);
});
