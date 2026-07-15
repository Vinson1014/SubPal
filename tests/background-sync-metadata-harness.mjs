import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const contextWithExtraKey = {
  taskID: 'candidate:550e8400-e29b-41d4-a716-446655440000',
  targetType: 'candidate-translation',
  action: 'review-candidate',
  slotKey: 'slot-000321',
  timestamp: 321.2,
  staleKey: 'drop-me'
};

const exactContextKeys = ['action', 'slotKey', 'targetType', 'taskID', 'timestamp'];

export async function loadSync() {
  const source = await readFile(new URL('../background/sync.js', import.meta.url), 'utf8');
  const state = {
    voteQueue: [],
    voteHistory: [],
    translationQueue: [],
    translationHistory: [],
    replacementEventQueue: [],
    replacementEventHistory: [],
    voteStateByTranslation: {}
  };
  const apiCalls = [];
  const context = vm.createContext({
    console,
    Date,
    setTimeout,
    clearTimeout,
    chrome: {
      alarms: { create() {}, onAlarm: { addListener() {} } },
      runtime: { onStartup: { addListener() {} } },
      storage: {
        local: {
          async get(keys) {
            const requestedKeys = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requestedKeys.map((key) => [
              key,
              JSON.parse(JSON.stringify(state[key]))
            ]));
          },
          async set(values) {
            for (const [key, value] of Object.entries(values)) {
              state[key] = JSON.parse(JSON.stringify(value));
            }
          }
        }
      }
    }
  });
  const apiModule = new vm.SyntheticModule([
    'isPermanentError',
    'setVoteState',
    'submitReplacementEvents',
    'submitTranslation',
    'submitVote'
  ], function initializeApi() {
    this.setExport('isPermanentError', () => false);
    this.setExport('setVoteState', async (payload) => {
      apiCalls.push({ kind: 'setVoteState', payload });
      return { myVote: payload.voteState, upvotes: 3, downvotes: 1 };
    });
    this.setExport('submitReplacementEvents', async () => ({ success: true }));
    this.setExport('submitTranslation', async (payload) => {
      apiCalls.push({ kind: 'submitTranslation', payload });
      return { success: true };
    });
    this.setExport('submitVote', async (payload) => {
      apiCalls.push({ kind: 'submitVote', payload });
      return { success: true };
    });
  }, { context, identifier: 'background/api.js' });
  const module = new vm.SourceTextModule(source, { context, identifier: 'background/sync.js' });
  await module.link((specifier) => {
    if (specifier === './api.js') return apiModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { module, state, apiCalls };
}

export function assertExactContext(context) {
  assert.deepEqual(Object.keys(context).sort(), exactContextKeys);
  assert.deepEqual(context, {
    taskID: contextWithExtraKey.taskID,
    targetType: contextWithExtraKey.targetType,
    action: contextWithExtraKey.action,
    slotKey: contextWithExtraKey.slotKey,
    timestamp: contextWithExtraKey.timestamp
  });
}
