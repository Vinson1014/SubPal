import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

function createContext() {
  const appendAttempts = [];
  const window = {
    location: { hostname: 'www.netflix.com' },
    subpalPageScript: {}
  };
  const document = {
    head: { appendChild(node) { appendAttempts.push(node); } },
    documentElement: { appendChild(node) { appendAttempts.push(node); } }
  };
  const context = vm.createContext({
    console: { error() {}, log() {}, warn() {} },
    Date,
    Promise,
    clearTimeout() {},
    setTimeout() { return 0; },
    setInterval() { return 0; },
    clearInterval() {},
    window,
    document
  });

  return { appendAttempts, context };
}

async function createModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Unexpected synthetic dependency'); });
  await module.evaluate();
  return module;
}

async function createPlaybackContextModule(context, playbackContextManager) {
  return createModule(context, 'content/core/playback-context-manager.js', { playbackContextManager });
}

function createPlaybackContext({ context, playback, initialize = async () => true } = {}) {
  return {
    getCurrentContext: () => context,
    getPlayback: () => playback,
    initialize
  };
}

async function loadInitializationManager({ waitForPageScript, playbackContextManager = createPlaybackContext() }) {
  const { appendAttempts, context } = createContext();
  let injectionRequests = 0;
  const messaging = await createModule(context, 'content/system/messaging.js', {
    sendMessage: async () => ({}),
    waitForPageScript,
    requestPageScriptInjection: async () => {
      injectionRequests += 1;
      appendAttempts.push('legacy-request');
    }
  });
  const videoInfo = await createModule(context, 'content/core/video-info.js', {
    getVideoId: () => '81234567'
  });
  const playbackContext = await createPlaybackContextModule(context, playbackContextManager);
  const source = await readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/system/initialization-manager.js' });
  await module.link((specifier) => {
    if (specifier === './messaging.js') return messaging;
    if (specifier === '../core/video-info.js') return videoInfo;
    if (specifier === '../core/playback-context-manager.js') return playbackContext;
    throw new Error(`Unexpected initialization dependency: ${specifier}`);
  });
  await module.evaluate();

  return {
    appendAttempts,
    injectionRequests: () => injectionRequests,
    manager: new module.namespace.InitializationManager()
  };
}

async function loadModeDetector({ waitForPageScript, playbackContextManager }) {
  const { appendAttempts, context } = createContext();
  let injectionRequests = 0;
  const messaging = await createModule(context, 'content/system/messaging.js', {
    waitForPageScript,
    requestPageScriptInjection: async () => {
      injectionRequests += 1;
      appendAttempts.push('legacy-request');
    }
  });
  const playbackContext = await createPlaybackContextModule(context, playbackContextManager);
  const source = await readFile(new URL('../content/subtitle-modes/mode-detector.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/subtitle-modes/mode-detector.js' });
  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messaging;
    if (specifier === '../core/playback-context-manager.js') return playbackContext;
    throw new Error(`Unexpected mode dependency: ${specifier}`);
  });
  await module.evaluate();

  return {
    appendAttempts,
    detector: new module.namespace.ModeDetector(),
    injectionRequests: () => injectionRequests
  };
}

test('Given the retired Netflix API bridge When its module is requested Then it is absent', async () => {
  await assert.rejects(
    readFile(new URL('../content/system/netflix-api-bridge.js', import.meta.url), 'utf8'),
    (error) => error?.code === 'ENOENT'
  );
});

test('Given MAIN initialization When page readiness succeeds or times out Then it waits once and never requests an append', async (t) => {
  await t.test('success', async () => {
    const waits = [];
    const harness = await loadInitializationManager({
      waitForPageScript: async (timeout) => { waits.push(timeout); }
    });

    assert.equal(await harness.manager.initializePageScript(), true);
    assert.deepEqual(waits, [5000]);
    assert.equal(harness.injectionRequests(), 0);
    assert.deepEqual(harness.appendAttempts, []);
  });

  await t.test('timeout', async () => {
    const harness = await loadInitializationManager({
      waitForPageScript: async () => { throw new Error('readiness timeout'); }
    });

    await assert.rejects(harness.manager.initializePageScript(), /readiness timeout/);
    assert.equal(harness.injectionRequests(), 0);
    assert.deepEqual(harness.appendAttempts, []);
  });
});

test('Given MAIN initialization When readiness precedes the PlaybackContext snapshot Then it initializes through the typed bootstrap without legacy API or initializer commands', async () => {
  const waits = [];
  let initializeCalls = 0;
  const playbackContextManager = createPlaybackContext({
    initialize: async () => {
      initializeCalls += 1;
      return true;
    }
  });
  const harness = await loadInitializationManager({
    waitForPageScript: async (timeout) => { waits.push(timeout); },
    playbackContextManager
  });

  assert.equal(await harness.manager.checkNetflixAPI(), true);
  assert.deepEqual(waits, [5000]);
  assert.equal(initializeCalls, 1);
  assert.equal(harness.manager.state.playbackContextReady, true);
  assert.equal(harness.manager.state.netflixAPIAvailable, true);
  assert.equal(harness.injectionRequests(), 0);
  assert.deepEqual(harness.appendAttempts, []);
});

test('Given a transitioning PlaybackContext When the mode detector checks readiness Then it remains a soft-not-ready interceptor state without fetching languages', async () => {
  const playbackCalls = [];
  const playback = { perform(intent) { playbackCalls.push(intent); } };
  const harness = await loadModeDetector({
    waitForPageScript: async () => {},
    playbackContextManager: createPlaybackContext({
      context: { state: 'transitioning', videoId: '81234567', sessionId: null, epoch: 2 },
      playback
    })
  });

  const result = await harness.detector.detectInterceptModeStatus();
  assert.deepEqual({ status: result.status, mode: result.mode, reason: result.reason }, {
    status: 'soft_not_ready', mode: 'intercept', reason: 'playback-context-not-ready'
  });
  assert.deepEqual(playbackCalls, []);
});

test('Given a ready PlaybackContext and typed available languages When the mode detector checks readiness Then it reports intercept-ready with the exact context', async () => {
  const playbackCalls = [];
  const context = { state: 'ready', videoId: '81234567', sessionId: 'watch-session-a', epoch: 4 };
  const playback = {
    async perform(intent) {
      playbackCalls.push(intent);
      return {
        ok: true,
        value: {
          variant: 'available-languages',
          languages: [{ code: 'en', name: 'English', trackId: 'track-en', trackType: 'PRIMARY', rawTrackType: null }]
        }
      };
    }
  };
  const harness = await loadModeDetector({
    waitForPageScript: async () => {},
    playbackContextManager: createPlaybackContext({ context, playback })
  });

  const result = await harness.detector.detectInterceptModeStatus();
  assert.deepEqual({ status: result.status, mode: result.mode, reason: result.reason }, {
    status: 'ready', mode: 'intercept', reason: 'intercept-ready'
  });
  assert.deepEqual(playbackCalls.map((intent) => JSON.parse(JSON.stringify(intent))), [{
    variant: 'available-languages',
    payload: {},
    expected: { videoId: '81234567', sessionId: 'watch-session-a', epoch: 4 }
  }]);
});

test('Given initialization and mode readiness sources When inspected Then no generic API, player, language, or interceptor commands remain', async () => {
  const [initializationSource, modeSource] = await Promise.all([
    readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/subtitle-modes/mode-detector.js', import.meta.url), 'utf8')
  ]);

  for (const source of [initializationSource, modeSource]) {
    assert.doesNotMatch(source, /CHECK_API_AVAILABILITY|INITIALIZE_PLAYER_HELPER|INITIALIZE_SUBTITLE_INTERCEPTOR|PING|CHECK_PLAYER_READY|GET_AVAILABLE_LANGUAGES|TEST_SUBTITLE_FETCH|sendMessageToPageScript/);
  }
  assert.doesNotMatch(initializationSource, /quickInterceptorCheck|checkPlayerReady/);
});
