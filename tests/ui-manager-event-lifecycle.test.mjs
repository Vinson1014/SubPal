import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { SUPPORTED_LANGUAGES } from '../content/system/config/config-schema.js';

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
    localReplacementUpserts: [],
    timeouts: []
  };

  const contextValues = {
    console,
    Date,
    document: { getElementById: () => null },
    window: {},
    setInterval: () => 1,
    clearInterval,
    clearTimeout,
    setTimeout: (callback) => {
      lifecycle.timeouts.push(callback);
      return lifecycle.timeouts.length;
    }
  };
  const context = vm.createContext(contextValues);
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
  context.sendMessage = async () => ({});
  context.contributionProjection = async () => ({ ok: true, value: {} });
  const dependencies = new Map([
    ['../system/config/config-schema.js', new vm.SyntheticModule(['SUPPORTED_LANGUAGES'], function () {
      this.setExport('SUPPORTED_LANGUAGES', SUPPORTED_LANGUAGES);
    }, { context })],
    ['./subtitle-display.js', componentModule('SubtitleDisplay', 'show(value) { globalThis.lifecycle.renders.push(value); } hide() {}')],
    ['./interaction-panel.js', componentModule('InteractionPanel', 'onSubmitClick() {} onLikeClick() {} onDislikeClick() {} updateVoteDisplay() {} updatePosition(value) { globalThis.lifecycle.avoidanceUpdates.push({ panel: this, value }); } hide() {}')],
    ['./submission-dialog.js', componentModule('SubmissionDialog', 'onSubmit(callback) { globalThis.lifecycle.submissionCallback = callback; } onCancel() {} onClose() {}')],
    ['./fullscreen-handler.js', componentModule('FullscreenHandler', 'registerUIComponent() {} onFullscreenChange() {}')],
    ['./ui-avoidance-handler.js', componentModule('UIAvoidanceHandler')],
    ['./toast-manager.js', componentModule('ToastManager')],
    ['./netflix-player-adapter.js', new vm.SourceTextModule('export const getPlayerAdapter = () => ({});', { context })],
    ['../core/subtitle-replacer.js', new vm.SourceTextModule('export class SubtitleReplacer {}', { context })],
    ['../system/messaging.js', new vm.SourceTextModule(`
      export const sendMessage = message => globalThis.sendMessage(message);
      export const registerInternalEventHandler = (type, handler) => {
        globalThis.handlers.set(type, handler);
        return () => { globalThis.lifecycle.disposerCalls += 1; globalThis.handlers.delete(type); };
      };
      export const dispatchInternalEvent = event => {
        globalThis.events.push({ ...event, initialized: globalThis.manager.isInitialized });
      };
    `, { context })],
    ['../system/capabilities/contributions.js', new vm.SourceTextModule(`
      export const createPageContributions = () => Object.freeze({
        getProjection: input => globalThis.contributionProjection(input)
      });
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
  manager.subtitleReplacer = { isInitialized: true, processSubtitle: async value => value, upsertLocalReplacement(record) { lifecycle.localReplacementUpserts.push(record); return record; }, cleanup() { lifecycle.replacerCleanups = (lifecycle.replacerCleanups || 0) + 1; } };
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
    setContributionProjection(handler) { context.contributionProjection = handler; },
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

test('auto secondary warnings distinguish failures, require dual auto, and deduplicate per video and reason across epochs', async () => {
  const { manager, handlers } = await loadManager();
  const messages = [];
  manager.showWarningToast = message => messages.push(message);
  const notify = (status, reason, language = 'ja-JP', overrides = {}) => {
    handlers.get('SUBTITLE_READINESS_CHANGED')({
      reason: 'language-acquisition-failed', slot: 'secondary', failureReason: reason,
      readiness: { context: { videoId: 'A', epoch: 1 }, secondary: {
        configuredLanguage: 'auto', dualEnabled: true, language, originalLanguages: language ? [language] : [],
        resolution: { status, reason, ...(reason === 'parse-empty' ? { failureKind: 'acquisition-failed' } : {}) },
        ...overrides
      } }
    });
  };
  notify('missing', 'no-eligible-secondary-track', 'ja', { dualEnabled: false });
  notify('missing', 'no-eligible-secondary-track', 'ja', { configuredLanguage: 'en' });
  assert.equal(messages.length, 0);
  notify('missing', 'no-eligible-secondary-track');
  notify('missing', 'no-eligible-secondary-track', 'ja');
  notify('unknown', 'no-valid-native-audio-language', null);
  notify('ambiguous', 'multiple-native-audio-languages', 'da');
  notify('unavailable', 'original-language-unavailable', null);
  notify('unavailable', 'parse-empty', 'da');
  assert.equal(messages.length, 5);
  assert.match(messages[0], /沒有原始語言字幕.*日本語/);
  assert.match(messages[1], /無法判斷原始語言/);
  assert.match(messages[2], /多種原始語言.*da/);
  assert.match(messages[3], /原始語言解析失敗/);
  assert.match(messages[4], /字幕取得失敗.*da/);
  handlers.get('SUBTITLE_READINESS_CHANGED')({ reason: 'language-acquisition-failed', slot: 'secondary',
    readiness: { context: { videoId: 'A', epoch: 2 }, secondary: { configuredLanguage: 'auto', dualEnabled: true,
      language: 'ja', resolution: { status: 'missing', reason: 'no-eligible-secondary-track' } } } });
  assert.equal(messages.length, 5);
  handlers.get('SUBTITLE_READINESS_CHANGED')({ reason: 'language-acquisition-failed', slot: 'secondary',
    readiness: { context: { videoId: 'B', epoch: 3 }, secondary: { configuredLanguage: 'auto', dualEnabled: true,
      language: 'ja', resolution: { status: 'missing', reason: 'no-eligible-secondary-track' } } } });
  assert.equal(messages.length, 6);
  for (let epoch = 4; epoch < 60; epoch += 1) {
    manager.handleAcquisitionFailureNotification({ reason: 'language-acquisition-failed', slot: 'primary',
      failureReason: 'parse-empty', readiness: { context: { videoId: 'A', epoch } } });
  }
  const afterPrimaryWarnings = messages.length;
  notify('missing', 'no-eligible-secondary-track');
  assert.equal(messages.length, afterPrimaryWarnings, 'primary warning eviction must not lose per-video secondary deduplication');
});

test('ready auto same-track suppression never warns despite a false secondary slot and does not consume later failure notifications', async () => {
  const { manager, handlers } = await loadManager();
  const messages = [];
  manager.showWarningToast = message => messages.push(message);
  const notify = (epoch, status, reason) => handlers.get('SUBTITLE_READINESS_CHANGED')({
    reason: 'language-acquisition-failed', slot: 'secondary', failureReason: reason,
    readiness: { context: { videoId: 'A', epoch }, secondary: {
      configuredLanguage: 'auto', dualEnabled: true, language: 'en', originalLanguages: ['en'],
      ready: false, missingReason: reason, resolution: { status, reason }
    } }
  });
  for (let epoch = 1; epoch <= 4; epoch += 1) notify(epoch, 'ready', 'same-primary-track');
  assert.equal(messages.length, 0);
  notify(4, 'missing', 'no-eligible-secondary-track');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /沒有原始語言字幕/);
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

test('Given translation enqueue succeeds When the dialog submit callback settles Then it returns success instead of a false failure', async () => {
  const fixture = await loadManager();
  fixture.manager.translationBridge = {
    enqueue: async () => ({ ok: true, value: { status: 'queued-locally', operationId: 'translation-1' } })
  };
  fixture.manager.showToast = () => {};

  const result = await fixture.lifecycle.submissionCallback({ translation: '修正翻譯' });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: 'queued-locally',
    operationId: 'translation-1'
  });
  assert.equal(fixture.lifecycle.localReplacementUpserts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.lifecycle.localReplacementUpserts[0])), {
    itemId: 'translation-1',
    slotKey: null,
    videoId: null,
    suggestedSubtitle: '修正翻譯',
    status: 'pending'
  });
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

test('Given typed vote authority resolves after a video switch When the subtitle resumes Then stale authority data cannot update the new generation', async () => {
  const fixture = await loadManager();
  const storage = deferred();
  fixture.setContributionProjection(() => storage.promise);
  const showPromise = fixture.manager.showSubtitle({ text: 'old video', timestamp: 1, mode: 'dom', translationID: 'translation-1' });
  await flush();

  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await fixture.manager._componentReinitializationPromise;
  storage.resolve({ ok: true, value: { authority: { myVote: 'like', upvotes: 3, downvotes: 1 }, hasPendingVote: false, permanentFailure: null } });
  await showPromise;

  assert.equal(fixture.manager.currentSubtitle, null);
  assert.equal(fixture.lifecycle.voteUpdates.length, 0, 'stale authority data must not update the new generation');
});

test('Given typed vote authority rejects after a video switch When the subtitle resumes Then stale error recovery cannot update the new generation', async () => {
  const fixture = await loadManager();
  const storage = deferred();
  fixture.setContributionProjection(() => storage.promise);
  const showPromise = fixture.manager.showSubtitle({ text: 'old video', timestamp: 1, mode: 'dom', translationID: 'translation-1' });
  await flush();

  fixture.handlers.get('VIDEO_ID_CHANGED')({ oldVideoId: '1', newVideoId: '2' });
  await fixture.manager._componentReinitializationPromise;
  storage.reject(new Error('storage failed'));
  await showPromise;

  assert.equal(fixture.manager.currentSubtitle, null);
  assert.equal(fixture.lifecycle.voteUpdates.length, 0, 'stale storage errors must not continue into vote/UI updates');
});

test('Given a seek starts a new render generation When an earlier cue arrives Then it renders while the previous generation is rejected', async () => {
  const fixture = await loadManager();
  const staleReplacement = deferred();
  fixture.manager.subtitleReplacer.processSubtitle = (subtitle) =>
    subtitle.text === 'before seek' ? staleReplacement.promise : Promise.resolve(subtitle);

  const staleRender = fixture.manager.showSubtitle({
    text: 'before seek',
    timestamp: 1211.11,
    mode: 'intercept',
    renderGeneration: 0
  });
  await flush();

  fixture.handlers.get('SUBTITLE_RENDER_RESET')({ renderGeneration: 1 });
  await fixture.manager.showSubtitle({
    text: 'after backward seek',
    timestamp: 1202.13,
    mode: 'intercept',
    renderGeneration: 1
  });
  staleReplacement.resolve({ text: 'before seek', timestamp: 1211.11, mode: 'intercept' });
  await staleRender;

  assert.deepEqual(fixture.lifecycle.renders.map(subtitle => subtitle.text), ['after backward seek']);
  assert.equal(fixture.manager.currentSubtitle.text, 'after backward seek');
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

test('Given local translation operations When UIManager reads reconciliation Then it uses the contribution projection interface and maps minimized records by operation ID', async () => {
  const fixture = await loadManager();
  const pendingItem = { operationId: 'pending-operation', status: 'syncing', syncedAt: null, terminal: false };
  const completedItem = { operationId: 'completed-operation', status: 'completed', syncedAt: 123, terminal: true };
  const messages = [];
  fixture.setContributionProjection(async (message) => {
    messages.push(message);
    return { ok: true, value: [pendingItem, completedItem] };
  });

  const snapshot = await fixture.manager.readTranslationSyncSnapshot([pendingItem.operationId, completedItem.operationId]);

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    variant: 'translation-reconciliation',
    payload: { operationIds: [pendingItem.operationId, completedItem.operationId] }
  }]);
  assert.equal(snapshot.get(pendingItem.operationId).status, 'syncing');
  assert.equal(snapshot.get(completedItem.operationId).syncedAt, 123);
});

test('Given typed vote authority and a permanent failure When UIManager reads both paths Then scoped bridge data updates and rolls back', async () => {
  const fixture = await loadManager();
  const messages = [];
  let rollback;
  fixture.manager.revertOptimisticVote = (state, counts) => { rollback = { state, counts }; };
  fixture.setContributionProjection(async (message) => {
    messages.push(message);
    return { ok: true, value: {
      authority: { myVote: 'like', upvotes: 3, downvotes: 1 },
      hasPendingVote: false,
      permanentFailure: messages.length === 2 ? { previousVoteState: 'none', previousCounts: { like: 1, dislike: 2 } } : null
    } };
  });

  await fixture.manager.showSubtitle({ text: 'vote', timestamp: 1, mode: 'dom', translationID: 'translation-1' });
  await fixture.manager.checkAndRevertPermanentFailures();

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { variant: 'vote-authority', payload: { translationID: 'translation-1' } },
    { variant: 'vote-authority', payload: { translationID: 'translation-1' } }
  ]);
  assert.deepEqual(rollback, { state: 'none', counts: { like: 1, dislike: 2 } });
});

test('Given a minimized reconciliation record When UIManager reconciles local replacements Then it applies the status matched by operation ID', async () => {
  const fixture = await loadManager();
  const messages = [];
  const statusUpdates = [];
  fixture.manager.subtitleReplacer = {
    listLocalReplacements() {
      return [{ itemId: 'operation-1', status: 'pending' }];
    },
    setLocalReplacementStatus(itemId, status) {
      statusUpdates.push({ itemId, status });
      return { itemId, status };
    },
    isLocalReplacementReconciliationDue() {
      return false;
    }
  };
  fixture.setContributionProjection(async (message) => {
    messages.push(message);
    return { ok: true, value: [{ operationId: 'operation-1', status: 'syncing', syncedAt: null, terminal: false }] };
  });

  await fixture.manager.checkAndReconcileTranslationSubmissions();

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    variant: 'translation-reconciliation',
    payload: { operationIds: ['operation-1'] }
  }]);
  assert.deepEqual(statusUpdates, [{ itemId: 'operation-1', status: 'syncing' }]);
});
