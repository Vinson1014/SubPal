import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const pageScriptSource = await readFile(new URL('../netflix-page-script.js', import.meta.url), 'utf8');
const harnessPageScriptSource = pageScriptSource.replace(
  "  window.addEventListener('message', handleMessage);",
  "  window.__subpalTestHandleJump = handleJumpToTimecode;\n\n  window.addEventListener('message', handleMessage);"
);
const plain = (value) => JSON.parse(JSON.stringify(value));

function createPageHarness({
  sessions = ['watch-fa058b0f-0000-4000-8000-000000000001'],
  videoId = '81234567',
  playerApiVideoId = videoId,
  movieId = videoId,
  duration = 300000,
  currentTime = 120000,
  apiAvailable = true,
  playerUi = {},
  rawTtmlBody = null,
  fetchResponses = null
} = {}) {
  const listeners = new Map();
  const documentListeners = new Map();
  const seekCalls = [];
  const otherSeekCalls = [];
  const responses = [];
  const responseTargetOrigins = [];
  const routeMessages = [];
  const errors = [];
  let sessionReads = 0;
  let currentSessionIds = [...sessions];
  let currentVideoId = videoId;
  let currentPlayerApiVideoId = playerApiVideoId;
  let currentMovieId = movieId;
  let currentDuration = duration;
  let currentTimeMs = currentTime;
  let trackMutations = 0;
  let currentTimedTextTrack = {
    bcp47: 'en', displayName: 'English', trackId: 'track-en', trackType: 'PRIMARY', rawTrackType: null, isNoneTrack: false
  };
  let currentUserActivation = true;
  let now = Date.now();
  let fetchResponseIndex = 0;
  let creditsClickCount = 0;
  let globalCreditsClickCount = 0;
  let nextEpisodeClickCount = 0;
  let playerWrapperQueries = 0;
  let creditsQueries = 0;
  let activeExpectedPlayer = null;
  let hasSeeked = false;
  const playPauseSelector = playerUi.playPauseSelector || 'control-play-pause';
  const typeANextEpisodeCtasLive = () => playerUi.nextEpisode === true && !hasSeeked && playerUi.typeANextEpisodeCtasLiveAfterSeek !== false;
  const controlsStandardReady = () => playerUi.controlsStandard === true &&
    (!playerUi.controlsStandardAfterPlayerChecks || playerWrapperQueries >= playerUi.controlsStandardAfterPlayerChecks);
  const mediaSettled = () => !playerUi.mediaSettlesAfterPlayerChecks || playerWrapperQueries >= playerUi.mediaSettlesAfterPlayerChecks;
  const expectedPlayer = {
    isConnected: playerUi.absentExpectedWrapper !== true,
    getAttribute: (name) => name === 'data-videoid' ? videoId : name === 'data-uia' ? 'player' : null,
    querySelector(selector) {
      if (selector === 'video') return playerUi.mediaMissingWithinExpected ? null : mediaElement;
      if (selector === '[data-uia="watch-video-player-view-minimized"]') {
        return minimizedElement.isConnected && playerUi.markerLayout !== 'ancestor' ? minimizedElement : null;
      }
      if (selector === 'button[data-uia="watch-credits-seamless-button"]') {
        creditsQueries += 1;
        if (playerUi.creditsMissing || creditsQueries <= (playerUi.creditsMissingChecks || 0)) return null;
        return playerUi.minimized || playerUi.returnStaleCredits ? creditsButton : null;
      }
      if (selector === '[data-uia="player-controls"]') return normalControls.isConnected ? normalControls : null;
      if (selector === '[data-uia="controls-standard"]') return controlsStandardReady() ? controlsStandard : null;
      if (selector === '[data-uia="timeline"]') return controlsStandardReady() ? timelineControl : null;
      if (selector === `[data-uia="${playPauseSelector}"]`) return controlsStandardReady() ? playPauseControl : null;
      if (selector === 'button[data-uia="next-episode-seamless-button"]') return typeANextEpisodeCtasLive() ? nextEpisodeButton : null;
      return null;
    },
    querySelectorAll(selector) {
      const element = this.querySelector(selector);
      return element ? [element] : [];
    },
    contains(element) {
      if (element === mediaElement || element === creditsButton || element === normalControls ||
          element === controlsStandard || element === timelineControl || element === playPauseControl ||
          element === nextEpisodeButton) return true;
      return element === minimizedElement && playerUi.markerLayout !== 'ancestor';
    }
  };
  activeExpectedPlayer = expectedPlayer;
  const replacementExpectedPlayer = {
    ...expectedPlayer,
    isConnected: false,
    querySelector: expectedPlayer.querySelector
  };
  const duplicateExpectedPlayer = {
    ...expectedPlayer,
    isConnected: playerUi.multipleExpectedWrappers === true,
    querySelector: expectedPlayer.querySelector
  };
  const wrongPlayer = {
    isConnected: true,
    getAttribute: (name) => name === 'data-videoid' ? 'other-video' : name === 'data-uia' ? 'player' : null,
    querySelector: () => null,
    contains: () => false
  };
  const previewMarkers = new Map([
    ['[data-uia="background-video-container"]', 'background-video-container'],
    ['[data-uia="promoted-video"]', 'promoted-video'],
    ['[data-uia="postplay-background-play"]', 'postplay-background-play']
  ].map(([selector, uia]) => [selector, {
    isConnected: playerUi.previewLike === true,
    getAttribute: (name) => name === 'data-uia' ? uia : null,
    getClientRects: () => playerUi.previewLike === true ? [{}] : [],
    contains: () => false
  }]));
  const mediaElement = {
    get isConnected() { return playerUi.mediaMissingWithinExpected !== true && mediaSettled(); },
    get ended() { return playerUi.mediaEnded === true || !mediaSettled(); },
    getClientRects: () => mediaSettled() ? [{}] : []
  };
  const minimizedElement = {
    isConnected: playerUi.minimized === true && playerUi.detachedMarker !== true,
    getClientRects() { return this.isConnected && playerUi.minimizedVisible !== false ? [{}] : []; },
    contains(player) {
      if (playerUi.unrelatedAncestor === true) return player === wrongPlayer;
      return playerUi.markerLayout === 'ancestor' && player === activeExpectedPlayer;
    },
    closest: () => playerUi.markerLayout === 'ancestor' ? null : activeExpectedPlayer
  };
  const duplicateMinimizedElement = {
    isConnected: playerUi.multipleContainingMarkers === true,
    getClientRects() { return this.isConnected ? [{}] : []; },
    contains: (player) => playerUi.markerLayout === 'ancestor' && player === activeExpectedPlayer
  };
  const normalControls = {
    isConnected: playerUi.normalControls === true,
    getClientRects() { return this.isConnected ? [{}] : []; },
    closest: () => activeExpectedPlayer
  };
  const controlsStandard = {
    get isConnected() { return controlsStandardReady(); },
    getClientRects: () => controlsStandardReady() ? [{}] : [],
    closest: () => activeExpectedPlayer
  };
  const timelineControl = {
    get isConnected() { return controlsStandardReady(); },
    getClientRects: () => controlsStandardReady() ? [{}] : [],
    closest: () => activeExpectedPlayer
  };
  const playPauseControl = {
    get isConnected() { return controlsStandardReady(); },
    getClientRects: () => controlsStandardReady() ? [{}] : [],
    closest: () => activeExpectedPlayer
  };
  const creditsButton = {
    isConnected: playerUi.creditsConnected !== false,
    get disabled() {
      return playerUi.creditsDisabled === true || creditsQueries <= (playerUi.creditsDisabledChecks || 0);
    },
    textContent: playerUi.creditsText || '任意語系文字',
    getAttribute(name) { return name === 'aria-disabled' && playerUi.creditsAriaDisabled ? 'true' : null; },
    getClientRects() {
      const delayedVisible = creditsQueries > (playerUi.creditsHiddenChecks || 0);
      return this.isConnected && playerUi.creditsVisible !== false && delayedVisible ? [{}] : [];
    },
    closest: () => playerUi.creditsWrongPlayer ? wrongPlayer : activeExpectedPlayer,
    matches(selector) { return selector === ':disabled' && this.disabled; },
    click() {
      creditsClickCount += 1;
      if (playerUi.creditsClickThrows === true) throw new Error('credits activation failed');
      if (playerUi.identityChangeOnCreditsClick) {
        currentVideoId = 'changed-video';
        currentPlayerApiVideoId = currentVideoId;
        currentMovieId = currentVideoId;
      }
      if (playerUi.replaceExpectedWrapperOnCreditsClick) {
        expectedPlayer.isConnected = false;
        replacementExpectedPlayer.isConnected = true;
        activeExpectedPlayer = replacementExpectedPlayer;
      }
      if (playerUi.restoreOnCreditsClick !== false) {
        minimizedElement.isConnected = false;
        creditsButton.isConnected = false;
        normalControls.isConnected = true;
      }
    }
  };
  const globalCreditsButton = {
    isConnected: true,
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}],
    matches: () => false,
    closest: () => wrongPlayer,
    click() { globalCreditsClickCount += 1; }
  };
  const globalMediaElement = { isConnected: true, ended: false, getClientRects: () => [{}] };
  const globalNormalControls = { isConnected: true, getClientRects: () => [{}], closest: () => wrongPlayer };
  const nextEpisodeButton = { click() { nextEpisodeClickCount += 1; } };
  Object.defineProperties(nextEpisodeButton, {
    isConnected: { get: typeANextEpisodeCtasLive },
    getClientRects: { value: () => typeANextEpisodeCtasLive() ? [{}] : [] },
    closest: { value: () => activeExpectedPlayer }
  });
  const control = {
    attributes: { 'data-control-id': 'control-render-1' },
    closest(selector) { return selector === '.subpal-endscreen-timecode' ? this : null; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = String(value); }
  };

  const selectedPlayer = {
    getMovieId: () => currentMovieId,
    getCurrentTime: () => currentTimeMs,
    getDuration: () => currentDuration,
    getTimedTextTrack: () => currentTimedTextTrack,
    getTimedTextTrackList: () => [currentTimedTextTrack],
    setTimedTextTrack: async (track) => {
      trackMutations += 1;
      currentTimedTextTrack = track;
      if (playerUi.driftPlayerApiVideoIdOnTrackMutation) currentPlayerApiVideoId = playerUi.driftPlayerApiVideoIdOnTrackMutation;
    },
    seek: (milliseconds) => {
      seekCalls.push(milliseconds);
      currentTimeMs = milliseconds;
      hasSeeked = true;
      if (playerUi.nextEpisode === true && playerUi.typeANextEpisodeCtasLiveAfterSeek !== true) {
        creditsButton.isConnected = false;
      }
    }
  };
  const otherPlayer = {
    getMovieId: () => 'other-video',
    getCurrentTime: () => 1000,
    getDuration: () => currentDuration,
    getTimedTextTrack: () => null,
    seek: (milliseconds) => otherSeekCalls.push(milliseconds)
  };
  const api = {
    getOpenPlaybackSessions: () => {
      sessionReads += 1;
      return currentSessionIds.map((sessionId) => ({ sessionId }));
    },
    getVideoIdBySessionId: (sessionId) => sessionId === 'watch-fa058b0f-0000-4000-8000-000000000001' ? currentPlayerApiVideoId : 'other-video',
    videoPlayer: {
      getVideoPlayerBySessionId: (sessionId) => {
        if (sessionId === 'watch-fa058b0f-0000-4000-8000-000000000001') return selectedPlayer;
        if (sessionId?.startsWith('watch-')) return otherPlayer;
        return null;
      }
    }
  };

  const location = { href: `https://www.netflix.com/watch/${videoId}`, origin: 'https://www.netflix.com' };
  const history = {
    pushState(_state, _unused, url) {
      if (url !== undefined && url !== null) location.href = new URL(String(url), location.href).href;
    },
    replaceState(_state, _unused, url) {
      if (url !== undefined && url !== null) location.href = new URL(String(url), location.href).href;
    }
  };
  const window = {
    netflix: apiAvailable ? { appContext: { state: { playerApp: { getAPI: () => api } } } } : null,
    location,
    history,
    navigator: { userActivation: { get isActive() { return currentUserActivation; } } },
    crypto: { randomUUID: (() => { let id = 0; return () => `page-request-${++id}`; })() },
    fetch: async () => {
      const configured = fetchResponses?.[fetchResponseIndex++];
      const body = configured?.body ?? rawTtmlBody ?? '';
      const response = {
        ok: configured?.ok ?? true,
        status: configured?.status ?? 200,
        headers: { get: (name) => name === 'content-type' ? configured?.contentType ?? (rawTtmlBody ? 'application/ttml+xml' : null) : null },
        text: async () => body
      };
      response.clone = () => response;
      return response;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    postMessage(data, targetOrigin) {
      responses.push(data);
      responseTargetOrigins.push(targetOrigin);
    },
    dispatchMessage(event) {
      for (const listener of listeners.get('message') || []) listener(event);
    }
  };
  window.addEventListener('messageToContentScript', (event) => {
    if (event.detail?.message?.type === 'VIDEO_ID_CHANGED') routeMessages.push(event.detail.message);
  });
  const document = {
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
    querySelector(selector) {
      if (previewMarkers.has(selector)) return playerUi.previewLike === true ? previewMarkers.get(selector) : null;
      if (selector === '[data-uia="watch-video-player-view-minimized"]') return playerUi.globalUnrelatedElements && (minimizedElement.isConnected || playerUi.returnStaleMinimized) ? minimizedElement : null;
      if (selector === 'button[data-uia="watch-credits-seamless-button"]') {
        if (playerUi.globalUnrelatedElements) return globalCreditsButton;
        if (playerUi.creditsMissing) return null;
        return playerUi.minimized || playerUi.returnStaleCredits ? creditsButton : null;
      }
      if (selector === '[data-uia="player-controls"]') return playerUi.globalUnrelatedControls ? globalNormalControls : normalControls.isConnected ? normalControls : null;
      if (selector === '[data-uia="controls-standard"]') return playerUi.globalUnrelatedControls ? globalNormalControls : controlsStandard.isConnected ? controlsStandard : null;
      if (selector === '[data-uia="timeline"]') return playerUi.globalUnrelatedControls ? globalNormalControls : timelineControl.isConnected ? timelineControl : null;
      if (selector === '[data-uia="control-play-pause"]') return playerUi.globalUnrelatedControls ? globalNormalControls : playPauseControl.isConnected ? playPauseControl : null;
      if (selector === 'video') return playerUi.globalUnrelatedElements ? globalMediaElement : mediaElement;
      if (selector === 'button[data-uia="next-episode-seamless-button"]') return nextEpisodeButton;
      return null;
    },
    querySelectorAll(selector) {
      if (previewMarkers.has(selector)) {
        const marker = previewMarkers.get(selector);
        return playerUi.previewLike === true ? [marker] : [];
      }
      if (selector === '[data-uia="watch-video-player-view-minimized"]') {
        const markers = [];
        if (minimizedElement.isConnected || playerUi.returnStaleMinimized) markers.push(minimizedElement);
        if (duplicateMinimizedElement.isConnected) markers.push(duplicateMinimizedElement);
        return markers;
      }
      if (selector === '[data-uia="player"][data-videoid]' || selector === '[data-uia="player"]') {
        playerWrapperQueries += 1;
        if (playerUi.becomeNormalAfterPlayerChecks && playerWrapperQueries >= playerUi.becomeNormalAfterPlayerChecks) {
          minimizedElement.isConnected = false;
          creditsButton.isConnected = false;
          normalControls.isConnected = true;
        }
        if (playerUi.hideMinimizedAfterPlayerChecks && playerWrapperQueries >= playerUi.hideMinimizedAfterPlayerChecks) {
          playerUi.minimizedVisible = false;
        }
        const wrappers = [wrongPlayer];
        if (playerWrapperQueries > (playerUi.wrapperMissingChecks || 0)) {
          if (expectedPlayer.isConnected) wrappers.push(expectedPlayer);
          if (replacementExpectedPlayer.isConnected) wrappers.push(replacementExpectedPlayer);
          if (duplicateExpectedPlayer.isConnected) wrappers.push(duplicateExpectedPlayer);
        }
        return wrappers;
      }
      return [];
    },
    dispatchClick({ trusted = true, userActive = true, target = control } = {}) {
      currentUserActivation = userActive;
      for (const listener of documentListeners.get('click') || []) {
        listener({ type: 'click', isTrusted: trusted, target, currentTarget: document });
      }
    }
  };
  class XMLHttpRequest {
    open() {}
    send() {}
  }

  const context = vm.createContext({
    window,
    document,
    location,
    history,
    XMLHttpRequest,
    console: { log() {}, error(...args) { errors.push(args); } },
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout: () => {},
    Promise,
    structuredClone,
    Date: class HarnessDate extends Date { static now() { return now; } },
    Math,
    JSON,
    Error,
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    }
  });
  vm.runInContext(harnessPageScriptSource, context, { filename: 'netflix-page-script.js' });

  function send(data, { source = window, origin = location.origin, target = 'subpal-page-script' } = {}) {
    const before = responses.length;
    window.dispatchMessage({ source, origin, data: { source: 'subpal-content-script', target, messageId: `test-${before}`, ...data } });
    return responses.at(-1);
  }

  function sendTyped(envelope, { source = window, origin = location.origin, target = 'subpal-page-script' } = {}) {
    window.dispatchMessage({
      source,
      origin,
      data: { source: 'subpal-content-script', target, envelope }
    });
  }

  function sendJump(request) {
    void window.__subpalTestHandleJump(request).then((response) => responses.push(response));
    return responses.at(-1);
  }

  return {
    window,
    history,
    document,
    control,
    api,
    selectedPlayer,
    otherPlayer,
    seekCalls,
    otherSeekCalls,
    responses,
    responseTargetOrigins,
    routeMessages,
    errors,
    send,
    sendJump,
    sendTyped,
    setSessions(nextSessions) { currentSessionIds = [...nextSessions]; },
    setVideoId(nextVideoId) { currentVideoId = nextVideoId; },
    setDuration(nextDuration) { currentDuration = nextDuration; },
    setCurrentTime(nextCurrentTime) { currentTimeMs = nextCurrentTime; },
    advanceTime(milliseconds) { now += milliseconds; },
    clickTimecode(options = {}) {
      const expected = options.expected || validExpected;
      control.setAttribute('data-subpal-jump-video-id', expected.videoId);
      control.setAttribute('data-subpal-jump-session-id', expected.sessionId);
      control.setAttribute('data-subpal-jump-epoch', expected.epoch);
      control.setAttribute('data-subpal-jump-target-timestamp', expected.targetTimestamp);
      document.dispatchClick(options);
      return {
        controlId: control.getAttribute('data-control-id'),
        requestId: control.getAttribute('data-subpal-jump-request-id'),
        issuedAt: Number(control.getAttribute('data-subpal-jump-issued-at'))
      };
    },
    get sessionReads() { return sessionReads; },
    get trackMutations() { return trackMutations; },
    get creditsClickCount() { return creditsClickCount; },
    get globalCreditsClickCount() { return globalCreditsClickCount; },
    get nextEpisodeClickCount() { return nextEpisodeClickCount; },
    get minimizedConnected() { return minimizedElement.isConnected; },
    get normalControlsConnected() { return normalControls.isConnected; },
    get minimizedMarkerConnected() { return minimizedElement.isConnected; },
    get creditsConnected() { return creditsButton.isConnected && typeANextEpisodeCtasLive(); },
    get nextEpisodeConnected() { return nextEpisodeButton.isConnected; },
    get controlsStandardConnected() { return controlsStandard.isConnected; },
    get timelineConnected() { return timelineControl.isConnected; },
    get playPauseConnected() { return playPauseControl.isConnected; },
    get mediaSettled() { return mediaSettled(); },
    get clickListenerCount() { return documentListeners.get('click')?.size || 0; },
    reinject() { vm.runInContext(harnessPageScriptSource, context, { filename: 'netflix-page-script.js' }); }
  };
}

function jumpMessage(expected, click) {
  return { type: 'JUMP_TO_TIMECODE', intent: 'jump-to-timecode', expected, ...click };
}

function trustedJump(harness, expected = validExpected) {
  return harness.sendJump(jumpMessage(expected, harness.clickTimecode({ expected })));
}

function typedRequest(requestId, kind, variant, payload, context) {
  const envelope = {
    protocolVersion: 1,
    requestId,
    kind,
    payload: { variant, payload }
  };
  if (context !== undefined) envelope.context = context;
  return envelope;
}

const typedContext = { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 3 };

async function settlePageCommand() {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

const validExpected = { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 3, targetTimestamp: 12.5 };

test('Given flattened legacy page commands When received Then no page owner action or response occurs', async () => {
  const harness = createPageHarness();

  for (const type of [
    'PING', 'CHECK_API_AVAILABILITY', 'JUMP_TO_TIMECODE', 'CHECK_PLAYER_READY', 'INITIALIZE_PLAYER_HELPER',
    'INITIALIZE_SUBTITLE_INTERCEPTOR', 'GET_AVAILABLE_LANGUAGES', 'SWITCH_LANGUAGE', 'SWITCH_TRACK',
    'GET_CURRENT_LANGUAGE', 'GET_SUBTITLE_CONTENT', 'GET_ALL_INTERCEPTED_SUBTITLES', 'GET_ALL_INTERCEPTED_TTML',
    'GET_SUBPAL_DEBUG_SNAPSHOT', 'CHECK_INTERCEPTOR_STATUS', 'TEST_SUBTITLE_FETCH', 'GET_SUBTITLE_TRACKS'
  ]) harness.send({ type, languageCode: 'zh-Hant', trackId: 'track-en', expected: validExpected });
  await settlePageCommand();

  assert.deepEqual(harness.responses, []);
  assert.deepEqual(harness.seekCalls, []);
});

test('Given forged legacy page messages When their physical headers are invalid or accessor-backed Then no command executes or response is posted', async () => {
  const harness = createPageHarness();
  let getterReads = 0;
  const accessor = { source: 'subpal-content-script', target: 'subpal-page-script', messageId: 'legacy-accessor' };
  Object.defineProperty(accessor, 'type', {
    enumerable: true,
    get() { getterReads += 1; return 'JUMP_TO_TIMECODE'; }
  });
  const nestedAccessor = {
    source: 'subpal-content-script', target: 'subpal-page-script', messageId: 'legacy-nested-accessor', type: 'PING',
    diagnostics: {}
  };
  Object.defineProperty(nestedAccessor.diagnostics, 'detail', {
    enumerable: true,
    get() { getterReads += 1; return 'unsafe'; }
  });
  for (const event of [
    { source: {}, origin: 'https://www.netflix.com', data: { source: 'subpal-content-script', target: 'subpal-page-script', messageId: 'legacy-source', type: 'PING' } },
    { source: harness.window, origin: 'https://invalid.example', data: { source: 'subpal-content-script', target: 'subpal-page-script', messageId: 'legacy-origin', type: 'PING' } },
    { source: harness.window, origin: 'https://www.netflix.com', data: { source: 'subpal-content-script', target: 'wrong-target', messageId: 'legacy-target', type: 'PING' } },
    { source: harness.window, origin: 'https://www.netflix.com', data: accessor },
    { source: harness.window, origin: 'https://www.netflix.com', data: nestedAccessor },
    { source: harness.window, origin: 'https://www.netflix.com', data: new Proxy({ source: 'subpal-content-script', target: 'subpal-page-script', messageId: 'legacy-proxy', type: 'PING' }, {}) }
  ]) {
    harness.window.dispatchMessage(event);
  }
  await settlePageCommand();
  assert.equal(getterReads, 0);
  assert.deepEqual(harness.responses, []);
  assert.deepEqual(harness.seekCalls, []);
});

test('Given canonical typed Playback requests When received by the page Then all six allowlisted variants return exact normalized Results', async () => {
  const track = { code: 'en', name: 'English', trackId: 'track-en', trackType: 'PRIMARY', rawTrackType: null };
  const cases = [
    ['context-snapshot', {}, undefined, {
      playback: {
        pageUrlVideoId: '81234567', playerApiVideoId: '81234567', movieId: '81234567',
        selectedSessionId: typedContext.sessionId, selectedSessionReason: 'watch-player-api-video-id-match',
        sessionSelectionConfidence: 'high', currentTime: 120000, duration: 300000, currentTrack: track
      }
    }],
    ['available-languages', {}, typedContext, { languages: [track] }],
    ['current-language', {}, typedContext, { language: track }],
    ['switch-language', { languageCode: 'en' }, typedContext, { language: track }],
    ['switch-track', { trackId: 'track-en' }, typedContext, { language: track }]
  ];

  for (const [index, [variant, payload, context, value]] of cases.entries()) {
    const harness = createPageHarness();
    const requestId = `typed-playback-${index}`;
    harness.sendTyped(typedRequest(requestId, 'playback', variant, payload, context));
    await settlePageCommand();
    assert.deepEqual(plain(harness.responses.at(-1)), {
      source: 'subpal-page-script',
      target: 'subpal-content-script',
      requestId,
      response: { ok: true, value }
    }, variant);
    assert.equal(harness.responseTargetOrigins.at(-1), 'https://www.netflix.com', variant);
  }

  const jumpHarness = createPageHarness();
  const click = jumpHarness.clickTimecode({ expected: validExpected });
  jumpHarness.sendTyped(typedRequest('typed-jump', 'playback', 'jump-to-timecode', {
    targetTimestamp: validExpected.targetTimestamp,
    controlId: click.controlId,
    requestId: click.requestId,
    issuedAt: click.issuedAt
  }, typedContext));
  await settlePageCommand();
  assert.deepEqual(plain(jumpHarness.responses.at(-1)), {
    source: 'subpal-page-script',
    target: 'subpal-content-script',
    requestId: 'typed-jump',
    response: { ok: true, value: { status: 'success' } }
  });
  assert.deepEqual(jumpHarness.seekCalls, [12500]);

  const forbiddenHarness = createPageHarness();
  forbiddenHarness.sendTyped(typedRequest('typed-forbidden', 'playback', 'jump-to-timecode', {
    targetTimestamp: validExpected.targetTimestamp,
    controlId: 'control-render-1',
    requestId: 'forged-request',
    issuedAt: Date.now()
  }, typedContext));
  await settlePageCommand();
  assert.deepEqual(plain(forbiddenHarness.responses.at(-1)), {
    source: 'subpal-page-script',
    target: 'subpal-content-script',
    requestId: 'typed-forbidden',
    response: { ok: false, error: { kind: 'forbidden', code: 'trusted-click-required', retryable: false } }
  });
  assert.deepEqual(forbiddenHarness.seekCalls, []);
});

test('Given typed Playback identity telemetry When the authoritative projection is checked Then matching movie and reasonable sessions mutate while true video or session mismatches stay stale', async () => {
  const expected = { videoId: '81234567', sessionId: typedContext.sessionId, epoch: 3 };
  const stale = { ok: false, error: { kind: 'stale-context', code: 'page-context-mismatch', retryable: false } };
  const switchLanguage = async (harness, requestId, context = expected) => {
    harness.sendTyped(typedRequest(requestId, 'playback', 'switch-language', { languageCode: 'en' }, context));
    await settlePageCommand();
    return plain(harness.responses.at(-1)).response;
  };

  const movieMatch = createPageHarness({ playerApiVideoId: null, movieId: expected.videoId });
  assert.deepEqual(await switchLanguage(movieMatch, 'typed-movie-match'), {
    ok: true,
    value: { language: { code: 'en', name: 'English', trackId: 'track-en', trackType: 'PRIMARY', rawTrackType: null } }
  });
  assert.equal(movieMatch.window.subpalPageScript.getDebugSnapshot().playback.selectedSessionReason, 'watch-movie-id-match');
  assert.equal(movieMatch.trackMutations, 1);

  const reasonableMatch = createPageHarness({ videoId: '99999999', playerApiVideoId: expected.videoId, movieId: '77777777' });
  assert.deepEqual(await switchLanguage(reasonableMatch, 'typed-reasonable-match'), {
    ok: true,
    value: { language: { code: 'en', name: 'English', trackId: 'track-en', trackType: 'PRIMARY', rawTrackType: null } }
  });
  assert.equal(reasonableMatch.window.subpalPageScript.getDebugSnapshot().playback.selectedSessionReason, 'watch-reasonable-playback-state');
  assert.equal(reasonableMatch.trackMutations, 1);

  const videoMismatch = createPageHarness({ playerApiVideoId: '99999999', movieId: expected.videoId });
  assert.deepEqual(await switchLanguage(videoMismatch, 'typed-video-mismatch'), stale);
  assert.equal(videoMismatch.trackMutations, 0);

  const sessionMismatch = createPageHarness();
  assert.deepEqual(await switchLanguage(sessionMismatch, 'typed-session-mismatch', { ...expected, sessionId: 'watch-other-session' }), stale);
  assert.equal(sessionMismatch.trackMutations, 0);

  const mutationDrift = createPageHarness({ playerUi: { driftPlayerApiVideoIdOnTrackMutation: '99999999' } });
  assert.deepEqual(await switchLanguage(mutationDrift, 'typed-mutation-drift'), stale);
  assert.equal(mutationDrift.trackMutations, 1);
});

test('Given canonical typed TTML requests When received by the page Then raw-pool and diagnostic-summary stay separate and bounded', async () => {
  const harness = createPageHarness();
  harness.sendTyped(typedRequest('typed-raw', 'ttml-acquisition-query', 'raw-pool', {}));
  await settlePageCommand();
  assert.deepEqual(plain(harness.responses.at(-1)), {
    source: 'subpal-page-script',
    target: 'subpal-content-script',
    requestId: 'typed-raw',
    response: { ok: true, value: { variant: 'raw-pool', entries: {} } }
  });

  harness.sendTyped(typedRequest('typed-summary', 'ttml-acquisition-query', 'diagnostic-summary', {}));
  await settlePageCommand();
  const summary = plain(harness.responses.at(-1));
  assert.deepEqual(summary, {
    source: 'subpal-page-script',
    target: 'subpal-content-script',
    requestId: 'typed-summary',
    response: { ok: true, value: { variant: 'diagnostic-summary', count: 0 } }
  });
  assert.equal(JSON.stringify(summary).includes('rawContent'), false);
  assert.equal(JSON.stringify(summary).includes('debugSnapshot'), false);
});

test('Given intercepted raw TTML When typed queries read it Then only raw-pool contains the complete body and diagnostic-summary remains count-only', async () => {
  const rawBody = '<?xml version="1.0"?><tt xml:lang="en"><body><div><p begin="00:00:00.000" end="00:00:01.000">raw-body-secret</p></div></body></tt>';
  const harness = createPageHarness({ rawTtmlBody: rawBody });
  await harness.window.fetch('https://oca.nflxvideo.net/subtitles?o=81234567&v=1&e=1');
  await settlePageCommand();
  harness.sendTyped(typedRequest('typed-raw-nonempty', 'ttml-acquisition-query', 'raw-pool', {}));
  await settlePageCommand();
  const rawPool = plain(harness.responses.at(-1));
  assert.equal(rawPool.response.value.variant, 'raw-pool');
  assert.equal(Object.values(rawPool.response.value.entries).some(entry => entry.rawContent === rawBody), true);

  harness.sendTyped(typedRequest('typed-summary-nonempty', 'ttml-acquisition-query', 'diagnostic-summary', {}));
  await settlePageCommand();
  const summary = plain(harness.responses.at(-1));
  assert.deepEqual(summary.response.value, { variant: 'diagnostic-summary', count: 0 });
  assert.equal(JSON.stringify(summary).includes(rawBody), false);
  assert.equal(JSON.stringify(summary).includes('rawContent'), false);
  assert.equal(JSON.stringify(summary).includes('debugSnapshot'), false);
});

test('Given bounded mixed CDN response events When typed diagnostic-summary is queried Then it counts only non-TTML candidates without leaking diagnostics', async () => {
  const ttml = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div><p begin="00:00:00.000">ttml-secret</p></div></body></tt>';
  const harness = createPageHarness({
    fetchResponses: [
      { contentType: 'application/ttml+xml', body: ttml },
      { contentType: 'application/ttml+xml', body: ttml },
      { contentType: 'application/json', body: '{"not":"ttml"}' }
    ]
  });
  for (const index of [1, 2, 3]) {
    await harness.window.fetch(`https://oca.nflxvideo.net/subtitles?o=${index}&v=track&e=entry`);
    await settlePageCommand();
  }

  assert.equal(harness.window.subpalPageScript.getDebugSnapshot().interceptedTTMLCount, 2);
  harness.sendTyped(typedRequest('typed-mixed-summary', 'ttml-acquisition-query', 'diagnostic-summary', {}));
  await settlePageCommand();
  const summary = plain(harness.responses.at(-1));
  assert.deepEqual(summary.response.value, { variant: 'diagnostic-summary', count: 1 });
  assert.deepEqual(Object.keys(summary.response.value).sort(), ['count', 'variant']);
  assert.equal(JSON.stringify(summary).includes('ttml-secret'), false);
  assert.equal(JSON.stringify(summary).includes('classification'), false);
  assert.equal(JSON.stringify(summary).includes('recentEvents'), false);
  assert.equal(JSON.stringify(summary).includes('oca.nflxvideo.net'), false);
});

test('Given malformed or untrusted typed messages When received Then no Playback or TTML owner runs and only safe correlations receive invalid Results', async () => {
  const harness = createPageHarness();
  const valid = typedRequest('typed-untrusted', 'playback', 'context-snapshot', {});
  harness.sendTyped(valid, { source: {} });
  harness.sendTyped(valid, { origin: 'https://invalid.example' });
  harness.sendTyped(valid, { target: 'wrong-target' });
  await settlePageCommand();
  assert.deepEqual(harness.responses, []);
  assert.equal(harness.sessionReads, 0);

  let getterReads = 0;
  const accessorPayload = { variant: 'context-snapshot', payload: {} };
  Object.defineProperty(accessorPayload, 'variant', {
    enumerable: true,
    get() { getterReads += 1; return 'context-snapshot'; }
  });
  const malformed = typedRequest('typed-invalid', 'playback', 'context-snapshot', {});
  malformed.payload = accessorPayload;
  harness.sendTyped(malformed);
  await settlePageCommand();
  assert.deepEqual(plain(harness.responses.at(-1)), {
    source: 'subpal-page-script',
    target: 'subpal-content-script',
    requestId: 'typed-invalid',
    response: { ok: false, error: { kind: 'invalid', code: 'invalid-private-envelope', retryable: false } }
  });
  assert.equal(getterReads, 0);

  const customPrototype = Object.assign(Object.create({}), typedRequest('typed-custom', 'playback', 'context-snapshot', {}));
  const withSymbol = typedRequest('typed-symbol', 'ttml-acquisition-query', 'raw-pool', {});
  withSymbol[Symbol('private')] = true;
  const benignProxy = new Proxy(typedRequest('typed-proxy', 'playback', 'context-snapshot', {}), {});
  const revoked = Proxy.revocable(typedRequest('typed-revoked', 'playback', 'context-snapshot', {}), {});
  revoked.revoke();
  const opaqueProxy = new Proxy(typedRequest('typed-opaque', 'playback', 'context-snapshot', {}), {
    ownKeys() { throw new Error('opaque request'); }
  });
  for (const envelope of [customPrototype, withSymbol, benignProxy, revoked.proxy, opaqueProxy]) {
    harness.sendTyped(envelope);
  }
  await settlePageCommand();
  assert.equal(harness.sessionReads, 0);
  for (const response of harness.responses.slice(1)) {
    assert.deepEqual(plain(response.response), { ok: false, error: { kind: 'invalid', code: 'invalid-private-envelope', retryable: false } });
  }
});

for (const method of ['pushState', 'replaceState']) {
  test(`Given watch identity 81234567 When history.${method} changes it to 87654321 Then one VIDEO_ID_CHANGED message is emitted synchronously`, () => {
    const harness = createPageHarness();

    harness.history[method](null, '', '/watch/87654321');

    assert.deepEqual(harness.routeMessages.map(({ type, oldVideoId, newVideoId }) => ({
      type,
      oldVideoId,
      newVideoId
    })), [{
      type: 'VIDEO_ID_CHANGED',
      oldVideoId: '81234567',
      newVideoId: '87654321'
    }]);
  });
}

for (const method of ['pushState', 'replaceState']) {
  test(`Given watch identity 81234567 When history.${method} keeps that identity Then no VIDEO_ID_CHANGED message is emitted`, () => {
    const harness = createPageHarness();

    harness.history[method](null, '', '/watch/81234567?trackId=1');

    assert.deepEqual(harness.routeMessages, []);
  });
}

test('Given page script reinitialization When pushState changes watch identity Then history is not double-wrapped', () => {
  const harness = createPageHarness();
  harness.reinject();

  harness.history.pushState(null, '', '/watch/87654321');

  assert.equal(harness.routeMessages.length, 1);
});

test('Given a trusted jump intent When handled Then one selected-session seek converts seconds to milliseconds and succeeds', async () => {
  const harness = createPageHarness();
  const responsePromise = trustedJump(harness);
  await settlePageCommand();

  assert.equal(responsePromise, undefined);
  const response = harness.responses.at(-1);
  assert.deepEqual(harness.errors, []);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.status, 'success');
  assert.equal(response.targetMilliseconds, 12500);
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.deepEqual(harness.otherSeekCalls, []);
});

test('Given an invalid timestamp When a jump intent is handled Then it returns a structured failure without seeking', async () => {
  for (const targetTimestamp of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const harness = createPageHarness();
    trustedJump(harness, { ...validExpected, targetTimestamp });
    await settlePageCommand();

    const response = harness.responses.at(-1);
    assert.equal(response.success, false);
    assert.equal(response.reason, 'invalid-target-timestamp');
    assert.deepEqual(harness.seekCalls, []);
  }
});

test('Given a video or session identity mismatch When handled Then it fails before seeking', async () => {
  for (const expected of [
    { ...validExpected, videoId: 'wrong-video' },
    { ...validExpected, sessionId: 'watch-other' }
  ]) {
    const harness = createPageHarness();
    trustedJump(harness, expected);
    await settlePageCommand();

    const response = harness.responses.at(-1);
    assert.equal(response.success, false);
    assert.ok(['video-mismatch', 'session-mismatch', 'click-latch-mismatch'].includes(response.reason));
    assert.deepEqual(harness.seekCalls, []);
  }
});

test('Given a non-integer or unavailable epoch When handled Then it fails closed before seeking', async () => {
  for (const epoch of [Number.NaN, -1, 1.5]) {
    const harness = createPageHarness();
    trustedJump(harness, { ...validExpected, epoch });
    await settlePageCommand();
    assert.equal(harness.responses.at(-1).reason, 'invalid-expected-context');
    assert.deepEqual(harness.seekCalls, []);
  }

  const unavailable = createPageHarness({ apiAvailable: false });
  trustedJump(unavailable);
  await settlePageCommand();
  assert.equal(unavailable.responses.at(-1).reason, 'player-api-unavailable');
  assert.deepEqual(unavailable.seekCalls, []);
});

test('Given a low-confidence, non-watch, or unavailable selected player When handled Then it returns fallback without seeking', async () => {
  const lowConfidence = createPageHarness({ sessions: ['watch-other'] });
  trustedJump(lowConfidence);
  await settlePageCommand();
  assert.equal(lowConfidence.responses.at(-1).reason, 'untrusted-session');
  assert.deepEqual(lowConfidence.seekCalls, []);

  const nonWatch = createPageHarness({ sessions: ['preview-81234567'] });
  trustedJump(nonWatch);
  await settlePageCommand();
  assert.equal(nonWatch.responses.at(-1).reason, 'untrusted-session');
  assert.deepEqual(nonWatch.seekCalls, []);

  const unavailablePlayer = createPageHarness();
  unavailablePlayer.api.videoPlayer.getVideoPlayerBySessionId = () => null;
  trustedJump(unavailablePlayer);
  await settlePageCommand();
  assert.equal(unavailablePlayer.responses.at(-1).reason, 'duration-unavailable');
  assert.deepEqual(unavailablePlayer.seekCalls, []);
});

test('Given a target beyond fresh duration When handled Then the page clamps once to duration milliseconds', async () => {
  const harness = createPageHarness({ duration: 90000, currentTime: 60000 });
  trustedJump(harness, { ...validExpected, targetTimestamp: 120 });
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).success, true);
  assert.equal(harness.responses.at(-1).targetMilliseconds, 90000);
  assert.deepEqual(harness.seekCalls, [90000]);
});

test('Given identity changes during immediate page revalidation When handled Then it does not seek', async () => {
  const harness = createPageHarness();
  const originalGetOpenSessions = harness.api.getOpenPlaybackSessions;
  let reads = 0;
  harness.api.getOpenPlaybackSessions = () => {
    reads += 1;
    if (reads === 2) return [{ sessionId: 'watch-other' }];
    return originalGetOpenSessions();
  };

  trustedJump(harness);
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'untrusted-session');
  assert.deepEqual(harness.seekCalls, []);
});

test('Given stale old and new watch sessions When handled Then ownership is ambiguous and neither session is sought', async () => {
  const harness = createPageHarness({ sessions: ['watch-other', validExpected.sessionId] });
  trustedJump(harness);
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'ambiguous-watch-session');
  assert.deepEqual(harness.seekCalls, []);
  assert.deepEqual(harness.otherSeekCalls, []);
});

test('Given post-seek identity invalidation When handled Then it returns failure after one seek', async () => {
  const harness = createPageHarness();
  const originalGetOpenSessions = harness.api.getOpenPlaybackSessions;
  let reads = 0;
  harness.api.getOpenPlaybackSessions = () => {
    reads += 1;
    if (reads === 3) return [{ sessionId: 'watch-other' }];
    return originalGetOpenSessions();
  };

  trustedJump(harness);
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'post-identity-mismatch');
  assert.deepEqual(harness.seekCalls, [12500]);
});

test('Given a page-originated or unrelated message When dispatched Then the jump command cannot trigger', async () => {
  const harness = createPageHarness();
  harness.window.dispatchMessage({
    source: harness.window,
    data: { source: 'subpal-page-script', target: 'subpal-page-script', type: 'JUMP_TO_TIMECODE', intent: 'jump-to-timecode', expected: validExpected }
  });
  harness.window.dispatchMessage({
    source: {},
    data: { source: 'subpal-content-script', target: 'subpal-page-script', type: 'JUMP_TO_TIMECODE', intent: 'jump-to-timecode', expected: validExpected }
  });
  harness.window.dispatchMessage({ source: harness.window, data: null });
  await settlePageCommand();

  assert.deepEqual(harness.seekCalls, []);
  assert.deepEqual(harness.responses, []);
});

test('Given an exact jump envelope without a trusted latch When handled Then it fails without seeking', async () => {
  const harness = createPageHarness();
  harness.sendJump(jumpMessage(validExpected, { controlId: 'control-render-1', requestId: 'forged-request', issuedAt: Date.now() }));
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'click-latch-missing');
  assert.deepEqual(harness.seekCalls, []);
});

test('Given a trusted click bound to one expected identity When its target payload is altered Then the latch is rejected before seek', async () => {
  const harness = createPageHarness();
  const click = harness.clickTimecode({ expected: validExpected });
  harness.sendJump(jumpMessage({ ...validExpected, targetTimestamp: 15 }, click));
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'click-latch-mismatch');
  assert.deepEqual(harness.seekCalls, []);
});

test('Given more trusted clicks than the bounded latch capacity When the oldest request arrives Then it has been purged', async () => {
  const harness = createPageHarness();
  const clicks = Array.from({ length: 40 }, () => harness.clickTimecode());
  harness.sendJump(jumpMessage(validExpected, clicks[0]));
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'click-latch-missing');
  assert.deepEqual(harness.seekCalls, []);
});

test('Given synthetic, inactive, expired, replayed, or wrong-control clicks When handled Then no unsafe seek occurs', async () => {
  const synthetic = createPageHarness();
  synthetic.clickTimecode({ trusted: false });
  synthetic.sendJump(jumpMessage(validExpected, synthetic.clickTimecode({ trusted: false })));
  await settlePageCommand();
  assert.deepEqual(synthetic.seekCalls, []);

  const inactive = createPageHarness();
  inactive.clickTimecode({ userActive: false });
  inactive.sendJump(jumpMessage(validExpected, inactive.clickTimecode({ userActive: false })));
  await settlePageCommand();
  assert.deepEqual(inactive.seekCalls, []);

  const expired = createPageHarness();
  const expiredClick = expired.clickTimecode();
  expired.advanceTime(5000);
  expired.sendJump(jumpMessage(validExpected, expiredClick));
  await settlePageCommand();
  assert.equal(expired.responses.at(-1).reason, 'click-latch-expired');
  assert.deepEqual(expired.seekCalls, []);

  const replay = createPageHarness();
  const replayClick = replay.clickTimecode();
  replay.sendJump(jumpMessage(validExpected, replayClick));
  await settlePageCommand();
  replay.sendJump(jumpMessage(validExpected, replayClick));
  await settlePageCommand();
  assert.equal(replay.responses.at(-1).reason, 'click-latch-missing');
  assert.deepEqual(replay.seekCalls, [12500]);

  const wrongControl = createPageHarness();
  const wrongClick = wrongControl.clickTimecode();
  wrongClick.controlId = 'other-control';
  wrongControl.sendJump(jumpMessage(validExpected, wrongClick));
  await settlePageCommand();
  assert.equal(wrongControl.responses.at(-1).reason, 'click-latch-mismatch');
  assert.deepEqual(wrongControl.seekCalls, []);
});

test('Given multiple plausible UUID watch sessions When handled Then ownership is ambiguous and no seek occurs', async () => {
  const harness = createPageHarness({ sessions: [validExpected.sessionId, 'watch-8b7c2e1d-0000-4000-8000-000000000002'] });
  harness.api.getVideoIdBySessionId = () => validExpected.videoId;
  harness.sendJump(jumpMessage(validExpected, harness.clickTimecode()));
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'ambiguous-watch-session');
  assert.deepEqual(harness.seekCalls, []);
});

test('Given page script reinjection When the public debug handle already exists Then click authorization listener remains singular and raw player capabilities stay private', () => {
  const harness = createPageHarness();
  assert.equal(harness.clickListenerCount, 1);
  assert.equal('playerHelper' in harness.window.subpalPageScript, false);
  assert.equal('subtitleInterceptor' in harness.window.subpalPageScript, false);
  assert.equal('playerAPI' in harness.window.subpalPageScript, false);
  assert.equal('videoPlayer' in harness.window.subpalPageScript, false);
  assert.equal(typeof harness.window.subpalPageScript.getDebugSnapshot, 'function');

  harness.reinject();
  assert.equal(harness.clickListenerCount, 1);
});

test('Given delayed convergence When handled Then bounded polling accepts successful convergence', async () => {
  const harness = createPageHarness();
  let reads = 0;
  harness.selectedPlayer.seek = (milliseconds) => { harness.seekCalls.push(milliseconds); };
  harness.selectedPlayer.getCurrentTime = () => reads++ < 4 ? 120000 : 12500;
  harness.sendJump(jumpMessage(validExpected, harness.clickTimecode()));
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).status, 'success');
  assert.deepEqual(harness.seekCalls, [12500]);
});

test('Given no convergence When handled Then bounded post-seek verification preserves post-seek failure', async () => {
  const harness = createPageHarness();
  harness.selectedPlayer.seek = (milliseconds) => { harness.seekCalls.push(milliseconds); };
  harness.sendJump(jumpMessage(validExpected, harness.clickTimecode()));
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).reason, 'post-seek-mismatch');
  assert.deepEqual(harness.seekCalls, [12500]);
});

test('Given verified seek convergence while Netflix remains minimized When the native credits control is safe Then it activates once and restores normal player UI', async () => {
  const harness = createPageHarness({ playerUi: { minimized: true } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'restored');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
  assert.equal(harness.minimizedConnected, false);
  assert.equal(harness.normalControlsConnected, true);
});

test('Given verified seek convergence with exact-player native controls visible When restoration rechecks it Then the jump remains successful without a false warning', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    normalControls: true,
    restoreOnCreditsClick: false
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'restored', JSON.stringify(response));
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.ok(harness.creditsClickCount <= 1);
  assert.equal(harness.globalCreditsClickCount, 0);
  assert.equal(harness.nextEpisodeClickCount, 0);
  assert.equal(harness.normalControlsConnected, true);
});

test('Given a trusted Type A next-episode jump with settling media When owned current controls replace live CTAs Then persistent marker and auto-hidden controls still prove success', async () => {
  const harness = createPageHarness({ playerUi: {
    nextEpisode: true,
    minimized: true,
    controlsStandard: true,
    controlsStandardAfterPlayerChecks: 4,
    mediaSettlesAfterPlayerChecks: 3
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.snapshot.videoId, validExpected.videoId);
  assert.equal(response.snapshot.sessionId, validExpected.sessionId);
  assert.equal(response.targetMilliseconds, 12500);
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.minimizedMarkerConnected, true);
  assert.equal(harness.creditsConnected, false);
  assert.equal(harness.nextEpisodeConnected, false);
  assert.equal(harness.controlsStandardConnected, true);
  assert.equal(harness.timelineConnected, true);
  assert.equal(harness.playPauseConnected, true);
  assert.equal(harness.mediaSettled, true);
  assert.ok(harness.creditsClickCount <= 1);
  assert.equal(harness.nextEpisodeClickCount, 0);
});

test('Given live Type A next-episode controls expose control-play-pause-play When the jump converges Then the exact owned play/pause selector proves restoration', async () => {
  const harness = createPageHarness({ playerUi: {
    nextEpisode: true,
    minimized: true,
    playPauseSelector: 'control-play-pause-play',
    controlsStandard: true,
    controlsStandardAfterPlayerChecks: 4,
    mediaSettlesAfterPlayerChecks: 3
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.snapshot.videoId, validExpected.videoId);
  assert.equal(response.snapshot.sessionId, validExpected.sessionId);
  assert.equal(response.targetMilliseconds, 12500);
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.minimizedMarkerConnected, true);
  assert.equal(harness.creditsConnected, false);
  assert.equal(harness.nextEpisodeConnected, false);
  assert.equal(harness.controlsStandardConnected, true);
  assert.equal(harness.timelineConnected, true);
  assert.equal(harness.playPauseConnected, true);
  assert.equal(harness.mediaSettled, true);
  assert.ok(harness.creditsClickCount <= 1);
  assert.equal(harness.nextEpisodeClickCount, 0);
});

test('Given hidden or stale Type A next-episode credits CTAs When restoration is attempted Then it remains partial without unsafe activation', async () => {
  for (const playerUi of [
    { nextEpisode: true, minimized: true, creditsVisible: false },
    { nextEpisode: true, minimized: true, creditsConnected: false, returnStaleCredits: true }
  ]) {
    const harness = createPageHarness({ playerUi });

    trustedJump(harness);
    await settlePageCommand();

    const response = harness.responses.at(-1);
    assert.equal(response.success, false, JSON.stringify(response));
    assert.equal(response.status, 'partial', JSON.stringify(response));
    assert.equal(response.partial, true, JSON.stringify(response));
    assert.equal(response.reason, 'player-ui-restore-control-unusable');
    assert.equal(response.playerUiRestore.reason, 'player-ui-restore-control-unusable');
    assert.deepEqual(harness.seekCalls, [12500]);
    assert.equal(harness.creditsClickCount, 0);
    assert.equal(harness.nextEpisodeClickCount, 0);
  }
});

test('Given a persistent Type A next-episode CTA When current controls never replace it Then restoration remains partial after one credits activation', async () => {
  const harness = createPageHarness({ playerUi: {
    nextEpisode: true,
    minimized: true,
    typeANextEpisodeCtasLiveAfterSeek: true,
    restoreOnCreditsClick: false
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-type-a-next-episode-cta-live');
  assert.equal(response.playerUiRestore.reason, 'player-ui-restore-type-a-next-episode-cta-live');
  assert.equal(response.playerUiRestore.activated, true);
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
  assert.equal(harness.nextEpisodeClickCount, 0);
});

test('Given Type A next-episode credits activation throws When restoration attempts it Then it remains partial without retrying', async () => {
  const harness = createPageHarness({ playerUi: {
    nextEpisode: true,
    minimized: true,
    typeANextEpisodeCtasLiveAfterSeek: true,
    creditsClickThrows: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-activation-failed');
  assert.equal(response.playerUiRestore.reason, 'player-ui-restore-activation-failed');
  assert.equal(response.playerUiRestore.activated, false);
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
  assert.equal(harness.nextEpisodeClickCount, 0);
});

test('Given Type A next-episode media never settles within the restore deadline When a trusted jump converges Then restoration remains partial without activation', async () => {
  const harness = createPageHarness({ playerUi: {
    nextEpisode: true,
    minimized: true,
    mediaSettlesAfterPlayerChecks: 1000
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-media-unusable');
  assert.equal(response.playerUiRestore.reason, 'player-ui-restore-media-unusable');
  assert.equal(response.playerUiRestore.activated, false);
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
  assert.equal(harness.nextEpisodeClickCount, 0);
});

test('Given the live minimized ancestor contains the unique expected player When restoration runs Then it activates native credits and seeks exactly once', async () => {
  const harness = createPageHarness({ playerUi: { minimized: true, markerLayout: 'ancestor' } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.playerUiRestore.status, 'restored', JSON.stringify(response));
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
});

test('Given the live minimized ancestor has no safe restore controls When a trusted jump converges Then seek succeeds without unsafe UI activation', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    markerLayout: 'ancestor',
    creditsMissing: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.reason, 'seeked', JSON.stringify(response));
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
  assert.equal(harness.globalCreditsClickCount, 0);
  assert.equal(harness.nextEpisodeClickCount, 0);
  assert.equal(response.playerUiRestore.success, false, JSON.stringify(response));
  assert.equal(response.playerUiRestore.activated, false, JSON.stringify(response));
  assert.equal(response.playerUiRestore.reason, 'player-ui-restore-control-missing', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'unavailable', JSON.stringify(response));
});

test('Given the minimized expected player has no credits control but visible player controls When a trusted jump converges Then restoration is proven without activation', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    markerLayout: 'ancestor',
    creditsMissing: true,
    normalControls: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.success, true, JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'restored', JSON.stringify(response));
  assert.equal(response.playerUiRestore.reason, 'player-ui-restored', JSON.stringify(response));
  assert.equal(response.playerUiRestore.activated, false, JSON.stringify(response));
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
  assert.equal(harness.globalCreditsClickCount, 0);
});

test('Given an unrelated minimized ancestor When restoration runs Then it cannot authorize native activation', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    markerLayout: 'ancestor',
    unrelatedAncestor: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-marker-ownership-invalid');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
});

test('Given a detached minimized marker When restoration runs Then it cannot authorize native activation', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    markerLayout: 'ancestor',
    detachedMarker: true,
    returnStaleMinimized: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-marker-ownership-invalid');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
});

test('Given multiple minimized ancestors contain the expected player When restoration runs Then marker ownership fails closed', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    markerLayout: 'ancestor',
    multipleContainingMarkers: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-marker-ownership-ambiguous');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
});

test('Given verified seek convergence with normal player UI When handled Then restoration is not needed and no native control activates', async () => {
  const harness = createPageHarness();

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'not-needed');
  assert.equal(harness.creditsClickCount, 0);
});

test('Given no connected wrapper for the expected video When restoration runs Then unrelated global elements cannot authorize activation', async () => {
  const harness = createPageHarness({ playerUi: {
    nextEpisode: true,
    minimized: true,
    absentExpectedWrapper: true,
    globalUnrelatedElements: true,
    globalUnrelatedControls: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-ownership-missing');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
  assert.equal(harness.globalCreditsClickCount, 0);
});

test('Given multiple connected wrappers with the expected videoId When restoration runs Then ambiguous ownership fails closed without activation', async () => {
  const harness = createPageHarness({ playerUi: { nextEpisode: true, minimized: true, multipleExpectedWrappers: true } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-ownership-ambiguous');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
});

test('Given unrelated global video credits and controls When the expected wrapper lacks its native control Then no global fallback clicks or proves success', async () => {
  const harness = createPageHarness({ playerUi: {
    nextEpisode: true,
    minimized: true,
    creditsMissing: true,
    mediaMissingWithinExpected: true,
    globalUnrelatedElements: true,
    globalUnrelatedControls: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-media-unusable');
  assert.equal(harness.creditsClickCount, 0);
  assert.equal(harness.globalCreditsClickCount, 0);
});

test('Given delayed expected-wrapper and credits-control render When restoration waits within its bound Then it activates and seeks exactly once', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    wrapperMissingChecks: 2,
    creditsMissingChecks: 2
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'restored');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
});

test('Given an expected-player credits control is initially hidden or disabled When it later becomes usable Then restoration activates exactly once', async () => {
  for (const delayedState of [
    { creditsHiddenChecks: 3 },
    { creditsDisabledChecks: 3 }
  ]) {
    const harness = createPageHarness({ playerUi: { minimized: true, ...delayedState } });

    trustedJump(harness);
    await settlePageCommand();

    const response = harness.responses.at(-1);
    assert.equal(response.status, 'success', JSON.stringify(response));
    assert.equal(response.playerUiRestore.status, 'restored');
    assert.deepEqual(harness.seekCalls, [12500]);
    assert.equal(harness.creditsClickCount, 1);
  }
});

test('Given an expected-player credits control never becomes visible or enabled When bounded waiting expires Then restoration remains partial without activation', async () => {
  for (const unusableState of [
    { creditsVisible: false },
    { creditsDisabled: true }
  ]) {
    const harness = createPageHarness({ playerUi: { minimized: true, ...unusableState } });

    trustedJump(harness);
    await settlePageCommand();

    const response = harness.responses.at(-1);
    assert.equal(response.status, 'partial', JSON.stringify(response));
    assert.equal(response.reason, 'player-ui-restore-control-unusable');
    assert.deepEqual(harness.seekCalls, [12500]);
    assert.equal(harness.creditsClickCount, 0);
  }
});

test('Given the expected player stops being visibly minimized while waiting for a usable credits control When restoration rechecks it Then it returns not-needed without activation', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    creditsDisabled: true,
    hideMinimizedAfterPlayerChecks: 3
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'not-needed');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
});

test('Given the expected player becomes normal while waiting for its credits control When restoration rechecks it Then it returns not-needed without activation', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    creditsMissingChecks: 4,
    becomeNormalAfterPlayerChecks: 3
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'not-needed');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
});

test('Given React replaces the expected wrapper after native activation When verification re-queries exact ownership Then the replacement can prove restoration', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    markerLayout: 'ancestor',
    replaceExpectedWrapperOnCreditsClick: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.playerUiRestore.status, 'restored');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
});

test('Given the expected player remains minimized after activation while unrelated global controls are visible When verification runs Then global controls cannot prove restoration', async () => {
  const harness = createPageHarness({ playerUi: {
    minimized: true,
    markerLayout: 'ancestor',
    restoreOnCreditsClick: false,
    globalUnrelatedControls: true
  } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-timeout');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
});

test('Given a minimized player with a missing, disabled, stale, wrong-player, or ended-media control When handled Then only valid no-control capability is unavailable and other restore cases fail closed after one seek', async () => {
  for (const [playerUi, expectedStatus, expectedReason, expectedRestore] of [
    [{ minimized: true, creditsMissing: true }, 'success', 'seeked', {
      success: false,
      status: 'unavailable',
      reason: 'player-ui-restore-control-missing',
      activated: false
    }],
    [{ minimized: true, creditsDisabled: true }, 'partial', 'player-ui-restore-control-unusable'],
    [{ minimized: true, creditsConnected: false, returnStaleCredits: true }, 'partial', 'player-ui-restore-control-unusable'],
    [{ nextEpisode: true, minimized: true, typeANextEpisodeCtasLiveAfterSeek: true, creditsWrongPlayer: true }, 'partial', 'player-ui-restore-control-wrong-player'],
    [{ nextEpisode: true, minimized: true, mediaEnded: true }, 'partial', 'player-ui-restore-media-unusable']
  ]) {
    const harness = createPageHarness({ playerUi });

    trustedJump(harness);
    await settlePageCommand();

    const response = harness.responses.at(-1);
    assert.equal(response.success, expectedStatus === 'success', JSON.stringify(response));
    assert.equal(response.status, expectedStatus, JSON.stringify(response));
    assert.equal(response.reason, expectedReason);
    if (expectedStatus === 'partial') assert.equal(response.partial, true, JSON.stringify(response));
    if (expectedRestore) {
      assert.equal(response.playerUiRestore.success, expectedRestore.success);
      assert.equal(response.playerUiRestore.status, expectedRestore.status);
      assert.equal(response.playerUiRestore.reason, expectedRestore.reason);
      assert.equal(response.playerUiRestore.activated, expectedRestore.activated);
    }
    assert.deepEqual(harness.seekCalls, [12500]);
    assert.equal(harness.creditsClickCount, 0);
  }
});

test('Given Netflix identity changes after native credits activation When restoration waits Then it fails closed without a second click or seek', async () => {
  const harness = createPageHarness({
    playerUi: { nextEpisode: true, minimized: true, typeANextEpisodeCtasLiveAfterSeek: true, identityChangeOnCreditsClick: true, restoreOnCreditsClick: false }
  });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-identity-changed');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
});

test('Given native credits activation does not restore the minimized player When bounded waiting expires Then it reports non-convergence without retrying', async () => {
  const harness = createPageHarness({ playerUi: { minimized: true, restoreOnCreditsClick: false } });

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, false, JSON.stringify(response));
  assert.equal(response.status, 'partial', JSON.stringify(response));
  assert.equal(response.partial, true, JSON.stringify(response));
  assert.equal(response.reason, 'player-ui-restore-timeout');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 1);
});

test('Given a safe credits button with arbitrary localized text When restoration runs Then selection does not depend on its text', async () => {
  const harness = createPageHarness({ playerUi: { minimized: true, creditsText: 'Abspann ansehen' } });

  trustedJump(harness);
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).playerUiRestore.status, 'restored');
  assert.equal(harness.creditsClickCount, 1);
});

test('Given minimized end-screen controls When restoration runs Then the next-episode control is never activated', async () => {
  const harness = createPageHarness({ playerUi: { minimized: true } });

  trustedJump(harness);
  await settlePageCommand();

  assert.equal(harness.responses.at(-1).status, 'success');
  assert.equal(harness.responses.length, 1);
  assert.equal(harness.creditsClickCount, 1);
  assert.equal(harness.nextEpisodeClickCount, 0);
});

test('Given a non-Type A next-episode preview-like DOM When a trusted jump converges Then baseline seek succeeds without activating credits or next episode', async () => {
  const harness = createPageHarness({ playerUi: { previewLike: true } });
  const ordinaryHarness = createPageHarness();

  assert.equal(ordinaryHarness.document.querySelector('[data-uia="promoted-video"]'), null);
  assert.ok(harness.document.querySelector('[data-uia="background-video-container"]')?.isConnected);
  assert.ok(harness.document.querySelector('[data-uia="promoted-video"]')?.isConnected);
  assert.ok(harness.document.querySelector('[data-uia="postplay-background-play"]')?.isConnected);
  assert.equal(harness.document.querySelector('button[data-uia="watch-credits-seamless-button"]'), null);
  assert.equal(harness.document.querySelector('button[data-uia="next-episode-seamless-button"]')?.isConnected, false);

  trustedJump(harness);
  await settlePageCommand();

  const response = harness.responses.at(-1);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.status, 'success', JSON.stringify(response));
  assert.equal(response.reason, 'seeked');
  assert.equal(response.playerUiRestore.status, 'not-needed');
  assert.deepEqual(harness.seekCalls, [12500]);
  assert.equal(harness.creditsClickCount, 0);
  assert.equal(harness.nextEpisodeClickCount, 0);
});
