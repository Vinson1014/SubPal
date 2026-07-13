import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeObserver, createHarness, loadAdapter } from './endscreen-signal-adapter-fixtures.mjs';

test('Given an active endscreen panel When playback resumes and the candidate disappears Then the adapter emits an inactive signal without observing a task', async () => {
  const Adapter = await loadAdapter();
  const harness = createHarness({
    media: { currentTime: 20, duration: 1800, ended: false, paused: false },
    markers: [{ uia: 'background-video' }, { uia: 'promoted-video' }, { uia: 'postplay-background-play' }]
  });
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
  harness.video.paused = true;
  harness.video.dispatch('pause');
  harness.scheduler.flush();

  assert.equal(harness.observations.length, 1, '播放恢復前應保留已觀察的 eligible candidate');
  assert.deepEqual(inactiveSignals, [true], '候選消失時應發出一次 isolated inactive signal');
});
