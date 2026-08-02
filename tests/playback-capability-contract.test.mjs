import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function context(epoch = 4) {
  return { state: 'ready', videoId: '81234567', sessionId: 'watch-session-a', epoch };
}

function expected(epoch = 4) {
  return { videoId: '81234567', sessionId: 'watch-session-a', epoch };
}

function intent(variant, payload, contextValue = expected()) {
  if (variant === 'context-snapshot') return { variant, payload: {} };
  return { variant, payload, expected: contextValue };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.now = 0;
    this.tasks = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delay, at: this.now + delay });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  delays() {
    return [...this.tasks.values()].map(task => task.delay);
  }

  advanceBy(duration) {
    const target = this.now + duration;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

async function loadPlayback() {
  const [resultSource, diagnosticsSource, transportsSource, playbackSource] = await Promise.all([
    readFile(new URL('../content/system/capabilities/result.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/private-transport-diagnostics.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/private-transports.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/playback.js', import.meta.url), 'utf8')
  ]);
  const moduleContext = vm.createContext({
    AbortController,
    Promise,
    structuredClone,
    clearTimeout,
    setTimeout
  });
  const result = new vm.SourceTextModule(resultSource, {
    context: moduleContext,
    identifier: 'content/system/capabilities/result.js'
  });
  const playback = new vm.SourceTextModule(playbackSource, {
    context: moduleContext,
    identifier: 'content/system/capabilities/playback.js'
  });
  const diagnostics = new vm.SourceTextModule(diagnosticsSource, {
    context: moduleContext,
    identifier: 'content/system/capabilities/private-transport-diagnostics.js'
  });
  const transports = new vm.SourceTextModule(transportsSource, {
    context: moduleContext,
    identifier: 'content/system/capabilities/private-transports.js'
  });
  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await diagnostics.link(() => { throw new Error('private-transport-diagnostics.js has no dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected transport dependency: ${specifier}`);
  });
  await playback.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transports.js') return transports;
    throw new Error(`Unexpected playback dependency: ${specifier}`);
  });
  await result.evaluate();
  await diagnostics.evaluate();
  await transports.evaluate();
  await playback.evaluate();
  return playback.namespace;
}

function track() {
  return { code: 'en', name: 'English', trackId: 'track-en', trackType: 'PRIMARY', rawTrackType: null };
}

function snapshot() {
  return {
    pageUrlVideoId: '81234567',
    playerApiVideoId: '81234567',
    movieId: '81234567',
    selectedSessionId: 'watch-session-a',
    selectedSessionReason: 'watch-player-api-video-id-match',
    sessionSelectionConfidence: 'high',
    currentTime: 12.5,
    duration: 180,
    currentTrack: track()
  };
}

function responseFor(variant) {
  switch (variant) {
    case 'context-snapshot': return { playback: snapshot() };
    case 'available-languages': return { languages: [track()] };
    case 'current-language': return { language: track() };
    case 'switch-language':
    case 'switch-track': return { language: track() };
    case 'jump-to-timecode': return { status: 'partial' };
    default: throw new Error(`Unexpected variant ${variant}`);
  }
}

function outcomeFor(variant) {
  return { variant, ...responseFor(variant) };
}

function createAdapter(result) {
  const calls = [];
  let disposed = 0;
  return {
    calls,
    get disposed() { return disposed; },
    request(command, options) {
      calls.push({ command, options });
      return typeof result === 'function' ? result(command, options) : result;
    },
    dispose() {
      disposed += 1;
    }
  };
}

test('Given the typed Playback module When it is loaded Then its only public factories are available', async () => {
  const playback = await loadPlayback();

  assert.equal(typeof playback.parsePlaybackIntent, 'function');
  assert.equal(typeof playback.createPlayback, 'function');
  assert.equal(typeof playback.createPagePlayback, 'function');
});

test('Given the six allowlisted playback variants When parsed Then each has exactly its typed payload and context contract', async () => {
  const { parsePlaybackIntent } = await loadPlayback();
  const variants = [
    intent('context-snapshot'),
    intent('available-languages', {}),
    intent('current-language', {}),
    intent('switch-language', { languageCode: 'zh-Hant' }),
    intent('switch-track', { trackId: 12 }),
    intent('jump-to-timecode', {
      targetTimestamp: 27.5,
      controlId: 'control-a',
      requestId: 'request-a',
      issuedAt: 1234
    })
  ];

  for (const value of variants) {
    const parsed = parsePlaybackIntent(value);
    assert.deepEqual(plain(parsed), { ok: true, value });
  }
});

test('Given malformed, hostile, or non-own playback data When parsed or performed Then it is rejected without getters or adapter dispatch', async () => {
  const { createPlayback, parsePlaybackIntent } = await loadPlayback();
  let getterReads = 0;
  const accessor = intent('available-languages', {});
  Object.defineProperty(accessor, 'variant', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'available-languages';
    }
  });
  const inherited = Object.assign(Object.create({ variant: 'available-languages' }), { payload: {}, expected: expected() });
  const symbol = intent('available-languages', {});
  symbol[Symbol('private')] = true;
  const nonEnumerable = intent('available-languages', {});
  Object.defineProperty(nonEnumerable, 'unexpected', { value: true });
  const customPrototype = Object.assign(Object.create({}), intent('available-languages', {}));
  const benignProxy = new Proxy(intent('available-languages', {}), {});
  const revokedTarget = Proxy.revocable(intent('available-languages', {}), {});
  revokedTarget.revoke();
  const trapped = new Proxy(intent('available-languages', {}), {
    ownKeys() { throw new Error('ownKeys must stay private'); }
  });
  const invalid = [
    null,
    [],
    () => {},
    { variant: 'available-languages', expected: expected() },
    { variant: 'available-languages', payload: {} },
    { variant: 'unknown', payload: {}, expected: expected() },
    { variant: 'context-snapshot', payload: {}, expected: expected() },
    { variant: 'available-languages', payload: {}, expected: { ...expected(), extra: true } },
    { variant: 'switch-language', payload: { languageCode: '' }, expected: expected() },
    { variant: 'switch-language', payload: { languageCode: 'en', extra: true }, expected: expected() },
    { variant: 'switch-track', payload: { trackId: -1 }, expected: expected() },
    { variant: 'switch-track', payload: { trackId: 1.5 }, expected: expected() },
    { variant: 'jump-to-timecode', payload: { targetTimestamp: -1, controlId: 'a', requestId: 'b', issuedAt: 1 }, expected: expected() },
    inherited,
    accessor,
    symbol,
    nonEnumerable,
    customPrototype,
    benignProxy,
    revokedTarget.proxy,
    trapped
  ];

  for (const value of invalid) {
    assert.deepEqual(plain(parsePlaybackIntent(value)), {
      ok: false,
      error: { kind: 'invalid', code: 'playback-intent', retryable: false }
    });
  }
  assert.equal(getterReads, 0);

  const adapter = createAdapter({ ok: true, value: responseFor('available-languages') });
  const playback = createPlayback({ getCurrentContext: () => context(), adapter });
  assert.deepEqual(plain(await playback.perform(accessor)), {
    ok: false,
    error: { kind: 'invalid', code: 'playback-intent', retryable: false }
  });
  assert.equal(adapter.calls.length, 0);

  let nestedPayloadReads = 0;
  let nestedExpectedReads = 0;
  const nestedPayload = {};
  Object.defineProperty(nestedPayload, 'languageCode', {
    enumerable: true,
    get() {
      nestedPayloadReads += 1;
      return 'en';
    }
  });
  const nestedExpected = { sessionId: 'watch-session-a', epoch: 4 };
  Object.defineProperty(nestedExpected, 'videoId', {
    enumerable: true,
    get() {
      nestedExpectedReads += 1;
      return '81234567';
    }
  });
  const nestedAccessor = { variant: 'switch-language', payload: nestedPayload, expected: nestedExpected };
  assert.deepEqual(plain(parsePlaybackIntent(nestedAccessor)), {
    ok: false,
    error: { kind: 'invalid', code: 'playback-intent', retryable: false }
  });
  assert.equal(nestedPayloadReads, 0);
  assert.equal(nestedExpectedReads, 0);
  assert.deepEqual(plain(await playback.perform(nestedAccessor)), {
    ok: false,
    error: { kind: 'invalid', code: 'playback-intent', retryable: false }
  });
  assert.equal(adapter.calls.length, 0);
  assert.equal(nestedPayloadReads, 0);
  assert.equal(nestedExpectedReads, 0);
});

test('Given a cross-realm ordinary record or a direct null-prototype record When parsed Then strict data parsing accepts them', async () => {
  const { parsePlaybackIntent } = await loadPlayback();
  const crossRealm = vm.runInNewContext(`({
    variant: 'switch-language',
    payload: { languageCode: 'en' },
    expected: { videoId: '81234567', sessionId: 'watch-session-a', epoch: 4 }
  })`);
  const nullPrototype = Object.assign(Object.create(null), {
    variant: 'switch-track',
    payload: Object.assign(Object.create(null), { trackId: 'track-a' }),
    expected: Object.assign(Object.create(null), expected())
  });

  assert.equal(parsePlaybackIntent(crossRealm).ok, true);
  assert.equal(parsePlaybackIntent(nullPrototype).ok, true);
});

test('Given a context snapshot When Playback performs it Then it bootstraps without context reads and sends one fixed-deadline typed request', async () => {
  const { createPlayback } = await loadPlayback();
  const clock = new FakeClock();
  let contextReads = 0;
  const adapter = createAdapter({ ok: true, value: responseFor('context-snapshot') });
  const playback = createPlayback({
    getCurrentContext() {
      contextReads += 1;
      return context();
    },
    adapter,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  const result = await playback.perform(intent('context-snapshot'), { deadlineMs: 1 });

  assert.deepEqual(plain(result), { ok: true, value: outcomeFor('context-snapshot') });
  assert.equal(contextReads, 0);
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(plain(adapter.calls[0].command), intent('context-snapshot'));
  assert.deepEqual(Object.keys(adapter.calls[0].options).sort(), ['deadlineMs', 'signal']);
  assert.equal(adapter.calls[0].options.deadlineMs, 3000);
  assert.equal(clock.delays().length, 0);
});

test('Given each context-bound playback variant When it succeeds Then it checks exact ready context before and after one request with its fixed deadline', async () => {
  const { createPlayback } = await loadPlayback();
  const cases = [
    ['available-languages', {}, 3000],
    ['current-language', {}, 3000],
    ['switch-language', { languageCode: 'en' }, 10000],
    ['switch-track', { trackId: 'track-a' }, 10000],
    ['jump-to-timecode', { targetTimestamp: 15, controlId: 'control-a', requestId: 'request-a', issuedAt: 99 }, 3000]
  ];

  for (const [variant, payload, deadlineMs] of cases) {
    const clock = new FakeClock();
    let contextReads = 0;
    const adapter = createAdapter({ ok: true, value: responseFor(variant) });
    const playback = createPlayback({
      getCurrentContext() {
        contextReads += 1;
        return context();
      },
      adapter,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    const value = intent(variant, payload);

    assert.deepEqual(plain(await playback.perform(value, { deadlineMs: 1 })), { ok: true, value: outcomeFor(variant) });
    assert.equal(contextReads, 2, variant);
    assert.equal(adapter.calls.length, 1, variant);
    assert.deepEqual(plain(adapter.calls[0].command), value, variant);
    assert.equal(adapter.calls[0].options.deadlineMs, deadlineMs, variant);
    assert.deepEqual(clock.delays(), [], variant);
  }
});

test('Given a context-bound request with stale preflight or postflight context When Playback performs it Then it rejects stale without replaying', async () => {
  const { createPlayback } = await loadPlayback();
  const request = intent('available-languages', {});
  const stale = { ok: false, error: { kind: 'stale-context', code: 'playback-stale-context', retryable: false } };

  const preflightAdapter = createAdapter({ ok: true, value: responseFor('available-languages') });
  const preflight = createPlayback({
    getCurrentContext: () => ({ ...context(), epoch: 5 }),
    adapter: preflightAdapter
  });
  assert.deepEqual(plain(await preflight.perform(request)), stale);
  assert.equal(preflightAdapter.calls.length, 0);

  let reads = 0;
  const postflightAdapter = createAdapter({ ok: true, value: responseFor('available-languages') });
  const postflight = createPlayback({
    getCurrentContext: () => {
      reads += 1;
      return reads === 1 ? context() : { ...context(), epoch: 5 };
    },
    adapter: postflightAdapter
  });
  assert.deepEqual(plain(await postflight.perform(request)), stale);
  assert.equal(postflightAdapter.calls.length, 1);
  assert.equal(reads, 2);
});

test('Given a timeout, cancellation, or disconnect When Playback settles Then it normalizes once, aborts pending work, and never replays', async () => {
  const { createPlayback } = await loadPlayback();
  const request = intent('available-languages', {});

  const timeoutClock = new FakeClock();
  const timeoutPending = deferred();
  let timeoutSignal;
  let timeoutContextReads = 0;
  const timeoutAdapter = createAdapter((_command, options) => {
    timeoutSignal = options.signal;
    return timeoutPending.promise;
  });
  const timeoutPlayback = createPlayback({
    getCurrentContext: () => {
      timeoutContextReads += 1;
      return context();
    },
    adapter: timeoutAdapter,
    setTimeout: timeoutClock.setTimeout,
    clearTimeout: timeoutClock.clearTimeout
  });
  const timeoutResult = timeoutPlayback.perform(request);
  assert.deepEqual(timeoutClock.delays(), [3000]);
  timeoutClock.advanceBy(3000);
  assert.deepEqual(plain(await timeoutResult), {
    ok: false,
    error: { kind: 'timeout', code: 'playback-timeout', retryable: true }
  });
  assert.equal(timeoutSignal.aborted, true);
  timeoutPending.resolve({ ok: true, value: responseFor('available-languages') });
  await Promise.resolve();
  assert.equal(timeoutAdapter.calls.length, 1);
  assert.equal(timeoutContextReads, 1);

  const cancelPending = deferred();
  const cancelController = new AbortController();
  let cancelContextReads = 0;
  const cancelAdapter = createAdapter(() => cancelPending.promise);
  const cancelPlayback = createPlayback({
    getCurrentContext: () => {
      cancelContextReads += 1;
      return context();
    },
    adapter: cancelAdapter
  });
  const cancelResult = cancelPlayback.perform(request, cancelController.signal);
  cancelController.abort();
  assert.deepEqual(plain(await cancelResult), {
    ok: false,
    error: { kind: 'cancelled', code: 'playback-cancelled', retryable: false }
  });
  cancelPending.reject(new Error('late page rejection'));
  await Promise.resolve();
  assert.equal(cancelAdapter.calls.length, 1);
  assert.equal(cancelContextReads, 1);

  const disconnectAdapter = createAdapter({ ok: false, error: { kind: 'disconnected', code: 'transport-lost', retryable: true } });
  const disconnectPlayback = createPlayback({ getCurrentContext: () => context(), adapter: disconnectAdapter });
  assert.deepEqual(plain(await disconnectPlayback.perform(request)), {
    ok: false,
    error: { kind: 'disconnected', code: 'page-adapter-disconnected', retryable: true }
  });
});

test('Given a page rejection or malformed page response When Playback performs it Then it exposes only validated normalized outcomes', async () => {
  const { createPlayback } = await loadPlayback();
  const request = intent('jump-to-timecode', {
    targetTimestamp: 10,
    controlId: 'control-a',
    requestId: 'request-a',
    issuedAt: 4
  });
  const rejectedAdapter = createAdapter({
    ok: false,
    error: { kind: 'domain-rejected', code: 'trusted-click-required', retryable: false }
  });
  const rejectedPlayback = createPlayback({ getCurrentContext: () => context(), adapter: rejectedAdapter });
  assert.deepEqual(plain(await rejectedPlayback.perform(request)), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'trusted-click-required', retryable: false }
  });

  const forbiddenAdapter = createAdapter({
    ok: false,
    error: { kind: 'forbidden', code: 'trusted-click-required', retryable: false }
  });
  const forbiddenPlayback = createPlayback({ getCurrentContext: () => context(), adapter: forbiddenAdapter });
  assert.deepEqual(plain(await forbiddenPlayback.perform(request)), {
    ok: false,
    error: { kind: 'forbidden', code: 'trusted-click-required', retryable: false }
  });

  for (const response of [
    { ok: true, value: { status: 'unknown' } },
    { ok: false, error: { kind: 'domain-rejected', code: '', retryable: false } },
    { ok: false, error: { kind: 'forbidden', code: 'other-page-reason', retryable: false } },
    { ok: false, error: { kind: 'forbidden', code: 'trusted-click-required', retryable: true } },
    { ok: false, error: { kind: 'timeout', code: 'page-timeout', retryable: false } },
    { arbitrary: true }
  ]) {
    const adapter = createAdapter(response);
    const playback = createPlayback({ getCurrentContext: () => context(), adapter });
    assert.deepEqual(plain(await playback.perform(request)), {
      ok: false,
      error: { kind: 'domain-rejected', code: 'invalid-page-response', retryable: false }
    });
  }
});

test('Given page responses with extra secrets or debug data When Playback projects every variant Then none can survive the fixed outcome contract', async () => {
  const { createPlayback } = await loadPlayback();
  const cases = [
    ['context-snapshot', {}],
    ['available-languages', {}],
    ['current-language', {}],
    ['switch-language', { languageCode: 'en' }],
    ['switch-track', { trackId: 'track-en' }],
    ['jump-to-timecode', { targetTimestamp: 10, controlId: 'control-a', requestId: 'request-a', issuedAt: 4 }]
  ];

  for (const [variant, payload] of cases) {
    const adapter = createAdapter({ ok: true, value: { ...responseFor(variant), pageSecret: 'must-not-escape' } });
    const playback = createPlayback({ getCurrentContext: () => context(), adapter });
    assert.deepEqual(plain(await playback.perform(intent(variant, payload))), {
      ok: false,
      error: { kind: 'domain-rejected', code: 'invalid-page-response', retryable: false }
    }, variant);
  }
});

test('Given a partial jump success When Playback validates the page outcome Then it remains a successful terminal result', async () => {
  const { createPlayback } = await loadPlayback();
  const adapter = createAdapter({ ok: true, value: responseFor('jump-to-timecode') });
  const playback = createPlayback({ getCurrentContext: () => context(), adapter });

  assert.deepEqual(plain(await playback.perform(intent('jump-to-timecode', {
    targetTimestamp: 10,
    controlId: 'control-a',
    requestId: 'request-a',
    issuedAt: 4
  }))), { ok: true, value: { variant: 'jump-to-timecode', status: 'partial' } });
  assert.equal(adapter.calls.length, 1);
});

test('Given shared page adapter work When one Playback capability is disposed Then only its own pending and future operations terminalize', async () => {
  const { createPlayback } = await loadPlayback();
  const firstPending = deferred();
  const secondPending = deferred();
  const signals = [];
  const adapter = createAdapter((_command, options) => {
    signals.push(options.signal);
    return signals.length === 1 ? firstPending.promise : secondPending.promise;
  });
  let firstContextReads = 0;
  const first = createPlayback({
    getCurrentContext: () => {
      firstContextReads += 1;
      return context();
    },
    adapter
  });
  const second = createPlayback({ getCurrentContext: () => context(), adapter });
  assert.deepEqual(Object.keys(first).sort(), ['dispose', 'perform']);
  assert.equal(Object.isFrozen(first), true);

  const firstInFlight = first.perform(intent('available-languages', {}));
  const secondInFlight = second.perform(intent('current-language', {}));
  first.dispose();
  first.dispose();
  assert.deepEqual(plain(await firstInFlight), {
    ok: false,
    error: { kind: 'disconnected', code: 'page-adapter-disconnected', retryable: true }
  });
  assert.equal(adapter.disposed, 0);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  firstPending.resolve({ ok: true, value: responseFor('available-languages') });
  await Promise.resolve();
  assert.equal(firstContextReads, 1);

  secondPending.resolve({ ok: true, value: responseFor('current-language') });
  assert.deepEqual(plain(await secondInFlight), { ok: true, value: outcomeFor('current-language') });
  assert.deepEqual(plain(await first.perform(intent('available-languages', {}))), {
    ok: false,
    error: { kind: 'disconnected', code: 'page-adapter-disconnected', retryable: true }
  });
  assert.equal(adapter.calls.length, 2);
});

test('Given PagePlayback When it composes an owned private adapter Then it sends canonical Playback requests and stops that adapter exactly once', async () => {
  const { createPagePlayback } = await loadPlayback();
  const calls = [];
  let stops = 0;
  const ownedTransport = {
    request(command, options) {
      calls.push({ command, options });
      return { ok: true, value: responseFor('context-snapshot') };
    },
    stop() { stops += 1; }
  };
  const playback = createPagePlayback({
    getCurrentContext: () => context(),
    window: { location: { origin: 'https://www.netflix.com' } },
    createRequestId: () => 'page-playback-1',
    createTransport: () => ownedTransport
  });

  assert.deepEqual(Object.keys(playback).sort(), ['dispose', 'perform']);
  assert.deepEqual(plain(await playback.perform(intent('context-snapshot'))), {
    ok: true, value: outcomeFor('context-snapshot')
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].command), {
    protocolVersion: 1,
    requestId: 'page-playback-1',
    kind: 'playback',
    payload: { variant: 'context-snapshot', payload: {} }
  });
  playback.dispose();
  playback.dispose();
  assert.equal(stops, 1);
  assert.deepEqual(plain(await playback.perform(intent('context-snapshot'))), {
    ok: false,
    error: { kind: 'disconnected', code: 'page-adapter-disconnected', retryable: true }
  });
});
