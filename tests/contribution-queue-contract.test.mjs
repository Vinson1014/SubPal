import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enqueueContribution, getContributionProjection, retryContribution } from '../background/contribution-queue.js';
import { runStorageMutation } from '../background/storage-mutation-coordinator.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function profileStore(activeProfileId = 'profile-a') {
  return {
    schemaVersion: 1,
    activeProfileId,
    byId: {
      'profile-a': { id: 'profile-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
      'profile-b': { id: 'profile-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: 'jwt-b' }
    }
  };
}

function createStorage(initial, options = {}) {
  const values = clone(initial);
  const setCalls = [];
  const firstSet = deferred();
  const releaseFirstSet = deferred();
  let holdFirstSet = options.holdFirstSet === true;

  return {
    local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        await options.beforeQueueRead?.({ keys: requested, values });
        return Object.fromEntries(requested.map((key) => [key, clone(values[key])]));
      },
      async set(updates) {
        setCalls.push(clone(updates));
        if (holdFirstSet) {
          holdFirstSet = false;
          firstSet.resolve();
          await releaseFirstSet.promise;
        }
        Object.assign(values, clone(updates));
      }
    },
    data() { return clone(values); },
    firstSet: firstSet.promise,
    releaseFirstSet() { releaseFirstSet.resolve(); },
    setCalls
  };
}

function voteIntent(translationID = 'translation-1') {
  return {
    category: 'contribution-intent',
    variant: 'enqueue-vote',
    payload: {
      videoId: 'netflix-81234567',
      timestamp: 12.5,
      voteType: 'upvote',
      translationID,
      voteState: 'like'
    }
  };
}

function translationIntent() {
  return {
    category: 'contribution-intent',
    variant: 'enqueue-translation',
    payload: {
      videoId: 'netflix-81234567',
      timestamp: 12.5,
      original: 'Original subtitle',
      translation: 'Improved subtitle',
      languageCode: 'zh-TW',
      submissionReason: 'quality'
    }
  };
}

function replacementIntent(extraPayload = {}) {
  return {
    category: 'contribution-intent',
    variant: 'enqueue-replacement-event',
    payload: {
      translationID: 'translation-1',
      contributorUserID: 'contributor-1',
      occurredAt: '2026-08-01T00:00:00.000Z',
      ...extraPayload
    }
  };
}

test('Given a rejected storage mutation When a later mutation starts Then the shared coordinator heals the chain', async () => {
  const storage = {};
  await assert.rejects(runStorageMutation(storage, async () => { throw new Error('first mutation failed'); }), /first mutation failed/);
  assert.equal(await runStorageMutation(storage, async () => 'second mutation committed'), 'second mutation committed');
});

test('Given profile-bound failed records When typed retry and projection run Then only the bound record changes and identity survives', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    voteQueue: [
      { id: 'vote-a', operationId: 'operation-a', backendProfileId: 'profile-a', translationID: 'translation-1', status: 'failed', retryCount: 3, error: 'failed', errorMetadata: { isPermanent: true }, previousVoteState: 'none', previousCounts: { like: 1, dislike: 2 } },
      { id: 'vote-b', operationId: 'operation-b', backendProfileId: 'profile-b', translationID: 'translation-1', status: 'failed', retryCount: 2, error: 'foreign' }
    ]
  });

  assert.equal(await retryContribution(storage.local, 'operation-a', 'profile-a'), true);
  assert.deepEqual(storage.data().voteQueue.map((record) => [record.id, record.operationId, record.backendProfileId, record.status, record.retryCount, record.error]), [
    ['vote-a', 'operation-a', 'profile-a', 'pending', 0, null],
    ['vote-b', 'operation-b', 'profile-b', 'failed', 2, 'foreign']
  ]);
  storage.data().voteQueue[0].status;
  await storage.local.set({ voteQueue: [{ ...storage.data().voteQueue[0], status: 'failed', errorMetadata: { isPermanent: true }, previousVoteState: 'none', previousCounts: { like: 1, dislike: 2 } }, storage.data().voteQueue[1]] });
  assert.deepEqual(await getContributionProjection(storage.local, {
    variant: 'vote-authority', payload: { translationID: 'translation-1' }
  }), {
    authority: null,
    hasPendingVote: false,
    permanentFailure: { previousVoteState: 'none', previousCounts: { like: 1, dislike: 2 } }
  });
  assert.equal(storage.data().voteQueue[0].status, 'failed-reverted');
  assert.equal(storage.data().voteQueue[1].status, 'failed');
});

test('Given typed retry and enqueue overlap When both durable queue mutations complete Then neither record is lost', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    voteQueue: [{ id: 'failed-vote', operationId: 'failed-operation', backendProfileId: 'profile-a', status: 'failed', retryCount: 2, error: 'failed' }]
  });
  await Promise.all([
    retryContribution(storage.local, 'failed-operation', 'profile-a'),
    enqueueContribution(storage.local, voteIntent('new-translation'))
  ]);
  assert.equal(storage.data().voteQueue.length, 2);
  assert.deepEqual(storage.data().voteQueue.find((record) => record.id === 'failed-vote'), {
    id: 'failed-vote', operationId: 'failed-operation', backendProfileId: 'profile-a', status: 'pending', retryCount: 0, error: null
  });
  const enqueued = storage.data().voteQueue.find((record) => record.id !== 'failed-vote');
  assert.equal(enqueued.id, enqueued.operationId);
  assert.equal(enqueued.status, 'pending');
});

test('Given two independent queue requests and a delayed first write When both enqueue Then both durable records survive', async () => {
  const storage = createStorage({ backendProfiles: profileStore(), voteQueue: [] }, { holdFirstSet: true });
  const first = enqueueContribution(storage.local, voteIntent('translation-1'));
  await storage.firstSet;
  const second = enqueueContribution(storage.local, voteIntent('translation-2'));
  await new Promise(setImmediate);
  assert.equal(storage.setCalls.length, 1);
  storage.releaseFirstSet();

  await Promise.all([first, second]);
  assert.equal(storage.data().voteQueue.length, 2);
  assert.equal(storage.data().voteQueue.every((record) => record.id === record.operationId), true);
});

test('Given all contribution variants with storage writes pending When enqueued Then every success waits for its durable write', async () => {
  for (const [key, intent] of [
    ['voteQueue', voteIntent()],
    ['translationQueue', translationIntent()],
    ['replacementEventQueue', replacementIntent()]
  ]) {
    const storage = createStorage({ backendProfiles: profileStore(), [key]: [] }, { holdFirstSet: true });
    const queued = enqueueContribution(storage.local, intent);
    await storage.firstSet;
    assert.equal(await Promise.race([queued, Promise.resolve('pending')]), 'pending');
    storage.releaseFirstSet();
    const result = await queued;
    assert.equal(result.operationId, storage.data()[key][0].id);
  }
});

test('Given a malformed current-schema active profile When enqueue is requested Then migration repairs the store and queue persistence is rejected', async () => {
  const storage = createStorage({
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'profile-a',
      byId: { 'profile-a': { id: 'profile-a', endpoint: 'https://user:secret@a.example.test', userId: 'user-a', jwt: null } }
    },
    voteQueue: []
  });

  await assert.rejects(enqueueContribution(storage.local, voteIntent()), /active backend profile/i);
  assert.deepEqual(storage.setCalls.map((call) => Object.keys(call)), [['backendProfiles']]);
  assert.equal(storage.data().voteQueue.length, 0);
});

test('Given the same translation is queued under different profiles When each profile enqueues a vote Then coalescing stays profile-scoped', async () => {
  const storage = createStorage({ backendProfiles: profileStore('profile-a'), voteQueue: [] });
  const first = await enqueueContribution(storage.local, voteIntent());
  storage.data().backendProfiles;
  await storage.local.set({ backendProfiles: profileStore('profile-b') });
  const second = await enqueueContribution(storage.local, voteIntent());

  assert.notEqual(first.operationId, second.operationId);
  assert.deepEqual(storage.data().voteQueue.map((record) => record.backendProfileId).sort(), ['profile-a', 'profile-b']);
});

test('Given an identity-free replacement event When it crosses the queue boundary Then the active profile atomically supplies both persisted identities', async () => {
  const storage = createStorage({ backendProfiles: profileStore(), replacementEventQueue: [] });

  const result = await enqueueContribution(storage.local, replacementIntent());

  assert.equal(result.operationId, storage.data().replacementEventQueue[0].operationId);
  assert.deepEqual(storage.data().replacementEventQueue.map(({ translationID, contributorUserID, occurredAt, backendProfileId, beneficiaryUserID }) => ({
    translationID, contributorUserID, occurredAt, backendProfileId, beneficiaryUserID
  })), [{
    translationID: 'translation-1', contributorUserID: 'contributor-1', occurredAt: '2026-08-01T00:00:00.000Z',
    backendProfileId: 'profile-a', beneficiaryUserID: 'user-a'
  }]);
});

test('Given A is active when a replacement event begins and B becomes active at the queue read When the mutation persists Then both stored identities bind to B and a later switch cannot rewrite them', async () => {
  let switched = false;
  const storage = createStorage({ backendProfiles: profileStore('profile-a'), replacementEventQueue: [] }, {
    async beforeQueueRead({ keys, values }) {
      if (!switched && keys.includes('replacementEventQueue')) {
        switched = true;
        values.backendProfiles = profileStore('profile-b');
      }
    }
  });

  await enqueueContribution(storage.local, replacementIntent());
  await storage.local.set({ backendProfiles: profileStore('profile-a') });

  assert.equal(switched, true);
  assert.deepEqual(storage.data().replacementEventQueue.map(({ backendProfileId, beneficiaryUserID }) => ({ backendProfileId, beneficiaryUserID })), [
    { backendProfileId: 'profile-b', beneficiaryUserID: 'user-b' }
  ]);
});

test('Given replacement intent caller authority or an unavailable profile When enqueue is requested Then the queue receives no write', async () => {
  const storage = createStorage({ backendProfiles: profileStore(), replacementEventQueue: [] });
  for (const authority of [
    { beneficiaryUserID: 'forged-beneficiary' }, { userId: 'forged-user' }, { profile: 'forged-profile' },
    { endpoint: 'https://forged.example.test' }, { jwt: 'forged-jwt' }, { credential: 'forged-credential' }
  ]) {
    await assert.rejects(enqueueContribution(storage.local, replacementIntent(authority)), /invalid contribution intent/i);
  }
  assert.equal(storage.data().replacementEventQueue.length, 0);

  const unavailable = createStorage({
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'profile-a',
      byId: { 'profile-a': { id: 'profile-a', endpoint: 'https://user:secret@a.example.test', userId: 'user-a', jwt: null } }
    },
    replacementEventQueue: []
  });
  await assert.rejects(enqueueContribution(unavailable.local, replacementIntent()), /active backend profile/i);
  assert.equal(unavailable.data().replacementEventQueue.length, 0);
});
