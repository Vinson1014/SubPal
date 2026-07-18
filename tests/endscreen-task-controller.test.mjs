import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createContext,
  createController,
  loadController,
  typeBObservation,
  typeANextEpisodeObservation,
  unsupportedTerminalNextEpisodeObservation
} from './endscreen-task-controller-fixtures.mjs';

const EndscreenTaskController = await loadController();

test('Given an unsupported terminal next-episode observation in a trusted ready context When it is confirmed after debounce Then it is rejected', async () => {
  const { controller, scheduler, sentMessages, taskBatches } = createController(EndscreenTaskController);

  controller.observe(unsupportedTerminalNextEpisodeObservation());
  scheduler.advance(499);
  assert.equal(sentMessages.length, 0);

  controller.observe(unsupportedTerminalNextEpisodeObservation());
  scheduler.advance(1);
  await Promise.resolve();

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(taskBatches, []);
});

test('Given a trusted ready type-a-next-episode observation with playing media and both live controls at alternate finite media values When it is confirmed twice Then it requests tasks once after debounce and remains once per context', async () => {
  const { controller, scheduler, sentMessages, taskBatches } = createController(EndscreenTaskController);

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(499);
  assert.equal(sentMessages.length, 0);

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(1);
  await Promise.resolve();

  assert.deepEqual(sentMessages, [{ type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 }]);
  assert.deepEqual(taskBatches, [{ tasks: [{ taskID: 'task-1' }], context: createContext() }]);

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
});

test('Given malformed, untrusted, missing-variant, or incomplete-evidence observations When they are observed Then no task request is sent', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  controller.observe(unsupportedTerminalNextEpisodeObservation(createContext({ state: 'transitioning' })));
  controller.observe(unsupportedTerminalNextEpisodeObservation(createContext(), { snapshot: { currentTime: Infinity, duration: 1800, state: 'ended' } }));
  controller.observe(unsupportedTerminalNextEpisodeObservation(createContext(), { variant: undefined }));
  controller.observe(unsupportedTerminalNextEpisodeObservation(createContext(), { evidence: {} }));
  scheduler.advance(1000);

  assert.equal(sentMessages.length, 0);
});

test('Given normal play or pause snapshots When terminal endscreen evidence is present Then they never request tasks', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  controller.observe(unsupportedTerminalNextEpisodeObservation(createContext(), { snapshot: { currentTime: 1740, duration: 1800, state: 'play' } }));
  controller.observe(unsupportedTerminalNextEpisodeObservation(createContext(), { snapshot: { currentTime: 1740, duration: 1800, state: 'pause' } }));
  scheduler.advance(1000);

  assert.equal(sentMessages.length, 0);
});

test('Given early paused playback with next-episode CTA evidence When it is confirmed twice Then it does not request tasks', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);
  const earlyPaused = unsupportedTerminalNextEpisodeObservation(createContext(), {
    snapshot: { currentTime: 1740, duration: 1800, state: 'paused' }
  });

  controller.observe(earlyPaused);
  controller.observe(earlyPaused);
  scheduler.advance(500);

  assert.equal(sentMessages.length, 0);
});

test('Given one eligible observation When its debounce expires without a second confirmation Then it does not request tasks', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  controller.observe(unsupportedTerminalNextEpisodeObservation());
  scheduler.advance(500);
  await Promise.resolve();

  assert.equal(sentMessages.length, 0);
});

test('Given an eligible endscreen was already fetched for a context When it is observed again Then the request remains once per video session epoch', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
});

test('Given an eligible context is dismissed When it is later observed as eligible Then it remains suppressed for that context', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  controller.dismiss(createContext());
  controller.observe(unsupportedTerminalNextEpisodeObservation());
  controller.observe(unsupportedTerminalNextEpisodeObservation());
  scheduler.advance(500);

  assert.equal(sentMessages.length, 0);
});

test('Given a previous endscreen context was completed When VIDEO_ID_CHANGED arrives Then the next ready context can request tasks', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();
  controller.handleInternalEvent({ type: 'VIDEO_ID_CHANGED', newVideoId: 'netflix-87654321' });
  const nextContext = createContext({ videoId: 'netflix-87654321', sessionId: 'watch-session-2', epoch: 4 });
  controller.observe(typeANextEpisodeObservation(nextContext, { snapshot: { currentTime: 987.5, duration: 1975.25, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(nextContext, { snapshot: { currentTime: 987.5, duration: 1975.25, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[1].videoID, 'netflix-87654321');
});

test('Given a task request is pending When VIDEO_ID_CHANGED makes its context stale Then its late result is not published', async () => {
  let resolveRequest;
  const pendingRequest = new Promise((resolve) => { resolveRequest = resolve; });
  const { controller, scheduler, taskBatches } = createController(EndscreenTaskController, {
    sendMessage: async () => await pendingRequest
  });

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  controller.handleInternalEvent({ type: 'VIDEO_ID_CHANGED', newVideoId: 'netflix-87654321' });
  resolveRequest({ tasks: [{ taskID: 'stale-task' }] });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(taskBatches, []);
});

test('Given a task request is pending When the endscreen becomes inactive Then its late result is not published and the context remains once-finished', async () => {
  let resolveRequest;
  let requestCount = 0;
  const pendingRequest = new Promise((resolve) => { resolveRequest = resolve; });
  const { controller, scheduler, taskBatches } = createController(EndscreenTaskController, {
    sendMessage: async () => {
      requestCount += 1;
      return await pendingRequest;
    }
  });

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  controller.handleInternalEvent({ type: 'ENDSCREEN_INACTIVE' });
  resolveRequest({ tasks: [{ taskID: 'stale-after-resume' }] });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(taskBatches, []);
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();

  assert.equal(requestCount, 1, 'inactive signal 不應清除 once-per-context 完成狀態');
});

test('Given type-b state-b-recommendation-trailer evidence When it is temporarily disabled and confirmed twice Then it sends no requests or task batches', async () => {
  const { controller, scheduler, sentMessages, taskBatches } = createController(EndscreenTaskController);

  controller.observe(typeBObservation());
  controller.observe(typeBObservation());
  scheduler.advance(500);
  await Promise.resolve();

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(taskBatches, []);
});

test('Given type-b state-a-recommendation-countdown evidence When it is temporarily disabled and confirmed twice Then it sends no requests or task batches', async () => {
  const { controller, scheduler, sentMessages, taskBatches } = createController(EndscreenTaskController);
  const countdownTypeBObservation = typeBObservation(createContext(), {
    snapshot: { currentTime: 15, duration: 63, state: 'paused' }
  });

  controller.observe(countdownTypeBObservation);
  controller.observe(countdownTypeBObservation);
  scheduler.advance(500);
  await Promise.resolve();

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(taskBatches, []);
});

test('Given stale type-b markers at terminal media When they are observed Then they never request tasks', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  const staleTypeBObservation = typeBObservation(createContext(), {
    snapshot: { currentTime: 1800, duration: 1800, state: 'ended' }
  });
  controller.observe(staleTypeBObservation);
  controller.observe(staleTypeBObservation);
  scheduler.advance(500);

  assert.equal(sentMessages.length, 0);
});

test('Given a rejected task request When its promise settles Then it does not publish tasks or leak an unhandled rejection', async () => {
  let requestCount = 0;
  const { controller, scheduler, taskBatches } = createController(EndscreenTaskController, {
    sendMessage: async () => {
      requestCount += 1;
      throw new Error('connection lost');
    }
  });

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(requestCount, 1);
  assert.deepEqual(taskBatches, []);
});

test('Given a rejected request in an unchanged trusted context When later eligible observations repeat Then it stays once per context and publishes no tasks', async () => {
  let requestCount = 0;
  const { controller, scheduler, taskBatches } = createController(EndscreenTaskController, {
    sendMessage: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new Error('connection lost');
      return { tasks: [{ taskID: 'retry-task' }] };
    }
  });

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();
  await Promise.resolve();
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  await Promise.resolve();

  assert.equal(requestCount, 1);
  assert.deepEqual(taskBatches, []);
});

test('Given repeated observations of the unchanged trusted context When it is pending Then it confirms without resetting its debounce', async () => {
  const { controller, scheduler, sentMessages } = createController(EndscreenTaskController);

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(400);
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(100);
  await Promise.resolve();

  assert.equal(sentMessages.length, 1);
});

test('Given changed trusted context while work is pending When the old request resolves Then stale work is invalidated', async () => {
  let resolveRequest;
  let requestCount = 0;
  const pendingRequest = new Promise((resolve) => { resolveRequest = resolve; });
  const { controller, scheduler, taskBatches } = createController(EndscreenTaskController, {
    sendMessage: async () => {
      requestCount += 1;
      return await pendingRequest;
    }
  });
  const nextContext = createContext({ videoId: 'netflix-87654321', sessionId: 'watch-session-2', epoch: 4 });

  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  controller.observe(typeANextEpisodeObservation(createContext(), { snapshot: { currentTime: 1111.25, duration: 2222.5, state: 'playing' } }));
  scheduler.advance(500);
  controller.observe({ context: nextContext });
  resolveRequest({ tasks: [{ taskID: 'stale-task' }] });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(requestCount, 1);
  assert.deepEqual(taskBatches, []);
});
