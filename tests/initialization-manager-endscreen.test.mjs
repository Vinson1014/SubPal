import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { createHarness, loadAdapter } from './endscreen-signal-adapter-fixtures.mjs';

async function loadInitializationManager({ timerOwner, captureBridge = false } = {}) {
  const source = await readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8');
  const languageCodeSource = await readFile(new URL('../content/utils/language-code.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    console,
    Date,
    document: {},
    MutationObserver: class {},
    window: timerOwner,
    setTimeout: timerOwner?.setTimeout,
    clearTimeout: timerOwner?.clearTimeout
  });
  const messagingModule = new vm.SourceTextModule(`
    export const sendMessage = async () => ({});
    export const registerInternalEventHandler = () => () => {};
    export const requestPageScriptInjection = async () => {};
    export const waitForPageScript = async () => {};
    export const sendMessageToPageScript = async () => ({ success: true, available: true });
  `, { context });
  const videoInfoModule = new vm.SourceTextModule('export const getVideoId = () => "netflix-81234567";', { context });
  const languageCodeModule = new vm.SourceTextModule(languageCodeSource, { context });
  const bridgeModule = new vm.SourceTextModule(captureBridge
    ? 'export let lastOptions; export class EndscreenTaskBridge { constructor(options) { lastOptions = options; } start() {} }'
    : 'export class EndscreenTaskBridge { constructor() { throw new Error("bridge should not be created"); } }', { context });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/system/initialization-manager.js',
    importModuleDynamically: async () => messagingModule
  });

  await module.link((specifier) => {
    if (specifier === './messaging.js') return messagingModule;
    if (specifier === '../core/video-info.js') return videoInfoModule;
    if (specifier === '../core/endscreen-task-bridge.js') return bridgeModule;
    if (specifier === '../utils/language-code.js') return languageCodeModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return { InitializationManager: module.namespace.InitializationManager, bridge: bridgeModule.namespace };
}

test('Given absent or invalid primary-language configuration When Netflix API initialization reaches Phase 3 Then it succeeds without constructing an acquisition bridge', async () => {
  const { InitializationManager } = await loadInitializationManager();

  for (const languageCode of [undefined, '', 42]) {
    const manager = new InitializationManager();
    manager.configBridge = { get: () => languageCode };
    manager.state.configLoaded = true;
    manager.initializePlaybackContextManager = async () => {
      manager.components.playbackContextManager = { getCurrentContext: () => ({}) };
      manager.state.playbackContextReady = true;
    };

    assert.equal(await manager.checkNetflixAPI(), true);
    assert.equal(manager.state.netflixAPIAvailable, true);
    assert.equal(manager.components.endscreenTaskBridge, null);
  }
});

test('Given configured Chinese display languages When the endscreen bridge is initialized Then it receives their API language codes', async () => {
  for (const [primaryLanguage, apiLanguageCode] of [['zh-Hant', 'zh-TW'], ['zh-Hans', 'zh-CN']]) {
    const timerOwner = {
      setTimeout() {},
      clearTimeout() {}
    };
    const { InitializationManager, bridge } = await loadInitializationManager({ timerOwner, captureBridge: true });
    const manager = new InitializationManager();
    manager.configBridge = { get: () => primaryLanguage };
    manager.state.configLoaded = true;
    manager.state.playbackContextReady = true;
    manager.components.playbackContextManager = { getCurrentContext: () => ({}) };

    assert.equal(manager.initializeEndscreenTaskBridge(), true);
    assert.equal(bridge.lastOptions.languageCode, apiLanguageCode);
  }
});

test('Given receiver-sensitive window timers When initialization injects them into the real adapter Then raw calls throw Illegal invocation while injected schedule and cancel remain receiver-safe', async () => {
  const timerOwner = {
    scheduled: [],
    cancelled: [],
    setTimeout(callback) {
      if (this !== timerOwner) throw new TypeError('Illegal invocation');
      const job = { callback };
      this.scheduled.push(job);
      return job;
    },
    clearTimeout(job) {
      if (this !== timerOwner) throw new TypeError('Illegal invocation');
      this.cancelled.push(job);
    }
  };
  const { InitializationManager, bridge } = await loadInitializationManager({ timerOwner, captureBridge: true });
  const manager = new InitializationManager();
  manager.configBridge = { get: () => 'zh-TW' };
  manager.state.configLoaded = true;
  manager.state.playbackContextReady = true;
  manager.components.playbackContextManager = { getCurrentContext: () => ({}) };

  assert.equal(manager.initializeEndscreenTaskBridge(), true);
  const Adapter = await loadAdapter();
  const rawHarness = createHarness();
  const rawAdapter = new Adapter({
    document: rawHarness.document,
    Observer: class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} },
    schedule: timerOwner.setTimeout,
    cancel: timerOwner.clearTimeout,
    getContext: rawHarness.context,
    controller: rawHarness.controller
  });
  rawAdapter.start();

  assert.throws(() => rawAdapter.queueObservation(), { name: 'TypeError', message: 'Illegal invocation' });

  const rawCancelHarness = createHarness();
  const rawCancelAdapter = new Adapter({
    document: rawCancelHarness.document,
    Observer: class { observe() {} disconnect() {} },
    schedule: (...args) => timerOwner.setTimeout(...args),
    cancel: timerOwner.clearTimeout,
    getContext: rawCancelHarness.context,
    controller: rawCancelHarness.controller
  });
  rawCancelAdapter.start();
  rawCancelAdapter.queueObservation();

  assert.throws(() => rawCancelAdapter.stop(), { name: 'TypeError', message: 'Illegal invocation' });

  const harness = createHarness();
  const adapter = new Adapter({
    document: harness.document,
    Observer: class { observe() {} disconnect() {} },
    schedule: bridge.lastOptions.schedule,
    cancel: bridge.lastOptions.cancel,
    getContext: harness.context,
    controller: harness.controller
  });
  adapter.start();

  assert.doesNotThrow(() => adapter.queueObservation());
  assert.doesNotThrow(() => adapter.stop());
  assert.equal(timerOwner.scheduled.length, 2);
  assert.equal(timerOwner.cancelled.length, 1);
});
