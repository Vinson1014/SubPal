import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enqueueContribution } from '../background/contribution-queue.js';

function createStorage() {
  const values = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'profile-a',
      byId: { 'profile-a': { id: 'profile-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null } }
    },
    voteQueue: []
  };
  return {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, structuredClone(values[key])]));
    },
    async set(updates) { Object.assign(values, structuredClone(updates)); },
    values
  };
}

const taskContext = {
  taskID: 'candidate:translation-1',
  targetType: 'candidate-translation',
  action: 'review-candidate',
  slotKey: 'slot-000321',
  timestamp: 321.2
};

function vote(payload) {
  return { category: 'contribution-intent', variant: 'enqueue-vote', payload };
}

test('Given a pending task vote When a context-free hover vote coalesces for the same translation Then task-only metadata is removed without replacing identity', async () => {
  const storage = createStorage();
  const first = await enqueueContribution(storage, vote({
    videoId: 'netflix-81234567', timestamp: 321.2, voteType: 'upvote', translationID: 'translation-1',
    originalSubtitle: 'Candidate subtitle', slotKey: 'slot-000321', voteState: 'like', resolutionContext: taskContext
  }));
  const second = await enqueueContribution(storage, vote({
    videoId: 'netflix-81234567', timestamp: 321.2, voteType: 'downvote', translationID: 'translation-1',
    originalSubtitle: 'Candidate subtitle', slotKey: 'slot-000321'
  }));

  const record = storage.values.voteQueue[0];
  assert.equal(storage.values.voteQueue.length, 1);
  assert.equal(second.operationId, first.operationId);
  assert.equal(record.id, record.operationId);
  assert.equal(Object.hasOwn(record, 'resolutionContext'), false);
  assert.equal(Object.hasOwn(record, 'voteState'), false);
});
