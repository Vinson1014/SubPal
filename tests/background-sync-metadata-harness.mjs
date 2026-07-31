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
  const migration = options.migration ?? Promise.resolve();
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
  const apiProfileIds = [];
  const alarmCalls = [];
  const storageCalls = [];
  const resolvedProfileIds = [];
  const onAlarm = { listener: null };
  const onStartup = { listener: null };
  let migrationCalls = 0;
  let storageMigrationCalls = 0;
  const ensureBackendProfilesMigrated = async () => {
    migrationCalls += 1;
    await migration;
  };
  const ensureStorageMigrationsComplete = async () => {
    storageMigrationCalls += 1;
    await migration;
  };
  const submitReplacementEvents = options.submitReplacementEvents ?? (async () => ({ success: true }));
  const submitVote = options.submitVote ?? (async () => ({ success: true }));
  const setVoteState = options.setVoteState ?? (async (payload) => ({ myVote: payload.voteState, upvotes: 3, downvotes: 1 }));
  const recordApiProfile = (profileId) => {
    if (options.captureActiveProfile) {
      apiProfileIds.push(profileId);
    }
  };
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
            storageCalls.push({ operation: 'get', keys: requestedKeys });
            options.beforeStorageGet?.({ keys: requestedKeys, state });
            const result = Object.fromEntries(requestedKeys.map((key) => [
              key,
              state[key] === undefined ? undefined : JSON.parse(JSON.stringify(state[key]))
            ]));
            await options.afterStorageGet?.({ keys: requestedKeys, state, result });
            return result;
          },
          async set(values) {
            storageCalls.push({ operation: 'set', keys: Object.keys(values) });
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
    this.setExport('isPermanentError', (error) => options.isPermanentError?.(error) ?? false);
    this.setExport('setVoteState', async (payload) => {
      recordApiProfile(payload.backendProfileId);
      apiCalls.push({ kind: 'setVoteState', payload });
      return await setVoteState(payload);
    });
    this.setExport('submitReplacementEvents', async (payload, _autoRetryOn401, backendProfileId) => {
      recordApiProfile(backendProfileId);
      apiCalls.push({ kind: 'submitReplacementEvents', payload, backendProfileId });
      return await submitReplacementEvents(payload, _autoRetryOn401, backendProfileId);
    });
    this.setExport('submitTranslation', async (payload) => {
      recordApiProfile(payload.backendProfileId);
      apiCalls.push({ kind: 'submitTranslation', payload });
      return { success: true };
    });
    this.setExport('submitVote', async (payload) => {
      recordApiProfile(payload.backendProfileId);
      apiCalls.push({ kind: 'submitVote', payload });
      return await submitVote(payload);
    });
  }, { context, identifier: 'background/api.js' });
  const profilesModule = new vm.SyntheticModule([
    'ensureBackendProfilesMigrated',
    'resolveBackendProfile'
  ], function initializeProfiles() {
    this.setExport('ensureBackendProfilesMigrated', ensureBackendProfilesMigrated);
    this.setExport('resolveBackendProfile', async (profileId) => {
      await ensureBackendProfilesMigrated();
      const store = state.backendProfiles;
      const id = profileId ?? store?.activeProfileId ?? 'default';
      resolvedProfileIds.push(id);
      return JSON.parse(JSON.stringify(store?.byId?.[id] ?? { id }));
    });
  }, { context, identifier: 'background/backend-profiles.js' });
  const storageMigrationsModule = new vm.SyntheticModule(['ensureStorageMigrationsComplete'], function initializeStorageMigrations() {
    this.setExport('ensureStorageMigrationsComplete', ensureStorageMigrationsComplete);
  }, { context, identifier: 'background/storage-migrations.js' });
  const mutationChains = new WeakMap();
  const storageMutationModule = new vm.SyntheticModule(['runStorageMutation'], function initializeStorageMutation() {
    this.setExport('runStorageMutation', (storage, operation) => {
      const previous = mutationChains.get(storage) || Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      mutationChains.set(storage, current);
      return current;
    });
  }, { context, identifier: 'background/storage-mutation-coordinator.js' });
  const module = new vm.SourceTextModule(source, { context, identifier: 'background/sync.js' });
  await module.link((specifier) => {
    if (specifier === './api.js') return apiModule;
    if (specifier === './backend-profiles.js') return profilesModule;
    if (specifier === './storage-migrations.js') return storageMigrationsModule;
    if (specifier === './storage-mutation-coordinator.js') return storageMutationModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    module,
    state,
    apiCalls,
    apiProfileIds,
    resolvedProfileIds,
    alarmCalls,
    get migrationCalls() { return migrationCalls; },
    get storageMigrationCalls() { return storageMigrationCalls; },
    storageCalls,
    storage: context.chrome.storage.local,
    startupRegistered: onStartup.listener !== null,
    triggerAlarm: async (alarm) => await onAlarm.listener(alarm)
  };
}

export async function loadSyncListener(state, options = {}) {
  const source = await readFile(new URL('../background/sync-listener.js', import.meta.url), 'utf8');
  const migration = options.migration ?? Promise.resolve();
  const syncCalls = [];
  const syncProfileIds = [];
  const storageCalls = [];
  const resolvedProfileIds = [];
  const onChanged = { listener: null };
  const onStartup = { listener: null };
  let migrationCalls = 0;
  let storageMigrationCalls = 0;
  const recordSyncProfile = (profileId) => {
    if (options.captureActiveProfile) {
      syncProfileIds.push(profileId);
    }
  };
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
        local: {
          async get(key) {
            storageCalls.push({ operation: 'get', keys: [key] });
            return { [key]: state[key] };
          }
        },
        onChanged: { addListener(listener) { onChanged.listener = listener; } }
      }
    }
  });
  const syncModule = new vm.SyntheticModule([
    'triggerVoteSync',
    'triggerTranslationSync',
    'triggerReplacementEventSync'
  ], function initializeSyncModule() {
    this.setExport('triggerVoteSync', async (profileId) => { recordSyncProfile(profileId); syncCalls.push('vote'); });
    this.setExport('triggerTranslationSync', async (profileId) => { recordSyncProfile(profileId); syncCalls.push('translation'); });
    this.setExport('triggerReplacementEventSync', async (profileId) => { recordSyncProfile(profileId); syncCalls.push('replacement-event'); });
  }, { context, identifier: 'background/sync.js' });
  const profilesModule = new vm.SyntheticModule(['ensureBackendProfilesMigrated', 'resolveBackendProfile'], function initializeProfiles() {
    this.setExport('ensureBackendProfilesMigrated', async () => {
      migrationCalls += 1;
      await migration;
    });
    this.setExport('resolveBackendProfile', async () => {
      await migration;
      const id = state.backendProfiles?.activeProfileId ?? 'default';
      resolvedProfileIds.push(id);
      return JSON.parse(JSON.stringify(state.backendProfiles?.byId?.[id] ?? { id }));
    });
  }, { context, identifier: 'background/backend-profiles.js' });
  const storageMigrationsModule = new vm.SyntheticModule(['ensureStorageMigrationsComplete'], function initializeStorageMigrations() {
    this.setExport('ensureStorageMigrationsComplete', async () => {
      storageMigrationCalls += 1;
      await migration;
    });
  }, { context, identifier: 'background/storage-migrations.js' });
  const mutationChains = new WeakMap();
  const storageMutationModule = new vm.SyntheticModule(['runStorageMutation'], function initializeStorageMutation() {
    this.setExport('runStorageMutation', (storage, operation) => {
      const previous = mutationChains.get(storage) || Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      mutationChains.set(storage, current);
      return current;
    });
  }, { context, identifier: 'background/storage-mutation-coordinator.js' });
  const module = new vm.SourceTextModule(source, { context, identifier: 'background/sync-listener.js' });
  await module.link((specifier) => {
    if (specifier === './sync.js') return syncModule;
    if (specifier === './backend-profiles.js') return profilesModule;
    if (specifier === './storage-migrations.js') return storageMigrationsModule;
    if (specifier === './storage-mutation-coordinator.js') return storageMutationModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await new Promise(setImmediate);
  return {
    module,
    syncCalls,
    syncProfileIds,
    resolvedProfileIds,
    get migrationCalls() { return migrationCalls; },
    get storageMigrationCalls() { return storageMigrationCalls; },
    storageCalls,
    storageListenerRegistered: onChanged.listener !== null,
    startupRegistered: onStartup.listener !== null,
    triggerStorageChange(changes, area = 'local') { onChanged.listener(changes, area); },
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
