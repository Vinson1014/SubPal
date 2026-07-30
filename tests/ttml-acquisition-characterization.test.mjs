import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const interceptorSource = await readFile(new URL('../content/subtitle-modes/subtitle-interceptor.js', import.meta.url), 'utf8');
const resultSource = await readFile(new URL('../content/system/capabilities/result.js', import.meta.url), 'utf8');
const ingressSource = await readFile(new URL('../content/system/capabilities/ttml-acquisition-ingress.js', import.meta.url), 'utf8');

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
    currentTrackAtRequest: { code: language },
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

async function createTTMLHarness() {
  let context = createPlaybackContext('episode-A', 1);
  const rawCache = new Map();
  const rendered = [];
  const eventListeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const listeners = eventListeners.get(type) ?? new Set();
      listeners.add(listener);
      eventListeners.set(type, listeners);
    },
    removeEventListener(type, listener) { eventListeners.get(type)?.delete(listener); },
    listenerCount(type) { return eventListeners.get(type)?.size ?? 0; }
  };
  const pageMessage = async ({ type }) => {
    assert.equal(type, 'GET_ALL_INTERCEPTED_TTML');
    return { success: true, allTTMLs: Object.fromEntries(rawCache) };
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
    sendMessageToPageScript: pageMessage,
    sendMessage: async () => ({}),
    registerInternalEventHandler: () => () => {},
    dispatchInternalEvent() {}
  });
  const videoInfo = await createSyntheticModule(sandbox, 'video-info.js', {
    getCurrentTimestamp: () => 1,
    getVideoId: () => context.videoId
  });
  const playback = await createSyntheticModule(sandbox, 'playback-context-manager.js', {
    playbackContextManager: { getCurrentContext: () => ({ ...context }) }
  });
  const playerAdapter = await createSyntheticModule(sandbox, 'netflix-player-adapter.js', {
    getPlayerAdapter: () => ({ calculatePosition: () => null }),
    setRegionConfigs() {}
  });
  const overlapMatcher = await createSyntheticModule(sandbox, 'dom-overlap-matcher.js', {
    DOMOverlapMatcher: class DOMOverlapMatcher {}
  });
  const result = new vm.SourceTextModule(resultSource, {
    context: sandbox,
    identifier: 'content/system/capabilities/result.js'
  });
  const ingress = new vm.SourceTextModule(ingressSource, {
    context: sandbox,
    identifier: 'content/system/capabilities/ttml-acquisition-ingress.js'
  });
  await result.link(() => { throw new Error('Unexpected result dependency'); });
  await ingress.link((specifier) => {
    assert.equal(specifier, './result.js');
    return result;
  });
  await result.evaluate();
  await ingress.evaluate();
  const dependencies = new Map([
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
  interceptor.onSubtitleDetected(output => {
    rendered.push({
      primaryText: output.dualSubtitle.primaryText,
      secondaryText: output.dualSubtitle.secondaryText
    });
  });

  return {
    capture({ videoId, language, text, requestTime }) {
      const cacheKey = `${language}_${videoId}_fixture_track`;
      const event = vm.runInContext(`(${JSON.stringify({
        cacheKey,
        rawContent: text,
        requestInfo: createRequestInfo(videoId, language, requestTime),
        language
      })})`, sandbox);
      rawCache.set(cacheKey, event);
      interceptor.captureRawTTMLEvidence(event);
      return cacheKey;
    },
    async readPageRawCacheKeys() {
      const response = await pageMessage({ type: 'GET_ALL_INTERCEPTED_TTML' });
      return Object.keys(response.allTTMLs);
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
