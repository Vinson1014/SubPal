import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { enqueueContribution } from '../background/contribution-queue.js';

async function loadVoteBridge(request) {
  const source = await readFile(new URL('../content/core/vote-bridge.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, window: {}, __request: request });
  const contributionsModule = new vm.SourceTextModule(
    'export const createPageContributions = () => Object.freeze({ enqueue: input => globalThis.__request("enqueue", input), retry: operationId => globalThis.__request("retry", operationId) });',
    { context }
  );
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/core/vote-bridge.js'
  });

  await module.link((specifier) => {
    if (specifier === '../system/capabilities/contributions.js') return contributionsModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.voteBridge;
}

function queueStorage(queue = []) {
  const values = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'profile-a',
      byId: { 'profile-a': { id: 'profile-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null } }
    },
    voteQueue: structuredClone(queue)
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

function legacyVote(voteType) {
  return {
    videoId: 'netflix-81234567',
    timestamp: 12.5,
    voteType,
    originalSubtitle: 'Original subtitle'
  };
}

function resolutionContext(overrides = {}) {
  return {
    taskID: 'candidate:550e8400-e29b-41d4-a716-446655440000',
    targetType: 'candidate-translation',
    action: 'review-candidate',
    slotKey: 'slot-000321',
    timestamp: 321.2,
    ...overrides
  };
}

test('Given legacy upvote and downvote calls When voteBridge serializes them Then each uses the narrow contribution enqueue interface and voteState is omitted', async () => {
  const messages = [];
  const voteBridge = await loadVoteBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: `item-${messages.length}` } };
  });

  await voteBridge.enqueue(legacyVote('upvote'));
  await voteBridge.enqueue(legacyVote('downvote'));

  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.variant, 'enqueue-vote');
    assert.equal(Object.hasOwn(message.payload, 'voteState'), false);
  }
});

test('Given explicit translation vote states When voteBridge serializes them Then like dislike and none are preserved', async () => {
  const messages = [];
  const voteBridge = await loadVoteBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: `item-${messages.length}` } };
  });

  for (const voteState of ['like', 'dislike', 'none']) {
    await voteBridge.enqueue({
      ...legacyVote(voteState === 'dislike' ? 'downvote' : 'upvote'),
      translationID: 'translation-1',
      voteState
    });
  }

  assert.deepEqual(messages.map((message) => message.payload.voteState), ['like', 'dislike', 'none']);
});

test('Given voteState is omitted When the background queue enqueues a legacy vote Then the vote is accepted', async () => {
  const storage = queueStorage();
  const result = await enqueueContribution(storage, { category: 'contribution-intent', variant: 'enqueue-vote', payload: legacyVote('upvote') });

  assert.equal(result.status, 'queued-locally');
  assert.equal(storage.values.voteQueue.length, 1);
  assert.equal(storage.values.voteQueue[0].status, 'pending');
});

test('Given a pending translation vote When a later vote is merged by the background queue Then its item ID and non-null rollback baseline are retained', async () => {
  const pendingVote = {
    id: 'existing-vote-1',
    operationId: 'existing-vote-1',
    backendProfileId: 'profile-a',
    videoId: 'netflix-81234567',
    timestamp: 12.5,
    voteType: 'upvote',
    translationID: 'translation-1',
    voteState: 'like',
    previousVoteState: 'dislike',
    previousCounts: { like: 4, dislike: 2 },
    status: 'pending',
    createdAt: 1,
    updatedAt: 1
  };
  const storage = queueStorage([pendingVote]);

  const result = await enqueueContribution(storage, { category: 'contribution-intent', variant: 'enqueue-vote', payload: {
    ...legacyVote('downvote'),
    translationID: 'translation-1',
    voteState: 'dislike',
    previousVoteState: 'like',
    previousCounts: { like: 5, dislike: 2 }
  }});

  assert.equal(result.operationId, 'existing-vote-1');
  assert.equal(storage.values.voteQueue.length, 1);
  assert.equal(storage.values.voteQueue[0].id, 'existing-vote-1');
  assert.equal(storage.values.voteQueue[0].voteState, 'dislike');
  assert.equal(storage.values.voteQueue[0].previousVoteState, 'dislike');
  assert.deepEqual(storage.values.voteQueue[0].previousCounts, { like: 4, dislike: 2 });
});

test('Given the page contribution client returns a failure When voteBridge enqueues Then the normalized error is wrapped', async () => {
  const voteBridge = await loadVoteBridge(async () => ({ ok: false, error: { kind: 'domain-rejected', code: 'queue-rejected-vote', retryable: false } }));

  await assert.rejects(
    voteBridge.enqueue(legacyVote('upvote')),
    /投票加入隊列失敗: queue-rejected-vote/
  );
});

test('Given a vote operation When voteBridge retries it Then it sends the typed retry intent, returns retryScheduled, and exposes no history or status reads', async () => {
  const messages = [];
  const voteBridge = await loadVoteBridge(async (operation, input) => {
    messages.push({ operation, input });
    return { ok: true, value: { retryScheduled: true, operationId: 'vote-operation-1' } };
  });

  const retried = await voteBridge.retry('vote-operation-1');

  assert.equal(retried, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ operation: 'retry', input: 'vote-operation-1' }]);
  assert.equal(typeof voteBridge.getHistory, 'undefined');
  assert.equal(typeof voteBridge.getStatus, 'undefined');
});

test('Given a normal subtitle hover vote When voteBridge enqueues it Then the legacy payload shape remains unchanged', async () => {
  const messages = [];
  const voteBridge = await loadVoteBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: 'hover-vote-1' } };
  });

  await voteBridge.enqueue({
    ...legacyVote('upvote'),
    translationID: null,
    slotKey: 'slot-000124'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    variant: 'enqueue-vote',
    payload: {
      videoId: 'netflix-81234567',
      timestamp: 12.5,
      voteType: 'upvote',
      translationID: null,
      originalSubtitle: 'Original subtitle',
      slotKey: 'slot-000124',
      previousVoteState: null,
      previousCounts: null
    }
  }]);
});

test('Given a candidate review vote When voteBridge enqueues it Then translationID and exactly five resolutionContext keys reach the queue', async () => {
  const messages = [];
  const voteBridge = await loadVoteBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: 'candidate-vote-1' } };
  });
  const context = resolutionContext();

  await voteBridge.enqueue({
    ...legacyVote('upvote'),
    translationID: '550e8400-e29b-41d4-a716-446655440000',
    voteState: 'like',
    resolutionContext: context
  });

  const payload = JSON.parse(JSON.stringify(messages[0].payload));
  assert.equal(payload.translationID, '550e8400-e29b-41d4-a716-446655440000');
  assert.deepEqual(payload.resolutionContext, context);
  assert.deepEqual(Object.keys(payload.resolutionContext).sort(), [
    'action', 'slotKey', 'targetType', 'taskID', 'timestamp'
  ]);
});
