import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as secondarySelection from '../shared/secondary-track-selection.js';
import * as secondaryPreference from '../shared/secondary-language-preference.js';
import { createPageSecondaryRuntimeStatus } from '../content/system/capabilities/secondary-runtime-status.js';
import { formatSecondaryRuntimeStatus } from '../shared/secondary-runtime-status.js';
import { createPrivatePlaybackPage } from './helpers/private-playback-page.mjs';

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

async function createTTMLHarness({ prepareSecondary = true, domSample = null, domMatchResult = null, realContextPoll = false, runtimeImportGate = null } = {}) {
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
  const runtimePublications = [];
  const track = {
    code: 'en',
    name: 'English',
    trackId: 'en-track',
    trackType: 'PRIMARY',
    rawTrackType: 'SUBTITLES',
    isNoneTrack: false,
    isForcedNarrative: false
  };
  let nativeTrack = { ...track };
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
        return { ok: true, value: { variant: input.variant, language: { ...nativeTrack } } };
      case 'switch-language':
        return { ok: true, value: { variant: input.variant, language: {
          ...track, code: input.payload.languageCode, trackId: input.payload.languageCode === 'zh-Hant' ? 'zh-track' : `${input.payload.languageCode}-track`
        } } };
      case 'switch-track':
        return { ok: true, value: { variant: input.variant, language: {
          ...track, code: input.payload.trackId === 'zh-track' ? 'zh-Hant' : 'en', trackId: input.payload.trackId
        } } };
      default:
        throw new Error(`Unexpected Playback variant: ${input.variant}`);
    }
  };
  const window = {
    dispatchEvent(event) {
      if (event.type === 'messageToContentScript') {
        runtimePublications.push(structuredClone(event.detail.message));
        for (const listener of eventListeners.get('responseFromContentScript') ?? []) {
          listener({ detail: { messageId: event.detail.messageId, response: { ok: true, value: { published: true } } } });
        }
      }
      for (const listener of eventListeners.get(event.type) ?? []) listener(event);
    },
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
    async perform(input) {
      playbackCalls.push(JSON.parse(JSON.stringify(input)));
      const result = playbackResults.get(input.variant);
      const response = await (typeof result === 'function' ? result(input) : result || defaultPlaybackResult(input));
      if (input.variant.startsWith('switch-') && response?.ok && response.value.language) nativeTrack = { ...response.value.language };
      return response;
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
    ['../../shared/secondary-language-preference.js', await createSyntheticModule(sandbox, 'secondary-language-preference.js', secondaryPreference)],
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
    identifier: 'content/subtitle-modes/subtitle-interceptor.js',
    async importModuleDynamically(specifier) {
      if (specifier.endsWith('capabilities/secondary-runtime-status.js')) {
        if (runtimeImportGate) await runtimeImportGate();
        return createSyntheticModule(sandbox, 'secondary-runtime-status.js', { createPageSecondaryRuntimeStatus });
      }
      throw new Error(`Unexpected dynamic import: ${specifier}`);
    }
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
    runtimePublications,
    async settleRuntime() { await new Promise(resolve => setImmediate(resolve)); },
    setContextState(state) { context.state = state; },
    createInterceptor() { return new module.namespace.SubtitleInterceptor(); },
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
    changeContext(update) {
      context = { ...context, ...update };
      return internalHandlers.get('PLAYBACK_CONTEXT_CHANGED')?.({ context: { ...context }, reason: 'fixture-context-change' });
    },
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
    async enterDomEmergency(reason) {
      const source = await readFile(new URL('../content/subtitle-modes/subtitle-coordinator.js', import.meta.url), 'utf8');
      const coordinatorModule = new vm.SourceTextModule(source, { context: sandbox });
      const languageCode = await createSyntheticModule(sandbox, 'language-code.js', { toAPILanguageCode: value => value });
      const slotKey = await createSyntheticModule(sandbox, 'slot-key.js', { buildSlotKey: () => 'fixture-slot' });
      await coordinatorModule.link(specifier => ({
        '../core/video-info.js': videoInfo,
        '../utils/language-code.js': languageCode,
        '../utils/slot-key.js': slotKey
      })[specifier]);
      await coordinatorModule.evaluate();
      const coordinator = new coordinatorModule.namespace.SubtitleCoordinator();
      coordinator.interceptor = interceptor;
      coordinator.currentMode = 'intercept';
      let nativeStarted = false;
      coordinator.domMonitor = { start() { nativeStarted = true; } };
      await coordinator.enterDomEmergency(reason);
      coordinator.stopBackgroundUpgrade('fixture-complete');
      return { currentMode: coordinator.currentMode, nativeStarted };
    },
    ingressInstances() {
      return ingressInstances;
    },
    setPlaybackResult(variant, result) {
      if (variant === 'current-language' && result?.ok) {
        nativeTrack = { ...result.value.language };
        playbackResults.delete(variant);
        return;
      }
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

test('auto same-source primary keeps identity and suppresses secondary acquisition, cache assignment and render', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.primaryLanguage = 'en';
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'primary', trackId: 'en-track' });
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'translated', trackId: 'zh-track' });
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language',
    originalLanguage: { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en'] } } });
  interceptor.dualSubtitleEnabled = true;
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('same-track');
  assert.equal(result.reason, 'same-primary-track');
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'ready');
  assert.equal(interceptor.getStatus().secondaryResolution.reason, 'same-primary-track');
  assert.equal(harness.readiness().primary.trackId, 'en-track');
  assert.equal(harness.readiness().primary.ready, true);
  assert.equal(harness.readiness().secondary.ready, false);
  assert.equal(harness.readiness().secondary.missingReason, 'same-primary-track');
  await interceptor.loadLanguageDataFromCache('en', 'secondary');
  await interceptor.ensureLanguageAvailable('en', 'secondary');
  assert.equal(await interceptor.trySecondaryDomRecovery('same-track-recovery'), false);
  assert.equal(interceptor.secondarySubtitles.length, 0);
  assert.equal(harness.render().secondaryText, '');
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-') || call.variant === 'current-language'), false);
  const callsBeforePrimaryChange = harness.playbackCalls().length;
  interceptor.configBridge = { async setSubtitleLanguages() {} };
  await interceptor.setLanguages('zh-Hant', 'auto');
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(harness.render().secondaryText, 'primary');
  assert.equal(harness.playbackCalls().length, callsBeforePrimaryChange);
});

test('auto original and manual-fallback success caches preserve same-track suppression through real polls and primary-only cache restoration', async () => {
  for (const [initiallySuppressed, manualFallback] of [[true, false], [false, false], [true, true], [false, true]]) {
    const harness = await createTTMLHarness({ prepareSecondary: false, realContextPoll: true });
    const interceptor = harness.interceptor();
    interceptor.setupEventHandlers();
    interceptor.primaryLanguage = initiallySuppressed ? 'en' : 'zh-Hant';
    let preferenceReads = 0;
    interceptor.configBridge = {
      async setSubtitleLanguages() {},
      async readLastManualSecondaryLanguage() { preferenceReads += 1; return 'en'; }
    };
    interceptor.dualSubtitleEnabled = false;
    captureActiveEpisode(harness, 'episode-A', 'A');
    interceptor.applyConfiguredSecondaryLanguage('auto');
    harness.setPlaybackResult('original-language', manualFallback ? {
      ok: false, error: { kind: 'domain-rejected', code: 'original-language-unavailable', retryable: false }
    } : { ok: true, value: { variant: 'original-language', originalLanguage: {
      status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
    } } });
    interceptor.dualSubtitleEnabled = true;
    interceptor.isActive = true;
    interceptor.isInitialized = true;
    const initialResult = await interceptor.ensureSecondaryLanguageAvailableOnce('initial');
    assert.equal(initialResult.success, true);
    interceptor.setLanguageAcquisitionResult('secondary', initialResult);
    await harness.settleRuntime();
    assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.status, 'ready');
    assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.isManualFallback, manualFallback);
    const readyReason = manualFallback ? 'last-manual-subtitles-ready' : 'original-language-subtitles-ready';
    assert.equal(harness.readiness().secondary.resolution.status, 'ready');
    assert.equal(harness.readiness().secondary.resolution.reason, initiallySuppressed ? 'same-primary-track' : readyReason);
    assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'auto');
    assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'en');
    assert.deepEqual(Array.from(harness.readiness().secondary.originalLanguages), manualFallback ? [] : ['en']);
    if (initiallySuppressed) {
      assert.equal(initialResult.source, 'suppressed');
      assert.equal(initialResult.reason, 'same-primary-track');
    }
    const attempts = () => interceptor.debugEvents.filter(event => event.type === 'AUTO_SECONDARY_ATTEMPT').length;
    const secondaryCalls = () => harness.playbackCalls().filter(call => call.variant !== 'context-snapshot').length;
    const callsAfterSuccess = secondaryCalls();
    const primaryChanges = initiallySuppressed ? ['zh-Hant', 'en', 'zh-Hant', 'en'] : ['en', 'zh-Hant', 'en', 'zh-Hant'];
    for (const primaryLanguage of primaryChanges) {
      await interceptor.setLanguages(primaryLanguage, 'auto');
      const suppressed = primaryLanguage === 'en';
      assert.equal(harness.readiness().secondary.ready, !suppressed);
      assert.equal(harness.readiness().secondary.resolution.status, 'ready');
      assert.equal(harness.readiness().secondary.resolution.reason,
        suppressed ? 'same-primary-track' : readyReason);
      await harness.settleRuntime();
      assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.reason, suppressed ? 'same-primary-track' : readyReason);
      assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.isManualFallback, manualFallback);
      const label = formatSecondaryRuntimeStatus('auto', harness.runtimePublications.at(-1).payload.snapshot);
      assert.equal(label.includes('與主要字幕同軌，已省略'), suppressed);
      assert.equal(label.includes('使用上次手動語言'), manualFallback);
      assert.equal(label.includes('目前無法讀取原始語言'), manualFallback);
      assert.equal(harness.render().secondaryText, suppressed ? '' : 'A secondary');
      assert.equal(harness.readiness().primary.ready, true);
      interceptor.applyDualSubtitleEnabled(false);
      interceptor.applyDualSubtitleEnabled(true);
      for (let poll = 0; poll < 4; poll += 1) await harness.poll();
      await harness.settleRuntime();
      const reenabled = harness.runtimePublications.at(-1)?.payload.snapshot;
      assert.equal(reenabled?.status, 'ready', 'a fresh poll must reauthorize completed context cache after off/on');
      assert.equal(reenabled.effectiveLanguage, 'en');
      assert.equal(reenabled.reason, suppressed ? 'same-primary-track' : readyReason);
      assert.equal(reenabled.isManualFallback, manualFallback);
      assert.equal(await interceptor.ensureSecondaryLanguageAvailableOnce('ordinary-reload'), initialResult);
      assert.equal(harness.readiness().secondary.ready, !suppressed);
      assert.equal(secondaryCalls(), callsAfterSuccess, 'primary-only changes and stable polls must not resolve, select or switch again');
      assert.equal(attempts(), 1, 'suppression is a successful result, not a retryable missing slot');
    }
    assert.equal(interceptor.debugEvents.some(event => event.type === 'AUTO_SECONDARY_ATTEMPT_FAILED'), false);
    assert.equal(harness.internalEvents.some(event => event.reason === 'language-acquisition-failed'), false);
    assert.equal(preferenceReads, manualFallback ? 1 : 0);
    assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 1);
  }
});

test('runtime status producer publishes unresolved/negative/manual changes and never re-labels late old-context resolution', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.isActive = true;
  interceptor.isInitialized = true;
  interceptor.applyConfiguredSecondaryLanguage('auto');
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.status, 'resolving');
  for (const status of ['unknown', 'ambiguous']) {
    interceptor.applyConfiguredSecondaryLanguage('en');
    interceptor.applyConfiguredSecondaryLanguage('auto');
    harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
      status, reason: status === 'unknown' ? 'no-native-audio' : 'multiple-native-languages', languages: []
    } } });
    await interceptor.resolveAutoSecondaryLanguage();
    await harness.settleRuntime();
    assert.equal(harness.runtimePublications.at(-1).payload.snapshot.status, status);
    assert.equal(harness.runtimePublications.at(-1).payload.snapshot.effectiveLanguage, null);
  }
  interceptor.applyConfiguredSecondaryLanguage('en');
  interceptor.applyConfiguredSecondaryLanguage('auto');
  let release;
  harness.setPlaybackResult('original-language', () => new Promise(resolve => { release = resolve; }));
  const pending = interceptor.resolveAutoSecondaryLanguage();
  harness.switchPlayback('episode-B');
  interceptor.applyConfiguredSecondaryLanguage('ja');
  await harness.settleRuntime();
  const latest = harness.runtimePublications.at(-1).payload;
  assert.equal(latest.snapshot.videoId, 'episode-B');
  assert.equal(latest.snapshot.status, 'manual');
  assert.equal(latest.snapshot.effectiveLanguage, 'ja');
  release({ ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  await pending;
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.at(-1).payload.sequence, latest.sequence);
  assert.equal(harness.runtimePublications.some(item => item.payload.snapshot.videoId === 'episode-B' && item.payload.snapshot.status === 'ready'), false);
});

test('runtime publisher retries after a context transition blocks its delayed initial import', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = await createTTMLHarness({ prepareSecondary: false, runtimeImportGate: () => gate });
  const interceptor = harness.interceptor();
  interceptor.isActive = true;
  interceptor.isInitialized = true;
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setContextState('transitioning');
  release();
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.length, 0);
  harness.setContextState('ready');
  interceptor.dispatchSubtitleReadinessChanged('context-ready');
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.status, 'resolving');
});

test('recreated MAIN interceptors keep publication ordering in the same isolated owner lifetime', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const first = harness.interceptor();
  first.isActive = true;
  first.isInitialized = true;
  first.applyConfiguredSecondaryLanguage('auto');
  await harness.settleRuntime();
  const firstSequence = harness.runtimePublications.at(-1).payload.sequence;
  const second = harness.createInterceptor();
  second.isActive = true;
  second.isInitialized = true;
  second.applyConfiguredSecondaryLanguage('auto');
  await harness.settleRuntime();
  assert.ok(harness.runtimePublications.at(-1).payload.sequence > firstSequence);
});

test('context publication observes synchronous secondary cleanup before reload and cannot label delayed fallback ready as the new video', async () => {
  for (const update of [
    { videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 },
    { sessionId: 'watch-episode-A-new' },
    { epoch: 2 }
  ]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = await createTTMLHarness({ runtimeImportGate: () => gate });
    const interceptor = harness.interceptor();
    interceptor.primaryLanguage = 'en';
    interceptor.dualSubtitleEnabled = false;
    captureActiveEpisode(harness, 'episode-A', 'A');
    interceptor.dualSubtitleEnabled = true;
    interceptor.applyConfiguredSecondaryLanguage('auto');
    interceptor.configBridge = { async readLastManualSecondaryLanguage() { return 'en'; } };
    harness.setPlaybackResult('original-language', { ok: false, error: {
      kind: 'domain-rejected', code: 'original-language-unavailable', retryable: false
    } });
    const result = await interceptor.ensureSecondaryLanguageAvailableOnce('fallback-A');
    interceptor.setLanguageAcquisitionResult('secondary', result);
    assert.equal(result.reason, 'same-primary-track');
    interceptor.isInitialized = true;
    interceptor.isActive = true;
    void interceptor.publishSecondaryRuntimeStatus();
    const primary = interceptor.primarySubtitles;
    const primaryMeta = interceptor.primarySubtitleMeta;
    let reloads = 0;
    let earlyDiscovery = 0;
    // 此處只隔離 primary 的既有 stale-slot gate，觀察 context 同步失效與發布的邊界。
    interceptor.tryStartPrimaryDiscovery = () => {
      earlyDiscovery++;
      assert.equal(interceptor.secondarySubtitles.length, 0);
      assert.equal(interceptor.effectiveSecondaryLanguage, null);
      assert.equal(interceptor.primarySubtitles, primary);
      return false;
    };
    interceptor.loadInterceptedSubtitles = async () => {
      reloads++;
      assert.equal(interceptor.secondarySubtitles.length, 0);
      assert.equal(interceptor.effectiveSecondaryLanguage, null);
    };
    interceptor.setupEventHandlers();
    harness.changeContext(update);
    assert.equal(earlyDiscovery, 1);
    assert.equal(reloads, 0, 'context invalidation is synchronous, reload is still scheduled');
    assert.equal(interceptor.secondarySubtitles.length, 0);
    assert.equal(interceptor.secondaryTimeIndex, null);
    assert.equal(interceptor.secondarySubtitleMeta, null);
    assert.equal(interceptor.selectedSecondaryTrack, null);
    assert.equal(interceptor.effectiveSecondaryLanguage, null);
    assert.equal(interceptor.primarySubtitles, primary);
    assert.equal(interceptor.primarySubtitleMeta, primaryMeta);
    release();
    await harness.settleRuntime();
    assert.equal(harness.runtimePublications.length, 1);
    const publication = harness.runtimePublications[0].payload;
    assert.equal(publication.context.videoId, update.videoId || 'episode-A');
    assert.equal(publication.context.sessionId, update.sessionId || 'watch-episode-A');
    assert.equal(publication.context.epoch, update.epoch || 1);
    assert.equal(publication.snapshot.status, 'resolving');
    assert.equal(publication.snapshot.effectiveLanguage, null);
    assert.equal(publication.snapshot.isManualFallback, false);
    assert.deepEqual(publication.snapshot.quality, { isCC: false, degraded: false });
    assert.equal(formatSecondaryRuntimeStatus('auto', publication.snapshot), '自動：解析中…');
    interceptor.stop();
    await harness.settleRuntime();
  }
});

test('DOM emergency invalidation replaces a delayed ready publication without reviving secondary or changing primary data', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = await createTTMLHarness({ runtimeImportGate: () => gate });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.dualSubtitleEnabled = true;
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  await interceptor.ensureSecondaryLanguageAvailableOnce('ready-before-emergency');
  interceptor.isInitialized = true;
  interceptor.isActive = true;
  void interceptor.publishSecondaryRuntimeStatus();
  const primary = interceptor.primarySubtitles;
  assert.equal((await harness.enterDomEmergency('page-script-unavailable')).currentMode, 'dom');
  release();
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.length, 1);
  const snapshot = harness.runtimePublications[0].payload.snapshot;
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.effectiveLanguage, null);
  assert.equal(snapshot.isManualFallback, false);
  assert.equal(interceptor.secondarySubtitles.length, 0);
  assert.equal(interceptor.primarySubtitles, primary);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('a delayed ready publication cannot borrow a new resolution generation after dual mode is disabled and reenabled in the same context', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = await createTTMLHarness({ runtimeImportGate: () => gate });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.dualSubtitleEnabled = true;
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  await interceptor.ensureSecondaryLanguageAvailableOnce('ready-before-disable');
  interceptor.isInitialized = true;
  interceptor.isActive = true;
  void interceptor.publishSecondaryRuntimeStatus();
  interceptor.applyDualSubtitleEnabled(false);
  interceptor.applyDualSubtitleEnabled(true);
  release();
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.length, 0, 'old ready snapshot must not gain authority from the reenabled lifecycle');
  interceptor.dispatchSubtitleReadinessChanged('reenabled');
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.status, 'resolving');
  const callsBeforeFreshInvocation = harness.playbackCalls().length;
  await interceptor.ensureSecondaryLanguageAvailableOnce('fresh-reenabled-invocation');
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.status, 'ready');
  assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.effectiveLanguage, 'en');
  assert.equal(harness.playbackCalls().length, callsBeforeFreshInvocation);
  interceptor.stop();
  await harness.settleRuntime();
});

test('same-language different-source captures promote secondary independently without replacing the primary CC slot', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.primaryLanguage = 'en';
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'primary CC', trackId: 'en-cc' });
  interceptor.dualSubtitleEnabled = true;
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'secondary full', trackId: 'en-track' });
  assert.equal(harness.readiness().primary.trackId, 'en-cc');
  assert.equal(harness.readiness().secondary.trackId, 'en-track');
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(harness.render().primaryText, 'primary CC');
  assert.equal(harness.render().secondaryText, 'secondary full');
});

test('primary-only changes suppress and restore retained secondary data without resolution, downloads or track switches', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.configBridge = { async setSubtitleLanguages() {} };
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary zh' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'original en' });
  interceptor.applyConfiguredSecondaryLanguage('auto');
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language',
    originalLanguage: { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en'] } } });
  interceptor.dualSubtitleEnabled = true;
  await interceptor.ensureSecondaryLanguageAvailableOnce('initial');
  assert.equal(harness.render().secondaryText, 'original en');
  interceptor.isInitialized = true;
  interceptor.isActive = true;
  harness.playbackCalls().length = 0;
  await interceptor.setLanguages('en', 'auto');
  assert.equal(harness.readiness().primary.trackId, 'en-track');
  assert.equal(interceptor.secondarySubtitles.length, 0);
  assert.equal(harness.render().secondaryText, '');
  await interceptor.setLanguages('zh-Hant', 'auto');
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(harness.render().secondaryText, 'original en');
  assert.equal(harness.playbackCalls().length, 0);
});

test('same-language distinct primary CC and secondary full tracks survive cache acquisition and readiness independently', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.primaryLanguage = 'en';
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'primary CC', trackId: 'en-cc' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'cached full', trackId: 'en-track' });
  interceptor.dualSubtitleEnabled = true;
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('same-language-cache');
  assert.equal(result.success, true);
  assert.equal(harness.readiness().primary.trackId, 'en-cc');
  assert.equal(harness.readiness().secondary.trackId, 'en-track');
  assert.equal(harness.render().secondaryText, 'cached full');
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('either missing track identity suppresses only canonical exact language, not a shared base', async () => {
  for (const [primaryId, secondaryId] of [[null, 'en-track'], ['en-cc', null], [null, null]]) {
    for (const [primaryLanguage, suppressed] of [['EN', true], ['en-US', false]]) {
      const harness = await createTTMLHarness({ prepareSecondary: false });
      const interceptor = harness.interceptor();
      harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [
        { code: 'en', trackId: secondaryId, trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
          isNoneTrack: false, isForcedNarrative: false }
      ] } });
      await interceptor.prepareSecondaryTrack();
      interceptor.primaryLanguage = primaryLanguage;
      interceptor.dualSubtitleEnabled = false;
      harness.capture({ videoId: 'episode-A', language: primaryLanguage, text: 'primary', trackId: primaryId });
      harness.capture({ videoId: 'episode-A', language: 'en', text: 'full', trackId: secondaryId });
      interceptor.dualSubtitleEnabled = true;
      const result = await interceptor.ensureSecondaryLanguageAvailableOnce('identity-fallback');
      assert.equal(result.success, true);
      assert.equal(harness.readiness().secondary.ready, !suppressed);
      assert.equal(harness.render().secondaryText, suppressed ? '' : 'full');
      assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
    }
  }
});

test('new video, session and epoch contexts immediately clear only secondary runtime before any reload or render', async () => {
  for (const update of [
    { videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 },
    { sessionId: 'watch-episode-A-new' },
    { epoch: 2 },
    { state: 'transitioning' },
    { state: 'unavailable', videoId: null, sessionId: null }
  ]) {
    const harness = await createTTMLHarness();
    const interceptor = harness.interceptor();
    interceptor.dualSubtitleEnabled = false;
    captureActiveEpisode(harness, 'episode-A', 'A');
    interceptor.dualSubtitleEnabled = true;
    interceptor.applyConfiguredSecondaryLanguage('auto');
    harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
      status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
    } } });
    await interceptor.ensureSecondaryLanguageAvailableOnce('seed');
    assert.equal(harness.readiness().secondary.ready, true);
    const primary = interceptor.primarySubtitles;
    const primaryMeta = interceptor.primarySubtitleMeta;
    interceptor.setupEventHandlers();
    harness.changeContext(update);
    assert.equal(interceptor.secondarySubtitles.length, 0);
    assert.equal(interceptor.secondaryTimeIndex, null);
    assert.equal(interceptor.secondarySubtitleMeta, null);
    assert.equal(interceptor.effectiveSecondaryLanguage, null);
    assert.equal(interceptor.selectedSecondaryTrack, null);
    assert.equal(interceptor.primarySubtitles, primary);
    assert.equal(interceptor.primarySubtitleMeta, primaryMeta);
    interceptor.stop();
  }
});

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

test('auto secondary intercepted after primary defer publishes ready instead of caching a permanent resolving success', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.isInitialized = true;
  interceptor.isActive = true;
  interceptor.setupEventHandlers();
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [{ code: 'en', trackId: 'en-track',
    trackType: 'PRIMARY', rawTrackType: 'SUBTITLES', isNoneTrack: false, isForcedNarrative: false }] } });
  const deferred = await interceptor.ensureSecondaryLanguageAvailableOnce('next-episode-before-primary');
  assert.equal(deferred.reason, 'deferred-primary-not-ready');
  // Netflix 已攔截目標字幕後，下一個取得入口應完成狀態，而不是重新切軌。
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'Original subtitles', trackId: 'en-track' });
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: '主要字幕' });
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('next-episode-interception');
  assert.equal(result.success, true);
  assert.equal(result.source, 'already-ready');
  assert.equal(harness.readiness().secondary.ready, true);
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'ready');
  assert.equal(interceptor.getStatus().secondaryResolution.reason, 'original-language-subtitles-ready');
  await harness.poll();
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.at(-1).payload.snapshot.status, 'ready');
  assert.equal(formatSecondaryRuntimeStatus('auto', harness.runtimePublications.at(-1).payload.snapshot), '自動：English');
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 1);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
  assert.deepEqual(harness.render(), { primaryText: '主要字幕', secondaryText: 'Original subtitles', secondaryLanguage: 'en' });
  interceptor.stop();
});

test('late selected-track reads cannot cross an auto/manual/auto generation or overwrite the newer selected identity', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  let finishOld;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  harness.setPlaybackResult('available-languages', () => {
    started();
    return new Promise(resolve => { finishOld = resolve; });
  });
  const old = interceptor.prepareSecondaryTrack();
  await reading;
  interceptor.applyConfiguredSecondaryLanguage('ja');
  interceptor.applyConfiguredSecondaryLanguage('en');
  const track = { code: 'en', trackId: 'new-en', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES', isNoneTrack: false, isForcedNarrative: false };
  harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [track] } });
  await interceptor.prepareSecondaryTrack();
  finishOld({ ok: true, value: { variant: 'available-languages', languages: [{ ...track, trackId: 'old-en' }] } });
  await old;
  assert.equal(interceptor.getStatus().selectedSecondaryTrack.trackId, 'new-en');
});

test('stop invalidates pending original-language work even before the interceptor was started', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.applyConfiguredSecondaryLanguage('auto');
  let finish;
  harness.setPlaybackResult('original-language', () => new Promise(resolve => { finish = resolve; }));
  const old = interceptor.ensureSecondaryLanguageAvailableOnce('pending-stop');
  interceptor.stop();
  finish({ ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  await old;
  assert.equal(interceptor.effectiveSecondaryLanguage, null);
  assert.equal(interceptor.secondarySubtitles.length, 0);
  assert.equal(harness.playbackCalls().length, 1);
});

test('real page setter responses retain actual targets and never restore over a user CC selection during the setter', async () => {
  for (const [mode, variant] of [
    ['en', 'switch-track'], ['auto', 'switch-track'],
    ['en', 'switch-secondary-language'], ['auto', 'switch-secondary-language'],
    ['en', 'switch-language'], ['auto', 'switch-language']
  ]) {
    const target = { bcp47: 'en', trackId: 'en-track', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES', isNoneTrack: false, isForcedNarrative: false };
    const user = { ...target, trackId: 'user-en-cc', trackType: 'ASSISTIVE', rawTrackType: 'CLOSEDCAPTIONS' };
    const starting = { ...target, bcp47: 'zh-Hant', trackId: 'zh-track' };
    const page = createPrivatePlaybackPage({
      context: { videoId: '81234567', sessionId: 'watch-81234567', epoch: 1 },
      tracks: [starting, target, user], startingTrack: starting,
      async afterSet(track, select) {
        if (track.trackId === 'en-track') {
          select(user);
          // 即使 Netflix 後續改寫原物件，ack 仍須保存 setter 前的 target evidence。
          track.trackId = 'mutated-target';
        }
      }
    });
    if (variant !== 'switch-track') {
      const response = await page.perform(variant, variant === 'switch-secondary-language' ?
        { languageCode: 'en', excludedTrackIds: [] } : { languageCode: 'en' });
      assert.equal(response.ok, true);
      assert.equal(response.value.variant, variant);
      assert.equal(response.value.language.trackId, 'en-track');
      assert.equal(page.current().trackId, 'user-en-cc');
      assert.deepEqual(page.mutations, ['en-track']);
      continue;
    }
    const harness = await createTTMLHarness({ prepareSecondary: false });
    harness.changeContext({ videoId: '81234567', sessionId: 'watch-81234567', epoch: 1 });
    const interceptor = harness.interceptor();
    interceptor.applyDualSubtitleEnabled(false);
    harness.capture({ videoId: '81234567', language: 'zh-Hant', text: 'primary' });
    interceptor.applyConfiguredSecondaryLanguage(mode);
    harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
      status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
    } } });
    interceptor.applyDualSubtitleEnabled(true);
    const setterResponses = [];
    for (const operation of ['current-language', 'switch-track']) {
      harness.setPlaybackResult(operation, async input => {
        const response = await page.perform(input.variant, input.payload, input.expected);
        if (operation === 'switch-track') setterResponses.push(response);
        return response;
      });
    }
    await interceptor.ensureSecondaryLanguageAvailableOnce('producer-user-race', { timeoutMs: 1 });
    assert.equal(setterResponses.length, 1);
    assert.equal(setterResponses[0].ok, true);
    assert.equal(setterResponses[0].value.language.trackId, 'en-track');
    assert.equal(page.current().trackId, 'user-en-cc');
    assert.deepEqual(page.mutations, ['en-track']);
  }
});

test('consumer rejects a mismatched setter acknowledgement before claiming the user track', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.applyDualSubtitleEnabled(false);
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.applyDualSubtitleEnabled(true);
  let native = { code: 'zh-Hant', trackId: 'zh-track' };
  harness.setPlaybackResult('current-language', () => ({ ok: true, value: { variant: 'current-language', language: native } }));
  harness.setPlaybackResult('switch-track', () => {
    native = { code: 'en', trackId: 'user-en-cc' };
    return { ok: true, value: { variant: 'switch-track', language: native } };
  });
  await interceptor.ensureSecondaryLanguageAvailableOnce('mismatched-ack', { timeoutMs: 1 });
  assert.equal(native.trackId, 'user-en-cc');
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).map(call => call.payload.trackId), ['en-track']);
});

test('secondary finally never restores over a user-selected Netflix track, including same-language different identity', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  let native = { code: 'zh-Hant', trackId: 'zh-track' };
  harness.setPlaybackResult('current-language', () => ({ ok: true, value: { variant: 'current-language', language: native } }));
  harness.setPlaybackResult('switch-track', input => {
    native = { code: 'en', trackId: input.payload.trackId };
    harness.capture({ videoId: 'episode-A', language: 'en', text: 'secondary', trackId: input.payload.trackId });
    // 使用者選到另一條同語言軌；只比較語言會錯誤 restore。
    native = { code: 'en', trackId: 'user-en-cc' };
    return { ok: true, value: { variant: 'switch-track', language: { code: 'en', trackId: input.payload.trackId } } };
  });
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('user-changed', { timeoutMs: 20 })).success, true);
  assert.equal(native.trackId, 'user-en-cc');
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).map(call => call.payload.trackId), ['en-track']);
});

test('native primary and legacy secondary operations wait for secondary acquisition and its owned restore', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.sleep = async () => {};
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  let native = { code: 'zh-Hant', trackId: 'zh-track' };
  let finish;
  let started;
  const switching = new Promise(resolve => { started = resolve; });
  harness.setPlaybackResult('current-language', () => ({ ok: true, value: { variant: 'current-language', language: native } }));
  harness.setPlaybackResult('switch-track', input => {
    native = { code: input.payload.trackId === 'en-track' ? 'en' : 'zh-Hant', trackId: input.payload.trackId };
    if (input.payload.trackId !== 'en-track') return { ok: true, value: { variant: 'switch-track', language: native } };
    started();
    return new Promise(resolve => { finish = () => {
      harness.capture({ videoId: 'episode-A', language: 'en', text: 'secondary', trackId: 'en-track' });
      resolve({ ok: true, value: { variant: 'switch-track', language: native } });
    }; });
  });
  harness.setPlaybackResult('switch-language', input => {
    native = { code: input.payload.languageCode, trackId: `${input.payload.languageCode}-track` };
    return { ok: true, value: { variant: 'switch-language', language: native } };
  });
  const secondary = interceptor.ensureSecondaryLanguageAvailableOnce('serialized', { timeoutMs: 100 });
  await switching;
  const primary = interceptor.switchLanguageAndWait('ja', 'primary', { timeoutMs: 5 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.playbackCalls().some(call => call.payload?.languageCode === 'ja'), false);
  finish();
  await Promise.all([secondary, primary]);
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).map(call => call.payload.trackId || call.payload.languageCode),
    ['en-track', 'zh-track', 'ja', 'zh-track']);
});

test('DOM recovery success returns the common success result and a third auto attempt stays ready across later polls', async () => {
  for (const mode of ['auto', 'en']) {
    const requestInfo = createRequestInfo('episode-A', 'en');
    const harness = await createTTMLHarness({
      prepareSecondary: false, realContextPoll: true,
      domSample: { text: 'Recovered', timestamp: 1 },
      domMatchResult: { matched: true, result: {
        cacheKey: 'en_episode-B_fixture_en-track', language: 'en', rawContent: 'Recovered', requestInfo,
        score: 1, matchedUnits: 1, totalDomUnits: 1
      } }
    });
    const interceptor = harness.interceptor();
    interceptor.setupEventHandlers();
    interceptor.applyDualSubtitleEnabled(false);
    harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
    interceptor.applyConfiguredSecondaryLanguage(mode);
    interceptor.applyDualSubtitleEnabled(true);
    interceptor.isActive = true;
    interceptor.sleep = async () => {};
    harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
      status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
    } } });
    harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
    if (mode === 'auto') {
      for (const reason of ['first', 'second']) {
        assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce(reason, { retryAuto: true, timeoutMs: 1 })).success, false);
      }
    }
    harness.capture({ videoId: 'episode-B', language: 'en', text: 'Recovered', trackId: 'en-track' });
    const recovered = await interceptor.ensureSecondaryLanguageAvailableOnce('recovery', { retryAuto: true, timeoutMs: 1 });
    assert.equal(recovered.success, true, `${mode}: ready recovery cannot return or cache the preceding timeout`);
    assert.equal(recovered.source, 'dom-recovery');
    assert.equal(harness.readiness().secondary.ready, true);
    assert.equal(harness.readiness().primary.ready, true);
    assert.equal(harness.readiness().secondary.resolution.status, mode === 'auto' ? 'ready' : 'manual');
    assert.equal(harness.render().secondaryText, 'Recovered');
    await harness.settleRuntime();
    assert.equal(harness.runtimePublications.at(-1)?.payload.snapshot.status, mode === 'auto' ? 'ready' : 'manual');
    const callsAfterRecovery = harness.playbackCalls().filter(call => call.variant !== 'context-snapshot').length;
    for (let poll = 0; poll < 5; poll += 1) await harness.poll();
    assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('after-recovery', { retryAuto: true, timeoutMs: 1 })).success, true);
    assert.equal(harness.playbackCalls().filter(call => call.variant !== 'context-snapshot').length, callsAfterRecovery);
    assert.equal(interceptor.debugEvents.filter(event => event.type === 'AUTO_SECONDARY_ATTEMPT').at(-1)?.attempt ?? 0, mode === 'auto' ? 3 : 0);
    assert.equal(harness.readiness().secondary.resolution.status, mode === 'auto' ? 'ready' : 'manual');
  }
});

test('disabling manual or auto acquisition restores only a still-owned native target in the same context', async () => {
  for (const mode of ['en', 'auto']) {
    for (const boundary of ['owned', 'late-setter', 'user-track', 'context']) {
      const harness = await createTTMLHarness({ prepareSecondary: false });
      const interceptor = harness.interceptor();
      interceptor.configBridge = { async setDualSubtitleEnabled() {} };
      interceptor.applyDualSubtitleEnabled(false);
      harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
      interceptor.applyConfiguredSecondaryLanguage(mode);
      interceptor.applyDualSubtitleEnabled(true);
      harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
        status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
      } } });
      let native = { code: 'zh-Hant', trackId: 'zh-track' };
      let switched;
      const switching = new Promise(resolve => { switched = resolve; });
      let releaseSetter;
      const setterGate = new Promise(resolve => { releaseSetter = resolve; });
      harness.setPlaybackResult('current-language', () => ({ ok: true, value: { variant: 'current-language', language: native } }));
      harness.setPlaybackResult('switch-track', async input => {
        native = { code: input.payload.trackId === 'en-track' ? 'en' : 'zh-Hant', trackId: input.payload.trackId };
        if (input.payload.trackId === 'en-track') switched();
        if (boundary === 'late-setter') await setterGate;
        return { ok: true, value: { variant: 'switch-track', language: native } };
      });
      const pending = interceptor.ensureSecondaryLanguageAvailableOnce('cancel-acquisition', { timeoutMs: 1000 });
      await switching;
      await new Promise(resolve => setImmediate(resolve));
      if (boundary === 'user-track') native = { code: 'en', trackId: 'user-en-cc' };
      if (boundary === 'context') harness.changeContext({ videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 });
      await interceptor.setDualSubtitleEnabled(false);
      releaseSetter();
      await pending;
      const stillOwned = boundary === 'owned' || boundary === 'late-setter';
      assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).map(call => call.payload.trackId),
        stillOwned ? ['en-track', 'zh-track'] : ['en-track'], `${mode}/${boundary}`);
      assert.equal(native.trackId, stillOwned ? 'zh-track' : boundary === 'user-track' ? 'user-en-cc' : 'en-track');
      assert.equal(harness.readiness().primary.ready, boundary !== 'context');
      assert.equal(harness.readiness().secondary.ready, false);
    }
  }
});

test('disabled then reenabled cannot revive a pending resolution but completed context cache remains reusable', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.configBridge = { async setDualSubtitleEnabled() {} };
  interceptor.applyConfiguredSecondaryLanguage('auto');
  let finish;
  harness.setPlaybackResult('original-language', () => new Promise(resolve => { finish = resolve; }));
  const old = interceptor.ensureSecondaryLanguageAvailableOnce('before-disable');
  await interceptor.setDualSubtitleEnabled(false);
  await interceptor.setDualSubtitleEnabled(true);
  finish({ ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja']
  } } });
  await old;
  assert.equal(interceptor.effectiveSecondaryLanguage, null);
  assert.equal(interceptor.selectedSecondaryTrack, null);
  assert.equal(harness.playbackCalls().length, 1);
});

test('a late secondary setter from A cannot restore using ready B context or overwrite B slot, retry or identity', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'A primary' });
  interceptor.dualSubtitleEnabled = true;
  let finish;
  let started;
  const switching = new Promise(resolve => { started = resolve; });
  harness.setPlaybackResult('current-language', () => ({ ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } }));
  harness.setPlaybackResult('switch-track', () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const old = interceptor.ensureSecondaryLanguageAvailableOnce('old-A', { timeoutMs: 20 });
  await switching;
  interceptor.setupEventHandlers();
  harness.changeContext({ videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 });
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-B', 'B');
  interceptor.dualSubtitleEnabled = true;
  const current = interceptor.ensureSecondaryLanguageAvailableOnce('new-B', { timeoutMs: 20 });
  await interceptor.loadLanguageDataFromCache('zh-Hant', 'primary');
  finish({ ok: true, value: { variant: 'switch-track', language: { code: 'en', trackId: 'en-track' } } });
  await Promise.all([old, current]);
  assert.deepEqual(harness.render(), { primaryText: 'B primary', secondaryText: 'B secondary', secondaryLanguage: 'en' });
  assert.equal(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).length, 1);
  assert.equal(interceptor.lastAcquisitionResults.secondary.success, true);
  interceptor.stop();
});

test('restore fails closed when the native current track loses its known owned identity', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  let native = { code: 'zh-Hant', trackId: 'zh-track' };
  harness.setPlaybackResult('current-language', () => ({ ok: true, value: { variant: 'current-language', language: native } }));
  harness.setPlaybackResult('switch-track', input => {
    harness.capture({ videoId: 'episode-A', language: 'en', text: 'secondary', trackId: 'en-track' });
    native = { code: 'en', trackId: null };
    return { ok: true, value: { variant: 'switch-track', language: { code: 'en', trackId: input.payload.trackId } } };
  });
  await interceptor.ensureSecondaryLanguageAvailableOnce('unknown-current-identity', { timeoutMs: 10 });
  assert.equal(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).length, 1);
});

test('manual concurrent acquisition shares selected-track discovery and the complete switch plus restore promise', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.dualSubtitleEnabled = true;
  const results = await Promise.all([
    interceptor.ensureSecondaryLanguageAvailableOnce('manual-1'),
    interceptor.ensureSecondaryLanguageAvailableOnce('manual-2')
  ]);
  assert.equal(results.every(result => result.success), true);
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'available-languages').length, 1);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('a late restore current-track read cannot borrow the new context even when B reports the old owned target', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  let native = { code: 'zh-Hant', trackId: 0 };
  let switched = false;
  let restoreRead;
  let finishRead;
  const restoring = new Promise(resolve => { restoreRead = resolve; });
  harness.setPlaybackResult('current-language', () => {
    if (switched) {
      restoreRead();
      return new Promise(resolve => { finishRead = resolve; });
    }
    return { ok: true, value: { variant: 'current-language', language: native } };
  });
  harness.setPlaybackResult('switch-track', input => {
    const startReference = native;
    native = { code: 'en', trackId: input.payload.trackId };
    startReference.trackId = 'mutated-after-capture';
    switched = true;
    harness.capture({ videoId: 'episode-A', language: 'en', text: 'secondary', trackId: 'en-track' });
    return { ok: true, value: { variant: 'switch-track', language: native } };
  });
  const old = interceptor.ensureSecondaryLanguageAvailableOnce('restore-read-A', { timeoutMs: 20 });
  await restoring;
  interceptor.setupEventHandlers();
  harness.changeContext({ videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 });
  finishRead({ ok: true, value: { variant: 'current-language', language: native } });
  await old;
  assert.equal(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).length, 1);
  assert.equal(interceptor.effectiveSecondaryLanguage, null);
  assert.equal(interceptor.secondarySubtitles.length, 0);
  interceptor.stop();
});

test('the immutable numeric-zero starting track survives mutation of the returned playback object', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  let native = { code: 'zh-Hant', trackId: 0 };
  harness.setPlaybackResult('current-language', () => ({ ok: true, value: { variant: 'current-language', language: native } }));
  harness.setPlaybackResult('switch-track', input => {
    const previous = native;
    native = { code: input.payload.trackId === 0 ? 'zh-Hant' : 'en', trackId: input.payload.trackId };
    previous.trackId = 'mutated';
    if (input.payload.trackId === 'en-track') harness.capture({ videoId: 'episode-A', language: 'en', text: 'secondary', trackId: 'en-track' });
    return { ok: true, value: { variant: 'switch-track', language: native } };
  });
  await interceptor.ensureSecondaryLanguageAvailableOnce('immutable-start', { timeoutMs: 20 });
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant === 'switch-track').map(call => call.payload.trackId), ['en-track', 0]);
});

test('late last-manual fallback preference cannot revive stopped, disabled, mode-replaced or newer-video work', async () => {
  for (const boundary of ['stop', 'disabled', 'mode', 'context']) {
    const harness = await createTTMLHarness({ prepareSecondary: false });
    const interceptor = harness.interceptor();
    interceptor.dualSubtitleEnabled = false;
    captureActiveEpisode(harness, 'episode-A', 'A');
    interceptor.dualSubtitleEnabled = true;
    interceptor.applyConfiguredSecondaryLanguage('auto');
    let finish;
    let reading;
    const preferenceRead = new Promise(resolve => { reading = resolve; });
    interceptor.configBridge = {
      async setDualSubtitleEnabled() {},
      readLastManualSecondaryLanguage() { reading(); return new Promise(resolve => { finish = resolve; }); }
    };
    harness.setPlaybackResult('original-language', { ok: false, error: {
      kind: 'domain-rejected', code: 'original-language-unavailable', retryable: false
    } });
    const old = interceptor.ensureSecondaryLanguageAvailableOnce(`pending-preference-${boundary}`);
    await preferenceRead;
    if (boundary === 'stop') interceptor.stop();
    if (boundary === 'disabled') {
      await interceptor.setDualSubtitleEnabled(false);
      await interceptor.setDualSubtitleEnabled(true);
    }
    if (boundary === 'mode') {
      interceptor.applyConfiguredSecondaryLanguage('ja');
      interceptor.applyConfiguredSecondaryLanguage('auto');
    }
    if (boundary === 'context') {
      interceptor.setupEventHandlers();
      harness.changeContext({ videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 });
      interceptor.dualSubtitleEnabled = false;
      captureActiveEpisode(harness, 'episode-B', 'B');
      interceptor.dualSubtitleEnabled = true;
      harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
        status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
      } } });
      await interceptor.loadLanguageDataFromCache('zh-Hant', 'primary');
      assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('new-B')).success, true);
    }
    finish('ja');
    assert.equal((await old).reason, 'stale-original-language-resolution');
    assert.equal(interceptor.effectiveSecondaryLanguage, boundary === 'context' ? 'en' : null);
    if (boundary === 'context') assert.equal(harness.render().secondaryText, 'B secondary');
    assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
    interceptor.stop();
  }
});

test('effective-language ABA starts a fresh acquisition rather than borrowing an older same-key pending job', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  let finish;
  let started;
  const switching = new Promise(resolve => { started = resolve; });
  harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  harness.setPlaybackResult('switch-track', input => {
    started();
    return new Promise(resolve => { finish = () => resolve({ ok: true, value: { variant: 'switch-track', language: { code: 'en', trackId: input.payload.trackId } } }); });
  });
  const old = interceptor.ensureSecondaryLanguageAvailableOnce('old-target', { timeoutMs: 20 });
  await switching;
  interceptor.setEffectiveSecondaryLanguage('ja', { status: 'manual', reason: 'temporary-target' });
  interceptor.setEffectiveSecondaryLanguage('en', { status: 'manual', reason: 'new-target' });
  harness.capture({ videoId: 'episode-A', language: 'en', text: 'new target', trackId: 'en-track' });
  const current = interceptor.ensureSecondaryLanguageAvailableOnce('new-target', { timeoutMs: 20 });
  finish();
  const [oldResult, currentResult] = await Promise.all([old, current]);
  assert.equal(oldResult.success, false);
  assert.equal(currentResult.success, true);
  assert.equal(harness.render().secondaryText, 'new target');
});

test('context invalidation during DOM recovery current-track capture releases the recovery owner without restoring', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-B', language: 'en', text: 'raw candidate', trackId: 'en-track' });
  interceptor.dualSubtitleEnabled = true;
  let finish;
  let started;
  const capturing = new Promise(resolve => { started = resolve; });
  harness.setPlaybackResult('current-language', () => {
    started();
    return new Promise(resolve => { finish = resolve; });
  });
  const old = interceptor.trySecondaryDomRecovery('capture-old-context');
  await capturing;
  interceptor.setupEventHandlers();
  harness.changeContext({ videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 });
  finish({ ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  assert.equal(await old, false);
  assert.equal(interceptor.getStatus().secondaryRecovery.inFlight, false);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
  interceptor.stop();
});

test('exhausted auto negative cache resets for session, epoch and track revision but not an ordinary reload', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.setupEventHandlers();
  interceptor.isActive = true;
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'unknown', reason: 'no-valid-native-audio-language'
  } } });
  const originals = () => harness.playbackCalls().filter(call => call.variant === 'original-language').length;
  await interceptor.ensureSecondaryLanguageAvailableOnce('initial');
  await harness.poll();
  await harness.poll();
  for (let i = 0; i < 4; i += 1) await harness.poll();
  await interceptor.ensureSecondaryLanguageAvailableOnce('ordinary-reload');
  assert.equal(originals(), 3);
  harness.changeContext({ sessionId: 'watch-episode-A-reconnected' });
  await harness.poll();
  assert.equal(originals(), 4);
  harness.changeContext({ epoch: 2 });
  await harness.poll();
  assert.equal(originals(), 5);
  harness.setTrackListRevision(1);
  await harness.poll();
  assert.equal(originals(), 6);
  interceptor.stop();
});

test('dubbing and audio-description observations with stable video session epoch and list revision keep the successful secondary cache', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'A');
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.dualSubtitleEnabled = true;
  harness.setTrackListRevision(0);
  harness.setPlaybackResult('original-language', { ok: true, value: { variant: 'original-language', originalLanguage: {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
  } } });
  await interceptor.ensureSecondaryLanguageAvailableOnce('initial');
  const calls = harness.playbackCalls().length;
  interceptor.setupEventHandlers();
  interceptor.isActive = true;
  for (const observed of ['dubbing', 'audio-description']) {
    harness.changeContext({ source: observed, updatedAt: Date.now() });
    await harness.poll();
    assert.equal(harness.readiness().secondary.ready, true);
    assert.equal(harness.render().secondaryText, 'A secondary');
    assert.equal(harness.playbackCalls().length, calls);
  }
  interceptor.stop();
});

test('real coordinator DOM emergency and page-script-unavailable transitions clear secondary work without interrupting primary data', async () => {
  for (const pending of [false, true]) {
    const harness = await createTTMLHarness({ prepareSecondary: false });
    const interceptor = harness.interceptor();
    interceptor.dualSubtitleEnabled = false;
    captureActiveEpisode(harness, 'episode-A', 'A');
    interceptor.dualSubtitleEnabled = true;
    interceptor.applyConfiguredSecondaryLanguage('auto');
    let finish;
    const response = { ok: true, value: { variant: 'original-language', originalLanguage: {
      status: 'resolved', reason: 'native-audio-language', baseLanguage: 'en', languages: ['en']
    } } };
    harness.setPlaybackResult('original-language', pending ? () => new Promise(resolve => { finish = resolve; }) : response);
    const acquisition = interceptor.ensureSecondaryLanguageAvailableOnce('before-emergency');
    if (!pending) {
      await acquisition;
      assert.equal(harness.readiness().secondary.ready, true);
    }
    const primary = interceptor.primarySubtitles;
    const result = await harness.enterDomEmergency(pending ? 'page-script-unavailable' : 'interception-failure-threshold');
    assert.deepEqual(result, { currentMode: 'dom', nativeStarted: true });
    if (pending) finish(response);
    await acquisition;
    assert.equal(interceptor.secondarySubtitles.length, 0);
    assert.equal(interceptor.secondaryTimeIndex, null);
    assert.equal(interceptor.secondarySubtitleMeta, null);
    assert.equal(interceptor.selectedSecondaryTrack, null);
    assert.equal(interceptor.effectiveSecondaryLanguage, null);
    assert.equal(interceptor.primarySubtitles, primary);
    assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
  }
});

test('new context releases an old primary interception wait without clearing primary data or delaying the native queue', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.sleep = async () => {};
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  interceptor.dualSubtitleEnabled = true;
  const primaryData = interceptor.primarySubtitles;
  let started;
  const switching = new Promise(resolve => { started = resolve; });
  harness.setPlaybackResult('switch-language', input => {
    started();
    return { ok: true, value: { variant: 'switch-language', language: { code: input.payload.languageCode, trackId: 'ja-track' } } };
  });
  let settled = false;
  const old = interceptor.switchLanguageAndWait('ja', 'primary', { timeoutMs: 100 }).then(result => { settled = true; return result; });
  await switching;
  interceptor.setupEventHandlers();
  harness.changeContext({ videoId: 'episode-B', sessionId: 'watch-episode-B', epoch: 2 });
  assert.equal(interceptor.primarySubtitles, primaryData);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  assert.equal((await old).reason, 'stale-native-work');
  assert.equal(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).length, 1);
  interceptor.stop();
});

test('standalone DOM recovery holds the shared native sequence through its wait and restore before legacy primary refresh', async () => {
  const harness = await createTTMLHarness();
  const interceptor = harness.interceptor();
  interceptor.dualSubtitleEnabled = false;
  harness.capture({ videoId: 'episode-A', language: 'zh-Hant', text: 'primary' });
  harness.capture({ videoId: 'episode-B', language: 'en', text: 'raw candidate', trackId: 'en-track' });
  interceptor.dualSubtitleEnabled = true;
  harness.setPlaybackResult('current-language', { ok: true, value: { variant: 'current-language', language: { code: 'zh-Hant', trackId: 'zh-track' } } });
  let finish;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  interceptor.sleep = async ms => {
    if (ms !== 1200) return;
    started();
    await new Promise(resolve => { finish = resolve; });
  };
  const recovery = interceptor.trySecondaryDomRecovery('serialized-recovery');
  await waiting;
  const primary = interceptor.switchLanguageAndWait('ja', 'primary', { timeoutMs: 5 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.playbackCalls().some(call => call.payload?.languageCode === 'ja'), false);
  finish();
  assert.equal(await recovery, false);
  await primary;
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')).map(call => call.payload.trackId || call.payload.languageCode),
    ['en-track', 'zh-track', 'ja', 'zh-track']);
});

test('auto original unknown, ambiguous and missing subtitles keep primary ready and publish distinct reasons without manual fallback', async () => {
  for (const resolution of [
    { status: 'unknown', reason: 'no-valid-native-audio-language' },
    { status: 'ambiguous', reason: 'multiple-native-audio-languages' },
    { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja'] }
  ]) {
    const harness = await createTTMLHarness({ prepareSecondary: false });
    const interceptor = harness.interceptor();
    interceptor.configBridge = { async readLastManualSecondaryLanguage() { assert.fail('negative original resolution must not read manual preference'); } };
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
    await harness.settleRuntime();
    assert.equal(harness.runtimePublications.at(-1).payload.snapshot.status, resolution.status === 'resolved' ? 'missing' : resolution.status);
    assert.equal(harness.runtimePublications.at(-1).payload.snapshot.reason, expectedReason);
    assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 1);
    assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
    assert.equal(interceptor.getStatus().selectedSecondaryTrack, null);
  }
});

test('only audio capability unavailable with working playback falls back to last manual and keeps configured auto', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  let preferenceReads = 0;
  interceptor.configBridge = { async readLastManualSecondaryLanguage() { preferenceReads += 1; return 'en'; } };
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.dualSubtitleEnabled = false;
  captureActiveEpisode(harness, 'episode-A', 'fallback', Date.now());
  await harness.reloadCurrentContext();
  harness.setPlaybackResult('original-language', { ok: false, error: { kind: 'domain-rejected', code: 'original-language-unavailable', retryable: false } });
  interceptor.dualSubtitleEnabled = true;
  const result = await interceptor.ensureSecondaryLanguageAvailableOnce('audio-unavailable');
  assert.equal(result.success, true, JSON.stringify({ result, events: interceptor.debugEvents }));
  assert.equal(interceptor.getStatus().configuredSecondaryLanguage, 'auto');
  assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, 'en');
  assert.equal(harness.render().secondaryText, 'fallback secondary');
  assert.equal(harness.readiness().primary.ready, true);
  await interceptor.ensureSecondaryLanguageAvailableOnce('cached-fallback');
  assert.equal(preferenceReads, 1);
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 1);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
});

test('page-script failure, timeout, invalid response or unavailable playback never reads fallback preference or acquires secondary', async () => {
  for (const error of [
    { kind: 'disconnected', code: 'playback-disconnected', retryable: true },
    { kind: 'timeout', code: 'playback-timeout', retryable: true },
    { kind: 'stale', code: 'stale-playback-context', retryable: false },
    { kind: 'domain-rejected', code: 'invalid-playback-response', retryable: false },
    { kind: 'domain-rejected', code: 'original-language-unavailable', retryable: true },
    { kind: 'domain-rejected', code: 'original-language-unavailable', retryable: false }
  ]) {
    const harness = await createTTMLHarness({ prepareSecondary: false });
    const interceptor = harness.interceptor();
    interceptor.applyConfiguredSecondaryLanguage('auto');
    interceptor.configBridge = { async readLastManualSecondaryLanguage() { assert.fail('no preference read without playback'); } };
    harness.setPlaybackResult('original-language', { ok: false, error });
    if (error.code === 'original-language-unavailable' && error.retryable === false) {
      harness.setPlaybackResult('available-languages', { ok: false, error: { kind: 'disconnected', code: 'playback-disconnected', retryable: true } });
    }
    const result = await interceptor.ensureSecondaryLanguageAvailableOnce('page-unavailable');
    assert.equal(result.success, false);
    assert.equal(interceptor.getStatus().effectiveSecondaryLanguage, null);
    assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
  }
});

test('unavailable fallback still requires an eligible manual subtitle track and never chooses forced or guesses another language', async () => {
  const harness = await createTTMLHarness({ prepareSecondary: false });
  const interceptor = harness.interceptor();
  interceptor.applyConfiguredSecondaryLanguage('auto');
  interceptor.configBridge = { async readLastManualSecondaryLanguage() { return 'ja'; } };
  harness.setPlaybackResult('original-language', { ok: false, error: { kind: 'domain-rejected', code: 'original-language-unavailable', retryable: false } });
  harness.setPlaybackResult('available-languages', { ok: true, value: { variant: 'available-languages', languages: [
    { code: 'ja', trackId: 'ja-forced', isNoneTrack: false, isForcedNarrative: true, trackType: 'PRIMARY', rawTrackType: 'SUBTITLES' }
  ] } });
  assert.equal((await interceptor.ensureSecondaryLanguageAvailableOnce('missing-manual')).success, false);
  assert.equal(interceptor.getStatus().secondaryResolution.status, 'missing');
  assert.equal(interceptor.getStatus().selectedSecondaryTrack, null);
  assert.equal(interceptor.secondarySubtitles.length, 0);
  assert.equal(harness.playbackCalls().some(call => call.variant.startsWith('switch-')), false);
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
  let manualPreferenceReads = 0;
  interceptor.configBridge = { async readLastManualSecondaryLanguage() { manualPreferenceReads += 1; return 'ja'; } };
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
  await interceptor.ensureSecondaryLanguageAvailableOnce('acquisition-retry', { retryAuto: true, timeoutMs: 1 });
  assert.equal(harness.playbackCalls().filter(call => call.variant === 'original-language').length, 1);
  assert.equal(harness.readiness().secondary.resolution.failureKind, 'acquisition-failed');
  assert.equal(manualPreferenceReads, 0);
  await harness.settleRuntime();
  assert.equal(harness.runtimePublications.at(-1).payload.snapshot.status, 'unavailable');
  assert.equal(harness.runtimePublications.at(-1).payload.snapshot.reason, 'switch-track-timeout');
  assert.equal(harness.runtimePublications.at(-1).payload.snapshot.isManualFallback, false);
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
  harness.setPlaybackResult('original-language', { ok: false, error: { kind: 'disconnected', code: 'original-language-unavailable', retryable: true } });
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
  const inFlightIdentity = JSON.parse(interceptor.debugEvents.find(event => event.type === 'SECONDARY_ACQUISITION_STARTED').inFlightKey);
  assert.deepEqual(inFlightIdentity.slice(-5), ['episode-A', 'watch-episode-A', 1, 'da', 'da-track']);
  assert.equal(inFlightIdentity.includes('auto'), false);
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
  assert.deepEqual(harness.playbackCalls().slice(0, 5), [
    { variant: 'available-languages', payload: {}, expected },
    { variant: 'current-language', payload: {}, expected },
    { variant: 'current-language', payload: {}, expected },
    { variant: 'available-languages', payload: {}, expected },
    { variant: 'current-language', payload: {}, expected }
  ]);
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')), [
    { variant: 'switch-language', payload: { languageCode: 'zh-Hant' }, expected },
    { variant: 'switch-track', payload: { trackId: 'en-track' }, expected }
  ]);
  assert.equal(harness.playbackCalls().every(call => JSON.stringify(call.expected) === JSON.stringify(expected)), true);
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
  assert.deepEqual(harness.playbackCalls().filter(call => call.variant.startsWith('switch-')), [
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
