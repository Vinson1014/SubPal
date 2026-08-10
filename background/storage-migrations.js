import {
  BACKEND_PROFILE_MIGRATION_KEYS,
  buildBackendProfileMigration,
  normalizeBackendEndpoint
} from './backend-profiles.js';
import { runStorageMutation } from './storage-mutation-coordinator.js';

export const STORAGE_SCHEMA_VERSION = 1;
const STORAGE_SCHEMA_VERSION_KEY = 'storageSchemaVersion';
const STORAGE_MIGRATION_STATE_KEY = 'storageMigrationState';
const STORAGE_MIGRATION_KEYS = [
  STORAGE_SCHEMA_VERSION_KEY,
  STORAGE_MIGRATION_STATE_KEY,
  ...BACKEND_PROFILE_MIGRATION_KEYS
];

const migrationReadiness = new WeakMap();

function getStorage(storage) {
  const local = storage || globalThis.chrome?.storage?.local;
  if (!local?.get || !local?.set) throw new Error('Chrome local storage is unavailable');
  return local;
}

function readyState(malformedRecordCount) {
  return {
    status: 'ready',
    targetVersion: STORAGE_SCHEMA_VERSION,
    malformedRecordCount
  };
}

function needsAttentionState() {
  return {
    status: 'needs-attention',
    targetVersion: STORAGE_SCHEMA_VERSION,
    reason: 'unsupported-legacy-endpoint'
  };
}

function publicMigrationState(data) {
  if (data?.[STORAGE_SCHEMA_VERSION_KEY] === STORAGE_SCHEMA_VERSION) {
    const count = data?.[STORAGE_MIGRATION_STATE_KEY]?.malformedRecordCount;
    return readyState(Number.isInteger(count) && count >= 0 ? count : 0);
  }
  if (data?.[STORAGE_MIGRATION_STATE_KEY]?.status === 'needs-attention') return needsAttentionState();
  return { status: 'pending', targetVersion: STORAGE_SCHEMA_VERSION };
}

async function commitMigration(local, endpointOverride) {
  return await runStorageMutation(local, async () => {
    const data = await local.get(STORAGE_MIGRATION_KEYS);
    if (data[STORAGE_SCHEMA_VERSION_KEY] === STORAGE_SCHEMA_VERSION) {
      const { updates, malformedRecordCount } = buildBackendProfileMigration(data);
      const state = readyState(malformedRecordCount);
      if (JSON.stringify(data[STORAGE_MIGRATION_STATE_KEY]) !== JSON.stringify(state)) {
        updates[STORAGE_MIGRATION_STATE_KEY] = state;
      }
      if (Object.keys(updates).length > 0) await local.set(updates);
      return state;
    }

    let migration;
    try {
      migration = buildBackendProfileMigration(data, { endpointOverride });
    } catch (error) {
      if (error?.code !== 'unsupported-legacy-endpoint') throw error;
      const state = needsAttentionState();
      await local.set({ [STORAGE_MIGRATION_STATE_KEY]: state });
      throw error;
    }

    const state = readyState(migration.malformedRecordCount);
    await local.set({
      ...migration.updates,
      [STORAGE_SCHEMA_VERSION_KEY]: STORAGE_SCHEMA_VERSION,
      [STORAGE_MIGRATION_STATE_KEY]: state
    });
    return state;
  });
}

export async function getStorageMigrationStatus(storage) {
  const local = getStorage(storage);
  return publicMigrationState(await local.get([STORAGE_SCHEMA_VERSION_KEY, STORAGE_MIGRATION_STATE_KEY]));
}

export async function resolveStorageMigrationEndpoint(storage, endpoint) {
  const local = getStorage(storage);
  const normalizedEndpoint = normalizeBackendEndpoint(endpoint);
  if (!normalizedEndpoint) throw new Error('Invalid backend endpoint');
  const state = await getStorageMigrationStatus(local);
  if (state.status !== 'needs-attention' || state.reason !== 'unsupported-legacy-endpoint') {
    throw new Error('Storage migration does not require endpoint recovery');
  }
  const result = await commitMigration(local, normalizedEndpoint);
  migrationReadiness.delete(local);
  return result;
}

export function reconcileStorageMigrations(storage) {
  return commitMigration(getStorage(storage));
}

export function ensureStorageMigrationsComplete(storage) {
  const local = getStorage(storage);
  const existing = migrationReadiness.get(local);
  if (existing) return existing;
  const readiness = commitMigration(local);
  migrationReadiness.set(local, readiness);
  return readiness.catch((error) => {
    if (migrationReadiness.get(local) === readiness) migrationReadiness.delete(local);
    throw error;
  });
}
