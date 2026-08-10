import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STORAGE_SCHEMA_VERSION,
  ensureStorageMigrationsComplete,
  getStorageMigrationStatus,
  reconcileStorageMigrations,
  resolveStorageMigrationEndpoint
} from '../background/storage-migrations.js';

function clone(value) {
  return structuredClone(value);
}

function createStorage(initial = {}) {
  const state = clone(initial);
  const setCalls = [];
  let failNextSet = false;
  const local = {
    async get(keys) {
      if (keys === null || keys === undefined) return clone(state);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested.filter((key) => Object.hasOwn(state, key)).map((key) => [key, clone(state[key])])
      );
    },
    async set(items) {
      if (failNextSet) {
        failNextSet = false;
        throw new Error('storage write failed');
      }
      setCalls.push(clone(items));
      Object.assign(state, clone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  };
  return {
    local,
    data: () => clone(state),
    setCalls,
    failNextSet: () => { failNextSet = true; }
  };
}

function legacyRecord(id, status) {
  return {
    id,
    videoId: '81234567',
    status,
    createdAt: 123,
    retryCount: status === 'failed' ? 3 : 0,
    error: status === 'failed' ? 'legacy failure' : null
  };
}

function full041Fixture(endpoint = 'https://legacy.example.test/api/') {
  return {
    api: { baseUrl: endpoint },
    user: { userId: 'legacy-user-1234' },
    jwt: 'legacy-jwt',
    debugMode: true,
    isEnabled: false,
    crowdsourcing: { endscreenTasksEnabled: false },
    subtitle: { primaryLanguage: 'en', dualModeEnabled: true },
    video: { currentVideoId: '81234567' },
    voteQueue: [legacyRecord('vote-pending', 'pending')],
    voteHistory: [legacyRecord('vote-completed', 'completed')],
    translationQueue: [legacyRecord('translation-syncing', 'syncing')],
    translationHistory: [legacyRecord('translation-failed', 'failed')],
    replacementEventQueue: [legacyRecord('replacement-pending', 'pending')],
    replacementEventHistory: [legacyRecord('replacement-completed', 'completed')],
    voteStateByTranslation: {
      translation: { voteState: 'like', updatedAt: 456 }
    },
    unrelatedRoot: { preserved: true }
  };
}

test('Given a complete 0.4.1 storage snapshot When schema v1 migration runs Then identity, settings, payloads, and legacy recovery roots are preserved', async () => {
  const fixture = full041Fixture();
  const storage = createStorage(fixture);

  const result = await ensureStorageMigrationsComplete(storage.local);
  const migrated = storage.data();

  assert.deepEqual(result, { status: 'ready', targetVersion: STORAGE_SCHEMA_VERSION, malformedRecordCount: 0 });
  assert.equal(storage.setCalls.length, 1);
  assert.equal(migrated.storageSchemaVersion, STORAGE_SCHEMA_VERSION);
  assert.deepEqual(migrated.backendProfiles, {
    schemaVersion: 1,
    activeProfileId: 'default',
    byId: {
      default: {
        id: 'default',
        endpoint: 'https://legacy.example.test/api',
        userId: 'legacy-user-1234',
        jwt: 'legacy-jwt'
      }
    }
  });
  for (const key of [
    'voteQueue', 'voteHistory', 'translationQueue', 'translationHistory',
    'replacementEventQueue', 'replacementEventHistory'
  ]) {
    assert.equal(migrated[key][0].backendProfileId, 'default', key);
    assert.equal(migrated[key][0].operationId, migrated[key][0].id, key);
    for (const [field, value] of Object.entries(fixture[key][0])) assert.deepEqual(migrated[key][0][field], value, `${key}.${field}`);
  }
  assert.deepEqual(migrated.voteStateByTranslation.translation, {
    voteState: 'like', updatedAt: 456, backendProfileId: 'default'
  });
  for (const key of ['api', 'user', 'jwt', 'video', 'debugMode', 'isEnabled', 'crowdsourcing', 'subtitle', 'unrelatedRoot']) {
    assert.deepEqual(migrated[key], fixture[key], key);
  }

  await ensureStorageMigrationsComplete(storage.local);
  assert.equal(storage.setCalls.length, 1);
});

test('Given an unsafe 0.4.1 endpoint When migration starts Then it fails closed until Options confirms a safe replacement', async () => {
  const fixture = full041Fixture('http://legacy.internal.test/api');
  const storage = createStorage(fixture);

  await assert.rejects(ensureStorageMigrationsComplete(storage.local), (error) => error?.code === 'unsupported-legacy-endpoint');
  const blocked = storage.data();
  assert.equal(Object.hasOwn(blocked, 'backendProfiles'), false);
  assert.equal(Object.hasOwn(blocked, 'storageSchemaVersion'), false);
  assert.deepEqual(blocked.voteQueue, fixture.voteQueue);
  assert.deepEqual(await getStorageMigrationStatus(storage.local), {
    status: 'needs-attention', targetVersion: STORAGE_SCHEMA_VERSION, reason: 'unsupported-legacy-endpoint'
  });

  await assert.rejects(resolveStorageMigrationEndpoint(storage.local, 'http://still-unsafe.example.test'), /Invalid backend endpoint/);
  const recovered = await resolveStorageMigrationEndpoint(storage.local, 'https://legacy.internal.test/api/');
  assert.deepEqual(recovered, { status: 'ready', targetVersion: STORAGE_SCHEMA_VERSION, malformedRecordCount: 0 });
  assert.equal(storage.data().backendProfiles.byId.default.endpoint, 'https://legacy.internal.test/api');
  assert.equal(storage.data().backendProfiles.byId.default.jwt, 'legacy-jwt');
  assert.equal(storage.data().voteQueue[0].backendProfileId, 'default');
});

test('Given a transient migration write failure When readiness is retried Then no false marker remains and the second attempt succeeds', async () => {
  const storage = createStorage(full041Fixture());
  storage.failNextSet();

  await assert.rejects(ensureStorageMigrationsComplete(storage.local), /storage write failed/);
  assert.equal(Object.hasOwn(storage.data(), 'storageSchemaVersion'), false);

  await ensureStorageMigrationsComplete(storage.local);
  assert.equal(storage.data().storageSchemaVersion, STORAGE_SCHEMA_VERSION);
});

test('Given a late unbound queue record after schema v1 When reconciliation runs Then it is repaired without touching unrelated records', async () => {
  const storage = createStorage(full041Fixture());
  await ensureStorageMigrationsComplete(storage.local);
  const current = storage.data();
  await storage.local.set({
    voteQueue: [...current.voteQueue, { id: 'late-vote', status: 'pending', operationId: '' }]
  });

  await reconcileStorageMigrations(storage.local);

  const late = storage.data().voteQueue.find((record) => record.id === 'late-vote');
  assert.deepEqual(late, {
    id: 'late-vote', status: 'pending', operationId: 'late-vote', backendProfileId: 'default'
  });
});

test('Given malformed legacy records When migration runs Then they are retained, counted, and never rebound for synchronization', async () => {
  const fixture = full041Fixture();
  fixture.voteQueue.push(null, { status: 'pending', secret: 'preserved' });
  const storage = createStorage(fixture);

  const result = await ensureStorageMigrationsComplete(storage.local);

  assert.equal(result.malformedRecordCount, 2);
  assert.deepEqual(storage.data().voteQueue.slice(-2), [null, { status: 'pending', secret: 'preserved' }]);
});
