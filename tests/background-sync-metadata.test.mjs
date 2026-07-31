import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertExactContext, contextWithExtraKey, loadSync } from './background-sync-metadata-harness.mjs';

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
    backendProfileId: 'default'
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
    backendProfileId: 'default'
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
    backendProfileId: 'default'
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
  assertExactContext(state.voteHistory[0].resolutionContext);
});
