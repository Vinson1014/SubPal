import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadManagerHarness() {
  const source = await readFile(new URL('../content/core/playback-context-manager.js', import.meta.url), 'utf8');
  const handlers = [];
  const dispatchedEvents = [];
  const scheduledTimeouts = [];
  const clearedTimeoutIds = [];
  const playbackCalls = [];
  const createdPlaybacks = [];
  let nextTimeoutId = 1;
  let perform = async () => ({
    ok: true,
    value: {
      variant: 'context-snapshot',
      playback: createSnapshot()
    }
  });
  const createOwnedPlayback = () => {
    const playback = {
      disposals: 0,
      perform(intent, cancellation) {
        playbackCalls.push({ intent, cancellation, playback });
        return perform(intent, cancellation);
      },
      dispose() {
        playback.disposals += 1;
      }
    };
    createdPlaybacks.push(playback);
    return playback;
  };
  const messagingSource = `
    export function registerInternalEventHandler(_type, handler) {
      globalThis.handlers.push(handler);
      return () => {
        const index = globalThis.handlers.indexOf(handler);
        if (index !== -1) globalThis.handlers.splice(index, 1);
      };
    }
    export function dispatchInternalEvent(event) {
      globalThis.dispatchedEvents.push(event);
    }
  `;
  const context = vm.createContext({
    console,
    AbortController,
    Date,
    setTimeout: (callback, delay) => {
      const id = nextTimeoutId;
      nextTimeoutId += 1;
      scheduledTimeouts.push({ id, callback, delay });
      return id;
    },
    clearTimeout: (id) => {
      clearedTimeoutIds.push(id);
    },
    setInterval: () => 1,
    clearInterval() {},
    handlers,
    dispatchedEvents
  });
  const messagingModule = new vm.SourceTextModule(messagingSource, { context, identifier: 'messaging-stub.js' });
  const playbackModule = new vm.SyntheticModule(['createPagePlayback'], function initialize() {
    this.setExport('createPagePlayback', createOwnedPlayback);
  }, { context, identifier: 'playback-stub.js' });
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/core/playback-context-manager.js' });
  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messagingModule;
    if (specifier === '../system/capabilities/playback.js') return playbackModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await messagingModule.evaluate();
  await module.evaluate();
  return {
    Manager: module.namespace.PlaybackContextManager,
    handlers,
    dispatchedEvents,
    scheduledTimeouts,
    clearedTimeoutIds,
    playbackCalls,
    createdPlaybacks,
    setPerform(nextPerform) { perform = nextPerform; },
    getPlaybackDisposals: () => createdPlaybacks.reduce((total, playback) => total + playback.disposals, 0)
  };
}

function createSnapshot(videoId = '81234567') {
  return {
    pageUrlVideoId: videoId,
    playerApiVideoId: videoId,
    movieId: videoId,
    selectedSessionId: 'watch-session-a',
    selectedSessionReason: 'watch-player-api-video-id-match',
    sessionSelectionConfidence: 'high',
    currentTime: 0,
    duration: 180,
    currentTrack: {
      code: 'en',
      name: 'English',
      trackId: 'track-en',
      trackType: 'PRIMARY',
      rawTrackType: null
    }
  };
}

function contextSnapshotResult(videoId) {
  return {
    ok: true,
    value: {
      variant: 'context-snapshot',
      playback: createSnapshot(videoId)
    }
  };
}

test('Given a normalized initial snapshot failure When an owned PlaybackContext retries Then it disposes the failed owner once and creates a fresh owner without duplicate handlers', async () => {
  const { Manager, handlers, playbackCalls, createdPlaybacks, setPerform, getPlaybackDisposals } = await loadManagerHarness();
  const manager = new Manager();

  setPerform(async () => ({
    ok: false,
    error: { kind: 'timeout', code: 'playback-timeout', retryable: true }
  }));
  await assert.rejects(manager.initialize(), /playback-timeout/);
  assert.equal(handlers.length, 0);
  assert.equal(createdPlaybacks.length, 1);
  assert.equal(getPlaybackDisposals(), 1);

  manager.cleanup();
  manager.cleanup();
  assert.equal(getPlaybackDisposals(), 1);

  setPerform(async () => contextSnapshotResult());
  await manager.initialize();
  await manager.initialize();
  assert.equal(handlers.length, 1);
  assert.equal(createdPlaybacks.length, 2);
  assert.equal(createdPlaybacks[0].disposals, 1);
  assert.equal(createdPlaybacks[1].disposals, 0);
  assert.deepEqual(playbackCalls.map(({ intent }) => JSON.parse(JSON.stringify(intent))), [
    { variant: 'context-snapshot', payload: {} },
    { variant: 'context-snapshot', payload: {} }
  ]);

  manager.cleanup();
  manager.cleanup();
  assert.equal(handlers.length, 0);
  assert.equal(getPlaybackDisposals(), 2);
  assert.equal(createdPlaybacks[1].disposals, 1);
});

test('Given an injected Playback When its initial typed snapshot fails Then PlaybackContext never disposes the injected dependency', async () => {
  const { Manager } = await loadManagerHarness();
  let injectedDisposals = 0;
  const injectedPlayback = {
    async perform() {
      return {
        ok: false,
        error: { kind: 'timeout', code: 'playback-timeout', retryable: true }
      };
    },
    dispose() {
      injectedDisposals += 1;
    }
  };
  const manager = new Manager({ playback: injectedPlayback });

  await assert.rejects(manager.initialize(), /playback-timeout/);
  manager.cleanup();
  manager.cleanup();

  assert.equal(injectedDisposals, 0);
});

test('Given a pending video-change refresh When cleanup runs before its delay Then firing the captured callback causes no late work', async () => {
  const {
    Manager,
    handlers,
    dispatchedEvents,
    scheduledTimeouts,
    clearedTimeoutIds,
    playbackCalls
  } = await loadManagerHarness();
  const manager = new Manager();
  await manager.initialize();

  handlers[0]({ oldVideoId: null, newVideoId: '81234567' });
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delay, 1000);

  manager.cleanup();
  const statusAfterCleanup = manager.getStatus();
  const playbackCallsAfterCleanup = playbackCalls.length;
  const dispatchedEventCountAfterCleanup = dispatchedEvents.length;
  await scheduledTimeouts[0].callback();
  await Promise.resolve();

  assert.deepEqual(clearedTimeoutIds, [scheduledTimeouts[0].id]);
  assert.equal(playbackCalls.length, playbackCallsAfterCleanup);
  assert.equal(dispatchedEvents.length, dispatchedEventCountAfterCleanup);
  assert.deepEqual(manager.getStatus(), statusAfterCleanup);
});

test('Given an older snapshot that settles after VIDEO_ID_CHANGED When the newer generation owns the context Then the stale snapshot is aborted and cannot overwrite it', async () => {
  const { Manager, handlers, dispatchedEvents, setPerform } = await loadManagerHarness();
  const manager = new Manager();
  await manager.initialize();

  let resolveLateSnapshot;
  let lateSignal;
  setPerform((_intent, cancellation) => new Promise((resolve) => {
    resolveLateSnapshot = resolve;
    lateSignal = cancellation;
  }));
  const lateRefresh = manager.refreshContext('poll');

  await handlers[0]({ oldVideoId: '81234567', newVideoId: '99999999' });
  const eventCountAfterVideoChange = dispatchedEvents.length;
  assert.equal(lateSignal.aborted, true);

  resolveLateSnapshot(contextSnapshotResult('81234567'));
  await lateRefresh;

  assert.equal(manager.getCurrentContext().videoId, '99999999');
  assert.equal(manager.getCurrentContext().source, 'VIDEO_ID_CHANGED');
  assert.equal(dispatchedEvents.length, eventCountAfterVideoChange);
});

test('Given the PlaybackContext source When inspected Then it never reads a debug snapshot or generic page command', async () => {
  const source = await readFile(new URL('../content/core/playback-context-manager.js', import.meta.url), 'utf8');

  assert.match(source, /createPagePlayback/);
  assert.match(source, /variant:\s*'context-snapshot'/);
});
