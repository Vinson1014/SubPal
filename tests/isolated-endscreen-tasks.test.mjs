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

function harness(pathname = '/watch/82147770', {
  endscreenTasksEnabled = true,
  persistence = 'resolve',
  initialize = 'resolve'
} = {}) {
  const requests = [];
  const shown = [];
  const hidden = [];
  const routeTarget = createRouteTarget();
  const configWrites = [];
  const events = [];
  const configListeners = new Set();
  const debugListeners = new Set();
  const initializeResolvers = [];
  let preference = endscreenTasksEnabled;
  let debugMode = false;
  let beforePreferenceRead = null;
  let pendingPersistence = null;
  let resolveRequest;
  let adapterStarts = 0;
  let adapterStops = 0;
  let panelInitializes = 0;
  let panelCleanups = 0;
  let optOutCallback = null;
  let activePanel = null;
  let unsubscribeCalls = 0;
  const panelConfigSources = [];
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const configManager = {
    get(key) {
      if (key === 'crowdsourcing.endscreenTasksEnabled' && beforePreferenceRead) {
        const callback = beforePreferenceRead;
        beforePreferenceRead = null;
        callback();
      }
      if (key === 'crowdsourcing.endscreenTasksEnabled') return preference;
      if (key === 'debugMode') return debugMode;
      return 'zh-Hant';
    },
    set(key, value) {
      configWrites.push({ key, value });
      events.push('persist:start');
      const complete = () => {
        preference = value;
        events.push('persist:stored');
        for (const listener of configListeners) {
          listener(key, value, true);
        }
        events.push('persist:resolved');
      };
      if (persistence === 'reject') return Promise.reject(new Error('persist failed'));
      if (persistence === 'defer') {
        return new Promise((resolve, reject) => {
          pendingPersistence = { complete, resolve, reject };
        });
      }
      return Promise.resolve().then(() => {
        complete();
      });
    },
    subscribe(key, callback) {
      const listeners = key === 'debugMode' ? debugListeners : configListeners;
      listeners.add(callback);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribeCalls += 1;
        listeners.delete(callback);
      };
    }
  };
  const taskSystem = new IsolatedEndscreenTasks({
    document: {}, Observer: class {}, location: { pathname },
    configManager,
    schedule: () => 0, cancel: () => {}, clock: () => 0,
    sendMessage(message) { requests.push(message); return request; },
    routeTarget,
    Adapter: class {
      constructor(options) { this.options = options; }
      start() { adapterStarts += 1; events.push('adapter:start'); }
      stop() { adapterStops += 1; events.push('adapter:stop'); }
    },
    Controller: class { constructor(options) { this.options = options; } handleInternalEvent() {} },
    Panel: class {
      constructor(options) {
        this.visible = false;
        this.actionState = 'idle';
        this.confirmationVisible = false;
        this.tasks = null;
        this.currentTaskIndex = 0;
        this.showCalls = 0;
        this.configSource = options.configSource;
        this.configSubscriptionDisposer = null;
        panelConfigSources.push(this.configSource);
        activePanel = this;
      }
      async initialize() {
        panelInitializes += 1;
        this.debug = this.configSource?.get('debugMode') === true;
        this.configSubscriptionDisposer = this.configSource?.subscribe('debugMode', (_key, value) => {
          this.debug = value === true;
        }) ?? null;
        if (initialize === 'defer') await new Promise((resolve) => { initializeResolvers.push(resolve); });
      }
      show(tasks, context) {
        shown.push({ tasks, context });
        this.tasks = tasks;
        this.currentTaskIndex = 0;
        this.showCalls += 1;
        this.visible = true;
        events.push('panel:show');
      }
      hide() {
        hidden.push(true);
        this.visible = false;
        events.push('panel:hide');
      }
      onOptOut(callback) { optOutCallback = callback; }
      setActionState(state) {
        this.actionState = state;
        events.push(`panel:state:${state}`);
      }
      handleOptOutRequest() {
        this.confirmationVisible = true;
        events.push('panel:confirmation');
      }
      cleanup() {
        panelCleanups += 1;
        this.configSubscriptionDisposer?.();
        this.configSubscriptionDisposer = null;
        this.visible = false;
        events.push('panel:cleanup');
      }
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
    get hasOptOutCallback() { return typeof optOutCallback === 'function'; },
    get activePanel() { return activePanel; },
    get events() { return events; },
    get unsubscribeCalls() { return unsubscribeCalls; },
    get subscriptionCount() { return configListeners.size; },
    get debugSubscriptionCount() { return debugListeners.size; },
    panelConfigSources,
    configManager,
    configWrites,
    requestOptOut(payload = { task: { taskID: 'opt-out' }, context: { videoId: '82147770' } }) {
      activePanel.confirmationVisible = true;
      return optOutCallback?.({
        ...payload,
        setPending: () => { activePanel.actionState = 'loading'; },
        setFailure: () => { activePanel.actionState = 'error'; }
      });
    },
    emitPreference(value) {
      preference = value;
      for (const listener of configListeners) {
        listener('crowdsourcing.endscreenTasksEnabled', value, !value);
      }
    },
    setPreference(value) { preference = value; },
    beforeNextPreferenceRead(callback) { beforePreferenceRead = callback; },
    emitDebug(value) {
      debugMode = value;
      for (const listener of debugListeners) listener('debugMode', value, !value);
    },
    resolvePersistence() {
      pendingPersistence?.complete();
      pendingPersistence?.resolve();
      pendingPersistence = null;
    },
    rejectPersistence(error = new Error('persist failed')) {
      pendingPersistence?.reject(error);
      pendingPersistence = null;
    },
    resolveInitialize() {
      while (initializeResolvers.length > 0) initializeResolvers.shift()();
    },
    resolveRequest
  };
}

test('Given an initialized ConfigManager When the isolated owner creates panels Then each panel receives it as configSource and debug subscriptions stay singular across restarts', async () => {
  const h = harness();
  await h.taskSystem.start();

  assert.equal(h.panelConfigSources[0], h.configManager);
  assert.equal(h.debugSubscriptionCount, 1);
  h.emitDebug(true);
  assert.equal(h.activePanel.debug, true);

  h.taskSystem.cleanup();
  await h.taskSystem.start();
  assert.equal(h.panelConfigSources[1], h.configManager);
  assert.equal(h.debugSubscriptionCount, 1);
  h.taskSystem.cleanup();
});

test('Given a stale pending start When false then true arrive before it settles Then the latest true intent queues one guarded restart', async () => {
  const h = harness('/watch/82147770', { initialize: 'defer' });
  const initialStart = h.taskSystem.start();

  h.emitPreference(false);
  h.emitPreference(true);
  h.resolveInitialize();
  await initialStart;
  h.resolveInitialize();
  await h.taskSystem.start();

  assert.equal(h.taskSystem.pendingReenable, null);
  assert.equal(h.panelInitializes, 2);
  assert.equal(h.adapterStarts, 1);
  assert.equal(h.routeTarget.listenerCount('popstate'), 1);
  assert.equal(h.routeTarget.listenerCount('hashchange'), 1);
  assert.equal(h.requests.length, 0);
  h.taskSystem.cleanup();
});

test('Given a pending controller callback When the latest preference flips false immediately before dispatch Then no task request is sent', async () => {
  const h = harness();
  await h.taskSystem.start();
  const oldController = h.taskSystem.controller;

  h.beforeNextPreferenceRead(() => h.emitPreference(false));
  const pendingRequest = oldController.options.sendMessage({});
  h.resolveRequest({ tasks: [] });
  await pendingRequest;

  assert.deepEqual(h.requests, [], '停用競態下不應呼叫 sendMessage');
});

test('Given a current controller callback When preference is malformed or not exactly true Then dispatch is fail-closed, while true still dispatches', async (t) => {
  for (const value of [false, undefined, null, 'true', 1, {}]) {
    await t.test(String(value), async () => {
      const h = harness();
      await h.taskSystem.start();
      h.setPreference(value);
      const pendingRequest = h.taskSystem.controller.options.sendMessage({});
      h.resolveRequest({ tasks: [] });
      await pendingRequest;
      assert.deepEqual(h.requests, []);
    });
  }

  const enabled = harness();
  await enabled.taskSystem.start();
  const pendingRequest = enabled.taskSystem.controller.options.sendMessage({});
  enabled.resolveRequest({ tasks: [] });
  await pendingRequest;
  assert.equal(enabled.requests.length, 1, 'exactly true 時應維持既有 dispatch');
});

test('Given a queued re-enable When false arrives later Then no stale restart occurs', async () => {
  const h = harness('/watch/82147770', { initialize: 'defer' });
  const initialStart = h.taskSystem.start();

  h.emitPreference(true);
  h.emitPreference(false);
  h.resolveInitialize();
  await initialStart;

  assert.equal(h.adapterStarts, 0);
  assert.equal(h.routeTarget.listenerCount('popstate'), 0);
});

test('Given a queued re-enable When the owner is disposed Then no restart or duplicate resource is created', async () => {
  const h = harness('/watch/82147770', { initialize: 'defer' });
  const initialStart = h.taskSystem.start();

  h.emitPreference(true);
  h.taskSystem.dispose();
  h.resolveInitialize();
  await initialStart;

  assert.equal(h.adapterStarts, 0);
  assert.equal(h.panelInitializes, 1);
  assert.equal(h.subscriptionCount, 0);
  assert.equal(h.routeTarget.listenerCount('popstate'), 0);
});

test('Given the panel opt-out callback seam When confirmation is emitted Then false is persisted and the isolated owner is cleaned up', async () => {
  const h = harness();
  await h.taskSystem.start();

  assert.equal(h.hasOptOutCallback, true, 'isolated owner 應接上 panel opt-out callback');
  const optOut = h.requestOptOut();
  await optOut;

  assert.deepEqual(h.configWrites, [{ key: 'crowdsourcing.endscreenTasksEnabled', value: false }]);
  assert.deepEqual(
    h.events.filter(event => event.startsWith('persist') || event === 'adapter:stop'),
    ['persist:start', 'persist:stored', 'persist:resolved', 'adapter:stop']
  );
  assert.equal(h.taskSystem.started, false, '確認後應停止 isolated task owner');
  assert.equal(h.taskSystem.panel, null, '確認後應清理 task panel');
  assert.equal(h.taskSystem.adapter, null, '確認後應停止 endscreen adapter');
  assert.equal(h.adapterStops, 1, '確認後 adapter 應只停止一次');
  assert.equal(h.panelCleanups, 1, '確認後 panel 應只清理一次');
  assert.equal(h.routeTarget.listenerCount('popstate'), 0, '確認後應移除 route listener');
});

test('Given opt-out persistence fails When confirmation resolves Then the owner stays usable and the confirmation reopens with an error state', async () => {
  const h = harness('/watch/82147770', { persistence: 'reject' });
  await h.taskSystem.start();
  h.activePanel.show([{ taskID: 'opt-out' }], { videoId: '82147770' });

  await assert.rejects(h.requestOptOut(), /persist failed/);

  assert.equal(h.taskSystem.started, true, '保存失敗不應停用 isolated owner');
  assert.equal(h.adapterStops, 0, '保存失敗不應停止 adapter');
  assert.equal(h.panelCleanups, 0, '保存失敗不應清理 panel');
  assert.equal(h.activePanel.visible, true, '保存失敗後 panel 應重新可見');
  assert.equal(h.activePanel.confirmationVisible, true, '保存失敗後確認區塊應重新開啟');
  assert.equal(h.activePanel.actionState, 'error', '保存失敗後 panel 應保留 error state');
  assert.deepEqual(h.configWrites, [{ key: 'crowdsourcing.endscreenTasksEnabled', value: false }]);

  h.taskSystem.cleanup();
});

test('Given a multi-task panel When opt-out persistence fails Then the existing task sequence and index remain unchanged while only error state changes', async () => {
  const h = harness('/watch/82147770', { persistence: 'reject' });
  await h.taskSystem.start();
  const tasks = [{ taskID: 'first' }, { taskID: 'second' }];
  const context = { videoId: '82147770' };
  h.activePanel.show(tasks, context);
  h.activePanel.currentTaskIndex = 1;
  const showCallsBeforeFailure = h.activePanel.showCalls;

  await assert.rejects(h.requestOptOut({ task: tasks[1], context }), /persist failed/);

  assert.equal(h.activePanel.tasks, tasks, '失敗後應保留原任務陣列');
  assert.equal(h.activePanel.currentTaskIndex, 1, '失敗後應保留目前任務索引');
  assert.equal(h.activePanel.showCalls, showCallsBeforeFailure, '失敗後不應重新 show 面板');
  assert.equal(h.activePanel.actionState, 'error', '失敗後只應切換 confirmation error state');

  h.taskSystem.cleanup();
});

test('Given deferred opt-out persistence When cleanup is observed before persistence resolves Then cleanup waits for successful persistence', async () => {
  const h = harness('/watch/82147770', { persistence: 'defer' });
  await h.taskSystem.start();

  const optOut = h.requestOptOut();
  await Promise.resolve();
  const adapterStopsBeforePersistence = h.adapterStops;
  const panelCleanupsBeforePersistence = h.panelCleanups;

  h.resolvePersistence();
  await optOut;
  assert.equal(adapterStopsBeforePersistence, 0, '保存尚未完成前不應停止 adapter');
  assert.equal(panelCleanupsBeforePersistence, 0, '保存尚未完成前不應清理 panel');
  assert.equal(h.adapterStops, 1, '保存成功後應停止 adapter');
  assert.equal(h.panelCleanups, 1, '保存成功後應清理 panel');
});

test('Given an active owner When Options changes the preference to false Then it stops before a later request and repeated notifications remain idempotent', async () => {
  const h = harness();
  await h.taskSystem.start();
  const oldController = h.taskSystem.controller;

  h.emitPreference(false);
  h.emitPreference(false);
  const requestAfterDisable = oldController.options.sendMessage({});
  h.resolveRequest({ tasks: [] });
  await requestAfterDisable;

  assert.equal(h.adapterStops, 1);
  assert.equal(h.panelCleanups, 1);
  assert.equal(h.routeTarget.listenerCount('popstate'), 0);
  assert.deepEqual(h.requests, [], '停用後不應再送出任務請求');
});

test('Given a disabled owner When Options re-enables the preference Then it starts once and repeated notifications do not duplicate resources', async () => {
  const h = harness('/watch/82147770', { endscreenTasksEnabled: false });
  await h.taskSystem.start();
  assert.equal(h.subscriptionCount, 1);

  h.emitPreference(true);
  h.emitPreference(true);
  await h.taskSystem.start();
  await h.taskSystem.start();

  assert.equal(h.panelInitializes, 1);
  assert.equal(h.adapterStarts, 1);
  assert.equal(h.routeTarget.listenerCount('popstate'), 1);
  assert.equal(h.routeTarget.listenerCount('hashchange'), 1);
  assert.equal(h.requests.length, 0);

  h.taskSystem.cleanup();
  h.taskSystem.cleanup();
  assert.equal(h.adapterStops, 1);
  assert.equal(h.panelCleanups, 1);
});

test('Given an isolated owner When disposal repeats Then its config subscription is removed once and stale notifications cannot restart it', async () => {
  const h = harness('/watch/82147770', { endscreenTasksEnabled: false });
  await h.taskSystem.start();

  h.taskSystem.dispose();
  h.taskSystem.dispose();
  h.emitPreference(true);

  assert.equal(h.unsubscribeCalls, 1);
  assert.equal(h.subscriptionCount, 0);
  assert.equal(h.adapterStarts, 0);
  assert.equal(h.panelInitializes, 0);
});

test('Given a pending startup When a stale false/true notification races it Then obsolete startup cannot create duplicate adapters or listeners', async () => {
  const h = harness('/watch/82147770', { initialize: 'defer' });
  const initialStart = h.taskSystem.start();

  h.emitPreference(false);
  h.emitPreference(true);
  h.resolveInitialize();
  await initialStart;
  h.resolveInitialize();
  await h.taskSystem.start();

  assert.equal(h.adapterStarts, 1);
  assert.equal(h.panelInitializes, 2);
  assert.equal(h.routeTarget.listenerCount('popstate'), 1);
  assert.equal(h.routeTarget.listenerCount('hashchange'), 1);

  h.taskSystem.cleanup();
});

test('Given the panel opt-out seam When no confirmation callback is emitted Then the preference is not written', async () => {
  const h = harness();
  await h.taskSystem.start();

  assert.deepEqual(h.configWrites, [], '尚未確認時不應寫入 opt-out 設定');
  assert.equal(h.taskSystem.started, true, '取消或未確認不應停止 task owner');

  h.taskSystem.cleanup();
});

test('Given a disabled or malformed endscreen preference When isolated startup repeats Then disabled is the only opt-out value and malformed values remain enabled', async (t) => {
  const cases = [
    { name: 'explicit false', value: false, disabled: true },
    { name: 'missing', value: undefined, disabled: false },
    { name: 'string false', value: 'false', disabled: false },
    { name: 'null', value: null, disabled: false }
  ];

  for (const { name, value, disabled } of cases) {
    await t.test(name, async () => {
      const h = harness('/watch/82147770', { endscreenTasksEnabled: value });
      await Promise.all([h.taskSystem.start(), h.taskSystem.start()]);
      h.taskSystem.cleanup();
      h.taskSystem.cleanup();
      await h.taskSystem.start();

      assert.equal(h.panelInitializes, disabled ? 0 : 2);
      assert.equal(h.adapterStarts, disabled ? 0 : 2);
      assert.equal(h.requests.length, 0, 'startup 不應自行發出任務請求');
      assert.equal(h.panelCleanups, disabled ? 0 : 1, '未初始化 panel 不應被清理');
    });
  }
});

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
