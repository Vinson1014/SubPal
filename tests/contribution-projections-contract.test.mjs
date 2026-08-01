import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  enqueueContribution,
  getContributionProjection,
  retryContribution,
  retryFailedContributions
} from '../background/contribution-queue.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function profileStore(activeProfileId = 'profile-a') {
  return {
    schemaVersion: 1,
    activeProfileId,
    byId: {
      'profile-a': { id: 'profile-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: 'jwt-a' },
      'profile-b': { id: 'profile-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: 'jwt-b' }
    }
  };
}

function createStorage(initial, { holdFirstSet = false } = {}) {
  const values = clone(initial);
  const setCalls = [];
  const firstSet = deferred();
  const releaseFirstSet = deferred();

  return {
    local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
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
    data: () => clone(values),
    firstSet: firstSet.promise,
    releaseFirstSet: () => releaseFirstSet.resolve(),
    setCalls
  };
}

function createRawStorage(initial) {
  const setCalls = [];
  return {
    local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.map((key) => [key, initial[key]]));
      },
      async set(updates) {
        setCalls.push(updates);
        Object.assign(initial, updates);
      }
    },
    setCalls
  };
}

function failedRecord(id, backendProfileId = 'profile-a', extra = {}) {
  return {
    id,
    operationId: `operation-${id}`,
    backendProfileId,
    status: 'failed',
    retryCount: 3,
    error: 'failed',
    errorMetadata: { isPermanent: false, diagnostic: 'do-not-leak' },
    syncStartedAt: 123,
    payload: 'preserve-me',
    ...extra
  };
}

function voteIntent(translationID) {
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

function projection(variant, payload) {
  return { variant, payload };
}

test('Given an active vote authority and permanent failure When projected concurrently Then output is minimized and one failure is consumed', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    voteStateByTranslation: {
      'translation-a': {
        backendProfileId: 'profile-a', myVote: 'like', upvotes: 4, downvotes: 1,
        endpoint: 'https://a.example.test', jwt: 'jwt-a', updatedAt: 1
      },
      'translation-b': {
        backendProfileId: 'profile-b', myVote: 'dislike', upvotes: 99, downvotes: 99, jwt: 'jwt-b'
      }
    },
    voteQueue: [
      failedRecord('permanent-a', 'profile-a', {
        translationID: 'translation-a', errorMetadata: { isPermanent: true, diagnostic: 'private' },
        previousVoteState: 'none', previousCounts: { like: 2, dislike: 3 }
      }),
      failedRecord('permanent-b', 'profile-a', {
        translationID: 'translation-a', errorMetadata: { isPermanent: true },
        previousVoteState: 'like', previousCounts: { like: 4, dislike: 3 }
      }),
      { ...failedRecord('foreign', 'profile-b'), translationID: 'translation-a', status: 'pending' }
    ]
  });

  const read = projection('vote-authority', { translationID: 'translation-a' });
  const [first, second] = await Promise.all([
    getContributionProjection(storage.local, read),
    getContributionProjection(storage.local, read)
  ]);

  assert.deepEqual(first, {
    authority: { myVote: 'like', upvotes: 4, downvotes: 1 },
    hasPendingVote: false,
    permanentFailure: { previousVoteState: 'none', previousCounts: { like: 2, dislike: 3 } }
  });
  assert.deepEqual(second, {
    authority: { myVote: 'like', upvotes: 4, downvotes: 1 },
    hasPendingVote: false,
    permanentFailure: { previousVoteState: 'like', previousCounts: { like: 4, dislike: 3 } }
  });
  assert.deepEqual(storage.data().voteQueue.map((record) => record.status), ['failed-reverted', 'failed-reverted', 'pending']);
  assert.deepEqual(Object.keys(first.authority), ['myVote', 'upvotes', 'downvotes']);

  assert.deepEqual(await getContributionProjection(storage.local, projection('vote-authority', { translationID: 'translation-b' })),
    { authority: null, hasPendingVote: false, permanentFailure: null });
  await storage.local.set({ voteStateByTranslation: {
    ...storage.data().voteStateByTranslation,
    'translation-none': { backendProfileId: 'profile-a', myVote: 'none', upvotes: 1, downvotes: 0 }
  } });
  assert.deepEqual(await getContributionProjection(storage.local, projection('vote-authority', { translationID: 'translation-none' })),
    { authority: { myVote: null, upvotes: 1, downvotes: 0 }, hasPendingVote: false, permanentFailure: null });
});

test('Given hostile active-profile failed votes When vote authority is projected Then invalid permanent failures do not throw leak or mutate', async () => {
  const secret = 'private-error-metadata-must-not-leak';
  const cases = [
    ['missing metadata', (record) => { delete record.errorMetadata; }],
    ['null metadata', (record) => { record.errorMetadata = null; }],
    ['primitive metadata', (record) => { record.errorMetadata = secret; }],
    ['accessor metadata', (record) => {
      Object.defineProperty(record, 'errorMetadata', { enumerable: true, get() { throw new Error(secret); } });
    }],
    ['Proxy metadata', (record) => {
      record.errorMetadata = new Proxy({ isPermanent: true }, {
        getOwnPropertyDescriptor() { throw new Error(secret); }
      });
    }],
    ['malformed previous state', (record) => {
      record.errorMetadata = { isPermanent: true };
      record.previousVoteState = secret;
    }],
    ['missing previous count', (record) => {
      record.errorMetadata = { isPermanent: true };
      record.previousCounts = { like: 2 };
    }],
    ['negative previous count', (record) => {
      record.errorMetadata = { isPermanent: true };
      record.previousCounts = { like: -1, dislike: 3 };
    }]
  ];

  const outcomes = await Promise.all(cases.map(async ([name, configure], index) => {
    const failed = failedRecord(`hostile-${index}`, 'profile-a', {
      translationID: 'translation-a', previousVoteState: 'none', previousCounts: { like: 2, dislike: 3 }
    });
    configure(failed);
    const storage = createRawStorage({
      backendProfiles: profileStore(),
      voteStateByTranslation: {
        'translation-a': { backendProfileId: 'profile-a', myVote: 'like', upvotes: 4, downvotes: 1 }
      },
      voteQueue: [
        failed,
        { ...failedRecord(`pending-${index}`), translationID: 'translation-a', status: 'pending' }
      ]
    });
    try {
      const value = await getContributionProjection(storage.local, projection('vote-authority', { translationID: 'translation-a' }));
      return { name, value, writes: storage.setCalls.length, failedStatus: failed.status };
    } catch (error) {
      return { name, threw: error instanceof Error ? error.message : String(error), writes: storage.setCalls.length, failedStatus: failed.status };
    }
  }));

  assert.deepEqual(outcomes, cases.map(([name]) => ({
    name,
    value: {
      authority: { myVote: 'like', upvotes: 4, downvotes: 1 },
      hasPendingVote: true,
      permanentFailure: null
    },
    writes: 0,
    failedStatus: 'failed'
  })));
  assert.equal(JSON.stringify(outcomes).includes(secret), false);
});

test('Given unapproved projection shapes When read Then flat, inherited, accessor, symbol, extra, and authority fields are rejected', async () => {
  const storage = createStorage({ backendProfiles: profileStore(), voteQueue: [] });
  const inherited = Object.create({ variant: 'vote-authority' });
  inherited.payload = { translationID: 'translation-a' };
  const accessor = { variant: 'vote-authority' };
  Object.defineProperty(accessor, 'payload', { enumerable: true, get: () => ({ translationID: 'translation-a' }) });
  const symbol = projection('vote-authority', { translationID: 'translation-a' });
  symbol[Symbol('private')] = true;

  for (const input of [
    { projection: 'vote-authority', translationID: 'translation-a' },
    inherited,
    accessor,
    symbol,
    { variant: 'vote-authority', payload: { translationID: 'translation-a' }, extra: true },
    { variant: 'vote-authority', payload: { translationID: 'translation-a', jwt: 'jwt-a' } },
    projection('vote-authority', { translationID: '' })
  ]) {
    await assert.rejects(getContributionProjection(storage.local, input), /Invalid contribution projection/);
  }
});

test('Given profile-scoped queue and history records When translation reconciliation is projected Then queue wins and request order is preserved', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    translationQueue: [
      { id: 'queue-a', operationId: 'operation-a', backendProfileId: 'profile-a', status: 'failed', syncedAt: null, jwt: 'jwt-a' },
      { id: 'foreign', operationId: 'operation-b', backendProfileId: 'profile-b', status: 'pending', syncedAt: null },
      { id: 'malformed-status', operationId: 'operation-malformed-status', backendProfileId: 'profile-a', status: 'synced', syncedAt: 5 },
      { id: 'malformed-time', operationId: 'operation-malformed-time', backendProfileId: 'profile-a', status: 'pending', syncedAt: 'not-a-time' }
    ],
    translationHistory: [
      { id: 'history-a', operationId: 'operation-a', backendProfileId: 'profile-a', status: 'completed', syncedAt: 10, errorMetadata: { terminal: true } },
      { id: 'history-c', operationId: 'operation-c', backendProfileId: 'profile-a', status: 'completed', syncedAt: 20, errorMetadata: { terminal: true, diagnostic: 'private' } },
      { id: 'foreign-history', operationId: 'operation-d', backendProfileId: 'profile-b', status: 'completed', syncedAt: 30 }
    ]
  });

  const reconciled = await getContributionProjection(storage.local, projection('translation-reconciliation', {
    operationIds: ['operation-c', 'operation-a', 'operation-b', 'operation-d', 'operation-malformed-status', 'operation-malformed-time', 'unknown']
  }));
  assert.deepEqual(reconciled, [
    { operationId: 'operation-c', status: 'completed', syncedAt: 20, terminal: true },
    { operationId: 'operation-a', status: 'failed', syncedAt: null, terminal: false }
  ]);
  assert.deepEqual(reconciled.map((record) => Object.keys(record)), [
    ['operationId', 'status', 'syncedAt', 'terminal'],
    ['operationId', 'status', 'syncedAt', 'terminal']
  ]);
  assert.equal(storage.setCalls.length, 0);
  await assert.rejects(getContributionProjection(storage.local, projection('translation-reconciliation', { operationIds: ['operation-a', 'operation-a'] })), /Invalid contribution projection/);
  await assert.rejects(getContributionProjection(storage.local, projection('translation-reconciliation', {
    operationIds: Array.from({ length: 101 }, (_, index) => `operation-${index}`)
  })), /Invalid contribution projection/);
});

test('Given stored id and operationId disagree When reconciliation is requested Then only request-authorized canonical IDs are projected', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    translationQueue: [
      { id: 'local-id', operationId: 'foreign-operation', backendProfileId: 'profile-a', status: 'pending', syncedAt: null },
      { id: 'legacy-operation', backendProfileId: 'profile-a', status: 'failed', syncedAt: null }
    ],
    translationHistory: []
  });

  assert.deepEqual(await getContributionProjection(storage.local, projection('translation-reconciliation', {
    operationIds: ['local-id', 'foreign-operation', 'legacy-operation']
  })), [
    { operationId: 'foreign-operation', status: 'pending', syncedAt: null, terminal: false },
    { operationId: 'legacy-operation', status: 'failed', syncedAt: null, terminal: false }
  ]);
});

test('Given an authorized failed record When individually retried Then it preserves its binding and idempotent states do not write', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    voteQueue: [
      failedRecord('vote-a'),
      { ...failedRecord('vote-pending'), status: 'pending', retryCount: 1, error: null }
    ],
    translationQueue: [failedRecord('foreign-translation', 'profile-b')],
    replacementEventQueue: []
  });

  assert.equal(await retryContribution(storage.local, 'operation-vote-a', 'profile-a'), true);
  assert.deepEqual(storage.data().voteQueue[0], {
    id: 'vote-a', operationId: 'operation-vote-a', backendProfileId: 'profile-a', status: 'pending', retryCount: 0,
    error: null, payload: 'preserve-me'
  });
  const writesAfterFailedRetry = storage.setCalls.length;
  assert.equal(await retryContribution(storage.local, 'operation-vote-pending', 'profile-a'), true);
  assert.equal(storage.setCalls.length, writesAfterFailedRetry);

  const beforeFailures = storage.data();
  await assert.rejects(retryContribution(storage.local, 'operation-foreign-translation', 'profile-a'), /not found|authorized/i);
  await assert.rejects(retryContribution(storage.local, 'operation-missing', 'profile-a'), /not found|authorized/i);
  assert.deepEqual(storage.data(), beforeFailures);
});

test('Given duplicate operation records across queues When individually retried Then the ambiguity fails without writes', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    voteQueue: [failedRecord('vote-a', 'profile-a', { operationId: 'shared-operation' })],
    translationQueue: [failedRecord('translation-a', 'profile-a', { operationId: 'shared-operation' })],
    replacementEventQueue: []
  });

  await assert.rejects(retryContribution(storage.local, 'shared-operation', 'profile-a'), /not found|ambiguous/i);
  assert.equal(storage.setCalls.length, 0);
});

test('Given an inactive canonical selected profile When bulk retry is handler-authorized Then only its records are scheduled', async () => {
  const storage = createStorage({
    backendProfiles: profileStore('profile-a'),
    voteQueue: [failedRecord('active-vote'), failedRecord('inactive-vote', 'profile-b')],
    translationQueue: [failedRecord('inactive-translation', 'profile-b')],
    replacementEventQueue: [failedRecord('active-event')]
  });

  assert.deepEqual(await retryFailedContributions(storage.local, 'profile-b'), { vote: 1, translation: 1, replacementEvent: 0 });
  assert.equal(storage.data().voteQueue.find((record) => record.id === 'inactive-vote').status, 'pending');
  assert.equal(storage.data().translationQueue[0].status, 'pending');
  assert.equal(storage.data().voteQueue.find((record) => record.id === 'active-vote').status, 'failed');
  assert.equal(storage.data().replacementEventQueue[0].status, 'failed');
});

test('Given failed records across all queues When bulk retry overlaps enqueue Then authorized failures schedule without losing new work', async () => {
  const storage = createStorage({
    backendProfiles: profileStore(),
    voteQueue: [failedRecord('vote-a'), failedRecord('vote-b', 'profile-b')],
    translationQueue: [failedRecord('translation-a'), { ...failedRecord('translation-pending'), status: 'pending', error: null }],
    replacementEventQueue: [failedRecord('event-a'), failedRecord('event-b', 'profile-b')]
  }, { holdFirstSet: true });

  const retry = retryFailedContributions(storage.local, 'profile-a');
  await storage.firstSet;
  const enqueue = enqueueContribution(storage.local, voteIntent('translation-new'));
  storage.releaseFirstSet();

  assert.deepEqual(await retry, { vote: 1, translation: 1, replacementEvent: 1 });
  await enqueue;
  const data = storage.data();
  assert.equal(data.voteQueue.find((record) => record.id === 'vote-a').status, 'pending');
  assert.equal(data.translationQueue.find((record) => record.id === 'translation-a').status, 'pending');
  assert.equal(data.replacementEventQueue.find((record) => record.id === 'event-a').status, 'pending');
  assert.equal(data.voteQueue.find((record) => record.id === 'vote-b').status, 'failed');
  assert.equal(data.replacementEventQueue.find((record) => record.id === 'event-b').status, 'failed');
  assert.equal(data.voteQueue.some((record) => record.translationID === 'translation-new'), true);
  assert.equal(data.voteQueue.find((record) => record.id === 'vote-a').backendProfileId, 'profile-a');
});
