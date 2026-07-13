import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedEndscreenTasks } from '../content/system/isolated-endscreen-tasks.js';

function createRouteTarget() {
  const listeners = new Map();
  const removed = [];
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
      removed.push(type);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    removed
  };
}

function harness(pathname = '/watch/82147770') {
  const requests = [];
  const shown = [];
  const hidden = [];
  const routeTarget = createRouteTarget();
  let resolveRequest;
  let adapterStarts = 0;
  let adapterStops = 0;
  let panelInitializes = 0;
  let panelCleanups = 0;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const taskSystem = new IsolatedEndscreenTasks({
    document: {}, Observer: class {}, location: { pathname }, configManager: { get: () => 'zh-Hant' },
    schedule: () => 0, cancel: () => {}, clock: () => 0,
    sendMessage(message) { requests.push(message); return request; },
    routeTarget,
    Adapter: class {
      constructor(options) { this.options = options; }
      start() { adapterStarts += 1; }
      stop() { adapterStops += 1; }
    },
    Controller: class { constructor(options) { this.options = options; } handleInternalEvent() {} },
    Panel: class {
      async initialize() { panelInitializes += 1; }
      show(tasks, context) { shown.push({ tasks, context }); }
      hide() { hidden.push(true); }
      cleanup() { panelCleanups += 1; }
    }
  });
  return {
    taskSystem,
    requests,
    shown,
    hidden,
    routeTarget,
    get adapterStarts() { return adapterStarts; },
    get adapterStops() { return adapterStops; },
    get panelInitializes() { return panelInitializes; },
    get panelCleanups() { return panelCleanups; },
    resolveRequest
  };
}

test('Given isolated ownership When started Then request inputs come only from route/config with fixed limit five', async () => {
  const h = harness();
  await h.taskSystem.start();
  const context = h.taskSystem.getContext();
  const pending = h.taskSystem.controller.options.sendMessage({ type: 'ignored', videoID: 'forged', languageCode: 'xx', limit: 99 });
  h.resolveRequest({ tasks: [] });
  await pending;
  assert.deepEqual(h.requests, [{ type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 5 }]);
  assert.equal(context.videoId, '82147770');
});

test('Given a pending response When route changes Then stale tasks are ignored and panel is hidden', async () => {
  const h = harness();
  await h.taskSystem.start();
  const pending = h.taskSystem.controller.options.sendMessage({});
  h.taskSystem.location.pathname = '/watch/87654321';
  h.taskSystem.refreshRoute();
  h.resolveRequest({ tasks: [{ taskID: 'stale' }] });
  await pending;
  assert.deepEqual(h.shown, []);
  assert.equal(h.hidden.length >= 1, true);
});

test('Given an endscreen panel was shown When the adapter reports a non-eligible state Then the isolated panel is hidden', async () => {
  const h = harness();
  await h.taskSystem.start();
  const hiddenBefore = h.hidden.length;
  h.taskSystem.controller.options.onTasks([{ taskID: 'visible' }], h.taskSystem.getContext());
  assert.equal(h.shown.length, 1, '面板應先收到任務');

  h.taskSystem.adapter.options.onInactive();

  assert.equal(h.hidden.length, hiddenBefore + 1, 'endscreen signal 不再 eligible 時應隱藏面板');
});

test('Given an active isolated owner When cleanup is called repeatedly Then adapter, panel, and route listeners are disposed once', async () => {
  const h = harness();
  await h.taskSystem.start();

  assert.equal(h.routeTarget.listenerCount('popstate'), 1);
  assert.equal(h.routeTarget.listenerCount('hashchange'), 1);

  h.taskSystem.cleanup();
  h.taskSystem.cleanup();

  assert.equal(h.adapterStops, 1);
  assert.equal(h.panelCleanups, 1);
  assert.equal(h.routeTarget.listenerCount('popstate'), 0);
  assert.equal(h.routeTarget.listenerCount('hashchange'), 0);
  assert.deepEqual(h.routeTarget.removed.sort(), ['hashchange', 'popstate']);
});

test('Given a pending task response When cleanup occurs Then the response is invalid and cannot render', async () => {
  const h = harness();
  await h.taskSystem.start();
  const oldController = h.taskSystem.controller;
  const pending = oldController.options.sendMessage({});

  h.taskSystem.cleanup();
  h.resolveRequest({ tasks: [{ taskID: 'stale-after-cleanup' }] });

  assert.deepEqual(await pending, { tasks: [] });
  oldController.options.onTasks([{ taskID: 'stale-after-cleanup' }], { videoId: '82147770' });
  assert.deepEqual(h.shown, []);
});

test('Given a started owner When start is repeated and then restarted after cleanup Then resources are not duplicated', async () => {
  const h = harness();
  await Promise.all([h.taskSystem.start(), h.taskSystem.start()]);

  assert.equal(h.adapterStarts, 1);
  assert.equal(h.panelInitializes, 1);
  assert.equal(h.routeTarget.listenerCount('popstate'), 1);

  h.taskSystem.cleanup();
  await h.taskSystem.start();
  await h.taskSystem.start();

  assert.equal(h.adapterStarts, 2);
  assert.equal(h.panelInitializes, 2);
  assert.equal(h.routeTarget.listenerCount('popstate'), 1);
  assert.equal(h.routeTarget.listenerCount('hashchange'), 1);

  h.taskSystem.cleanup();
  assert.equal(h.adapterStops, 2);
  assert.equal(h.panelCleanups, 2);
});
