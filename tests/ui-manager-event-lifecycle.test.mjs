import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

async function loadManager() {
  const handlers = new Map();
  const events = [];
  const lifecycle = {
    componentCleanups: 0,
    disposerCalls: 0,
    renders: [],
    voteUpdates: [],
    avoidanceUpdates: [],
    timeouts: []
  };

  const context = vm.createContext({
    console,
    Date,
    document: { getElementById: () => null },
    chrome: { storage: { local: { get: (...args) => context.storageGet(...args) } } },
    setInterval: () => 1,
    clearInterval,
    clearTimeout,
    setTimeout: (callback) => {
      lifecycle.timeouts.push(callback);
      return lifecycle.timeouts.length;
    }
  });
  context.storageGet = async () => ({});
  const source = await readFile(new URL('../content/ui/ui-manager-new.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/ui/ui-manager-new.js' });
  const componentModule = (name, body = '') => new vm.SourceTextModule(`
    export class ${name} {
      async initialize() {
        globalThis.lifecycle.initializations = (globalThis.lifecycle.initializations || 0) + 1;
        if (globalThis.blockNextInitialization) {
          globalThis.blockNextInitialization = false;
          await new Promise(resolve => { globalThis.releaseInitialization = resolve; });
        }
      }
      cleanup() { globalThis.lifecycle.componentCleanups += 1; }
      ${body}
    }
  `, { context });
  context.lifecycle = lifecycle;
  context.blockNextInitialization = false;
  const dependencies = new Map([
    ['./subtitle-display.js', componentModule('SubtitleDisplay', 'show(value) { globalThis.lifecycle.renders.push(value); }')],
    ['./interaction-panel.js', componentModule('InteractionPanel', 'onSubmitClick() {} onLikeClick() {} onDislikeClick() {} updateVoteDisplay() {} updatePosition(value) { globalThis.lifecycle.avoidanceUpdates.push({ panel: this, value }); }')],
    ['./submission-dialog.js', componentModule('SubmissionDialog', 'onSubmit() {} onCancel() {} onClose() {}')],
    ['./fullscreen-handler.js', componentModule('FullscreenHandler', 'registerUIComponent() {} onFullscreenChange() {}')],
    ['./ui-avoidance-handler.js', componentModule('UIAvoidanceHandler')],
    ['./toast-manager.js', componentModule('ToastManager')],
    ['./netflix-player-adapter.js', new vm.SourceTextModule('export const getPlayerAdapter = () => ({});', { context })],
    ['../core/subtitle-replacer.js', new vm.SourceTextModule('export class SubtitleReplacer {}', { context })],
    ['../system/messaging.js', new vm.SourceTextModule(`
      export const sendMessage = async () => ({});
      export const registerInternalEventHandler = (type, handler) => {
        globalThis.handlers.set(type, handler);
        return () => { globalThis.lifecycle.disposerCalls += 1; globalThis.handlers.delete(type); };
      };
      export const dispatchInternalEvent = event => {
        globalThis.events.push({ ...event, initialized: globalThis.manager.isInitialized });
      };
    `, { context })]
  ]);
  context.handlers = handlers;
  context.events = events;
  await module.link((specifier) => dependencies.get(specifier));
  await module.evaluate();
  const manager = new module.namespace.UIManager();
  context.manager = manager;
  manager.showNativeSubtitles = () => {};
  manager.setupPlayerObserver = () => {};
  manager.syncNativeSubtitleVisibilityForSubtitle = () => {};
  manager.updateVoteDisplay = value => lifecycle.voteUpdates.push(value);
  manager.setupSubtitleHoverEvents = () => {};
  manager.isInitialized = true;
  manager.subtitleReplacer = { isInitialized: true, processSubtitle: async value => value, cleanup() { lifecycle.replacerCleanups = (lifecycle.replacerCleanups || 0) + 1; } };
  manager.setupEventHandlers();
  await manager.initializeComponents();
  manager.setupComponentInteractions();

  return {
    manager,
    handlers,
    events,
    lifecycle,
    blockInitialization() { context.blockNextInitialization = true; },
    releaseInitialization() { context.releaseInitialization(); },
    setStorageGet(handler) { context.storageGet = handler; },
    runTimers() {
      const callbacks = lifecycle.timeouts.splice(0);
      callbacks.forEach(callback => callback());
    }
  };
}

test('Given component reinitialization is pending When a subtitle callback arrives Then it is safely dropped without uninitialized error spam', async () => {
  const fixture = await loadManager();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  fixture.blockInitialization();
  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await flush();

  await fixture.manager.showSubtitle({ text: 'during transition', timestamp: 1, mode: 'dom' });

  console.error = originalError;
  assert.equal(errors.some(args => args.includes('UI 管理器未初始化')), false);
  assert.equal(fixture.lifecycle.renders.length, 0);
  fixture.releaseInitialization();
  await flush();
});

test('Given one pending transition When VIDEO_ID_CHANGED repeats Then only one component rebuild runs', async () => {
  const fixture = await loadManager();
  fixture.blockInitialization();
  const before = fixture.lifecycle.initializations;
  const handler = fixture.handlers.get('VIDEO_ID_CHANGED');
  handler({ oldVideoId: '1', newVideoId: '2' });
  handler({ oldVideoId: '2', newVideoId: '3' });
  await flush();

  assert.equal(fixture.lifecycle.initializations - before, 1);
  fixture.releaseInitialization();
  await flush();
  assert.equal(fixture.lifecycle.initializations - before, 6);
  assert.equal(fixture.events.find(event => event.type === 'UI_COMPONENTS_REINITIALIZED').newVideoId, '3');
});

test('Given a switch enters component disposal When another video event arrives Then the persistent listener still receives it', async () => {
  const fixture = await loadManager();
  fixture.blockInitialization();
  const handler = fixture.handlers.get('VIDEO_ID_CHANGED');
  handler({ oldVideoId: '1', newVideoId: '2' });
  await flush();

  assert.equal(fixture.handlers.get('VIDEO_ID_CHANGED'), handler);
  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '2', newVideoId: '3' });
  fixture.releaseInitialization();
  await flush();
  assert.equal(fixture.handlers.get('VIDEO_ID_CHANGED'), handler);
});

test('Given a completed rebuild When readiness is published Then listeners observe isInitialized true', async () => {
  const fixture = await loadManager();
  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await flush();

  const readiness = fixture.events.find(event => event.type === 'UI_COMPONENTS_REINITIALIZED');
  assert.equal(readiness.initialized, true);
});

test('Given a persistent SubtitleReplacer When video switches Then the same initialized replacer remains available', async () => {
  const fixture = await loadManager();
  const replacer = fixture.manager.subtitleReplacer;
  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await flush();

  assert.equal(fixture.manager.subtitleReplacer, replacer);
  assert.equal(fixture.lifecycle.replacerCleanups || 0, 0);
});

test('Given a rebuilt manager When terminal cleanup runs Then listeners and current components are disposed once', async () => {
  const fixture = await loadManager();
  const persistentListenerCount = fixture.handlers.size;
  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await flush();
  const cleanupsBeforeTerminal = fixture.lifecycle.componentCleanups;

  fixture.manager.cleanup();
  fixture.manager.cleanup();

  assert.equal(fixture.lifecycle.componentCleanups - cleanupsBeforeTerminal, 6);
  assert.equal(fixture.lifecycle.disposerCalls, persistentListenerCount);
});

test('Given components were recreated When the coordinator renders Then the new SubtitleDisplay receives the subtitle', async () => {
  const fixture = await loadManager();
  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await flush();

  await fixture.manager.showSubtitle({ text: 'new video', timestamp: 2, mode: 'dom' });

  assert.equal(fixture.lifecycle.renders.at(-1).text, 'new video');
});

test('Given replacement rejects after a video switch When the subtitle resumes Then stale replacement work cannot render into new components', async () => {
  const fixture = await loadManager();
  const replacement = deferred();
  fixture.manager.subtitleReplacer.processSubtitle = () => replacement.promise;
  const showPromise = fixture.manager.showSubtitle({ text: 'old video', timestamp: 1, mode: 'dom' });
  await flush();

  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await fixture.manager._componentReinitializationPromise;
  replacement.reject(new Error('replacement failed'));
  await showPromise;

  assert.equal(fixture.lifecycle.renders.length, 0, 'stale replacement error must not render on the new SubtitleDisplay');
  assert.equal(fixture.manager.currentSubtitle, null);
});

test('Given storage authority resolves after a video switch When the subtitle resumes Then stale authority data cannot update the new generation', async () => {
  const fixture = await loadManager();
  const storage = deferred();
  fixture.setStorageGet(() => storage.promise);
  const showPromise = fixture.manager.showSubtitle({ text: 'old video', timestamp: 1, mode: 'dom', translationID: 'translation-1' });
  await flush();

  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await fixture.manager._componentReinitializationPromise;
  storage.resolve({ voteStateByTranslation: { 'translation-1': { myVote: 'like', upvotes: 3, downvotes: 1 } }, voteQueue: [] });
  await showPromise;

  assert.equal(fixture.manager.currentSubtitle, null);
  assert.equal(fixture.lifecycle.voteUpdates.length, 0, 'stale authority data must not update the new generation');
});

test('Given storage authority rejects after a video switch When the subtitle resumes Then stale error recovery cannot update the new generation', async () => {
  const fixture = await loadManager();
  const storage = deferred();
  fixture.setStorageGet(() => storage.promise);
  const showPromise = fixture.manager.showSubtitle({ text: 'old video', timestamp: 1, mode: 'dom', translationID: 'translation-1' });
  await flush();

  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await fixture.manager._componentReinitializationPromise;
  storage.reject(new Error('storage failed'));
  await showPromise;

  assert.equal(fixture.manager.currentSubtitle, null);
  assert.equal(fixture.lifecycle.voteUpdates.length, 0, 'stale storage errors must not continue into vote/UI updates');
});

test('Given avoidance is delayed When the manager tears down Then the old callback does not dereference teardown state or update a new panel', async () => {
  const fixture = await loadManager();
  fixture.manager.currentSubtitle = { text: 'old video', timestamp: 1, mode: 'dom', position: { left: 10, top: 20, width: 100, height: 20 } };
  const oldPanel = fixture.manager.interactionPanel;
  fixture.manager.handleUIAvoidanceChange(true, 15);

  await fixture.manager.reinitializeVideoComponents({ oldVideoId: '1', newVideoId: '2' });
  assert.doesNotThrow(() => fixture.runTimers());
  assert.equal(fixture.lifecycle.avoidanceUpdates.length, 0, 'old avoidance work must not update the rebuilt panel');

  fixture.manager.currentSubtitle = { text: 'new video', timestamp: 2, mode: 'dom', position: { left: 10, top: 40, width: 100, height: 20 } };
  assert.notEqual(fixture.manager.interactionPanel, oldPanel);
  fixture.manager.handleUIAvoidanceChange(true, 15);
  fixture.manager.cleanup();
  assert.doesNotThrow(() => fixture.runTimers());
});
