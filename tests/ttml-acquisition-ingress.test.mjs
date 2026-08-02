import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    }
  };
}

function evidence(overrides = {}) {
  return {
    cacheKey: 'zh-Hant_episode-A_fixture-track',
    rawContent: '<tt><body><p begin="0s">fixture</p></body></tt>',
    language: 'zh-Hant',
    requestInfo: {
      requestId: 'fixture-request',
      sessionIdAtRequest: 'watch-episode-A',
      derivedSubtitleVideo: { videoId: 'episode-A', confidence: 'high' }
    },
    rawMetadata: { bodyHash: 'fixture-hash' },
    metadata: null,
    source: 'netflix-page-script',
    ...overrides
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function loadIngress(context = vm.createContext({})) {
  const paths = [
    'content/system/capabilities/result.js',
    'content/system/capabilities/private-transport-diagnostics.js',
    'content/system/capabilities/private-transports.js',
    'content/system/capabilities/ttml-acquisition-ingress.js'
  ];
  const sources = await Promise.all(paths.map(async (path) => {
    try {
      return await readFile(new URL(path, root), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }));
  if (sources.some((source) => source === null)) return null;

  const [result, diagnostics, transports, ingress] = sources.map((source, index) => new vm.SourceTextModule(source, {
    context,
    identifier: paths[index]
  }));
  await result.link(() => { throw new Error('result.js must not import dependencies'); });
  await diagnostics.link(() => { throw new Error('private transport diagnostics has no dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected private transport dependency: ${specifier}`);
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
  return {
    ...ingress.namespace,
    toRealm(value) { return vm.runInContext(`(${JSON.stringify(value)})`, context); }
  };
}

test('Given legal page-owned TTML evidence When the dedicated ingress captures it Then the owner outcome is normalized without altering nested evidence', async () => {
  const capability = await loadIngress();
  assert.ok(capability, 'TtmlAcquisitionIngress capability is missing');
  const received = [];
  const item = capability.toRealm(evidence());
  const ingress = new capability.TtmlAcquisitionIngress({
    captureTtmlEvidence(input) {
      received.push(input);
      return { status: 'promoted', cacheKey: input.cacheKey, language: input.language, role: 'primary' };
    }
  });

  const result = ingress.capture(item);

  assert.deepEqual(plain(result), {
    ok: true,
    value: { status: 'promoted', cacheKey: item.cacheKey, language: item.language, role: 'primary' }
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].requestInfo, item.requestInfo);
  assert.equal(received[0].rawMetadata, item.rawMetadata);
  assert.equal(received[0].metadata, item.metadata);
});

test('Given malformed physical capture envelopes When dispatched Then no owner call or observable capture occurs', async () => {
  const capability = await loadIngress();
  assert.ok(capability, 'TtmlAcquisitionIngress capability is missing');
  const window = createEventTarget();
  let captureCount = 0;
  const owner = {
    captureTtmlEvidence() {
      captureCount += 1;
      return { status: 'retained', cacheKey: 'unexpected', language: 'unexpected' };
    }
  };
  const ingress = new capability.TtmlAcquisitionIngress(owner);
  const dispose = capability.bindTtmlAcquisitionCapture(window, ingress);
  const eventType = capability.TTML_ACQUISITION_CAPTURED_EVENT;

  for (const detail of [
    null,
    {},
    { protocolVersion: 2, evidence: evidence() },
    { protocolVersion: 1, evidence: evidence({ rawContent: '' }) },
    { protocolVersion: 1, evidence: evidence({ requestInfo: [] }) },
    { protocolVersion: 1, evidence: evidence(), extra: true }
  ]) {
    window.dispatchEvent({ type: eventType, detail: capability.toRealm(detail) });
  }

  assert.equal(captureCount, 0);
  assert.equal(window.listenerCount(eventType), 1);
  dispose();
  assert.equal(window.listenerCount(eventType), 0);
});

test('Given hostile protocol and evidence records When capture or the physical listener receives them Then it returns invalid without invoking the owner or throwing', async () => {
  const capability = await loadIngress();
  assert.ok(capability, 'TtmlAcquisitionIngress capability is missing');
  const window = createEventTarget();
  let ownerCalls = 0;
  const ingress = new capability.TtmlAcquisitionIngress({
    captureTtmlEvidence() {
      ownerCalls += 1;
      return { status: 'retained' };
    }
  });
  const dispose = capability.bindTtmlAcquisitionCapture(window, ingress);
  const throwingProtocol = {};
  Object.defineProperty(throwingProtocol, 'protocolVersion', { get() { throw new Error('protocol getter'); } });
  const throwingEvidence = { protocolVersion: 1 };
  Object.defineProperty(throwingEvidence, 'evidence', { get() { throw new Error('evidence getter'); } });
  const throwingSource = evidence();
  Object.defineProperty(throwingSource, 'source', { get() { throw new Error('source getter'); } });
  const prototypeTrap = new Proxy({}, { getPrototypeOf() { throw new Error('prototype trap'); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const nullPrototype = Object.assign(Object.create(null), evidence());
  const symbolEvidence = evidence({ [Symbol('unexpected')]: true });
  const crossRealmEvidence = vm.runInNewContext(`(${JSON.stringify(evidence())})`);

  for (const detail of [throwingProtocol, throwingEvidence, { protocolVersion: 1, evidence: throwingSource },
    { protocolVersion: 1, evidence: prototypeTrap }, { protocolVersion: 1, evidence: revoked.proxy },
    { protocolVersion: 1, evidence: nullPrototype }, { protocolVersion: 1, evidence: symbolEvidence },
    { protocolVersion: 1, evidence: crossRealmEvidence }]) {
    assert.doesNotThrow(() => window.dispatchEvent({ type: capability.TTML_ACQUISITION_CAPTURED_EVENT, detail }));
  }
  assert.doesNotThrow(() => ingress.capture(revoked.proxy));
  assert.equal(ownerCalls, 0);
  dispose();
});

test('Given one MAIN-window ingress binding When it is rebound or another owner attempts to bind Then one physical event reaches only its original owner', async () => {
  const capability = await loadIngress();
  assert.ok(capability, 'TtmlAcquisitionIngress capability is missing');
  const window = createEventTarget();
  let firstCalls = 0;
  let secondCalls = 0;
  const first = new capability.TtmlAcquisitionIngress({
    captureTtmlEvidence(input) {
      firstCalls += 1;
      return { status: 'retained', cacheKey: input.cacheKey, language: input.language };
    }
  });
  const second = new capability.TtmlAcquisitionIngress({
    captureTtmlEvidence(input) {
      secondCalls += 1;
      return { status: 'retained', cacheKey: input.cacheKey, language: input.language };
    }
  });

  const dispose = capability.bindTtmlAcquisitionCapture(window, first);
  assert.equal(capability.bindTtmlAcquisitionCapture(window, first), dispose);
  assert.throws(() => capability.bindTtmlAcquisitionCapture(window, second), /already bound/);
  window.dispatchEvent({
    type: capability.TTML_ACQUISITION_CAPTURED_EVENT,
    detail: capability.toRealm({ protocolVersion: 1, evidence: evidence() })
  });

  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
  dispose();
  const replacementDispose = capability.bindTtmlAcquisitionCapture(window, second);
  replacementDispose();
});

test('Given independently evaluated ingress modules in one realm When different owners bind one window Then the realm lease permits one owner only', async () => {
  const context = vm.createContext({});
  const firstModule = await loadIngress(context);
  const secondModule = await loadIngress(context);
  const window = createEventTarget();
  let firstCalls = 0;
  let secondCalls = 0;
  const first = new firstModule.TtmlAcquisitionIngress({ captureTtmlEvidence: () => { firstCalls += 1; return { status: 'retained' }; } });
  const second = new secondModule.TtmlAcquisitionIngress({ captureTtmlEvidence: () => { secondCalls += 1; return { status: 'retained' }; } });

  const dispose = firstModule.bindTtmlAcquisitionCapture(window, first);
  assert.throws(() => secondModule.bindTtmlAcquisitionCapture(window, second), /already bound/);
  window.dispatchEvent({ type: firstModule.TTML_ACQUISITION_CAPTURED_EVENT, detail: firstModule.toRealm({ protocolVersion: 1, evidence: evidence() }) });
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
  dispose();
});

test('Given domain, stale, and parse outcomes from the SubtitleInterceptor owner When captured Then the ingress exposes stable Results without raw content', async () => {
  const capability = await loadIngress();
  assert.ok(capability, 'TtmlAcquisitionIngress capability is missing');
  const cases = [
    [{ status: 'retained', role: 'secondary' }, { ok: true, value: { status: 'retained', cacheKey: 'zh-Hant_episode-A_fixture-track', language: 'zh-Hant', role: 'secondary' } }],
    [{ status: 'domain-rejected', category: 'gate', reason: 'cache-key-video-mismatch' }, { ok: false, error: { kind: 'domain-rejected', code: 'ttml-gate-cache-key-video-mismatch', retryable: false } }],
    [{ status: 'stale-context', reason: 'playback-context-transitioning' }, { ok: false, error: { kind: 'stale-context', code: 'ttml-playback-context-transitioning', retryable: true } }],
    [{ status: 'domain-rejected', category: 'parse', reason: 'empty' }, { ok: false, error: { kind: 'domain-rejected', code: 'ttml-parse-empty', retryable: false } }]
  ];

  for (const [outcome, expected] of cases) {
    const ingress = new capability.TtmlAcquisitionIngress({ captureTtmlEvidence: () => outcome });
    const result = ingress.capture(capability.toRealm(evidence()));
    assert.deepEqual(plain(result), expected);
    assert.equal(JSON.stringify(result).includes('<tt>'), false);
  }
});

test('Given an owned reader returns a bounded raw pool When the ingress reads it Then complete evidence remains available without applying an active-video gate', async () => {
  const capability = await loadIngress();
  const first = evidence({
    requestInfo: { requestId: 'current-video', sessionIdAtRequest: 'watch-current' },
    timestamp: 1700000000000
  });
  const prefetched = evidence({
    cacheKey: 'zh-Hant_other-video_fixture-track',
    rawContent: '<tt><body><p begin="0s">other-video-body</p></body></tt>',
    requestInfo: { requestId: 'other-video', sessionIdAtRequest: 'watch-prefetched' },
    rawMetadata: { bodyHash: 'other-video-hash' },
    metadata: { preserved: true },
    timestamp: 1700000000001
  });
  let ownerCalls = 0;
  const reader = {
    async readRawPool() {
      return {
        ok: true,
        value: {
          entries: {
            [first.cacheKey]: rawEntry(first),
            [prefetched.cacheKey]: rawEntry(prefetched)
          }
        }
      };
    },
    async readDiagnosticSummary() { return { ok: true, value: { recentNonTtmlCandidateCount: 2 } }; }
  };
  const ingress = new capability.TtmlAcquisitionIngress({
    captureTtmlEvidence() { ownerCalls += 1; return { status: 'retained' }; }
  }, reader);

  const result = await ingress.readRawPool();

  assert.deepEqual(plain(result), {
    ok: true,
    value: {
      entries: {
        [first.cacheKey]: rawEntry(first),
        [prefetched.cacheKey]: rawEntry(prefetched)
      }
    }
  });
  assert.equal(result.value.entries[prefetched.cacheKey].rawContent.includes('other-video-body'), true);
  assert.equal(ownerCalls, 0);
});

test('Given hostile or oversized reader results When the ingress reads the raw pool Then it rejects before touching the owner or a getter', async () => {
  const capability = await loadIngress();
  let ownerCalls = 0;
  let getterReads = 0;
  const poisoned = {};
  Object.defineProperty(poisoned, 'ok', { enumerable: true, get() { getterReads += 1; throw new Error('getter'); } });
  const cyclic = { ok: true, value: { entries: {} } };
  cyclic.value.entries.loop = cyclic;
  const symbolResult = { ok: true, value: { entries: {} }, [Symbol('private')]: true };
  const customPrototype = Object.assign(Object.create({ inherited: true }), { ok: true, value: { entries: {} } });
  const opaqueProxy = new Proxy({ ok: true, value: { entries: {} } }, { getPrototypeOf() { throw new Error('proxy'); } });
  const revoked = Proxy.revocable({ ok: true, value: { entries: {} } }, {});
  revoked.revoke();
  const entries = {};
  for (let index = 0; index < 51; index += 1) entries[`en_video_${index}`] = rawEntry(evidence({ cacheKey: `en_video_${index}` }));
  const cases = [
    poisoned,
    cyclic,
    symbolResult,
    customPrototype,
    opaqueProxy,
    revoked.proxy,
    { ok: true, value: { entries } },
    { ok: true, value: { entries: { valid: rawEntry(evidence({ cacheKey: 'valid' })) }, debugSnapshot: {} } }
  ];

  for (const result of cases) {
    const ingress = new capability.TtmlAcquisitionIngress({
      captureTtmlEvidence() { ownerCalls += 1; return { status: 'retained' }; }
    }, {
      async readRawPool() { return result; },
      async readDiagnosticSummary() { return result; }
    });
    assert.deepEqual(plain(await ingress.readRawPool()), {
      ok: false,
      error: { kind: 'domain-rejected', code: 'ttml-raw-pool-invalid', retryable: false }
    });
  }

  assert.equal(getterReads, 0);
  assert.equal(ownerCalls, 0);
});

function rawEntry(item) {
  return {
    rawContent: item.rawContent,
    requestInfo: item.requestInfo,
    rawMetadata: item.rawMetadata,
    metadata: item.metadata,
    language: item.language,
    timestamp: item.timestamp ?? 1700000000000
  };
}

test('Given a diagnostic reader response When the ingress exposes it Then only a finite nonnegative candidate count is returned', async () => {
  const capability = await loadIngress();
  const reader = {
    async readRawPool() { return { ok: true, value: { entries: {} } }; },
    async readDiagnosticSummary() { return { ok: true, value: { recentNonTtmlCandidateCount: 7 } }; }
  };
  const ingress = new capability.TtmlAcquisitionIngress({ captureTtmlEvidence: () => ({ status: 'retained' }) }, reader);
  assert.deepEqual(plain(await ingress.readDiagnosticSummary()), {
    ok: true,
    value: { recentNonTtmlCandidateCount: 7 }
  });

  for (const value of [
    { recentNonTtmlCandidateCount: -1 },
    { recentNonTtmlCandidateCount: 1.5 },
    { recentNonTtmlCandidateCount: 1, rawContent: '<tt>secret</tt>' },
    { recentNonTtmlCandidateCount: 1, debug: true }
  ]) {
    reader.readDiagnosticSummary = async () => ({ ok: true, value });
    assert.deepEqual(plain(await ingress.readDiagnosticSummary()), {
      ok: false,
      error: { kind: 'domain-rejected', code: 'ttml-diagnostic-summary-invalid', retryable: false }
    });
  }
});

test('Given an injected reader has an in-flight raw query When ingress disposal runs Then the query disconnects once without disposing the external reader', async () => {
  const capability = await loadIngress();
  const deferred = createDeferred();
  let disposeCalls = 0;
  const reader = {
    readRawPool() { return deferred.promise; },
    async readDiagnosticSummary() { return { ok: true, value: { recentNonTtmlCandidateCount: 0 } }; },
    dispose() { disposeCalls += 1; }
  };
  const ingress = new capability.TtmlAcquisitionIngress({ captureTtmlEvidence: () => ({ status: 'retained' }) }, reader);
  const pending = ingress.readRawPool();

  ingress.dispose();
  deferred.resolve({ ok: true, value: { entries: {} } });

  assert.deepEqual(plain(await pending), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-raw-pool-disconnected', retryable: true }
  });
  assert.equal(disposeCalls, 0);
  assert.deepEqual(plain(await ingress.readDiagnosticSummary()), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-diagnostic-summary-disconnected', retryable: true }
  });
  ingress.dispose();
  assert.equal(disposeCalls, 0);
});

test('Given a lazily owned real reader has an in-flight raw query When ingress disposal runs Then transport listeners clear and the old ingress stays disconnected', async () => {
  const events = createEventTarget();
  const window = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage() {}
  };
  const context = vm.createContext({ window, Promise, setTimeout, clearTimeout });
  const capability = await loadIngress(context);
  const ingress = new capability.TtmlAcquisitionIngress({ captureTtmlEvidence: () => ({ status: 'retained' }) });
  const pending = ingress.readRawPool();

  assert.equal(events.listenerCount('message'), 1);
  ingress.dispose();

  assert.deepEqual(plain(await pending), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-raw-pool-disconnected', retryable: true }
  });
  assert.equal(events.listenerCount('message'), 0);
  assert.deepEqual(plain(await ingress.readRawPool()), {
    ok: false,
    error: { kind: 'disconnected', code: 'ttml-raw-pool-disconnected', retryable: true }
  });
});
