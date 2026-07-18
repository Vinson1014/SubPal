import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeNode, FakeObserver, createContext, createHarness, loadAdapter, start } from './endscreen-signal-adapter-fixtures.mjs';

test('Given one trusted terminal next-episode CTA and ended media When its event is coalesced Then it is rejected', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ markers: [{ uia: 'next-episode-seamless-button' }] });
  start(Adapter, harness);

  harness.video.dispatch('ended');
  FakeObserver.instances[0].trigger();
  assert.equal(harness.scheduler.pending, 1);
  harness.scheduler.flush();

  assert.deepEqual(harness.observations, []);
});

test('Given one trusted terminal next-episode CTA and media paused exactly at its end When pause fires Then it is rejected', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ media: { ended: false, paused: true }, markers: [{ uia: 'next-episode-seamless-button' }] });
  start(Adapter, harness);

  harness.video.dispatch('pause');
  harness.scheduler.flush();

  assert.deepEqual(harness.observations, []);
});

test('Given one trusted active type-b state-b-recommendation-trailer with every empirical marker When it plays Then it observes the hardened type-b contract', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 20, duration: 1800, ended: false, paused: false },
    markers: [{ uia: 'background-video-container' }, { uia: 'background-video' }, { uia: 'promoted-video' }, { uia: 'postplay-background-play' }]
  });
  harness.roots[0].dataset.uia = 'watch-video';
  start(Adapter, harness);

  harness.video.dispatch('play');
  harness.scheduler.flush();

  assert.deepEqual(JSON.parse(JSON.stringify(harness.observations)), [{
    context: createContext(),
    snapshot: { currentTime: 20, duration: 1800, state: 'playing' },
    variant: 'type-b',
    evidence: { promotedPreview: true }
  }]);
});

test('Given the live Netflix type-b state-b-recommendation-trailer hierarchy with an opacity-zero video wrapper When it plays Then it observes type-b', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 21, duration: 63, ended: false, paused: false },
    markers: [
      { uia: 'background-video-container' },
      { uia: 'background-video', style: { opacity: '0' } },
      { uia: 'promoted-video' },
      { uia: 'postplay-background-play' }
    ]
  });
  const watchVideo = harness.roots[0];
  watchVideo.dataset.uia = 'watch-video';
  const trailer = watchVideo.append(new FakeNode());
  const backgroundContainer = harness.markerNodes[0];
  const backgroundVideo = harness.markerNodes[1];
  const promotedVideo = harness.markerNodes[2];
  const playAction = harness.markerNodes[3];
  watchVideo.children = watchVideo.children.filter((node) =>
    ![harness.video, backgroundContainer, backgroundVideo, promotedVideo, playAction].includes(node)
  );
  trailer.append(backgroundContainer);
  backgroundContainer.append(backgroundVideo);
  backgroundVideo.append(new FakeNode()).append(harness.video);
  trailer.append(new FakeNode()).append(promotedVideo).append(playAction);
  start(Adapter, harness);

  harness.video.dispatch('play');
  harness.scheduler.flush();

  assert.equal(harness.observations[0]?.variant, 'type-b');
});

test('Given the type-b recommendation shell is visible during its state-a-recommendation-countdown pause When the media pauses Then it preserves a paused type-b observation', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 21, duration: 63, ended: false, paused: true },
    markers: [
      { uia: 'background-video-container' },
      { uia: 'promoted-video' },
      { uia: 'postplay-background-play' }
    ]
  });
  harness.roots[0].dataset.uia = 'watch-video';
  start(Adapter, harness);

  harness.video.dispatch('pause');
  harness.scheduler.flush();

  assert.equal(harness.observations[0]?.variant, 'type-b');
  assert.equal(harness.observations[0]?.snapshot?.state, 'paused');
});

test('Given one trusted live type-a-next-episode capture with direct player-root children at alternate finite media values When it plays Then it observes the hardened type-a-next-episode contract once', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 1111.25, duration: 2222.5, ended: false, paused: false, readyState: 4 },
    markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'next-episode-seamless-button' }]
  });
  harness.roots[0].dataset.uia = 'player';
  start(Adapter, harness);

  harness.video.dispatch('play');
  harness.scheduler.flush();

  assert.deepEqual(JSON.parse(JSON.stringify(harness.observations)), [{
    context: createContext(),
    snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' },
    variant: 'type-a-next-episode',
    evidence: { watchCreditsCta: true, nextEpisodeCta: true }
  }]);
});

test('Given one trusted live type-a-next-episode capture with split hierarchy under exactly one live player root at different finite media values When it plays Then it observes the hardened type-a-next-episode contract once', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 987.5, duration: 1975.25, ended: false, paused: false, readyState: 4 },
    markers: [{ uia: 'watch-credits-seamless-button', root: 0 }, { uia: 'next-episode-seamless-button', root: 0 }]
  });
  const player = harness.roots[0];
  player.dataset.uia = 'player';
  const videoCanvas = player.append(new FakeNode());
  const seamlessControls = player.append(new FakeNode());
  player.children = player.children.filter((node) => node !== harness.video && node !== harness.markerNodes[0] && node !== harness.markerNodes[1]);
  videoCanvas.append(harness.video);
  seamlessControls.append(harness.markerNodes[0]);
  seamlessControls.append(harness.markerNodes[1]);
  start(Adapter, harness);

  harness.video.dispatch('play');
  harness.scheduler.flush();

  assert.deepEqual(JSON.parse(JSON.stringify(harness.observations)), [{
    context: createContext(),
    snapshot: { currentTime: 987.5, duration: 1975.25, state: 'playing' },
    variant: 'type-a-next-episode',
    evidence: { watchCreditsCta: true, nextEpisodeCta: true }
  }]);
});

test('Given ordinary playback, an early pause, or non-ready media When events arrive Then no observation is emitted', async () => {
  const Adapter = await loadAdapter();
  for (const media of [
    { currentTime: 20, duration: 1800, ended: false, paused: false },
    { currentTime: 20, duration: 1800, ended: false, paused: true },
    { readyState: 3 }
  ]) {
    const harness = createHarness({ media, markers: [] });
    start(Adapter, harness);
    harness.video.dispatch('timeupdate');
    harness.scheduler.flush();
    assert.deepEqual(harness.observations, []);
  }
});

test('Given stale preview DOM at terminal media or next CTA at active media When checked Then variant cross-contamination emits nothing', async () => {
  const Adapter = await loadAdapter();
  for (const fixture of [
    { media: { ended: true, paused: false }, markers: [{ uia: 'background-video' }, { uia: 'promoted-video' }, { uia: 'postplay-background-play' }] },
    { media: { currentTime: 20, ended: false, paused: false }, markers: [{ uia: 'next-episode-seamless-button' }] }
  ]) {
    const harness = createHarness(fixture);
    start(Adapter, harness);
    harness.video.dispatch('timeupdate');
    harness.scheduler.flush();
    assert.deepEqual(harness.observations, []);
  }
});

test('Given hidden or detached markers, ambiguous candidates, or markers in separate roots When checked Then no observation is emitted', async () => {
  const Adapter = await loadAdapter();
  const fixtures = [
    { media: { currentTime: 1378.496948, duration: 1536.159625, ended: false, paused: false, readyState: 4 }, markers: [{ uia: 'watch-credits-seamless-button', visible: false }] },
    { media: { currentTime: 1378.496948, duration: 1536.159625, ended: false, paused: false, readyState: 4 }, markers: [{ uia: 'watch-credits-seamless-button', connected: false }] },
    { media: { currentTime: 1378.496948, duration: 1536.159625, ended: false, paused: false, readyState: 4 }, markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'watch-credits-seamless-button' }] },
    { media: { currentTime: 1378.496948, duration: 1536.159625, ended: false, paused: false, readyState: 4 }, rootCount: 2, markers: [{ uia: 'watch-credits-seamless-button', root: 0 }, { uia: 'next-episode-seamless-button', root: 1 }] }
  ];
  for (const fixture of fixtures) {
    const harness = createHarness(fixture);
    harness.roots[0].dataset.uia = 'player';
    start(Adapter, harness);
    harness.video.dispatch('timeupdate');
    harness.scheduler.flush();
    assert.deepEqual(harness.observations, []);
  }
});

test('Given markers hidden by the DOM, opacity, collapsed visibility, or no rendered box When checked Then no observation is emitted', async () => {
  const Adapter = await loadAdapter();
  const markers = [
    { uia: 'watch-credits-seamless-button', hidden: true },
    { uia: 'watch-credits-seamless-button', style: { opacity: '0' } },
    { uia: 'watch-credits-seamless-button', style: { visibility: 'collapse' } },
    { uia: 'watch-credits-seamless-button', rendered: false }
  ];
  for (const marker of markers) {
    const harness = createHarness({ media: { currentTime: 1378.496948, duration: 1536.159625, ended: false, paused: false, readyState: 4 }, markers: [marker] });
    harness.roots[0].dataset.uia = 'player';
    start(Adapter, harness);
    harness.video.dispatch('play');
    harness.scheduler.flush();
    assert.deepEqual(harness.observations, []);
  }
});

test('Given live type-a-next-episode controls only meet at a direct shared parent without data-uia="player" When checked Then they are not correlated into a candidate', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ media: { currentTime: 987.5, duration: 1975.25, ended: false, paused: false, readyState: 4 }, markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'next-episode-seamless-button' }] });
  const mediaBranch = harness.roots[0].append(new FakeNode());
  const controlsBranch = harness.roots[0].append(new FakeNode());
  harness.roots[0].children = harness.roots[0].children.filter((node) => node !== harness.video && node !== harness.markerNodes[0] && node !== harness.markerNodes[1]);
  mediaBranch.append(harness.video);
  controlsBranch.append(harness.markerNodes[0]);
  controlsBranch.append(harness.markerNodes[1]);
  start(Adapter, harness);

  harness.video.dispatch('play');
  harness.scheduler.flush();

  assert.deepEqual(harness.observations, []);
});

test('Given terminal media under video-canvas and its CTA under seamless controls within the live observed player When checked Then it is rejected', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'next-episode-seamless-button' }] });
  const player = harness.roots[0];
  player.dataset.uia = 'player';
  const videoCanvas = player.append(new FakeNode());
  const seamlessControls = player.append(new FakeNode());
  player.children = player.children.filter((node) => node !== harness.video && node !== harness.markerNodes[0]);
  videoCanvas.append(harness.video);
  seamlessControls.append(harness.markerNodes[0]);
  start(Adapter, harness);

  harness.video.dispatch('ended');
  harness.scheduler.flush();

  assert.deepEqual(harness.observations, []);
});

test('Given paused media within one millisecond of a finite duration and a next-episode CTA When pause fires Then it is rejected', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 1799.9995, duration: 1800, ended: false, paused: true },
    markers: [{ uia: 'next-episode-seamless-button' }]
  });
  start(Adapter, harness);

  harness.video.dispatch('pause');
  harness.scheduler.flush();

  assert.deepEqual(harness.observations, []);
});

test('Given paused media materially beyond its finite duration and a next-episode CTA When pause fires Then no terminal observation is emitted', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 1800.01, duration: 1800, ended: false, paused: true },
    markers: [{ uia: 'next-episode-seamless-button' }]
  });
  start(Adapter, harness);

  harness.video.dispatch('pause');
  harness.scheduler.flush();

  assert.deepEqual(harness.observations, []);
});

test('Given an untrusted context or a node made hidden before the scheduled check When events coalesce Then no stale observation is emitted', async () => {
  const Adapter = await loadAdapter();
  const untrusted = createHarness({ context: createContext({ state: 'transitioning' }), media: { currentTime: 1378.496948, duration: 1536.159625, ended: false, paused: false, readyState: 4 }, markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'next-episode-seamless-button' }] });
  start(Adapter, untrusted);
  untrusted.video.dispatch('play');
  untrusted.scheduler.flush();
  assert.deepEqual(untrusted.observations, []);

  const stale = createHarness({ media: { currentTime: 1378.496948, duration: 1536.159625, ended: false, paused: false, readyState: 4 }, markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'next-episode-seamless-button' }] });
  start(Adapter, stale);
  stale.video.dispatch('play');
  stale.markerNodes[0].visible = false;
  stale.scheduler.flush();
  assert.deepEqual(stale.observations, []);
});

test('Given a verified next-episode root When its CTA is clicked Then it is rejected and does not dismiss the context', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ markers: [{ uia: 'next-episode-seamless-button' }] });
  start(Adapter, harness);
  let prevented = false;

  harness.document.dispatch('click', { target: harness.markerNodes[0], preventDefault: () => { prevented = true; } });

  assert.deepEqual(harness.dismissals, []);
  assert.equal(prevented, false);
});

test('Given a verified next-episode root When an unrelated root descendant is clicked Then it does not dismiss the context', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ markers: [{ uia: 'next-episode-seamless-button' }] });
  const unrelated = harness.roots[0].append(new FakeNode());
  start(Adapter, harness);

  harness.document.dispatch('click', { target: unrelated });

  assert.deepEqual(harness.dismissals, []);
});

test('Given a started adapter When it is stopped Then every observer, media listener, document listener, and scheduled callback is cleaned up', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'next-episode-seamless-button' }] });
  const adapter = start(Adapter, harness);
  harness.video.dispatch('ended');

  adapter.stop();
  harness.scheduler.flush();
  harness.video.dispatch('ended');
  harness.document.dispatch('click', { target: harness.markerNodes[0] });

  assert.equal(FakeObserver.instances[0].disconnected, true);
  assert.equal(harness.video.listeners.get('ended').length, 0);
  assert.equal(harness.document.listeners.get('click').length, 0);
  assert.deepEqual(harness.observations, []);
  assert.deepEqual(harness.dismissals, []);
});

test('Given a watched media node is removed with its root When mutation processing runs Then its listener is released and no observation is emitted', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({ markers: [{ uia: 'watch-credits-seamless-button' }, { uia: 'next-episode-seamless-button' }] });
  start(Adapter, harness);

  harness.roots[0].children.splice(0, harness.roots[0].children.length);
  FakeObserver.instances[0].trigger();
  harness.scheduler.flush();
  harness.video.dispatch('ended');

  assert.equal(harness.video.listeners.get('ended').length, 0);
  assert.deepEqual(harness.observations, []);
});
