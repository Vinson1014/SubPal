import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as secondarySelection from '../shared/secondary-track-selection.js';

const interceptorSource = await readFile(new URL('../content/subtitle-modes/subtitle-interceptor.js', import.meta.url), 'utf8');

function createPlaybackContext(videoId, epoch) {
  return {
    epoch,
    videoId,
    sessionId: `watch-${videoId}`,
    currentTrack: null,
    state: 'ready',
    startedAt: 1,
    updatedAt: 1,
    source: 'fixture',
    snapshot: null,
    selectedSessionReason: 'fixture-watch-session',
    sessionSelectionConfidence: 'high'
  };
}

function createRequestInfo(videoId, language, requestTime = Date.now()) {
  return {
    requestTime,
    sessionIdAtRequest: `watch-${videoId}`,
    sessionSelectionConfidenceAtRequest: 'high',
    currentTrackAtRequest: { code: language, trackId: language === 'en' ? 'en-track' : 'zh-track' },
    derivedSubtitleVideo: {
      videoId,
      confidence: 'high',
      reason: 'fixture-request-evidence'
    }
  };
}

async function createSyntheticModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Unexpected synthetic dependency'); });
  await module.evaluate();
  return module;
}

async function createTTMLHarness({ prepareSecondary = true, domSample = null, domMatchResult = null, realContextPoll = false } = {}) {
  let context = createPlaybackContext('episode-A', 1);
  const rawCache = new Map();
  const rendered = [];
  const genericPageRpcCalls = [];
  const playbackCalls = [];
  const matcherOptions = [];
  const matcherLanguages = [];
  const ingressInstances = [];
  const internalEvents = [];
  const internalHandlers = new Map();
  const pendingInternalEvents = [];
  const intervals = [];
  const eventListeners = new Map();
  const track = {
    code: 'en',
    name: 'English',
    trackId: 'en-track',
    trackType: 'PRIMARY',
    rawTrackType: 'SUBTITLES',
    isNoneTrack: false,
    isForcedNarrative: false
  };
  const playbackResults = new Map();
  const defaultPlaybackResult = (input) => {
    switch (input.variant) {
      case 'context-snapshot':
        return { ok: true, value: { variant: input.variant, playback: {
          pageUrlVideoId: context.videoId, playerApiVideoId: context.videoId, movieId: context.videoId,
          selectedSessionId: context.sessionId, selectedSessionReason: 'watch-player-api-video-id-match',
          sessionSelectionConfidence: 'high', currentTime: 1, duration: 600, currentTrack: context.currentTrack,
          trackListRevision: context.trackListRevision ?? null
        } } };
      case 'available-languages':
        return { ok: true, value: { variant: input.variant, languages: [track, { ...track, code: 'zh-Hant', trackId: 'zh-track' }] } };
      case 'current-language':
      case 'switch-language':
      case 'switch-track':
        return { ok: true, value: { variant: input.variant, language: track } };
      default:
        throw new Error(`Unexpected Playback variant: ${input.variant}`);
    }
  };
  const window = {
    addEventListener(type, listener) {
      const listeners = eventListeners.get(type) ?? new Set();
      listeners.add(listener);
      eventListeners.set(type, listeners);
    },
    removeEventListener(type, listener) { eventListeners.get(type)?.delete(listener); },
    listenerCount(type) { return eventListeners.get(type)?.size ?? 0; }
  };
  const sandbox = vm.createContext({
    Date,
    Promise,
    console: { log() {}, warn() {}, error() {} },
    window,
    document: { getElementById() { return null; }, querySelector() { return null; } },
    setTimeout,
    clearTimeout,
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
    clearInterval() {},
    AbortController
  });
  const parser = await createSyntheticModule(sandbox, 'subtitle-parser.js', {
    parseSubtitle(rawContent) {
      return {
        subtitles: [{ startTime: 0, endTime: 60, text: rawContent }],
        regionConfigs: {}
      };
    },
    findSubtitleByTime(subtitles, currentTime) {
      return subtitles.find(subtitle => subtitle.startTime <= currentTime && currentTime <= subtitle.endTime) || null;
    },
    buildTimeIndex(subtitles) { return subtitles; },
    findSubtitleByTimeIndex(index, currentTime) {
      return index.find(subtitle => subtitle.startTime <= currentTime && currentTime <= subtitle.endTime) || null;
    }
  });
  const messaging = await createSyntheticModule(sandbox, 'messaging.js', {
    sendMessage: async () => ({}),
    registerInternalEventHandler(type, handler) {
      internalHandlers.set(type, handler);
      return () => internalHandlers.delete(type);
    },
    dispatchInternalEvent(event) {
      internalEvents.push(event);
      const result = internalHandlers.get(event.type)?.(event);
      if (result) pendingInternalEvents.push(Promise.resolve(result));
    }
  });
  const videoInfo = await createSyntheticModule(sandbox, 'video-info.js', {
    getCurrentTimestamp: () => 1,
    getVideoId: () => context.videoId
  });
  const fakePlayback = {
    perform(input) {
      playbackCalls.push(JSON.parse(JSON.stringify(input)));
      const result = playbackResults.get(input.variant);
      return Promise.resolve(typeof result === 'function' ? result(input) : result || defaultPlaybackResult(input));
    }
  };
  let manager;
  if (realContextPoll) {
    const source = await readFile(new URL('../content/core/playback-context-manager.js', import.meta.url), 'utf8');
    const managerModule = new vm.SourceTextModule(source, { context: sandbox });
    const capability = await createSyntheticModule(sandbox, 'playback.js', { createPagePlayback() { throw new Error('Use injected playback'); } });
    await managerModule.link(specifier => specifier === '../system/messaging.js' ? messaging : capability);
    await managerModule.evaluate();
    manager = new managerModule.namespace.PlaybackContextManager({ playback: fakePlayback });
    await manager.initialize();
    playbackCalls.length = 0;
  }
  const playback = await createSyntheticModule(sandbox, 'playback-context-manager.js', {
    playbackContextManager: manager || {
      getCurrentContext: () => ({ ...context }),
      getPlayback: () => fakePlayback
    }
  });
  const playerAdapter = await createSyntheticModule(sandbox, 'netflix-player-adapter.js', {
    getPlayerAdapter: () => ({ calculatePosition: () => null }),
    setRegionConfigs() {}
  });
  const overlapMatcher = await createSyntheticModule(sandbox, 'dom-overlap-matcher.js', {
    DOMOverlapMatcher: class DOMOverlapMatcher {
      constructor(options) {
        this.options = options;
        matcherOptions.push(options);
      }

      startWatching() { return true; }
      stopWatching() {}
      isWatching() { return false; }
      getDebugInfo() { return {}; }
      collectDOMSample() { return domSample; }
      async runMatchOnce(language) {
        matcherLanguages.push(language);
        if (domMatchResult) return domMatchResult;
        const rawPool = await this.options.readRawPool();
        return { matched: false, failureReason: rawPool.ok ? 'no-match' : 'raw-pool-unavailable', allResults: [] };
      }
    }
  });
  const ingress = await createSyntheticModule(sandbox, 'ttml-acquisition-ingress.js', {
    bindTtmlAcquisitionCapture(targetWindow, instance) {
      const listener = (event) => instance.acceptPhysicalCapture(event.detail);
      targetWindow.addEventListener('subpal-ttml-acquisition-captured', listener);
      return () => targetWindow.removeEventListener('subpal-ttml-acquisition-captured', listener);
    },
    TtmlAcquisitionIngress: class TtmlAcquisitionIngress {
      constructor(owner) {
        this.owner = owner;
        this.disposeCalls = 0;
        ingressInstances.push(this);
      }

      capture(evidence, options) {
        return this.owner.captureTtmlEvidence(evidence, options);
      }

      acceptPhysicalCapture(envelope) {
        return this.capture(envelope?.evidence || envelope, { resolveWaiters: true });
      }

      async readRawPool() {
        const entries = {};
        for (const [cacheKey, entry] of rawCache.entries()) {
          entries[cacheKey] = {
            rawContent: entry.rawContent,
            requestInfo: entry.requestInfo,
            rawMetadata: entry.rawMetadata || null,
            metadata: entry.metadata || null,
            language: entry.language,
            timestamp: entry.requestInfo?.requestTime || 1
          };
        }
        return { ok: true, value: { entries } };
      }

      async readDiagnosticSummary() {
        return { ok: true, value: { recentNonTtmlCandidateCount: 3 } };
      }

      dispose() {
        this.disposeCalls += 1;
      }
    }
  });
  const dependencies = new Map([
    ['../../shared/secondary-track-selection.js', await createSyntheticModule(sandbox, 'secondary-track-selection.js', secondarySelection)],
    ['../utils/subtitle-parser.js', parser],
    ['../system/messaging.js', messaging],
    ['../core/video-info.js', videoInfo],
    ['../core/playback-context-manager.js', playback],
    ['../ui/netflix-player-adapter.js', playerAdapter],
    ['./dom-overlap-matcher.js', overlapMatcher],
    ['../system/capabilities/ttml-acquisition-ingress.js', ingress]
  ]);
  const module = new vm.SourceTextModule(interceptorSource, {
    context: sandbox,
    identifier: 'content/subtitle-modes/subtitle-interceptor.js'
  });
  await module.link(specifier => {
    const dependency = dependencies.get(specifier);
    if (!dependency) throw new Error(`Unexpected import: ${specifier}`);
    return dependency;
  });
  await module.evaluate();

  const interceptor = new module.namespace.SubtitleInterceptor();
  interceptor.primaryLanguage = 'zh-Hant';
  interceptor.applyConfiguredSecondaryLanguage('en');
  interceptor.dualSubtitleEnabled = true;
  if (prepareSecondary) {
    await interceptor.prepareSecondaryTrack();
    playbackCalls.length = 0;
  }
  interceptor.onSubtitleDetected(output => {
    rendered.push({
      primaryText: output.dualSubtitle.primaryText,
      secondaryText: output.dualSubtitle.secondaryText,
      secondaryLanguage: output.dualSubtitle.secondaryLanguage
    });
  });

  return {
    internalEvents,
    async poll() {
      if (realContextPoll) {
        assert.equal(intervals.length, 1);
        assert.equal(intervals[0].delay, 3000);
        intervals[0].callback();
        await new Promise(resolve => setImmediate(resolve));
        while (pendingInternalEvents.length) await Promise.all(pendingInternalEvents.splice(0));
        return;
      }
      return internalHandlers.get('PLAYBACK_CONTEXT_POLLED')?.({ context: { ...context }, reason: 'poll' });
    },
    setTrackListRevision(revision) { context.trackListRevision = revision; },
    capture({ videoId, language, text, requestTime, trackId }) {
      const cacheKey = `${language}_${videoId}_fixture_${trackId || 'track'}`;
      const requestInfo = createRequestInfo(videoId, language, requestTime);
      if (trackId !== undefined) requestInfo.currentTrackAtRequest.trackId = trackId;
      const event = vm.runInContext(`(${JSON.stringify({
        cacheKey,
        rawContent: text,
        requestInfo,
        language
      })})`, sandbox);
      rawCache.set(cacheKey, event);
      interceptor.captureRawTTMLEvidence(event, { resolveWaiters: true });
      return cacheKey;
    },
    async readPageRawCacheKeys() {
      return [...rawCache.keys()];
    },
    async reloadCurrentContext() {
      await interceptor.checkExistingCache();
    },
    switchPlayback(videoId) {
      context = createPlaybackContext(videoId, context.epoch + 1);
      interceptor.cleanupOldVideoCache(videoId);
    },
    render() {
      interceptor.updateSubtitleDisplay();
      return rendered.at(-1) || null;
    },
    readiness() {
      return interceptor.getSubtitleReadinessSnapshot();
    },
    bindIngress() {
      interceptor.bindTtmlAcquisitionIngress();
    },
    stop() {
      interceptor.stop();
    },
    ingressListenerCount() {
      return window.listenerCount('subpal-ttml-acquisition-captured');
    },
    genericPageRpcCalls() {
      return genericPageRpcCalls;
    },
    playbackCalls() {
      return playbackCalls;
    },
    matcherOptions() {
      return matcherOptions;
    },
    matcherLanguages() {
      return matcherLanguages;
    },
    ingressInstances() {
      return ingressInstances;
    },
    setPlaybackResult(variant, result) {
      playbackResults.set(variant, result);
    },
    interceptor() {
      return interceptor;
    }
  };
}

function captureActiveEpisode(harness, videoId, label, requestTime) {
  const secondaryCacheKey = harness.capture({
    videoId,
    language: 'en',
    text: `${label} secondary`,
    requestTime
  });
  const primaryCacheKey = harness.capture({
    videoId,
    language: 'zh-Hant',
    text: `${label} primary`,
    requestTime
  });
  return { primaryCacheKey, secondaryCacheKey };
}

test('auto secondary resolves Japanese original language into the selected full track, cache and render without persisting inferred settings', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  const writes = [];
  interceptor.configBridge = { async setSubtitleLanguages(...languages) { writes.push(languages); } };
  await interceptor.setLanguages('zh-Hant', 'auto');
  const full = { code: 'ja', trackId: 'ja-full', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
    isNoneTrack: false, isForcedNarrative: false };
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language',
    originalLanguage: { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja'] } } });
  harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [
    { ...full, trackId: 'ja-forced', isForcedNarrative: true },
    { ...full, trackId: 'ja-none', isNoneTrack: true },
    { ...full, trackId: 'ja-cc', trackType: 'ASSISTIVE', rawTrackType: 'CLOSEDCAPTIONS' }, full
  ] } });
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: '主要字幕' });
  harness.capture({ videoId: 'episode-A', language: 'ja', text: '日本語 CC', trackId: 'ja-cc' });
  harness.capture({ videoId: 'episode-A', language: 'ja', text: '日本語', trackId: 'ja-full' });
  interceptor.dualSubtitleEnabled = true;
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('auto-japanese');
  assert.equal(result.success, true);
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'auto');
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'ja');
  assert.equal(interceptor.getStatus().selectedSecondaryTrack.trackId, 'ja-full');
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'ready');
  assert.deepEqual(harness.render(), { primaryText: '主要字幕', secondaryText: '日本語', secondaryLanguage: 'ja' });
  assert.equal(harness.readiness().secondary.ready, true);
  assert.deepEqual(writes, [['zh-Hant', 'auto']]);
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant === 'original-language'), [{
    variant: 'original-language', payload: {}, expected: { videoId: 'episode-A', sessionId: 'watch-episode-A', epoch: 1 }
  }]);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('auto original unknown, ambiguous and missing subtitles keep primary ready and publish distinct reasons without manual fallback', async () => {
  for (const resolution of [
    { status: 'unknown', reason: 'no-valid-native-audio-language' },
    { status: 'ambiguous', reason: 'multiple-native-audio-languages' },
    { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja'] }
  ]) {
    const harness = await createTTMLHarness({ prepareSecondary: false });
    const interceptor = harness.interceptor();
    interceptor.dualSubtitleEnabled = false;
    captureActiveEpisode(harness, 'episode-A', 'A');
    interceptor.applyConfiguredSecondaryLanguage('auto');
    interceptor.isActive = true;
    harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: resolution } });
    interceptor.dualSubtitleEnabled = true;
    const expectedReason = resolution.status === 'resolved' ? 'no-eligible-secondary-track' : resolution.reason;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await interceptor.ensureSecondaryLanguageAvailableOnce('auto-negative');
      assert.equal(result.reason, expectedReason);
      assert.equal(harness.readiness().primary.ready, true);
      assert.equal(harness.readiness().secondary.ready, false);
      assert.equal(harness.readiness().secondary.missingReason, expectedReason);
      assert.equal(harness.render().secondaryText, '');
      assert.equal(harness.render().primaryText, 'A primary');
      assert.equal(harness.readiness().canHideNativeSubtitles, true);
    }
    assert.equal(interceptor.getStatus().secondaryResolution.status, resolution.status === 'resolved' ? 'missing' : resolution.status);
    assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 1);
    assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
    assert.equal(interceptor.getStatus().selectedSecondaryTrack, null);
  }
});

test('auto English original acquires the structured selected track through interception and restores the original Netflix subtitle track', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language',
    originalLanguage: { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en'] } } });
  harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  harness.setPlaybackResult('switch-track', input => {
    if (input.payload.trackId === 'en-track') harness.capture({ videoId: 'episode-A', language: 'en', text: 'English original', trackId: 'en-track' });
    return { ok: true, value: { variant: input.variant, language: { code: input.payload.trackId === 'en-track' ? 'en' : 'zh-Hant', trackId: input.payload.trackId } } };
  });
  interceptor.dualSubtitleEnabled = true;
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('auto-english', { timeoutMs: 25 })).success, true);
  assert.deepEqual(harness.render(), { primaryText: 'primary', secondaryText: 'English original', secondaryLanguage: 'en' });
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).map(call => [call.variant, call.payload.trackId]),
    [['switch-track', 'en-track'], ['switch-track', 'zh-track']]);
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'ready');
});

test('auto acquisition failure publishes unavailable acquisition readiness without interrupting the primary slot', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary survives' });
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  harness.setPlaybackResult('switch-track', { ok: false, error: { code: 'switch-rejected' } });
  interceptor.dualSubtitleEnabled = true;
  interceptor.isActive = true;
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('failure', { timeoutMs: 1 });
  assert.equal(result.success, false);
  assert.equal(harness.readiness().secondary.configuredLanguage, 'auto');
  assert.equal(harness.readiness().secondary.resolution.status, 'unavailable');
  assert.equal(harness.readiness().secondary.resolution.failureKind, 'acquisition-failed');
  assert.equal(harness.readiness().secondary.resolution.reason, 'switch-track-timeout');
  assert.equal(harness.readiness().primary.ready, true);
  assert.equal(harness.render().primaryText, 'primary survives');
  assert.equal(harness.render().secondaryText, '');
  assert.equal(harness.readiness().canHideNativeSubtitles, true);
});

test('unchanged context polling retries late original-language information, then negative-caches after three attempts without repeated readiness', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false, realContextPoll: true });
  const interceptor = harness.interceptor();
  interceptor.setupEventHandlers();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.isActive = true;
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'unknown', reason: 'no-valid-native-audio-language'
  } } });
  interceptor.dualSubtitleEnabled = true;
  await interceptor.ensureSecondaryLanguageAvailableOnce('initial');
  for (let count = 0; count < 7; count += 1) {
    await harness.poll();
    await interceptor.ensureSecondaryLanguageAvailableOnce('ordinary-cache-reload');
  }
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 3);
  assert.equal(harness.internalEvents.filter(event => event.reason === 'language-acquisition-failed').length, 1);
  assert.equal(harness.render().primaryText, 'A primary');
  assert.equal(harness.readiness().primary.ready, true);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
  // 同 context 清單真的改變才解鎖；單純換配音並沒有 revision 訊號。
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  await harness.poll();
  assert.equal(harness.readiness().secondary.ready, false);
  harness.setTrackListRevision(1);
  await harness.poll();
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(harness.render().primaryText, 'A primary');
  assert.equal(harness.render().secondaryText, 'A secondary');
});

test('late native information and subtitle tracks recover on an unchanged real context poll before the retry limit', async () => {
  for (const initial of ['unknown', 'missing']) {
    const harness = await createTTMLHarness({ prepareSecondary: false, realContextPoll: true });
    const interceptor = harness.interceptor();
    interceptor.setupEventHandlers();
    interceptor.dualSubtitleEnabled = false;
    captureActiveEpisode(harness, 'episode-A', 'A');
    interceptor.applyConfiguredSecondaryLanguage('auto');
    interceptor.isActive = true;
    const resolved = { ok: true, value: { variant: 'original-language', originalLanguage: {
      status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
    } } };
    harness.setPlaybackResult('original-language', initial === 'unknown' ? { ok: true, value: {
      variant: 'original-language', originalLanguage: { status: 'unknown', reason: 'no-valid-native-audio-language' }
    } } : resolved);
    if (initial === 'missing') harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [] } });
    interceptor.dualSubtitleEnabled = true;
    assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('initial')).success, false);
    harness.setPlaybackResult('original-language', resolved);
    harness.setPlaybackResult('available-languages', null);
    await harness.poll();
    assert.equal(harness.readiness().secondary.ready, true);
    assert.equal(harness.render().primaryText, 'A primary');
    assert.equal(harness.render().secondaryText, 'A secondary');
    assert.equal(harness.internalEvents.filter(event => event.type === 'PLAYBACK_CONTEXT_CHANGED').length, 1, 'only initialize changes context');
  }
});

test('auto acquisition switching is bounded, disabled polls do no work, and user mode or video reset grants a new bounded attempt', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.setupEventHandlers();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  harness.setPlaybackResult('switch-track', { ok: false, error: { code: 'switch-rejected' } });
  interceptor.dualSubtitleEnabled = true;
  interceptor.isActive = true;
  await interceptor.ensureSecondaryLanguageAvailableOnce('initial', { timeoutMs: 1 });
  const attempts = () => harness.playbackCalls().filter(call => call.variant === 'switch-track' && call.payload.trackId === 'en-track').length;
  interceptor.dualSubtitleEnabled = false;
  for (let count = 0; count < 4; count += 1) await harness.poll();
  assert.equal(attempts(), 1);
  interceptor.dualSubtitleEnabled = true;
  for (let count = 0; count < 8; count += 1) {
    await harness.poll();
    await interceptor.ensureSecondaryLanguageAvailableOnce('cache-reload', { timeoutMs: 1 });
  }
  assert.equal(attempts(), 3);
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 1, 'resolved language stays cached');
  assert.equal(harness.internalEvents.filter(event => event.reason === 'language-acquisition-failed').length, 1);
  assert.equal(harness.render().primaryText, 'primary');
  interceptor.applyConfiguredSecondaryLanguage('en');
  interceptor.applyConfiguredSecondaryLanguage('auto');
  await interceptor.ensureSecondaryLanguageAvailableOnce('user-mode-reset', { timeoutMs: 1 });
  assert.equal(attempts(), 4);
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 2);
  harness.switchPlayback('episode-B');
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-B', language: 'zh-Hant', text: 'B primary' });
  interceptor.dualSubtitleEnabled = true;
  await interceptor.ensureSecondaryLanguageAvailableOnce('context-reset', { timeoutMs: 1 });
  assert.equal(attempts(), 5);
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 3);
  assert.equal(harness.render().primaryText, 'B primary');
});

test('auto original matching retains all native labels and promotes actual exact or unique-base subtitle codes including unsupported languages', async () => {
  for (const fixture of [
    { languages: ['ja', 'ja-JP'], codes: ['ja', 'ja-JP'], selectedCode: 'ja-JP' },
    { languages: ['pt-BR'], codes: ['pt'], selectedCode: 'pt' },
    { languages: ['da'], codes: ['da'], selectedCode: 'da' }
  ]) {
    const harness = await createTTMLHarness({ prepareSecondary: false });
    const interceptor = harness.interceptor();
    const tracks = fixture.codes.map((code, index) => ({ code, trackId: `track-${index}`, trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
      isForcedNarrative: false, isNoneTrack: false }));
    if (tracks.length > 1) Object.assign(tracks[0], { trackType: 'ASSISTIVE', rawTrackType: 'CLOSEDCAPTIONS' });
    harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
      status: 'resolved', reason: 'native-audio-language', baseLanguage: fixture.languages[0].split('-')[0], languages: fixture.languages
    } } });
    harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: tracks } });
    interceptor.dualSubtitleEnabled = false;
    harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
    for (const track of tracks) harness.capture({ videoId: 'episode-A', language: track.code, text: track.code, trackId: track.trackId });
    interceptor.applyConfiguredSecondaryLanguage('auto');
    interceptor.dualSubtitleEnabled = true;
    assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('auto-matching')).success, true);
    assert.equal(harness.render().secondaryLanguage, fixture.selectedCode);
    assert.equal(harness.render().secondaryText, fixture.selectedCode);
    assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, fixture.selectedCode);
    assert.equal(harness.readiness().secondary.ready, true);
  }
});

test('auto context cache survives dubbing, primary changes and dual off/on while disabled mode never starts resolution or acquisition', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.applyConfiguredSecondaryLanguage('auto');
  const original = { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en'] };
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: original } });
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('disabled')).reason, 'dual-subtitle-disabled');
  assert.equal(harness.playbackCalls().length, 0);
  interceptor.dualSubtitleEnabled = true;
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('enabled')).success, true);
  const calls = harness.playbackCalls().length;
  // 模擬切配音／口述影像後播放器的讀取值已改變；同 context 的解析不得再讀。
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'unknown', reason: 'no-valid-native-audio-language'
  } } });
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('dubbing-or-audio-description-changed')).success, true);
  interceptor.configBridge = { async setSubtitleLanguages() {}, async setDualSubtitleEnabled() {} };
  await interceptor.setLanguages('ja', 'auto');
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('primary-changed')).success, true);
  await interceptor.setDualSubtitleEnabled(false);
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('disabled-again')).reason, 'dual-subtitle-disabled');
  await interceptor.setDualSubtitleEnabled(true);
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('enabled-again')).success, true);
  assert.equal(harness.playbackCalls().length, calls);
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'en');
  assert.equal(harness.readiness().secondary.ready, true);
});

test('a pending auto resolution invalidated by a manual choice cannot start acquisition for the new choice', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.applyConfiguredSecondaryLanguage('auto');
  let resolveOriginal;
  harness.setPlaybackResult('original-language', () => new Promise(resolve => { resolveOriginal = resolve; }));
  interceptor.dualSubtitleEnabled = true;
  const pending = interceptor.ensureSecondaryLanguageAvailableOnce('pending-auto');
  interceptor.applyConfiguredSecondaryLanguage('en');
  resolveOriginal({ ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja']
  } } });
  assert.equal((await pending).reason, 'stale-original-language-resolution');
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'en');
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'en');
  assert.equal(harness.playbackCalls().length, 1);
  assert.equal(harness.readiness().primary.ready, true);
});

test('auto resolution cache is context bound and a late previous-video result cannot replace the current effective language', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.applyConfiguredSecondaryLanguage('auto');
  let resolveA;
  harness.setPlaybackResult('original-language', input => input.expected.videoId === 'episode-A' ?
    new Promise(resolve => { resolveA = resolve; }) : {
      ok: true, value: { variant: 'original-language', originalLanguage: {
        status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
      } }
    });
  interceptor.dualSubtitleEnabled = true;
  const pendingA = interceptor.ensureSecondaryLanguageAvailableOnce('pending-A');
  harness.switchPlayback('episode-B');
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-B', 'B');
  interceptor.dualSubtitleEnabled = true;
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('current-B')).success, true);
  resolveA({ ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja']
  } } });
  assert.equal((await pendingA).reason, 'stale-original-language-resolution');
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'en');
  assert.deepEqual(harness.render(), { primaryText: 'B primary', secondaryText: 'B secondary', secondaryLanguage: 'en' });
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant === 'original-language').map(call => call.expected.videoId),
    ['episode-A', 'episode-B']);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('manual secondary configuration exposes separate effective language, selected track and resolution without persisting runtime state', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  const writes = [];
  interceptor.configBridge = { async setSubtitleLanguages(...languages) { writes.push(languages); } };
  await interceptor.setLanguages('zh-Hant', 'en');
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'manual secondary' });
  interceptor.dualSubtitleEnabled = true;
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('manual-state');
  assert.equal(result.success, true);
  const status = interceptor.getStatus();
  assert.equal(status.configuredSecondaryLanguage, 'en');
  assert.equal(status.effectiveSecondaryLanguage, 'en');
  assert.equal(status.secondaryLanguage, 'en');
  assert.equal(status.selectedSecondaryTrack.trackId, 'en-track');
  assert.equal(status.secondaryResolution.status, 'manual');
  assert.equal(harness.readiness().secondary.language, 'en');
  assert.deepEqual(harness.render(), { primaryText: 'primary', secondaryText: 'manual secondary', secondaryLanguage: 'en' });
  assert.deepEqual(writes, [['zh-Hant', 'en']]);
});

test('manual secondary cache chooses full track identity instead of another same-language CC capture', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'CC', trackId: 'en-cc' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'full', trackId: 'en-track' });
  interceptor.dualSubtitleEnabled = true;
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('manual-cache');
  assert.equal(result.success, true);
  assert.equal(harness.render().secondaryText, 'full');
  assert.equal(interceptor.secondarySubtitleMeta.trackId, 'en-track');
  assert.equal(interceptor.selectedSecondaryTrack.isCC, false);
  assert.equal(interceptor.isLanguageSlotReady('ja', 'secondary'), false);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('secondary legacy acquisition uses effective language rather than a configured auto argument', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  const writes = [];
  interceptor.configBridge = { async setSubtitleLanguages(...languages) { writes.push(languages); } };
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'effective secondary' });
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.setEffectiveSecondaryLanguage('en', { status: 'ready', reason: 'fixture-resolution' });
  interceptor.dualSubtitleEnabled = true;
  const result = await interceptor.switchLanguageAndWait('auto', 'secondary', { timeoutMs: 25 });
  assert.equal(result.ready, true);
  assert.equal(result.languageCode, 'en');
  assert.equal(harness.render().secondaryText, 'effective secondary');
  assert.equal(harness.readiness().secondary.language, 'en');
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'auto');
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'ready');
  assert.deepEqual(writes, []);
  assert.equal(harness.playbackCalls().some(call => call.variant === 'original-language' || call.payload?.languageCode === 'auto'), false);
});

test('unresolved configured auto clears only secondary state and never reaches cache, readiness, recovery or legacy switching as a language', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.isActive = true;
  captureActiveEpisode(harness, 'episode-A', 'A');
  harness.render();
  assert.equal(harness.readiness().secondary.ready, true);
  interceptor.applyConfiguredSecondaryLanguage('auto');
  assert.equal(harness.readiness().primary.ready, true);
  assert.equal(harness.readiness().canHideNativeSubtitles, true);
  assert.equal(harness.readiness().secondary.language, null);
  assert.equal(harness.readiness().secondary.ready, false);
  assert.equal(interceptor.secondaryTimeIndex, null);
  assert.equal(interceptor.getStatus().selectedSecondaryTrack, null);
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'resolving');
  assert.deepEqual(harness.render(), { primaryText: 'A primary', secondaryText: '', secondaryLanguage: null });
  const callsBefore = harness.playbackCalls().length;
  harness.setPlaybackResult('original-language', { ok: false, error: { kind: 'domain-rejected', code: 'original-language-unavailable', retryable: false } });
  harness.setPlaybackResult('switch-language', { ok: false, error: { code: 'invalid-language' } });
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('unresolved');
  assert.equal(result.reason, 'original-language-unavailable');
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'unavailable');
  assert.equal(harness.readiness().primary.ready, true);
  assert.equal(harness.readiness().secondary.missingReason, 'original-language-unavailable');
  assert.equal(await interceptor.trySecondaryDomRecovery('unresolved'), false);
  await interceptor.fetchLanguageIfNeeded('auto', 'zh-Hant');
  await interceptor.loadSubtitleForLanguage('auto', 'secondary');
  await interceptor.refreshLanguageTrack('auto', 'secondary', null, { timeoutMs: 1 });
  assert.equal(harness.playbackCalls().length, callsBefore + 1);
  assert.equal(harness.playbackCalls().at(-1).variant, 'original-language');
  assert.equal(interceptor.selectBestLanguageCacheEntry('auto', 'secondary'), null);
  assert.equal(interceptor.isLanguageSlotReady('auto', 'secondary'), false);
  assert.equal(interceptor.acquisitionWaiters.size, 0);
  assert.equal(interceptor.analyzeCacheStatus(new Map([['auto', {}]])).needsSecondary, false);
});

test('secondary cache and diagnostics use an effective language outside configured language choices, never the auto request label', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.setEffectiveSecondaryLanguage('da', { status: 'ready', reason: 'fixture-resolution' });
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'da', languages: ['da']
  } } });
  harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [
    { code: 'da', trackId: 'da-track', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
      isNoneTrack: false, isForcedNarrative: false }
  ] } });
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-A', language: 'da', text: 'Danish secondary', trackId: 'da-track' });
  interceptor.dualSubtitleEnabled = true;
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('effective-danish')).success, true);
  await interceptor.loadLanguageDataFromCache('auto', 'secondary');
  assert.equal(interceptor.debugEvents.filter(event => event.type === 'LANGUAGE_CACHE_SELECTED').at(-1).languageCode, 'da');
  assert.equal((await interceptor.diagnoseLanguageAvailability('auto', 'secondary')).rawEntryCount, 1);
  assert.equal(harness.readiness().secondary.language, 'da');
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(harness.render().secondaryLanguage, 'da');
  assert.equal(harness.render().secondaryText, 'Danish secondary');
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'auto');
  assert.equal(interceptor.getStatus().secondaryLanguage, 'da');
  assert.equal(interceptor.debugEvents.find(event => event.type === 'SECONDARY_ACQUISITION_STARTED').inFlightKey,
    'episode-A|1|da|da-track');
  assert.equal(interceptor.debugEvents.some(event => event.languageCode === 'auto'), false);
});

test('setLanguages persists configured choices without mistaking an existing effective result for a setting', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  const writes = [];
  interceptor.configBridge = { async setSubtitleLanguages(...languages) { writes.push(languages); } };
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.setEffectiveSecondaryLanguage('en', { status: 'ready', reason: 'fixture-resolution' });
  interceptor.dualSubtitleEnabled = false;
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.dualSubtitleEnabled = true;
  await interceptor.ensureSecondaryLanguageAvailableOnce('configured-setting');
  const callsBefore = harness.playbackCalls().length;
  await interceptor.setLanguages('ja', 'auto');
  assert.deepEqual(writes, [['ja', 'auto']]);
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'auto');
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'en');
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'ready');
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(harness.playbackCalls().length, callsBefore);
  await interceptor.setLanguages('ja', 'en');
  assert.deepEqual(writes, [['ja', 'auto'], ['ja', 'en']]);
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'en');
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'en');
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'manual');
  assert.equal(harness.readiness().secondary.ready, true);
  await interceptor.setLanguages('ja', 'ko');
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'ko');
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'ko');
  assert.equal(interceptor.getStatus().selectedSecondaryTrack, null);
  assert.equal(harness.readiness().secondary.ready, false);
});

test('manual secondary switches the selected full track and does not reuse same-language CC readiness', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'wrong CC', trackId: 'en-cc' });
  interceptor.dualSubtitleEnabled = true;
  harness.setPlaybackResult('switch-track', input => {
    if (input.payload.trackId === 'en-track') harness.capture({
      videoId: 'episode-A', language: 'en', text: 'selected full', trackId: 'en-track'
    });
    return { ok: true, value: { variant: input.variant, language: { code: 'en', trackId: input.payload.trackId } } };
  });
  // Current Netflix track is a different language, not the already-cached CC.
  harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('manual-switch', { timeoutMs: 25 });
  assert.equal(result.success, true, JSON.stringify({ result, calls: harness.playbackCalls(), events: interceptor.debugEvents }));
  assert.equal(harness.render().secondaryText, 'selected full');
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant === 'switch-track').map(call => call.payload.trackId),
    ['en-track', 'zh-track']);
});

test('unavailable full secondary track falls back to eligible CC with degraded identity, never forced or none', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  const full = { code: 'en', name: 'English', trackId: 'en-track', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
    isForcedNarrative: false, isNoneTrack: false };
  const cc = { ...full, trackId: 'en-cc', trackType: 'ASSISTIVE', rawTrackType: 'CLOSEDCAPTIONS' };
  harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [
    { ...full, trackId: 'forced', isForcedNarrative: true }, { ...full, trackId: 'none', isNoneTrack: true }, cc, full
  ] } });
  harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  harness.setPlaybackResult('switch-track', input => input.payload.trackId === 'en-track' ?
    { ok: false, error: { kind: 'domain-rejected', code: 'track-unavailable', retryable: false } } :
    { ok: true, value: { variant: input.variant, language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  harness.setPlaybackResult('switch-secondary-language', input => {
    assert.deepEqual(JSON.parse(JSON.stringify(input.payload)), { languageCode: 'en', excludedTrackIds: ['en-track'] });
    harness.capture({ videoId: 'episode-A', language: 'en', text: 'CC fallback', trackId: 'en-cc' });
    return { ok: true, value: { variant: input.variant, language: cc } };
  });
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('manual-fallback', { timeoutMs: 25 });
  assert.equal(result.success, true);
  assert.equal(result.selectedTrack.trackId, 'en-cc');
  assert.equal(result.selectedTrack.isCC, true);
  assert.equal(result.selectedTrack.degraded, true);
  assert.equal(harness.render().secondaryText, 'CC fallback');
  assert.equal(interceptor.secondarySubtitleMeta.trackId, 'en-cc');
  assert.equal(interceptor.secondarySubtitleMeta.degraded, true);
  assert.equal(interceptor.secondarySubtitleMeta.isCC, true);
});

test('Given episode A active and episode B TTML is prefetched When raw B arrives Then B is retained in raw cache without mutating A active slots', async () => {
  const harness = await createTTMLHarness();
  const activeA = captureActiveEpisode(harness, 'episode-A', 'A');
  harness.render();
  const prefetchedB = harness.capture({ videoId: 'episode-B', language: 'zh-Hant', text: 'B primary' });
  harness.render();

  assert.equal((await harness.readPageRawCacheKeys()).includes(prefetchedB), true);
  assert.deepEqual(harness.render(), { primaryText: 'A primary', secondaryText: 'A secondary', secondaryLanguage: 'en' });
  assert.equal(harness.readiness().primary.cacheKey, activeA.primaryCacheKey);
  assert.equal(harness.readiness().secondary.cacheKey, activeA.secondaryCacheKey);
});

test('Given retained B TTML from prefetch When PlaybackContext switches to B Then B is reevaluated, selected, and rendered', async () => {
  const harness = await createTTMLHarness();
  captureActiveEpisode(harness, 'episode-A', 'A');
  const prefetchedB = harness.capture({ videoId: 'episode-B', language: 'zh-Hant', text: 'B primary' });

  harness.switchPlayback('episode-B');
  await harness.reloadCurrentContext();

  assert.equal((await harness.readPageRawCacheKeys()).includes(prefetchedB), true);
  assert.deepEqual(harness.render(), { primaryText: 'B primary', secondaryText: '', secondaryLanguage: 'en' });
  assert.equal(harness.readiness().primary.cacheKey, prefetchedB);
});

test('Given B is active When delayed A TTML arrives Then A is retained but cannot replace B active slot', async () => {
  const harness = await createTTMLHarness();
  harness.switchPlayback('episode-B');
  const activeB = captureActiveEpisode(harness, 'episode-B', 'B');
  harness.render();
  const delayedA = harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'A primary' });
  harness.render();

  assert.equal((await harness.readPageRawCacheKeys()).includes(delayedA), true);
  assert.deepEqual(harness.render(), { primaryText: 'B primary', secondaryText: 'B secondary', secondaryLanguage: 'en' });
  assert.equal(harness.readiness().primary.cacheKey, activeB.primaryCacheKey);
  assert.equal(harness.readiness().secondary.cacheKey, activeB.secondaryCacheKey);
});

test('Given TTML capture evidence is old When cache is reevaluated Then age alone retains it while current evidence and gates own the active slot', async () => {
  const harness = await createTTMLHarness();
  const activeB = captureActiveEpisode(harness, 'episode-B', 'B', 1);
  harness.render();
  harness.switchPlayback('episode-B');

  assert.equal((await harness.readPageRawCacheKeys()).includes(activeB.primaryCacheKey), true);

  harness.switchPlayback('episode-A');
  const activeA = captureActiveEpisode(harness, 'episode-A', 'A');
  await harness.reloadCurrentContext();

  assert.equal((await harness.readPageRawCacheKeys()).includes(activeB.primaryCacheKey), true);
  assert.deepEqual(harness.render(), { primaryText: 'A primary', secondaryText: 'A secondary', secondaryLanguage: 'en' });
  assert.equal(harness.readiness().primary.cacheKey, activeA.primaryCacheKey);
  assert.equal(harness.readiness().secondary.cacheKey, activeA.secondaryCacheKey);
});

test('Given a stopped interceptor When late cache capture runs Then it does not rebind the dedicated physical listener', async () => {
  const harness = await createTTMLHarness();
  harness.bindIngress();
  assert.equal(harness.ingressListenerCount(), 1);
  harness.stop();
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'late capture' });
  assert.equal(harness.ingressListenerCount(), 0);
});

test('Given an interceptor owns a bound ingress When it stops repeatedly Then capture unbinds, ingress disposes once, and a later lifecycle gets a fresh ingress', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  harness.bindIngress();
  const first = harness.ingressInstances()[0];
  assert.equal(harness.ingressListenerCount(), 1);

  harness.stop();
  harness.stop();

  assert.equal(harness.ingressListenerCount(), 0);
  assert.equal(first.disposeCalls, 1);
  assert.equal(interceptor.ttmlAcquisitionIngress, null);
  const second = interceptor.getTtmlAcquisitionIngress();
  assert.notEqual(second, first);
});

test('Given a ready playback context When SubtitleInterceptor reads and mutates language state Then it performs every typed operation with that exact context', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.sleep = async () => {};

  assert.equal(await interceptor.waitForPlayerReady(), true);
  assert.equal(await interceptor.recordDefaultLanguage(), 'en');
  assert.deepEqual(await interceptor.getCurrentNetflixLanguage(), {
    code: 'en', name: 'English', trackId: 'en-track', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
    isNoneTrack: false, isForcedNarrative: false
  });
  assert.equal((await interceptor.getAvailableNetflixLanguages()).length, 2);
  assert.equal((await interceptor.captureCurrentNetflixTrack()).trackId, 'en-track');
  await interceptor.switchNetflixLanguage('zh-Hant', 'test-switch');
  await interceptor.restoreNetflixTrack({ code: 'en', trackId: 'en-track' }, 'en', 'test-restore');

  const expected = { videoId: 'episode-A', sessionId: 'watch-episode-A', epoch: 1 };
  assert.deepEqual(harness.playbackCalls(), [
    { variant: 'available-languages', payload: {}, expected },
    { variant: 'current-language', payload: {}, expected },
    { variant: 'current-language', payload: {}, expected },
    { variant: 'available-languages', payload: {}, expected },
    { variant: 'current-language', payload: {}, expected },
    { variant: 'switch-language', payload: { languageCode: 'zh-Hant' }, expected },
    { variant: 'switch-track', payload: { trackId: 'en-track' }, expected }
  ]);
  assert.deepEqual(harness.genericPageRpcCalls(), []);
});

test('Given typed track restore rejects When SubtitleInterceptor restores the starting track Then it falls back once to the typed language operation', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  harness.setPlaybackResult('switch-track', {
    ok: false,
    error: { kind: 'domain-rejected', code: 'track-unavailable', retryable: false }
  });

  await interceptor.restoreNetflixTrack({ code: 'en', trackId: 'en-track' }, 'en', 'test-fallback');

  const expected = { videoId: 'episode-A', sessionId: 'watch-episode-A', epoch: 1 };
  assert.deepEqual(harness.playbackCalls(), [
    { variant: 'switch-track', payload: { trackId: 'en-track' }, expected },
    { variant: 'switch-language', payload: { languageCode: 'en' }, expected }
  ]);
  assert.deepEqual(harness.genericPageRpcCalls(), []);
});

test('numeric zero secondary starting track is restored by exact identity rather than language', async () => {
  const harness = await createTTMLHarness();
  await harness.interceptor().restoreNetflixTrack({ code: 'en', trackId: 0 }, 'en', 'zero-track');
  assert.equal(harness.playbackCalls().at(-1).variant, 'switch-track');
  assert.equal(harness.playbackCalls().at(-1).payload.trackId, 0);
});

test('secondary DOM recovery switches the selected track even when the current same-language track is CC', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-B', language: 'en', text: 'unattributed raw', trackId: 'en-track' });
  interceptor.dualSubtitleEnabled = true;
  interceptor.sleep = async () => {};
  harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language',
    language: { code: 'en', trackId: 'en-cc' } } });
  await interceptor.trySecondaryDomRecovery('manual-recovery');
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant === 'switch-track').map(call => call.payload.trackId),
    ['en-track', 'en-cc']);
  assert.equal(harness.playbackCalls().some(call => call.variant === 'switch-language'), false);
});

test('legacy secondary switching entry uses the same selected-track cache without the primary language variant', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'selected full', trackId: 'en-track' });
  interceptor.dualSubtitleEnabled = true;
  interceptor.sleep = async () => {};
  const result = await interceptor.switchLanguageAndWait('en', 'secondary', { timeoutMs: 1 });
  assert.equal(result.ready, true);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('secondary DOM recovery matches and promotes the effective language while configured auto stays out of cooldown and matcher targets', async () => {
  const requestInfo = createRequestInfo('episode-A', 'da');
  requestInfo.currentTrackAtRequest = { code: 'da', trackId: 'da-track' };
  const harness = await createTTMLHarness({
    prepareSecondary: false,
    domSample: { text: 'Danish secondary', timestamp: 1 },
    domMatchResult: { matched: true, result: {
      cacheKey: 'da_episode-B_fixture_da-track', language: 'da', rawContent: 'Danish secondary', requestInfo,
      score: 1, matchedUnits: 1, totalDomUnits: 1
    } }
  });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-B', language: 'da', text: 'Danish secondary', trackId: 'da-track' });
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.setEffectiveSecondaryLanguage('da', { status: 'ready', reason: 'fixture-resolution' });
  harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [
    { code: 'da', trackId: 'da-track', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
      isNoneTrack: false, isForcedNarrative: false }
  ] } });
  interceptor.dualSubtitleEnabled = true;
  interceptor.sleep = async () => {};
  assert.equal(await interceptor.trySecondaryDomRecovery('effective-recovery'), true);
  assert.deepEqual(harness.matcherLanguages(), ['da']);
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(harness.readiness().secondary.language, 'da');
  assert.equal(harness.render().secondaryText, 'Danish secondary');
  const started = interceptor.debugEvents.find(event => event.type === 'SECONDARY_DOM_RECOVERY_STARTED');
  assert.equal(started.cooldownKey, 'episode-A|1|da');
  assert.equal(started.secondaryLanguage, 'da');
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'auto');
  assert.equal(harness.playbackCalls().some(call => call.variant === 'original-language' || call.payload?.languageCode === 'auto'), false);
});

test('Given raw TTML and a diagnostic summary owned by the ingress When cache, diagnosis, and primary discovery run Then callers use the normalized reader and matcher receives it', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  const cacheKey = harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: '<tt><p>primary</p></tt>', requestTime: 1 });

  await interceptor.checkExistingCache();
  assert.equal(await interceptor.hasRawTTMLCandidateForLanguage('zh-Hant'), true);
  const diagnosis = await interceptor.diagnoseLanguageAvailability('zh-Hant', 'primary');
  assert.equal(diagnosis.recentNonTTMLCandidateCount, 3);
  assert.equal(diagnosis.rawEntryCount, 1);
  assert.equal(diagnosis.rawEntries[0].cacheKey, cacheKey);

  interceptor.isActive = true;
  interceptor.primarySubtitles = [];
  interceptor.primarySubtitleMeta = null;
  interceptor.tryPrimaryDiscoveryMatch = () => Promise.resolve();
  interceptor.startPrimaryDiscovery();

  assert.equal(harness.matcherOptions().length, 1);
  assert.equal(typeof harness.matcherOptions()[0].readRawPool, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(await harness.matcherOptions()[0].readRawPool())), {
    ok: true,
    value: {
      entries: {
        [cacheKey]: {
          rawContent: '<tt><p>primary</p></tt>',
          requestInfo: createRequestInfo('episode-A', 'zh-Hant', 1),
          rawMetadata: null,
          metadata: null,
          language: 'zh-Hant',
          timestamp: 1
        }
      }
    }
  });
  assert.deepEqual(harness.genericPageRpcCalls(), []);
});

test('Given an interceptor render generation When it emits a subtitle Then the payload carries that generation', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor._renderGeneration = 3;

  const subtitle = interceptor.convertToStandardFormat({
    primaryText: 'seek target cue',
    secondaryText: '',
    timestamp: 1202.13,
    primarySubtitle: null,
    secondarySubtitle: null,
    renderReadiness: {}
  });

  assert.equal(subtitle.renderGeneration, 3);
});
