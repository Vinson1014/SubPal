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

async function createTTMLHarness({ prepareSecondary = true } = {}) {
  let context = createPlaybackContext('episode-A', 1);
  const rawCache = new Map();
  const rendered = [];
  const genericPageRpcCalls = [];
  const playbackCalls = [];
  const matcherOptions = [];
  const ingressInstances = [];
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
    clearTimeout
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
    registerInternalEventHandler: () => () => {},
    dispatchInternalEvent() {}
  });
  const videoInfo = await createSyntheticModule(sandbox, 'video-info.js', {
    getCurrentTimestamp: () => 1,
    getVideoId: () => context.videoId
  });
  const playback = await createSyntheticModule(sandbox, 'playback-context-manager.js', {
    playbackContextManager: {
      getCurrentContext: () => ({ ...context }),
      getPlayback: () => ({
        perform(input) {
          playbackCalls.push(JSON.parse(JSON.stringify(input)));
          const result = playbackResults.get(input.variant);
          return Promise.resolve(typeof result === 'function' ? result(input) : result || defaultPlaybackResult(input));
        }
      })
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
      collectDOMSample() { return null; }
      async runMatchOnce() {
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
  interceptor.secondaryLanguage = 'en';
  interceptor.dualSubtitleEnabled = true;
  if (prepareSecondary) {
    await interceptor.prepareSecondaryTrack('en');
    playbackCalls.length = 0;
  }
  interceptor.onSubtitleDetected(output => {
    rendered.push({
      primaryText: output.dualSubtitle.primaryText,
      secondaryText: output.dualSubtitle.secondaryText
    });
  });

  return {
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
  assert.deepEqual(harness.render(), { primaryText: 'A primary', secondaryText: 'A secondary' });
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
  assert.deepEqual(harness.render(), { primaryText: 'B primary', secondaryText: '' });
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
  assert.deepEqual(harness.render(), { primaryText: 'B primary', secondaryText: 'B secondary' });
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
  assert.deepEqual(harness.render(), { primaryText: 'A primary', secondaryText: 'A secondary' });
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
