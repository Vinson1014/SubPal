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

export async function loadSync(options = {}) {
  const source = await readFile(new URL('../background/sync.js', import.meta.url), 'utf8');
  const state = {
    voteQueue: [],
    voteHistory: [],
    translationQueue: [],
    translationHistory: [],
    replacementEventQueue: [],
    replacementEventHistory: [],
    voteStateByTranslation: {},
    ...options.state
  };
  const apiCalls = [];
  const alarmCalls = [];
  const onAlarm = { listener: null };
  const onStartup = { listener: null };
  const context = vm.createContext({
    console,
    Date,
    setTimeout,
    clearTimeout,
    chrome: {
      alarms: {
        create(name, alarmInfo) { alarmCalls.push({ name, alarmInfo }); },
        onAlarm: { addListener(listener) { onAlarm.listener = listener; } }
      },
      runtime: { onStartup: { addListener(listener) { onStartup.listener = listener; } } },
      storage: {
        local: {
          async get(keys) {
            if (options.rejectGet?.(keys)) {
              throw new Error('sync storage rejected');
            }
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
    this.setExport('submitReplacementEvents', async (payload) => {
      apiCalls.push({ kind: 'submitReplacementEvents', payload });
      return { success: true };
    });
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
  return {
    module,
    state,
    apiCalls,
    alarmCalls,
    triggerAlarm: (alarm) => onAlarm.listener(alarm),
    startup: () => onStartup.listener()
  };
}

export async function loadSyncListener(state) {
  const source = await readFile(new URL('../background/sync-listener.js', import.meta.url), 'utf8');
  const syncCalls = [];
  const onChanged = { listener: null };
  const onStartup = { listener: null };
  let timerId = 0;
  const context = vm.createContext({
    clearTimeout() {},
    console,
    setTimeout(callback) {
      callback();
      timerId += 1;
      return timerId;
    },
    chrome: {
      runtime: { onStartup: { addListener(listener) { onStartup.listener = listener; } } },
      storage: {
        local: { async get(key) { return { [key]: state[key] }; } },
        onChanged: { addListener(listener) { onChanged.listener = listener; } }
      }
    }
  });
  const syncModule = new vm.SyntheticModule([
    'triggerVoteSync',
    'triggerTranslationSync',
    'triggerReplacementEventSync'
  ], function initializeSyncModule() {
    this.setExport('triggerVoteSync', async () => { syncCalls.push('vote'); });
    this.setExport('triggerTranslationSync', async () => { syncCalls.push('translation'); });
    this.setExport('triggerReplacementEventSync', async () => { syncCalls.push('replacement-event'); });
  }, { context, identifier: 'background/sync.js' });
  const module = new vm.SourceTextModule(source, { context, identifier: 'background/sync-listener.js' });
  await module.link((specifier) => {
    if (specifier === './sync.js') return syncModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await new Promise(setImmediate);
  return {
    module,
    syncCalls,
    triggerStorageChange(changes, area = 'local') { onChanged.listener(changes, area); },
    startup() { onStartup.listener(); }
  };
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
