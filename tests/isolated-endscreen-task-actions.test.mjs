import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

import { IsolatedEndscreenTasks } from '../content/system/isolated-endscreen-tasks.js';
import { SubmissionDialog } from '../content/ui/submission-dialog.js';

const context = {
  videoId: 'netflix-81234567',
  sessionId: 'watch-session-1',
  epoch: 3,
  state: 'ready'
};

const resolutionContext = {
  taskID: 'official:netflix-81234567:zh-TW:slot-000124',
  targetType: 'official-subtitle',
  action: 'submit-improvement',
  slotKey: 'slot-000124',
  timestamp: 124.5
};

const officialTask = {
  taskID: resolutionContext.taskID,
  targetType: resolutionContext.targetType,
  action: resolutionContext.action,
  videoID: context.videoId,
  timestamp: resolutionContext.timestamp,
  slotKey: resolutionContext.slotKey,
  originalSubtitle: 'Original subtitle',
  suggestedSubtitle: null,
  translationID: null
};

const candidateTask = {
  ...officialTask,
  taskID: 'candidate:550e8400-e29b-41d4-a716-446655440000',
  targetType: 'candidate-translation',
  action: 'review-candidate',
  suggestedSubtitle: 'Candidate subtitle',
  translationID: '550e8400-e29b-41d4-a716-446655440000'
};

function createPayload(intent, task = officialTask) {
  return {
    intent,
    task,
    context,
    translationID: intent.startsWith('vote-') ? task.translationID : undefined,
    sourceTranslationID: intent === 'submit-better-candidate' ? task.translationID : undefined,
    resolutionContext: {
      ...resolutionContext,
      taskID: task.taskID,
      targetType: task.targetType,
      action: task.action,
      slotKey: task.slotKey,
      timestamp: task.timestamp
    }
  };
}

function createOwner({ translationResult = { itemId: 'translation-1' }, translationError = null, voteResult = { itemId: 'vote-1' }, sendPageMessage = async (message) => ({ success: true, status: 'success', action: 'jump-to-timecode', requestId: message.requestId, controlId: message.controlId, issuedAt: message.issuedAt, expected: message.expected, targetTimestamp: message.expected.targetTimestamp, targetMilliseconds: message.expected.targetTimestamp * 1000, snapshot: { videoId: message.expected.videoId, sessionId: message.expected.sessionId, currentTime: message.expected.targetTimestamp * 1000 } }), pathname = '/watch/81234567', playbackContext = { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, state: 'ready' }, playbackContextManager = { getCurrentContext: () => ({ ...playbackContext }) } } = {}) {
  const calls = { opens: [], translations: [], votes: [], pageMessages: [] };
  const location = { pathname };
  const internalEventHandlers = new Map();
  class Dialog {
    constructor() {
      this.isInitialized = false;
      this.isOpen = false;
      this.submitCallback = null;
      this.cancelCallback = null;
      this.closeCallback = null;
    }

    async initialize() {
      this.isInitialized = true;
    }

    async open(data) {
      this.isOpen = true;
      calls.opens.push(data);
    }

    onSubmit(callback) {
      this.submitCallback = callback;
    }

    onCancel(callback) {
      this.cancelCallback = callback;
    }

    onClose(callback) {
      this.closeCallback = callback;
    }

    async submit(data) {
      const result = await this.submitCallback(data);
      if (result?.status === 'success') this.isOpen = false;
      return result;
    }

    cancel() {
      this.isOpen = false;
      this.cancelCallback();
      this.closeCallback();
    }

    close() {
      this.isOpen = false;
      this.closeCallback?.();
    }

    cleanup() {}
  }

  const translationBridge = {
    isInitialized: true,
    async enqueue(data) {
      calls.translations.push(data);
      if (translationError) throw translationError;
      return translationResult;
    }
  };
  const voteBridge = {
    isInitialized: true,
    async enqueue(data) {
      calls.votes.push(data);
      return voteResult;
    }
  };
  const config = { isInitialized: true, async initialize() { this.isInitialized = true; } };
  const owner = new IsolatedEndscreenTasks({
    document: {},
    Observer: class {},
    location,
    configManager: { get: () => true, subscribe: () => () => {} },
    schedule: () => 0,
    cancel: () => {},
    clock: () => 0,
    sendMessage: async () => ({ tasks: [] }),
    sendPageMessage(message) {
      calls.pageMessages.push(message);
      return sendPageMessage(message);
    },
    registerInternalEventHandler(type, handler) {
      const handlers = internalEventHandlers.get(type) ?? new Set();
      handlers.add(handler);
      internalEventHandlers.set(type, handlers);
      return () => handlers.delete(handler);
    },
    routeTarget: new EventTarget(),
    playbackContextManager,
    Dialog,
    translation: translationBridge,
    vote: voteBridge,
    config
  });
  owner.lifecycleGeneration = 1;
  owner.panel = { hide() {} };
  return {
    owner,
    calls,
    location,
    emitInternal(event) {
      const handlers = [...(internalEventHandlers.get(event.type) ?? [])];
      for (const handler of handlers) handler(event);
      return handlers.length;
    }
  };
}

async function settleActionStart() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function loadMessagingInstance() {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context: vm.createContext({ console }) });
  await module.link(() => { throw new Error('messaging.js has no static dependencies'); });
  await module.evaluate();
  return module.namespace;
}

test('Given separate execution worlds When one messaging instance dispatches Then another instance handler is not reached', async () => {
  const isolatedMessaging = await loadMessagingInstance();
  const mainMessaging = await loadMessagingInstance();
  let calls = 0;
  mainMessaging.registerInternalEventHandler('ENDSCREEN_TASK_ACTION', () => { calls += 1; });

  isolatedMessaging.dispatchInternalEvent({ type: 'ENDSCREEN_TASK_ACTION' });

  assert.equal(calls, 0);
});

test('Given an isolated submit action When the dialog opens Then completion waits for its submit callback and queue result', async () => {
  const { owner, calls } = createOwner();
  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement'));
  await settleActionStart();

  assert.equal(owner.submissionDialog.isOpen, true);
  assert.deepEqual(await Promise.race([action, Promise.resolve('pending')]), 'pending');
  const completion = owner.submissionDialog.submit({
    videoId: context.videoId,
    timestamp: resolutionContext.timestamp,
    original: officialTask.originalSubtitle,
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'improvement',
    slotKey: resolutionContext.slotKey
  });

  await completion;
  assert.deepEqual(await action, { status: 'success' });
  assert.equal(calls.translations.length, 1);
  assert.deepEqual(calls.translations[0].resolutionContext, resolutionContext);
  assert.equal(calls.translations[0].translationID, null);
});

test('Given an isolated submit action When the dialog is cancelled Then it settles as retryable error without queue work', async () => {
  const { owner, calls } = createOwner();
  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement'));
  await settleActionStart();

  owner.submissionDialog.cancel();

  assert.deepEqual(await action, { status: 'error', error: '已取消翻譯提交。' });
  assert.deepEqual(calls.translations, []);
});

test('Given an isolated submit action When translation enqueue fails Then it keeps the dialog open for retry', async () => {
  const { owner, calls } = createOwner({ translationError: new Error('queue unavailable') });
  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement'));
  await settleActionStart();

  await owner.submissionDialog.submit({
    videoId: context.videoId,
    timestamp: resolutionContext.timestamp,
    original: officialTask.originalSubtitle,
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'improvement'
  });

  assert.deepEqual(await Promise.race([action, Promise.resolve('pending')]), 'pending');
  assert.equal(owner.submissionDialog.isOpen, true);
  assert.equal(owner.pendingSubmission.isSubmitting, false);
  assert.equal(calls.translations.length, 1);
  owner.submissionDialog.cancel();
  assert.deepEqual(await action, { status: 'error', error: '已取消翻譯提交。' });
});

test('Given a candidate vote action When handled by the isolated owner Then voteBridge receives candidate ID and exact context', async () => {
  const { owner, calls } = createOwner();

  const result = await owner.handlePanelAction(owner.panel, 1, createPayload('vote-like', candidateTask));

  assert.deepEqual(result, { status: 'success' });
  assert.equal(calls.votes.length, 1);
  assert.equal(calls.votes[0].translationID, candidateTask.translationID);
  assert.deepEqual(Object.keys(calls.votes[0].resolutionContext).sort(), ['action', 'slotKey', 'targetType', 'taskID', 'timestamp']);

  const forged = createPayload('vote-like', candidateTask);
  forged.translationID = 'forged-candidate-id';
  assert.equal((await owner.handlePanelAction(owner.panel, 1, forged)).status, 'error');
  assert.equal(calls.votes.length, 1);
});

test('Given a non-jump action When handled by the isolated owner Then no page seek command is dispatched', async () => {
  const { owner, calls } = createOwner();

  const result = await owner.handlePanelAction(owner.panel, 1, createPayload('vote-like', candidateTask));

  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(calls.pageMessages, []);
});

test('Given a jump intent with the content-owned context When handled Then it dispatches the exact jump command contract', async () => {
  const { owner, calls } = createOwner();
  const expected = {
    videoId: '81234567',
    sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001',
    epoch: 7,
    targetTimestamp: 124.5
  };

  const result = await owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected,
    controlId: 'control-render-1',
    requestId: 'page-request-1',
    issuedAt: 1000
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(calls.pageMessages, [{
    type: 'JUMP_TO_TIMECODE',
    intent: 'jump-to-timecode',
    expected,
    controlId: 'control-render-1',
    requestId: 'page-request-1',
    issuedAt: 1000
  }]);
});

test('Given invalid jump timestamp or content context When handled Then it fails before page dispatch', async () => {
  const invalidTimestamps = [Number.NaN, Number.POSITIVE_INFINITY, -1];
  for (const targetTimestamp of invalidTimestamps) {
    const { owner, calls } = createOwner();
    const result = await owner.handlePanelAction(owner.panel, 1, {
      intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp },
      controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
    });

    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'invalid-target-timestamp');
    assert.deepEqual(calls.pageMessages, []);
  }

  const { owner, calls } = createOwner({
    pathname: '/browse',
    playbackContext: {
      videoId: '81234567',
      sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001',
      epoch: 7,
      state: 'transitioning'
    }
  });
  const result = await owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });

  assert.equal(result.reason, 'stale-context');
  assert.deepEqual(calls.pageMessages, []);
});

test('Given a forged jump identity When handled Then it fails closed before page dispatch', async () => {
  const { owner, calls } = createOwner();
  const forgedValues = [
    { videoId: 'wrong-video', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    { videoId: '81234567', sessionId: 'watch-other', epoch: 7, targetTimestamp: 1 },
    { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 8, targetTimestamp: 1 }
  ];

  for (const expected of forgedValues) {
    const result = await owner.handlePanelAction(owner.panel, 1, {
      intent: 'jump-to-timecode',
      expected, controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
    });
    assert.equal(result.reason, 'content-context-mismatch');
  }

  assert.deepEqual(calls.pageMessages, []);
});

test('Given a jump page response that resolves after route invalidation When handled Then late success is suppressed', async () => {
  let resolvePageMessage;
  const { owner, calls } = createOwner({
    sendPageMessage: () => new Promise((resolve) => { resolvePageMessage = resolve; })
  });
  const action = owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });

  await Promise.resolve();
  owner.lifecycleGeneration += 1;
  resolvePageMessage({ success: true, status: 'success' });

  const result = await action;
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'stale-lifecycle');
  assert.equal(calls.pageMessages.length, 1);
});

test('Given a watch-A page action is pending When internal VIDEO_ID_CHANGED reports watch B Then its late success is rejected', async () => {
  let resolvePageMessage;
  const { owner, calls, location, emitInternal } = createOwner({
    sendPageMessage: () => new Promise((resolve) => { resolvePageMessage = resolve; })
  });
  owner.refreshRoute();
  owner.bindRouteListeners(1);
  const action = owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });
  await Promise.resolve();

  location.pathname = '/watch/87654321';
  assert.equal(emitInternal({ type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' }), 1);
  resolvePageMessage({
    success: true,
    status: 'success',
    action: 'jump-to-timecode',
    requestId: 'page-request-1',
    controlId: 'control-render-1',
    issuedAt: 1000,
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    targetTimestamp: 1,
    targetMilliseconds: 1000,
    snapshot: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', currentTime: 1000 }
  });

  const result = await action;
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'stale-lifecycle');
  assert.equal(calls.pageMessages.length, 1);
});

test('Given an advisory jump success When PlaybackContext changes while awaiting it Then UI success is rejected independently', async () => {
  let contextReads = 0;
  const playbackContextManager = {
    getCurrentContext() {
      contextReads += 1;
      return {
        videoId: '81234567',
        sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001',
        epoch: contextReads >= 3 ? 8 : 7,
        state: 'ready'
      };
    }
  };
  const { owner } = createOwner({ playbackContextManager });
  const result = await owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });

  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'post-context-mismatch');
});

test('Given an advisory jump success with a mismatched post time When UI verifies it Then success is rejected', async () => {
  const { owner } = createOwner({
    sendPageMessage: async (message) => ({
      success: true,
      status: 'success',
      action: 'jump-to-timecode',
      requestId: message.requestId,
      controlId: message.controlId,
      issuedAt: message.issuedAt,
      expected: message.expected,
      targetTimestamp: message.expected.targetTimestamp,
      targetMilliseconds: 1000,
      snapshot: {
        videoId: message.expected.videoId,
        sessionId: message.expected.sessionId,
        currentTime: 5000
      }
    })
  });
  const result = await owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });

  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'post-time-mismatch');
});

test('Given a synthetic route session When the real playback context uses a UUID session Then dispatch fails closed', async () => {
  const { owner, calls } = createOwner();
  const result = await owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-81234567', epoch: 1, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });

  assert.equal(result.reason, 'content-context-mismatch');
  assert.deepEqual(calls.pageMessages, []);
});

test('Given a transitioning or changed real playback context When dispatch is attempted Then it fails stale before page transport', async () => {
  let currentContext = { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, state: 'transitioning' };
  let contextReads = 0;
  const playbackContextManager = {
    getCurrentContext: () => {
      contextReads += 1;
      return { ...currentContext, ...(contextReads >= 3 ? { epoch: 8 } : {}) };
    }
  };
  const { owner, calls } = createOwner({ playbackContextManager });
  const payload = {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  };

  const transitioning = await owner.handlePanelAction(owner.panel, 1, payload);
  assert.equal(transitioning.reason, 'stale-context');

  currentContext = { ...currentContext, state: 'ready' };
  const action = owner.handlePanelAction(owner.panel, 1, payload);
  const changed = await action;

  assert.equal(changed.reason, 'stale-context');
  assert.deepEqual(calls.pageMessages, []);
});

test('Given a structured page failure When the content transport resolves it Then the exact reason remains retryable', async () => {
  const { owner, calls } = createOwner({
    sendPageMessage: async (message) => ({
      success: false,
      status: 'error',
      action: 'jump-to-timecode',
      reason: 'session-mismatch',
      requestId: message.requestId,
      controlId: message.controlId,
      issuedAt: message.issuedAt,
      expected: message.expected,
      targetTimestamp: message.expected.targetTimestamp
    })
  });
  const result = await owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });

  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'session-mismatch');
  assert.equal(calls.pageMessages.length, 1);
});

test('Given a structured partial page result after a verified seek When coordinated Then diagnostics and the specific retryable fallback are preserved', async () => {
  const fallback = '已跳轉至字幕時間點，但無法安全還原播放器介面，請使用 Netflix 原生控制。';
  const { owner } = createOwner({
    sendPageMessage: async (message) => ({
      success: false,
      status: 'partial',
      partial: true,
      action: 'jump-to-timecode',
      reason: 'player-ui-restore-timeout',
      error: fallback,
      requestId: message.requestId,
      controlId: message.controlId,
      issuedAt: message.issuedAt,
      expected: message.expected,
      targetTimestamp: message.expected.targetTimestamp,
      targetMilliseconds: 1000,
      snapshot: { videoId: message.expected.videoId, sessionId: message.expected.sessionId, currentTime: 1000 },
      playerUiRestore: { status: 'failed', reason: 'player-ui-restore-timeout', activated: true }
    })
  });

  const result = await owner.handlePanelAction(owner.panel, 1, {
    intent: 'jump-to-timecode',
    expected: { videoId: '81234567', sessionId: 'watch-fa058b0f-0000-4000-8000-000000000001', epoch: 7, targetTimestamp: 1 },
    controlId: 'control-render-1', requestId: 'page-request-1', issuedAt: 1000
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.error, fallback);
  assert.equal(result.reason, 'player-ui-restore-timeout');
  assert.deepEqual(result.playerUiRestore, { status: 'failed', reason: 'player-ui-restore-timeout', activated: true });
});

test('Given an official or candidate action mismatch When handled by the isolated owner Then it fails closed without opening or enqueueing', async () => {
  const { owner, calls } = createOwner();
  const invalidActions = [
    ['vote-like', officialTask],
    ['vote-dislike', officialTask],
    ['submit-improvement', candidateTask],
    ['vote-like', { ...candidateTask, action: 'submit-better-candidate' }],
    ['vote-dislike', { ...candidateTask, action: 'submit-better-candidate' }]
  ];

  for (const [intent, task] of invalidActions) {
    const result = await owner.handlePanelAction(owner.panel, 1, createPayload(intent, task));
    assert.equal(result.status, 'error');
  }

  assert.equal(calls.opens.length, 0);
  assert.equal(calls.translations.length, 0);
  assert.equal(calls.votes.length, 0);
});

test('Given a resolution context with an extra key When an action is handled Then it fails closed before queue work', async () => {
  const { owner, calls } = createOwner();
  const payload = createPayload('submit-improvement');
  payload.resolutionContext.extra = 'forged';

  assert.equal((await owner.handlePanelAction(owner.panel, 1, payload)).status, 'error');
  assert.equal(calls.opens.length, 0);
  assert.equal(calls.translations.length, 0);
});

test('Given a vote initialization that is still pending When the route becomes stale Then no vote is enqueued', async () => {
  const { owner, calls } = createOwner();
  let releaseInitialization;
  owner.actionConfig = {
    isInitialized: false,
    initialize: () => new Promise((resolve) => { releaseInitialization = resolve; })
  };

  const action = owner.handlePanelAction(owner.panel, 1, createPayload('vote-like', candidateTask));
  await settleActionStart();
  owner.routeGeneration += 1;
  releaseInitialization();

  assert.equal((await action).status, 'error');
  assert.deepEqual(calls.votes, []);
});

test('Given a vote initialization that is still pending When the panel becomes hidden Then no vote is enqueued', async () => {
  const { owner, calls } = createOwner();
  let releaseInitialization;
  owner.actionConfig = {
    isInitialized: false,
    initialize: () => new Promise((resolve) => { releaseInitialization = resolve; })
  };

  const action = owner.handlePanelAction(owner.panel, 1, createPayload('vote-like', candidateTask));
  await settleActionStart();
  owner.panel.isVisible = false;
  releaseInitialization();

  assert.equal((await action).status, 'error');
  assert.deepEqual(calls.votes, []);
});

test('Given an opted-out owner When a vote or submission reaches enqueue Then no queue work is performed', async () => {
  const { owner, calls } = createOwner();
  const setting = { enabled: true };
  owner.configManager.get = (key) => key === 'crowdsourcing.endscreenTasksEnabled' ? setting.enabled : true;

  const vote = await owner.handlePanelAction(owner.panel, 1, createPayload('vote-like', candidateTask));
  assert.equal(vote.status, 'success');
  setting.enabled = false;

  const submission = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement'));
  await settleActionStart();
  assert.equal(owner.submissionDialog, null, 'opt-out should be observed before opening a submission dialog');
  assert.equal((await submission).status, 'error');
  assert.equal(calls.translations.length, 0);
});

test('Given isolated startup When the panel emits a submit intent Then the same-world dialog and translation bridge complete it', async () => {
  const { owner, calls } = createOwner();
  let activePanel = null;
  owner.configManager.get = (key) => key === 'subtitle.primaryLanguage' ? 'zh-Hant' : true;
  owner.Panel = class {
    constructor() {
      activePanel = this;
    }

    async initialize() {}
    onOptOut() {}
    onAction(callback) { this.actionCallback = callback; }
    hide() {}
    cleanup() {}
  };
  owner.Controller = class {
    constructor() {}
    handleInternalEvent() {}
  };
  owner.Adapter = class {
    constructor() {}
    start() {}
    stop() {}
  };

  await owner.start();
  const action = activePanel.actionCallback(createPayload('submit-improvement'));
  await settleActionStart();
  await owner.submissionDialog.submit({
    videoId: context.videoId,
    timestamp: resolutionContext.timestamp,
    original: officialTask.originalSubtitle,
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'improvement'
  });

  assert.deepEqual(await action, { status: 'success' });
  assert.equal(calls.translations.length, 1);
  owner.cleanup();
});

test('Given a candidate better-submit When the dialog submits Then the queue receives sourceTranslationID and null translationID', async () => {
  const { owner, calls } = createOwner();
  const task = { ...candidateTask, action: 'submit-better-candidate' };
  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-better-candidate', task));
  await settleActionStart();
  await owner.submissionDialog.submit({
    videoId: context.videoId,
    timestamp: task.timestamp,
    original: task.originalSubtitle,
    translation: 'Better subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'candidate improvement'
  });

  assert.deepEqual(await action, { status: 'success' });
  assert.equal(calls.translations[0].sourceTranslationID, task.translationID);
  assert.equal(calls.translations[0].translationID, null);
  assert.deepEqual(Object.keys(calls.translations[0].resolutionContext).sort(), ['action', 'slotKey', 'targetType', 'taskID', 'timestamp']);
});

test('Given malformed submit fields or a stale owner When the action resolves Then no success is reported', async () => {
  const { owner, calls } = createOwner();
  const malformed = createPayload('submit-improvement', { ...officialTask, originalSubtitle: '' });

  assert.equal((await owner.handlePanelAction(owner.panel, 1, malformed)).status, 'error');
  assert.equal(calls.opens.length, 0);

  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement'));
  await settleActionStart();
  owner.lifecycleGeneration = 2;
  await owner.submissionDialog.submit({
    videoId: context.videoId,
    timestamp: resolutionContext.timestamp,
    original: officialTask.originalSubtitle,
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'improvement'
  });

  assert.equal((await action).status, 'error');
});

test('Given a nullable slot key When the isolated submit action queues Then it preserves slotKey:null exactly', async () => {
  const { owner, calls } = createOwner();
  const task = { ...officialTask, slotKey: null };
  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement', task));
  await settleActionStart();

  await owner.submissionDialog.submit({
    videoId: context.videoId,
    timestamp: task.timestamp,
    original: task.originalSubtitle,
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'improvement'
  });

  assert.deepEqual(await action, { status: 'success' });
  assert.equal(calls.translations[0].resolutionContext.slotKey, null);
});

test('Given a pending submission When the panel is dismissed Then its later submit cannot enqueue', async () => {
  const { owner, calls } = createOwner();
  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement'));
  await settleActionStart();

  owner.handlePanelDismiss(owner.panel, 1);
  await owner.submissionDialog.submit({
    videoId: context.videoId,
    timestamp: resolutionContext.timestamp,
    original: officialTask.originalSubtitle,
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'improvement'
  });

  assert.equal((await action).status, 'error');
  assert.deepEqual(calls.translations, []);
});

test('Given a watch-A submission is pending When internal VIDEO_ID_CHANGED reports watch B Then it is cancelled and a late submit cannot enqueue', async () => {
  const { owner, calls, location, emitInternal } = createOwner();
  owner.refreshRoute();
  owner.bindRouteListeners(1);
  const action = owner.handlePanelAction(owner.panel, 1, createPayload('submit-improvement'));
  await settleActionStart();
  const dialog = owner.submissionDialog;

  location.pathname = '/watch/87654321';
  assert.equal(emitInternal({ type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' }), 1);

  assert.equal((await action).status, 'error');
  await dialog.submit({
    videoId: context.videoId,
    timestamp: resolutionContext.timestamp,
    original: officialTask.originalSubtitle,
    translation: 'Late improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'improvement',
    slotKey: resolutionContext.slotKey
  });
  assert.deepEqual(calls.translations, []);
});

test('Given a real dialog submit callback When it returns the queue promise Then the promise and task metadata are preserved', async () => {
  const dialog = Object.create(SubmissionDialog.prototype);
  const queueResult = Promise.resolve({ status: 'success' });
  let received = null;
  dialog.inputs = {
    languageDisplay: { getAttribute: () => 'zh-Hant' },
    translationInput: { value: 'Improved subtitle', focus() {} },
    reasonInput: { value: 'improvement', focus() {} }
  };
  dialog.currentSubtitleData = {
    videoId: context.videoId,
    timestamp: resolutionContext.timestamp,
    original: officialTask.originalSubtitle,
    slotKey: resolutionContext.slotKey,
    resolutionContext,
    translationID: null
  };
  dialog.eventCallbacks = { onSubmit: (data) => { received = data; return queueResult; } };
  dialog.convertToAPILanguageCode = () => 'zh-TW';
  dialog.log = () => {};
  dialog.close = () => {};
  dialog.setSubmitting = () => {};
  dialog.submissionError = { textContent: '' };

  const result = await dialog.handleSubmit();

  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(received.resolutionContext, resolutionContext);
  assert.equal(received.translationID, null);
});
