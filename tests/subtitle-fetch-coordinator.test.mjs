import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function context(overrides = {}) {
  return {
    state: 'ready',
    videoId: 'netflix-81234567',
    sessionId: 'watch-session-1',
    epoch: 1,
    ...overrides
  };
}

function replacement(timestamp = 12, overrides = {}) {
  const item = {
    videoID: 'netflix-81234567',
    timestamp,
    originalSubtitle: 'Original',
    suggestedSubtitle: 'Replacement',
    languageCode: 'zh-TW',
    ...overrides
  };
  item.slotKey ??= `${item.videoID}::${String(item.originalSubtitle).trim()}::${item.languageCode}::${Number(item.timestamp).toFixed(4)}`;
  return item;
}

async function loadCoordinator() {
  const runtime = vm.createContext({ Promise, Date, setTimeout, clearTimeout, setInterval, clearInterval });
  const [source, slotKeySource] = await Promise.all([
    readFile(new URL('../content/core/subtitle-fetch-coordinator.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/utils/slot-key.js', import.meta.url), 'utf8')
  ]);
  const slotKeyModule = new vm.SourceTextModule(slotKeySource, { context: runtime, identifier: 'content/utils/slot-key.js' });
  const module = new vm.SourceTextModule(source, { context: runtime, identifier: 'content/core/subtitle-fetch-coordinator.js' });
  await module.link((specifier) => {
    if (specifier === '../utils/slot-key.js') return slotKeyModule;
    throw new Error(`Unexpected coordinator dependency: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

test('Given an empty successful range When coverage is demanded again Then negative cache prevents a duplicate fetch', async () => {
  const { SubtitleFetchCoordinator } = await loadCoordinator();
  const queries = [];
  const coordinator = new SubtitleFetchCoordinator({
    query: async (query) => { queries.push(query); return { ok: true, value: { subtitles: [] } }; }
  });
  coordinator.activateContext(context(), 0);

  await coordinator.ensureCoverage(12, { reason: 'initial' });
  await coordinator.ensureCoverage(30, { reason: 'subtitle-demand' });

  assert.deepEqual(plain(queries), [{ videoId: 'netflix-81234567', timestamp: 12, duration: 180 }]);
  assert.equal(coordinator.intervals[0].status, 'completed');
});

test('Given continuous coverage has under sixty seconds remaining When checked Then prefetch starts at the furthest endpoint', async () => {
  const { SubtitleFetchCoordinator } = await loadCoordinator();
  const queries = [];
  const coordinator = new SubtitleFetchCoordinator({
    query: async (query) => { queries.push(query); return { ok: true, value: { subtitles: [] } }; }
  });
  coordinator.activateContext(context(), 0);
  coordinator.intervals = [
    { start: 0, end: 100, status: 'completed' },
    { start: 80, end: 180, status: 'completed' }
  ];

  await coordinator.ensureCoverage(130, { reason: 'tick' });

  assert.deepEqual(plain(queries), [{ videoId: 'netflix-81234567', timestamp: 180, duration: 180 }]);
});

test('Given rapid seek events When debounce settles Then only the latest location is demanded', async () => {
  const { SubtitleFetchCoordinator } = await loadCoordinator();
  const queries = [];
  let scheduled = null;
  const coordinator = new SubtitleFetchCoordinator({
    query: async (query) => { queries.push(query); return { ok: true, value: { subtitles: [] } }; },
    setTimeoutFn(callback) { scheduled = callback; return 1; },
    clearTimeoutFn() { scheduled = null; }
  });
  coordinator.activateContext(context(), 0);

  coordinator.handlePlayerState('seeked', 20);
  coordinator.handlePlayerState('seeked', 400);
  assert.deepEqual(queries, []);
  scheduled();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(plain(queries), [{ videoId: 'netflix-81234567', timestamp: 400, duration: 180 }]);
});

test('Given two requests are in flight When more demands arrive Then only the latest demand is retained', async () => {
  const { SubtitleFetchCoordinator } = await loadCoordinator();
  const requests = [];
  const coordinator = new SubtitleFetchCoordinator({
    query(query) {
      const response = deferred();
      requests.push({ query, response });
      return response.promise;
    }
  });
  coordinator.activateContext(context(), 0);

  const first = coordinator.requestAt(0);
  const second = coordinator.requestAt(200);
  const superseded = coordinator.requestAt(400);
  const latest = coordinator.requestAt(600);
  assert.equal((await superseded).error.code, 'subtitle-demand-superseded');
  assert.equal(requests.length, 2);

  requests[0].response.resolve({ ok: true, value: { subtitles: [] } });
  await first;
  await Promise.resolve();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].query.timestamp, 600);

  requests[1].response.resolve({ ok: true, value: { subtitles: [] } });
  requests[2].response.resolve({ ok: true, value: { subtitles: [] } });
  await Promise.all([second, latest]);
});

test('Given retryable and terminal failures When demand repeats Then cooldown is respected and force bypasses suppression', async () => {
  const { SubtitleFetchCoordinator } = await loadCoordinator();
  let now = 1_000;
  const queries = [];
  const results = [
    { ok: false, error: { kind: 'timeout', code: 'subtitles-query-timeout', retryable: true } },
    { ok: true, value: { subtitles: [] } },
    { ok: false, error: { kind: 'invalid', code: 'subtitle-response-invalid', retryable: false } },
    { ok: true, value: { subtitles: [] } }
  ];
  const coordinator = new SubtitleFetchCoordinator({
    clock: () => now,
    query: async (query) => { queries.push(query); return results.shift(); }
  });
  coordinator.activateContext(context(), 0);

  await coordinator.requestAt(10);
  assert.equal((await coordinator.requestAt(10)).error.code, 'subtitle-fetch-cooldown');
  now += 2_000;
  assert.equal((await coordinator.requestAt(10)).ok, true);
  await coordinator.requestAt(300);
  assert.equal((await coordinator.requestAt(300)).error.code, 'subtitle-fetch-cooldown');
  assert.equal((await coordinator.forceRefreshAt(300)).ok, true);
  assert.equal(queries.length, 4);
});

test('Given a successful range snapshot When a forced empty snapshot arrives Then withdrawn replacements are removed', async () => {
  const { SubtitleFetchCoordinator } = await loadCoordinator();
  const results = [
    { ok: true, value: { subtitles: [replacement()] } },
    { ok: true, value: { subtitles: [] } }
  ];
  const coordinator = new SubtitleFetchCoordinator({ query: async () => results.shift() });
  coordinator.activateContext(context(), 0);

  await coordinator.requestAt(0);
  assert.ok(coordinator.getReplacement(replacement().slotKey));
  await coordinator.forceRefreshAt(0);
  assert.equal(coordinator.getReplacement(replacement().slotKey), null);
});

test('Given a response violates video, range, slot, size, or text limits When validated Then the whole batch is rejected without cache pollution', async () => {
  const { SubtitleFetchCoordinator, MAX_BATCH_SIZE, MAX_SUBTITLE_TEXT_LENGTH } = await loadCoordinator();
  const invalidBatches = [
    [replacement(12, { videoID: 'wrong-video' })],
    [replacement(200)],
    [replacement(12, { slotKey: 'forged-slot' })],
    Array.from({ length: MAX_BATCH_SIZE + 1 }, () => replacement()),
    [replacement(12, { suggestedSubtitle: 'x'.repeat(MAX_SUBTITLE_TEXT_LENGTH + 1) })]
  ];

  for (const subtitles of invalidBatches) {
    const coordinator = new SubtitleFetchCoordinator({ query: async () => ({ ok: true, value: { subtitles } }) });
    coordinator.activateContext(context(), 0);
    const result = await coordinator.requestAt(0);
    assert.equal(result.error.code, 'subtitle-response-invalid');
    assert.equal(coordinator.cache.size, 0);
  }
});

test('Given context or source changes before a response When it arrives Then it cannot populate the new scope', async () => {
  const { SubtitleFetchCoordinator } = await loadCoordinator();
  const response = deferred();
  const coordinator = new SubtitleFetchCoordinator({ query: () => response.promise });
  coordinator.activateContext(context(), 0);
  const pending = coordinator.requestAt(0);
  coordinator.activateContext(context({ epoch: 2 }), 1);
  response.resolve({ ok: true, value: { subtitles: [replacement()] } });

  const result = await pending;
  assert.equal(result.error.kind, 'stale-context');
  assert.equal(coordinator.cache.size, 0);
  assert.equal(coordinator.sourceGeneration, 1);
});
