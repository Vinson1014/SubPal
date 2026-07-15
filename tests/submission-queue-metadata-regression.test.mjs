import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadSubmissionQueueManager() {
  const source = await readFile(new URL('../content/core/submission-queue-manager.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, __uuid: 'merged-vote-1' });
  const storageModule = new vm.SourceTextModule(`
    export class StorageAdapter {
      async initialize() {}
      async getQueue() { return []; }
      async getHistory() { return []; }
    }
    export const generateUUID = () => globalThis.__uuid;
  `, { context });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/core/submission-queue-manager.js'
  });

  await module.link((specifier) => {
    if (specifier === '../system/config/storage-adapter.js') return storageModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();

  const storedQueue = [];
  const storage = {
    async getQueue(type) {
      assert.equal(type, 'vote');
      return structuredClone(storedQueue);
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
  return {
    manager: new module.namespace.SubmissionQueueManager({ storage }),
    storedQueue
  };
}

const taskContext = {
  taskID: 'candidate:translation-1',
  targetType: 'candidate-translation',
  action: 'review-candidate',
  slotKey: 'slot-000321',
  timestamp: 321.2
};

test('Given a pending task vote When a context-free hover vote coalesces for the same translation Then task-only metadata is removed', async () => {
  const { manager, storedQueue } = await loadSubmissionQueueManager();

  await manager.enqueueVote({
    videoId: 'netflix-81234567',
    timestamp: 321.2,
    voteType: 'upvote',
    translationID: 'translation-1',
    originalSubtitle: 'Candidate subtitle',
    slotKey: 'slot-000321',
    voteState: 'like',
    resolutionContext: taskContext
  });
  await manager.enqueueVote({
    videoId: 'netflix-81234567',
    timestamp: 321.2,
    voteType: 'downvote',
    translationID: 'translation-1',
    originalSubtitle: 'Candidate subtitle',
    slotKey: 'slot-000321'
  });

  const serializedItem = JSON.parse(JSON.stringify(storedQueue[0]));
  assert.equal(storedQueue.length, 1);
  assert.equal(serializedItem.id, 'merged-vote-1');
  assert.equal(serializedItem.translationID, 'translation-1');
  assert.equal(serializedItem.slotKey, 'slot-000321');
  assert.equal(Object.hasOwn(serializedItem, 'resolutionContext'), false);
  assert.equal(Object.hasOwn(serializedItem, 'voteState'), false);
  assert.equal(Object.hasOwn(storedQueue[0], 'resolutionContext'), false);
  assert.equal(Object.hasOwn(storedQueue[0], 'voteState'), false);
});
