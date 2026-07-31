import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueContribution } from '../background/contribution-queue.js';
import { assertExactContext, contextWithExtraKey, loadSync } from './background-sync-metadata-harness.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function profileStore() {
  return {
    schemaVersion: 1,
    activeProfileId: 'profile-a',
    byId: {
      'profile-a': { id: 'profile-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
      'profile-b': { id: 'profile-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: null }
    }
  };
}

function pendingVote({ id, operationId, backendProfileId, voteState } = {}) {
  const record = {
    id: id ?? 'vote-1', operationId: operationId ?? 'operation-1', backendProfileId: backendProfileId ?? 'profile-a',
    videoId: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote', translationID: 'translation-1', originalSubtitle: 'Original subtitle',
    status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), syncedAt: null, retryCount: 0, error: null
  };
  if (voteState !== undefined) record.voteState = voteState;
  return record;
}

function voteIntent(voteState) {
  const payload = {
    videoId: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote', translationID: 'translation-1', originalSubtitle: 'Original subtitle'
  };
  if (voteState !== undefined) payload.voteState = voteState;
  return { category: 'contribution-intent', variant: 'enqueue-vote', payload };
}

function conflict409() {
  const error = new Error('duplicate vote');
  error.status = 409;
  return error;
}

function pauseAfterPendingVoteSnapshot() {
  const snapshotTaken = deferred();
  const resume = deferred();
  let voteQueueReads = 0;
  return {
    afterStorageGet: async ({ keys }) => {
      if (keys.length !== 1 || keys[0] !== 'voteQueue') return;
      voteQueueReads += 1;
      if (voteQueueReads !== 2) return;
      snapshotTaken.resolve();
      await resume.promise;
    },
    resume: () => resume.resolve(),
    snapshotTaken: snapshotTaken.promise
  };
}

test('Given a stale queued translation When translation sync retries it Then API and history preserve task metadata', async () => {
  const { module, state, apiCalls } = await loadSync();
  state.translationQueue = [{
    id: 'translation-stale-1',
    videoId: 'netflix-81234567',
    timestamp: 321.2,
    original: 'Original subtitle',
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'candidate improvement',
    slotKey: 'slot-000321',
    translationID: null,
    sourceTranslationID: '550e8400-e29b-41d4-a716-446655440000',
    resolutionContext: contextWithExtraKey,
    status: 'syncing',
    createdAt: 0,
    syncStartedAt: 0,
    retryCount: 1,
    error: null,
    backendProfileId: 'default',
    operationId: 'translation-stale-operation'
  }];

  await module.namespace.triggerTranslationSync();

  assert.deepEqual(JSON.parse(JSON.stringify(apiCalls)), [{
    kind: 'submitTranslation',
    payload: {
      videoId: 'netflix-81234567',
      timestamp: 321.2,
      original: 'Original subtitle',
      translation: 'Improved subtitle',
      submissionReason: 'candidate improvement',
      languageCode: 'zh-TW',
      slotKey: 'slot-000321',
      translationID: null,
      sourceTranslationID: '550e8400-e29b-41d4-a716-446655440000',
      resolutionContext: {
        taskID: contextWithExtraKey.taskID,
        targetType: contextWithExtraKey.targetType,
        action: contextWithExtraKey.action,
        slotKey: contextWithExtraKey.slotKey,
        timestamp: contextWithExtraKey.timestamp
      },
      backendProfileId: 'default'
    }
  }]);
  assert.equal(state.translationQueue.length, 0);
  assert.equal(state.translationHistory.length, 1);
  assert.deepEqual(state.translationHistory.map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId })), [
    { operationId: 'translation-stale-operation', backendProfileId: 'default' }
  ]);
  assertExactContext(state.translationHistory[0].resolutionContext);
});

test('Given a stale queued candidate vote When vote sync retries it Then setVoteState preserves translationID and context', async () => {
  const { module, state, apiCalls } = await loadSync();
  state.voteQueue = [{
    id: 'vote-stale-1',
    videoId: 'netflix-81234567',
    timestamp: 321.2,
    voteType: 'upvote',
    translationID: '550e8400-e29b-41d4-a716-446655440000',
    voteState: 'like',
    resolutionContext: contextWithExtraKey,
    status: 'syncing',
    createdAt: 0,
    syncStartedAt: 0,
    retryCount: 1,
    error: null,
    backendProfileId: 'default',
    operationId: 'candidate-vote-stale-operation'
  }];

  await module.namespace.triggerVoteSync();

  assert.deepEqual(JSON.parse(JSON.stringify(apiCalls)), [{
    kind: 'setVoteState',
    payload: {
      translationID: '550e8400-e29b-41d4-a716-446655440000',
      voteState: 'like',
      clientVersion: null,
      resolutionContext: {
        taskID: contextWithExtraKey.taskID,
        targetType: contextWithExtraKey.targetType,
        action: contextWithExtraKey.action,
        slotKey: contextWithExtraKey.slotKey,
        timestamp: contextWithExtraKey.timestamp
      },
      backendProfileId: 'default'
    }
  }]);
  assert.equal(state.voteQueue.length, 0);
  assert.equal(state.voteHistory.length, 1);
  assert.deepEqual(state.voteHistory.map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId })), [
    { operationId: 'candidate-vote-stale-operation', backendProfileId: 'default' }
  ]);
  assertExactContext(state.voteHistory[0].resolutionContext);
});

test('Given a stale queued legacy vote When vote sync retries it Then submitVote preserves translationID slot and context', async () => {
  const { module, state, apiCalls } = await loadSync();
  state.voteQueue = [{
    id: 'legacy-vote-stale-1',
    videoId: 'netflix-81234567',
    timestamp: 12.5,
    voteType: 'upvote',
    translationID: null,
    originalSubtitle: 'Original subtitle',
    slotKey: 'slot-000124',
    resolutionContext: contextWithExtraKey,
    status: 'syncing',
    createdAt: 0,
    syncStartedAt: 0,
    retryCount: 1,
    error: null,
    backendProfileId: 'default',
    operationId: 'legacy-vote-stale-operation'
  }];

  await module.namespace.triggerVoteSync();

  assert.deepEqual(JSON.parse(JSON.stringify(apiCalls)), [{
    kind: 'submitVote',
    payload: {
      videoID: 'netflix-81234567',
      timestamp: 12.5,
      voteType: 'upvote',
      translationID: null,
      originalSubtitle: 'Original subtitle',
      slotKey: 'slot-000124',
      resolutionContext: {
        taskID: contextWithExtraKey.taskID,
        targetType: contextWithExtraKey.targetType,
        action: contextWithExtraKey.action,
        slotKey: contextWithExtraKey.slotKey,
        timestamp: contextWithExtraKey.timestamp
      },
      backendProfileId: 'default'
    }
  }]);
  assert.equal(state.voteQueue.length, 0);
  assert.equal(state.voteHistory.length, 1);
  assert.deepEqual(state.voteHistory.map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId })), [
    { operationId: 'legacy-vote-stale-operation', backendProfileId: 'default' }
  ]);
  assertExactContext(state.voteHistory[0].resolutionContext);
});

test('Given a legacy vote snapshot When stateful coalescing wins before its claim and the API returns 409 Then sync classifies the claimed record as stateful', async () => {
  const pause = pauseAfterPendingVoteSnapshot();
  const inactiveTwin = pendingVote({ id: 'vote-b', operationId: 'operation-b', backendProfileId: 'profile-b', voteState: 'dislike' });
  const { module, state, apiCalls, storage } = await loadSync({
    state: { backendProfiles: profileStore(), voteQueue: [pendingVote(), inactiveTwin] },
    afterStorageGet: pause.afterStorageGet,
    setVoteState: async () => { throw conflict409(); },
    isPermanentError: (error) => error.status === 409
  });

  const sync = module.namespace.triggerVoteSync('profile-a');
  await pause.snapshotTaken;
  const coalesced = await enqueueContribution(storage, voteIntent('like'));
  assert.equal(coalesced.operationId, 'operation-1');
  pause.resume();
  await sync;

  assert.deepEqual(apiCalls.map(({ kind, payload }) => ({ kind, voteState: payload.voteState })), [{ kind: 'setVoteState', voteState: 'like' }]);
  assert.deepEqual(state.voteQueue.map(({ id, operationId, backendProfileId, status, voteState }) => ({ id, operationId, backendProfileId, status, voteState })), [
    { id: 'vote-1', operationId: 'operation-1', backendProfileId: 'profile-a', status: 'failed', voteState: 'like' },
    { id: 'vote-b', operationId: 'operation-b', backendProfileId: 'profile-b', status: 'pending', voteState: 'dislike' }
  ]);
  assert.equal(Object.hasOwn(state.voteQueue[0], 'syncStartedAt'), false);
  assert.deepEqual(state.voteHistory, []);
  assert.equal(state.voteQueue.some((record) => record.status === 'syncing'), false);
  assert.deepEqual(state.voteQueue[1], inactiveTwin);
});

test('Given a stateful vote snapshot When legacy coalescing wins before its claim and the API returns 409 Then sync classifies the claimed record as legacy', async () => {
  const pause = pauseAfterPendingVoteSnapshot();
  const inactiveTwin = pendingVote({ id: 'vote-b', operationId: 'operation-b', backendProfileId: 'profile-b', voteState: 'dislike' });
  const { module, state, apiCalls, storage } = await loadSync({
    state: { backendProfiles: profileStore(), voteQueue: [pendingVote({ voteState: 'like' }), inactiveTwin] },
    afterStorageGet: pause.afterStorageGet,
    submitVote: async () => { throw conflict409(); },
    isPermanentError: (error) => error.status === 409
  });

  const sync = module.namespace.triggerVoteSync('profile-a');
  await pause.snapshotTaken;
  const coalesced = await enqueueContribution(storage, voteIntent());
  assert.equal(coalesced.operationId, 'operation-1');
  pause.resume();
  await sync;

  assert.deepEqual(apiCalls.map(({ kind }) => kind), ['submitVote']);
  assert.deepEqual(state.voteQueue, [inactiveTwin]);
  assert.deepEqual(state.voteHistory.map(({ id, operationId, backendProfileId, status, voteState }) => ({ id, operationId, backendProfileId, status, voteState })), [
    { id: 'vote-1', operationId: 'operation-1', backendProfileId: 'profile-a', status: 'completed', voteState: undefined }
  ]);
  assert.equal(Object.hasOwn(state.voteHistory[0], 'voteState'), false);
  assert.equal(state.voteHistory.some((record) => record.status === 'syncing'), false);
  assert.equal(state.voteQueue.some((record) => record.status === 'syncing'), false);
  assert.deepEqual(state.voteQueue[0], inactiveTwin);
});
