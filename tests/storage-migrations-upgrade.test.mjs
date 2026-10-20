import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_BACKEND_ENDPOINT,
  RETIRED_BACKEND_ENDPOINT
} from '../background/backend-profiles.js';
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

test('Given a schema v1 store on the retired host When readiness runs Then it upgrades to schema v2 without changing identity or queue bindings', async () => {
  const storage = createStorage({
    storageSchemaVersion: 1,
    storageMigrationState: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 },
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'default',
      byId: {
        default: {
          id: 'default',
          endpoint: RETIRED_BACKEND_ENDPOINT,
          userId: 'existing-user',
          jwt: 'old-jwt'
        }
      }
    },
    voteQueue: [{ id: 'vote', operationId: 'vote', backendProfileId: 'default', status: 'pending' }]
  });

  const result = await ensureStorageMigrationsComplete(storage.local);
  const migrated = storage.data();

  assert.deepEqual(result, { status: 'ready', targetVersion: STORAGE_SCHEMA_VERSION, malformedRecordCount: 0 });
  assert.equal(STORAGE_SCHEMA_VERSION, 2);
  assert.equal(migrated.storageSchemaVersion, 2);
  assert.deepEqual(migrated.backendProfiles.byId.default, {
    id: 'default', endpoint: DEFAULT_BACKEND_ENDPOINT, userId: 'existing-user', jwt: null
  });
  assert.deepEqual(migrated.voteQueue, [
    { id: 'vote', operationId: 'vote', backendProfileId: 'default', status: 'pending' }
  ]);
  assert.equal(storage.setCalls.length, 1);

  await reconcileStorageMigrations(storage.local);
  assert.equal(storage.setCalls.length, 1, 'schema v2 reconciliation is a no-op');
});

test('Given a 0.4.1 snapshot on the retired host When schema v2 migration runs Then the default profile moves and the legacy JWT is cleared', async () => {
  const storage = createStorage(full041Fixture(`${RETIRED_BACKEND_ENDPOINT}/`));

  const result = await ensureStorageMigrationsComplete(storage.local);
  const migrated = storage.data();

  assert.deepEqual(result, { status: 'ready', targetVersion: STORAGE_SCHEMA_VERSION, malformedRecordCount: 0 });
  assert.deepEqual(migrated.backendProfiles.byId.default, {
    id: 'default', endpoint: DEFAULT_BACKEND_ENDPOINT, userId: 'legacy-user-1234', jwt: null
  });
  assert.equal(migrated.voteQueue[0].backendProfileId, 'default');
  assert.deepEqual(migrated.api, { baseUrl: `${RETIRED_BACKEND_ENDPOINT}/` });
  assert.deepEqual(migrated.user, { userId: 'legacy-user-1234' });
  assert.equal(migrated.jwt, 'legacy-jwt');
});

test('Given a fresh installation When readiness runs Then it uses the new official endpoint directly', async () => {
  const storage = createStorage();

  await ensureStorageMigrationsComplete(storage.local);

  const profile = storage.data().backendProfiles.byId.default;
  assert.equal(DEFAULT_BACKEND_ENDPOINT, 'https://api.subpal.dev');
  assert.equal(profile.endpoint, 'https://api.subpal.dev');
  assert.ok(profile.userId);
  assert.equal(profile.jwt, null);
  assert.equal(storage.setCalls.length, 1);
});

for (const version of [1, 2]) {
  test(`Given schema v${version} with multiple profiles and bound contributions When reconciled Then only retired endpoints and their JWTs change`, async () => {
    const fixture = {
      storageSchemaVersion: version,
      storageMigrationState: { status: 'ready', targetVersion: version, malformedRecordCount: 0 },
      backendProfiles: {
        schemaVersion: 1,
        activeProfileId: 'custom',
        byId: {
          default: { id: 'default', endpoint: RETIRED_BACKEND_ENDPOINT, userId: 'default-user', jwt: 'old-default-jwt' },
          custom: { id: 'custom', endpoint: `  ${RETIRED_BACKEND_ENDPOINT.toUpperCase()}:443///  `, userId: 'custom-user', jwt: 'old-custom-jwt' },
          manual: { id: 'manual', endpoint: DEFAULT_BACKEND_ENDPOINT, userId: 'manual-user', jwt: 'manual-jwt' },
          other: { id: 'other', endpoint: 'https://other.example.test', userId: 'other-user', jwt: 'other-jwt' }
        }
      },
      voteStateByTranslation: {
        translation: { voteState: 'like', updatedAt: 456, backendProfileId: 'custom' }
      }
    };
    for (const key of [
      'voteQueue', 'voteHistory', 'translationQueue', 'translationHistory',
      'replacementEventQueue', 'replacementEventHistory'
    ]) {
      fixture[key] = ['default', 'custom', 'manual', 'other'].map((profileId) => ({
        ...legacyRecord(`${key}-${profileId}`, key.endsWith('Queue') ? 'pending' : 'completed'),
        operationId: `${key}-${profileId}`,
        backendProfileId: profileId
      }));
    }
    const storage = createStorage(fixture);

    await reconcileStorageMigrations(storage.local);

    const expected = clone(fixture);
    expected.storageSchemaVersion = 2;
    expected.storageMigrationState.targetVersion = 2;
    for (const id of ['default', 'custom']) {
      expected.backendProfiles.byId[id].endpoint = 'https://api.subpal.dev';
      expected.backendProfiles.byId[id].jwt = null;
    }
    assert.deepEqual(storage.data(), expected);
    assert.equal(storage.setCalls.length, 1);
    assert.deepEqual(storage.setCalls[0].backendProfiles, expected.backendProfiles);

    // 新 token 寫入後，重跑 migration 不得再次清空。
    expected.backendProfiles.byId.custom.jwt = 'new-backend-jwt';
    await storage.local.set({ backendProfiles: expected.backendProfiles });
    await reconcileStorageMigrations(storage.local);
    assert.deepEqual(storage.data(), expected);
    assert.equal(storage.setCalls.length, 2, 'reconciliation does not rewrite a migrated profile');
  });
}

test('Given a retired endpoint and a failed v2 migration write When readiness retries Then endpoint JWT and schema change together', async () => {
  const fixture = {
    storageSchemaVersion: 1,
    storageMigrationState: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 },
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'default',
      byId: {
        default: { id: 'default', endpoint: RETIRED_BACKEND_ENDPOINT, userId: 'existing-user', jwt: 'old-jwt' }
      }
    }
  };
  const storage = createStorage(fixture);
  storage.failNextSet();

  await assert.rejects(ensureStorageMigrationsComplete(storage.local), /storage write failed/);
  assert.deepEqual(storage.data(), fixture);

  await ensureStorageMigrationsComplete(storage.local);
  assert.equal(storage.setCalls.length, 1);
  assert.equal(storage.setCalls[0].storageSchemaVersion, 2);
  assert.deepEqual(storage.setCalls[0].backendProfiles.byId.default, {
    id: 'default', endpoint: 'https://api.subpal.dev', userId: 'existing-user', jwt: null
  });
});
