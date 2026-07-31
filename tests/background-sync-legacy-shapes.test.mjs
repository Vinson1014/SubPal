import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSync } from './background-sync-metadata-harness.mjs';

test('Given a stale metadata-free translation When translation sync retries it Then legacy API and history shapes remain unchanged', async () => {
  const { module, state, apiCalls } = await loadSync();
  state.translationQueue = [{
    id: 'legacy-translation-stale-1', videoId: 'netflix-81234567', timestamp: 12.5,
    original: 'Original subtitle', translation: 'Improved subtitle', languageCode: 'zh-TW',
    submissionReason: 'normal subtitle hover submission', slotKey: null, status: 'syncing',
    createdAt: 0, syncStartedAt: 0, retryCount: 1, error: null, backendProfileId: 'default'
  }];

  await module.namespace.triggerTranslationSync();

  assert.deepEqual(JSON.parse(JSON.stringify(apiCalls)), [{
    kind: 'submitTranslation',
    payload: {
      videoId: 'netflix-81234567', timestamp: 12.5, original: 'Original subtitle',
      translation: 'Improved subtitle', submissionReason: 'normal subtitle hover submission',
      languageCode: 'zh-TW', slotKey: null, backendProfileId: 'default'
    }
  }]);
  assert.equal(state.translationQueue.length, 0);
  assert.equal(state.translationHistory.length, 1);
  assert.equal(Object.hasOwn(state.translationHistory[0], 'translationID'), false);
  assert.equal(Object.hasOwn(state.translationHistory[0], 'sourceTranslationID'), false);
  assert.equal(Object.hasOwn(state.translationHistory[0], 'resolutionContext'), false);
});

test('Given a stale metadata-free vote When vote sync retries it Then legacy API and history shapes remain unchanged', async () => {
  const { module, state, apiCalls } = await loadSync();
  state.voteQueue = [{
    id: 'legacy-vote-stale-1', videoId: 'netflix-81234567', timestamp: 12.5,
    voteType: 'upvote', translationID: null, originalSubtitle: 'Original subtitle', slotKey: null,
    status: 'syncing', createdAt: 0, syncStartedAt: 0, retryCount: 1, error: null, backendProfileId: 'default'
  }];

  await module.namespace.triggerVoteSync();

  assert.deepEqual(JSON.parse(JSON.stringify(apiCalls)), [{
    kind: 'submitVote',
    payload: {
      videoID: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote',
      translationID: null, originalSubtitle: 'Original subtitle', slotKey: null, backendProfileId: 'default'
    }
  }]);
  assert.equal(state.voteQueue.length, 0);
  assert.equal(state.voteHistory.length, 1);
  assert.equal(Object.hasOwn(state.voteHistory[0], 'resolutionContext'), false);
});
