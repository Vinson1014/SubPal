import { ensureBackendProfilesMigrated } from './backend-profiles.js';

const migrationReadiness = new WeakMap();

function getStorage(storage) {
  const local = storage || globalThis.chrome?.storage?.local;
  if (!local?.get || !local?.set || !local?.remove) throw new Error('Chrome local storage is unavailable');
  return local;
}

export async function migrateOldConfigKeys(storage) {
  const local = getStorage(storage);
  const migrations = [
    { oldKey: 'userID', newKey: 'user', newSubKey: 'userId' },
    { oldKey: 'currentVideoId', newKey: 'video', newSubKey: 'currentVideoId' }
  ];
  const oldData = await local.get(migrations.map(({ oldKey }) => oldKey));
  const keysToRemove = [];

  for (const { oldKey, newKey, newSubKey } of migrations) {
    const oldValue = oldData[oldKey];
    if (!oldValue) continue;
    const { [newKey]: existing = {} } = await local.get([newKey]);
    if (!existing[newSubKey]) await local.set({ [newKey]: { ...existing, [newSubKey]: oldValue } });
    keysToRemove.push(oldKey);
  }

  if (keysToRemove.length > 0) await local.remove(keysToRemove);
}

export function ensureStorageMigrationsComplete(storage) {
  const local = getStorage(storage);
  const existing = migrationReadiness.get(local);
  if (existing) return existing;
  const readiness = (async () => {
    await migrateOldConfigKeys(local);
    await ensureBackendProfilesMigrated(local);
  })();
  migrationReadiness.set(local, readiness);
  return readiness;
}
