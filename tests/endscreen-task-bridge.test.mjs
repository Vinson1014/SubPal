import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadBridge() {
  const source = await readFile(new URL('../content/core/endscreen-task-bridge.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console });
  const adapterModule = new vm.SourceTextModule('export class EndscreenSignalAdapter {}', { context });
  const controllerModule = new vm.SourceTextModule('export class EndscreenTaskController {}', { context });
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/core/endscreen-task-bridge.js' });

  await module.link((specifier) => {
    if (specifier === './endscreen-signal-adapter.js') return adapterModule;
    if (specifier === './endscreen-task-controller.js') return controllerModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.EndscreenTaskBridge;
}

function createContext(overrides = {}) {
  return {
    videoId: 'netflix-81234567',
    sessionId: 'watch-session-1',
    epoch: 3,
    state: 'ready',
    ...overrides
  };
}

function createHarness(Bridge, failures = {}) {
  const registrations = new Map();
  const disposerCalls = [];
  const lifecycle = [];
  const contexts = [createContext()];
  const adapters = [];
  const controllers = [];

  class Adapter {
    constructor(options) {
      this.options = options;
      adapters.push(this);
    }

    start() {
      lifecycle.push('adapter.start');
      if (failures.adapterStart) throw new Error('adapter start failed');
    }

    stop() {
      lifecycle.push('adapter.stop');
    }
  }

  class Controller {
    constructor(options) {
      this.options = options;
      this.events = [];
      controllers.push(this);
    }

    handleInternalEvent(event) {
      this.events.push(event);
    }
  }

  const bridge = new Bridge({
    document: {},
    Observer: class {},
    schedule: () => 1,
    cancel: () => {},
    clock: () => 0,
    debounceMs: 0,
    sendMessage: async () => ({ tasks: [{ taskID: 'task-1' }] }),
    languageCode: 'zh-TW',
    getContext: () => contexts.at(-1),
    registerInternalEventHandler(type, handler) {
      if (failures.registrationType === type) throw new Error(`registration failed: ${type}`);
      const handlers = registrations.get(type) ?? [];
      handlers.push(handler);
      registrations.set(type, handlers);
      return () => {
        lifecycle.push(`dispose:${type}`);
        disposerCalls.push(type);
        registrations.set(type, (registrations.get(type) ?? []).filter((item) => item !== handler));
      };
    },
    Adapter,
    Controller
  });

  return { bridge, registrations, disposerCalls, lifecycle, contexts, adapters, controllers };
}

test('Given an inert bridge When start is called repeatedly Then it creates one adapter/controller pair and registers each internal event once', async () => {
  const Bridge = await loadBridge();
  const harness = createHarness(Bridge);

  harness.bridge.start();
  harness.bridge.start();

  assert.equal(harness.adapters.length, 1);
  assert.equal(harness.controllers.length, 1);
  assert.equal(harness.registrations.get('VIDEO_ID_CHANGED').length, 1);
  assert.equal(harness.registrations.get('PLAYBACK_CONTEXT_CHANGED').length, 1);
  assert.deepEqual(harness.lifecycle, ['adapter.start']);
});

test('Given a bridge adapter When it obtains context Then it delegates only the current trusted PlaybackContextManager context', async () => {
  const Bridge = await loadBridge();
  const harness = createHarness(Bridge);
  const currentContext = createContext();
  harness.contexts.splice(0, harness.contexts.length, currentContext);

  harness.bridge.start();

  assert.strictEqual(harness.adapters[0].options.getContext(), currentContext);
  assert.strictEqual(harness.adapters[0].options.controller, harness.controllers[0]);
  assert.equal(harness.controllers[0].options.languageCode, 'zh-TW');
});

test('Given a started bridge When video or playback context changes Then it forwards invalidation to the controller and stale task results remain inert', async () => {
  const Bridge = await loadBridge();
  const harness = createHarness(Bridge);
  harness.bridge.start();
  const controller = harness.controllers[0];

  harness.registrations.get('VIDEO_ID_CHANGED')[0]({ type: 'VIDEO_ID_CHANGED', newVideoId: 'netflix-87654321' });
  harness.registrations.get('PLAYBACK_CONTEXT_CHANGED')[0]({ type: 'PLAYBACK_CONTEXT_CHANGED', context: createContext({ epoch: 4 }) });
  controller.options.onTasks([{ taskID: 'late-task' }], createContext());

  assert.deepEqual(JSON.parse(JSON.stringify(controller.events)), [
    { type: 'VIDEO_ID_CHANGED', newVideoId: 'netflix-87654321' },
    { type: 'VIDEO_ID_CHANGED', context: createContext({ epoch: 4 }) }
  ]);
  assert.equal(typeof controller.options.onTasks, 'function');
});

test('Given a started bridge When cleanup runs repeatedly Then it stops the adapter before disposing each handler and leaves no registrations', async () => {
  const Bridge = await loadBridge();
  const harness = createHarness(Bridge);
  harness.bridge.start();

  harness.bridge.cleanup();
  harness.bridge.cleanup();
  harness.bridge.start();

  assert.deepEqual(harness.lifecycle, [
    'adapter.start',
    'adapter.stop',
    'dispose:VIDEO_ID_CHANGED',
    'dispose:PLAYBACK_CONTEXT_CHANGED',
    'adapter.start'
  ]);
  assert.deepEqual(harness.disposerCalls, ['VIDEO_ID_CHANGED', 'PLAYBACK_CONTEXT_CHANGED']);
  assert.equal(harness.registrations.get('VIDEO_ID_CHANGED').length, 1);
  assert.equal(harness.registrations.get('PLAYBACK_CONTEXT_CHANGED').length, 1);
});

test('Given adapter startup fails after event registration When start throws Then every handler and adapter listener is rolled back and a retry creates one bridge', async () => {
  const Bridge = await loadBridge();
  const failures = { adapterStart: true };
  const harness = createHarness(Bridge, failures);

  assert.throws(() => harness.bridge.start(), /adapter start failed/);
  assert.deepEqual(harness.lifecycle, [
    'adapter.start',
    'adapter.stop',
    'dispose:VIDEO_ID_CHANGED',
    'dispose:PLAYBACK_CONTEXT_CHANGED'
  ]);
  assert.deepEqual(harness.registrations.get('VIDEO_ID_CHANGED'), []);
  assert.deepEqual(harness.registrations.get('PLAYBACK_CONTEXT_CHANGED'), []);

  failures.adapterStart = false;
  harness.bridge.start();

  assert.equal(harness.adapters.length, 2);
  assert.equal(harness.controllers.length, 2);
  assert.equal(harness.registrations.get('VIDEO_ID_CHANGED').length, 1);
  assert.equal(harness.registrations.get('PLAYBACK_CONTEXT_CHANGED').length, 1);
});

test('Given the second internal event registration fails When start throws Then the first handler is disposed and a retry does not duplicate it', async () => {
  const Bridge = await loadBridge();
  const failures = { registrationType: 'PLAYBACK_CONTEXT_CHANGED' };
  const harness = createHarness(Bridge, failures);

  assert.throws(() => harness.bridge.start(), /registration failed: PLAYBACK_CONTEXT_CHANGED/);
  assert.deepEqual(harness.lifecycle, ['dispose:VIDEO_ID_CHANGED']);
  assert.deepEqual(harness.registrations.get('VIDEO_ID_CHANGED'), []);
  assert.equal(harness.registrations.has('PLAYBACK_CONTEXT_CHANGED'), false);

  failures.registrationType = null;
  harness.bridge.start();

  assert.equal(harness.registrations.get('VIDEO_ID_CHANGED').length, 1);
  assert.equal(harness.registrations.get('PLAYBACK_CONTEXT_CHANGED').length, 1);
});
