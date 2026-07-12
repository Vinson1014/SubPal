import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadVoteBridge(sendMessage) {
  const source = await readFile(new URL('../content/core/vote-bridge.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, __sendMessage: sendMessage });
  const messagingModule = new vm.SourceTextModule(
    'export const sendMessage = globalThis.__sendMessage;',
    { context }
  );
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/core/vote-bridge.js'
  });

  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messagingModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.voteBridge;
}

async function loadSubmissionQueueManager({ queue = [], uuid = 'vote-item-1' } = {}) {
  const source = await readFile(
    new URL('../content/core/submission-queue-manager.js', import.meta.url),
    'utf8'
  );
  const context = vm.createContext({ console, __uuid: uuid });
  const storageModule = new vm.SourceTextModule(
    `export class StorageAdapter {
      async initialize() {}
      async getQueue() { return []; }
      async getHistory() { return []; }
    }
    export const generateUUID = () => globalThis.__uuid;`,
    { context }
  );
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/core/submission-queue-manager.js'
  });

  await module.link((specifier) => {
    if (specifier === '../system/config/storage-adapter.js') return storageModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();

  const storedQueue = structuredClone(queue);
  const storage = {
    async getQueue(type) {
      assert.equal(type, 'vote');
      return storedQueue;
    },
    async appendToQueue(type, item) {
      assert.equal(type, 'vote');
      storedQueue.push(structuredClone(item));
    },
    async set(value) {
      assert.deepEqual(Object.keys(value), ['voteQueue']);
      storedQueue.splice(0, storedQueue.length, ...structuredClone(value.voteQueue));
    }
  };
  const manager = new module.namespace.SubmissionQueueManager({ storage });
  return { manager, storedQueue };
}

function legacyVote(voteType) {
  return {
    videoId: 'netflix-81234567',
    timestamp: 12.5,
    voteType,
    originalSubtitle: 'Original subtitle'
  };
}

test('Given legacy upvote and downvote calls When voteBridge serializes them Then voteState is omitted', async () => {
  const messages = [];
  const voteBridge = await loadVoteBridge(async (message) => {
    messages.push(message);
    return { itemId: `item-${messages.length}` };
  });

  await voteBridge.enqueue(legacyVote('upvote'));
  await voteBridge.enqueue(legacyVote('downvote'));

  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.type, 'VOTE_ENQUEUE');
    assert.equal(Object.hasOwn(message.payload, 'voteState'), false);
  }
});

test('Given explicit translation vote states When voteBridge serializes them Then like dislike and none are preserved', async () => {
  const messages = [];
  const voteBridge = await loadVoteBridge(async (message) => {
    messages.push(message);
    return { itemId: `item-${messages.length}` };
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

test('Given voteState is omitted When SubmissionQueueManager enqueues a legacy vote Then the vote is accepted', async () => {
  const { manager, storedQueue } = await loadSubmissionQueueManager();

  const result = await manager.enqueueVote(legacyVote('upvote'));

  assert.equal(result.itemId, 'vote-item-1');
  assert.equal(storedQueue.length, 1);
  assert.equal(storedQueue[0].status, 'pending');
});

test('Given a pending translation vote When a later vote is merged Then its item ID and non-null rollback baseline are retained', async () => {
  const pendingVote = {
    id: 'existing-vote-1',
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
  const { manager, storedQueue } = await loadSubmissionQueueManager({ queue: [pendingVote] });

  const result = await manager.enqueueVote({
    ...legacyVote('downvote'),
    translationID: 'translation-1',
    voteState: 'dislike',
    previousVoteState: 'like',
    previousCounts: { like: 5, dislike: 2 }
  });

  assert.equal(result.itemId, 'existing-vote-1');
  assert.equal(storedQueue.length, 1);
  assert.equal(storedQueue[0].id, 'existing-vote-1');
  assert.equal(storedQueue[0].voteState, 'dislike');
  assert.equal(storedQueue[0].previousVoteState, 'dislike');
  assert.deepEqual(storedQueue[0].previousCounts, { like: 4, dislike: 2 });
});

test('Given sendMessage returns an error When voteBridge enqueues Then the response error is wrapped', async () => {
  const voteBridge = await loadVoteBridge(async () => ({ error: 'queue rejected vote' }));

  await assert.rejects(
    voteBridge.enqueue(legacyVote('upvote')),
    /投票加入隊列失敗: queue rejected vote/
  );
});
