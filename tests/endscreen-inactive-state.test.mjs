import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeNode, FakeObserver, createContext, createHarness, loadAdapter } from './endscreen-signal-adapter-fixtures.mjs';

const REPLACEMENT_MEDIA = { currentTime: 21, duration: 63, readyState: 4, ended: false, paused: false };
const MEDIA_SIGNAL_TYPES = ['ended', 'pause', 'play', 'timeupdate'];

function createRecommendationHarness() {
  const harness = createHarness({
    media: { currentTime: 20, duration: 63, ended: false, paused: false },
    markers: [{ uia: 'background-video-container' }, { uia: 'promoted-video' }, { uia: 'postplay-background-play' }]
  });
  harness.roots[0].dataset.uia = 'watch-video';
  return harness;
}

function createAdapter(Adapter, harness, inactiveCommands) {
  return new Adapter({
    document: harness.document,
    Observer: FakeObserver,
    schedule: harness.scheduler.schedule,
    cancel: harness.scheduler.cancel,
    getContext: harness.context,
    controller: harness.controller,
    onInactive: () => inactiveCommands.push('ENDSCREEN_INACTIVE')
  });
}

function assertMediaListenersAttached(media) {
  assert.deepEqual([...media.listeners.keys()], MEDIA_SIGNAL_TYPES);
  for (const type of MEDIA_SIGNAL_TYPES) assert.equal(media.listeners.get(type).length, 1);
}

test('Given an active endscreen panel When playback resumes and the candidate disappears Then the adapter emits an inactive signal without observing a task', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 20, duration: 1800, ended: false, paused: false },
    markers: [{ uia: 'background-video-container' }, { uia: 'promoted-video' }, { uia: 'postplay-background-play' }]
  });
  harness.roots[0].dataset.uia = 'watch-video';
  const inactiveCommands = [];
  const adapter = createAdapter(Adapter, harness, inactiveCommands);
  adapter.start();

  harness.video.dispatch('play');
  harness.scheduler.flush();
  harness.video.paused = true;
  for (const marker of harness.markerNodes) marker.isConnected = false;
  harness.video.dispatch('pause');
  harness.scheduler.flush();
  harness.scheduler.advance(500);

  assert.equal(harness.observations.length, 1, '播放恢復前應保留已觀察的 eligible candidate');
  assert.deepEqual(inactiveCommands, ['ENDSCREEN_INACTIVE'], '候選消失時應只發出一次 isolated inactive command');
});

test('Given the type-b recommendation shell remains When media is replaced before inactive confirmation Then inactive is canceled and the replacement is observed', async () => {
  const Adapter = await loadAdapter();
  const harness = createRecommendationHarness();
  const inactiveCommands = [];
  const adapter = createAdapter(Adapter, harness, inactiveCommands);
  adapter.start();
  harness.video.dispatch('play');
  harness.scheduler.flush();

  harness.video.remove();
  FakeObserver.instances[0].trigger();
  harness.scheduler.flush();
  const replacement = harness.roots[0].append(new FakeNode({ media: REPLACEMENT_MEDIA }));
  FakeObserver.instances[0].trigger();
  harness.scheduler.flush();
  harness.scheduler.advance(500);

  assert.deepEqual(inactiveCommands, []);
  assertMediaListenersAttached(replacement);
  assert.equal(harness.observations.length, 2);
  assert.equal(harness.observations[1].snapshot.currentTime, 21);
});

test('Given the type-b recommendation shell remains When media is replaced after inactive confirmation Then inactive stays suppressed and a later mutation observes the replacement', async () => {
  const Adapter = await loadAdapter();
  const harness = createRecommendationHarness();
  const inactiveCommands = [];
  const adapter = createAdapter(Adapter, harness, inactiveCommands);
  adapter.start();
  harness.video.dispatch('play');
  harness.scheduler.flush();

  harness.video.remove();
  FakeObserver.instances[0].trigger();
  harness.scheduler.flush();
  harness.scheduler.advance(500);
  const replacement = harness.roots[0].append(new FakeNode({ media: REPLACEMENT_MEDIA }));
  FakeObserver.instances[0].trigger();
  harness.scheduler.flush();

  assert.deepEqual(inactiveCommands, []);
  assertMediaListenersAttached(replacement);
  assert.equal(harness.observations.length, 2);
  assert.equal(harness.observations[1].snapshot.currentTime, 21);
});

test('Given Netflix briefly replaces the type-b recommendation shell When the shell returns within the inactive debounce Then the visible card is not dismissed', async () => {
  const Adapter = await loadAdapter();
  const context = createContext();
  const harness = createRecommendationHarness();
  harness.context = () => context;
  const inactiveSignals = [];
  const adapter = new Adapter({
    document: harness.document,
    Observer: FakeObserver,
    schedule: harness.scheduler.schedule,
    cancel: harness.scheduler.cancel,
    getContext: harness.context,
    controller: harness.controller,
    onInactive: () => inactiveSignals.push(true)
  });
  adapter.start();
  harness.video.dispatch('play');
  harness.scheduler.flush();

  context.state = 'transitioning';
  context.sessionId = 'background-session-1';
  for (const marker of harness.markerNodes) marker.isConnected = false;
  FakeObserver.instances[0].trigger();
  harness.scheduler.flush();
  for (const marker of harness.markerNodes) marker.isConnected = true;
  harness.video.isConnected = false;
  harness.video.paused = true;
  harness.video.dispatch('pause');
  harness.scheduler.flush();
  harness.scheduler.advance(500);

  assert.deepEqual(inactiveSignals, []);
  assert.equal(harness.observations.length, 1);
});
