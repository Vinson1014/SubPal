import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKEND_PROFILE_SCHEMA_VERSION,
  DEFAULT_BACKEND_ENDPOINT,
  DEFAULT_BACKEND_PROFILE_ID,
  activateBackendProfile,
  createBackendProfile,
  deleteBackendProfile,
  ensureBackendProfilesMigrated,
  exportBackendProfileQueue,
  listBackendProfiles,
  normalizeBackendEndpoint,
  resolveBackendProfile,
  setBackendProfileCredentials,
  toBackendProfileSnapshot
} from '../background/backend-profiles.js';
import { loadApiModule } from './crowdsourcing-test-harness.mjs';

const QUEUE_AND_HISTORY_KEYS = [
  'voteQueue',
  'voteHistory',
  'translationQueue',
  'translationHistory',
  'replacementEventQueue',
  'replacementEventHistory'
];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorage(initial = {}) {
  const values = clone(initial);
  const setCalls = [];
  let failNextWrite = false;

  return {
    local: {
      async get(keys) {
        if (keys === undefined || keys === null) return clone(values);
        const requestedKeys = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requestedKeys
            .filter((key) => Object.hasOwn(values, key))
            .map((key) => [key, clone(values[key])])
        );
      },
      async set(items) {
        setCalls.push(clone(items));
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('storage write failed');
        }
        Object.assign(values, clone(items));
      }
    },
    data() {
      return clone(values);
    },
    setCalls,
    failNextWrite() {
      failNextWrite = true;
    }
  };
}

function createWriteBarrierStorage(initial = {}) {
  const values = clone(initial);
  const setCalls = [];
  const firstWriteStarted = deferred();
  const releaseFirstWrite = deferred();
  let holdFirstWrite = true;

  return {
    local: {
      async get(keys) {
        if (keys === undefined || keys === null) return clone(values);
        const requestedKeys = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requestedKeys
            .filter((key) => Object.hasOwn(values, key))
            .map((key) => [key, clone(values[key])])
        );
      },
      async set(items) {
        setCalls.push(clone(items));
        if (holdFirstWrite) {
          holdFirstWrite = false;
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        }
        Object.assign(values, clone(items));
      }
    },
    data() {
      return clone(values);
    },
    setCalls,
    firstWriteStarted: firstWriteStarted.promise,
    releaseFirstWrite() {
      releaseFirstWrite.resolve();
    }
  };
}

function defaultStore(overrides = {}) {
  return {
    schemaVersion: BACKEND_PROFILE_SCHEMA_VERSION,
    activeProfileId: DEFAULT_BACKEND_PROFILE_ID,
    byId: {
      [DEFAULT_BACKEND_PROFILE_ID]: {
        id: DEFAULT_BACKEND_PROFILE_ID,
        endpoint: 'https://profiles.example.test/api',
        userId: 'default-user-1234',
        jwt: 'default-jwt'
      }
    },
    ...overrides
  };
}

function namedProfile(id, jwt = `${id}-jwt`) {
  return {
    id,
    endpoint: `https://${id}.example.test`,
    userId: `${id}-user`,
    jwt
  };
}

function profileStore(activeProfileId = DEFAULT_BACKEND_PROFILE_ID, profiles = {}) {
  return defaultStore({
    activeProfileId,
    byId: {
      ...defaultStore().byId,
      ...profiles
    }
  });
}

let freshModuleSequence = 0;

function loadFreshBackendProfilesModule() {
  const moduleUrl = new URL('../background/backend-profiles.js', import.meta.url);
  return import(`${moduleUrl.href}?worker-restart=${++freshModuleSequence}`);
}

function apiStorage(activeProfileId = DEFAULT_BACKEND_PROFILE_ID) {
  const profiles = defaultStore();
  return {
    backendProfiles: {
      ...profiles,
      activeProfileId,
      byId: {
        ...profiles.byId,
        target: {
          id: 'target',
          endpoint: 'https://target.example.test/v2',
          userId: 'target-user-5678',
          jwt: 'target-jwt'
        }
      }
    }
  };
}

function apiResponse(body) {
  return { ok: true, async json() { return body; } };
}

function unauthorizedResponse() {
  return { ok: false, status: 401, async json() { return { error: 'expired' }; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function assertNoSensitiveData(value) {
  const deniedKeys = new Set([
    'jwt', 'token', 'credential', 'rawTTML', 'originalSubtitle', 'original',
    'translation', 'submissionReason', 'contributorUserID', 'beneficiaryUserID',
    'error', 'arbitraryStorage'
  ]);

  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const isQueueType = key === 'translation' && (Array.isArray(nested) || typeof nested === 'number');
    assert.equal(deniedKeys.has(key) && !isQueueType, false, `export exposed denied field ${key}`);
    assertNoSensitiveData(nested);
  }
}

test('Given endpoint input When normalized Then only safe HTTPS or loopback HTTP endpoints survive', () => {
  assert.equal(normalizeBackendEndpoint(' https://API.example.test:8443/v1/ '), 'https://api.example.test:8443/v1');
  assert.equal(normalizeBackendEndpoint('http://localhost:8787/api/'), 'http://localhost:8787/api');
  assert.equal(normalizeBackendEndpoint('http://127.0.0.1:8787/api/'), 'http://127.0.0.1:8787/api');
  assert.equal(normalizeBackendEndpoint('http://[::1]:8787/api/'), 'http://[::1]:8787/api');

  for (const unsafeEndpoint of [
    '', 'not a url', 'ftp://example.test', 'https://user:secret@example.test',
    'https://example.test/path?token=secret', 'https://example.test/path#fragment',
    'http://example.test', 'http://localhost.evil.test', 'http://[::2]:8787'
  ]) {
    assert.equal(normalizeBackendEndpoint(unsafeEndpoint), null, unsafeEndpoint);
  }
});

test('Given legacy credentials and contribution records When migrated Then default ownership and operation IDs are repaired atomically', async () => {
  const storage = createStorage({
    api: { baseUrl: DEFAULT_BACKEND_ENDPOINT },
    user: { userId: 'legacy-user-1234' },
    jwt: 'legacy-jwt',
    voteQueue: [
      { id: 'vote-unbound', status: 'pending', originalSubtitle: 'secret subtitle' },
      { id: 'vote-bound', status: 'failed', backendProfileId: 'unknown-profile', operationId: '' }
    ],
    voteHistory: [{ id: 'vote-history', status: 'synced' }],
    translationQueue: [{ id: 'translation-unbound', status: 'syncing' }],
    translationHistory: [{ id: 'translation-history', status: 'failed' }],
    replacementEventQueue: [{ id: 'event-unbound', status: 'failed' }],
    replacementEventHistory: [{ id: 'event-history', status: 'synced', operationId: 'preserved-operation' }],
    voteStateByTranslation: {
      unbound: { voteState: 'like' },
      foreign: { backendProfileId: 'unknown-profile', voteState: 'dislike' }
    }
  });

  await ensureBackendProfilesMigrated(storage.local);

  const migrated = storage.data();
  assert.deepEqual(migrated.backendProfiles, {
    schemaVersion: BACKEND_PROFILE_SCHEMA_VERSION,
    activeProfileId: DEFAULT_BACKEND_PROFILE_ID,
    byId: {
      [DEFAULT_BACKEND_PROFILE_ID]: {
        id: DEFAULT_BACKEND_PROFILE_ID,
        endpoint: DEFAULT_BACKEND_ENDPOINT,
        userId: 'legacy-user-1234',
        jwt: 'legacy-jwt'
      }
    }
  });
  assert.equal(storage.setCalls.length, 1);
  assert.deepEqual(Object.keys(storage.setCalls[0]).sort(), [
    'backendProfiles', ...QUEUE_AND_HISTORY_KEYS, 'voteStateByTranslation'
  ].sort());

  for (const key of QUEUE_AND_HISTORY_KEYS) {
    const record = migrated[key].find((entry) => entry.id.endsWith('unbound') || entry.id.endsWith('history'));
    assert.equal(record.backendProfileId, DEFAULT_BACKEND_PROFILE_ID, key);
    if (record.id === 'event-history') {
      assert.equal(record.operationId, 'preserved-operation', key);
    } else {
      assert.equal(record.operationId, record.id, key);
    }
  }
  assert.deepEqual(migrated.voteQueue[1], {
    id: 'vote-bound',
    status: 'failed',
    backendProfileId: 'unknown-profile',
    operationId: 'vote-bound'
  });
  assert.deepEqual(migrated.replacementEventHistory[0], {
    id: 'event-history',
    status: 'synced',
    backendProfileId: DEFAULT_BACKEND_PROFILE_ID,
    operationId: 'preserved-operation'
  });
  assert.deepEqual(migrated.voteStateByTranslation.unbound, {
    backendProfileId: DEFAULT_BACKEND_PROFILE_ID,
    voteState: 'like'
  });
  assert.equal(Object.hasOwn(migrated.voteStateByTranslation.unbound, 'operationId'), false);
  assert.deepEqual(migrated.voteStateByTranslation.foreign, {
    backendProfileId: 'unknown-profile',
    voteState: 'dislike'
  });

  await ensureBackendProfilesMigrated(storage.local);
  assert.equal(storage.setCalls.length, 1, 'a ready migration is idempotent and performs no second write');
});

test('Given valid existing profiles and a stale active ID When migrated Then profiles survive and only the active profile is repaired', async () => {
  const storage = createStorage({
    api: { baseUrl: 'https://legacy.example.test/' },
    user: { userId: 'legacy-user' },
    jwt: 'legacy-jwt',
    backendProfiles: defaultStore({
      schemaVersion: 0,
      activeProfileId: 'missing-profile',
      byId: {
        default: {
          id: 'default',
          endpoint: 'https://existing.example.test/',
          userId: 'existing-user',
          jwt: 'existing-jwt'
        },
        retained: {
          id: 'retained',
          endpoint: 'https://retained.example.test/v2',
          userId: 'retained-user',
          jwt: null
        }
      }
    })
  });

  await ensureBackendProfilesMigrated(storage.local);
  const { backendProfiles } = storage.data();

  assert.equal(backendProfiles.schemaVersion, BACKEND_PROFILE_SCHEMA_VERSION);
  assert.equal(backendProfiles.activeProfileId, DEFAULT_BACKEND_PROFILE_ID);
  assert.deepEqual(backendProfiles.byId.default, {
    id: 'default', endpoint: 'https://existing.example.test', userId: 'existing-user', jwt: 'existing-jwt'
  });
  assert.deepEqual(backendProfiles.byId.retained, {
    id: 'retained', endpoint: 'https://retained.example.test/v2', userId: 'retained-user', jwt: null
  });
});

test('Given an already canonical store When migration is repeated concurrently Then it performs no writes', async () => {
  const storage = createStorage({
    backendProfiles: defaultStore(),
    voteQueue: [{ id: 'vote', operationId: 'vote', backendProfileId: 'default', status: 'pending' }],
    voteHistory: [],
    translationQueue: [],
    translationHistory: [],
    replacementEventQueue: [],
    replacementEventHistory: [],
    voteStateByTranslation: { translation: { backendProfileId: 'default', voteState: 'like' } }
  });

  await Promise.all([
    ensureBackendProfilesMigrated(storage.local),
    ensureBackendProfilesMigrated(storage.local)
  ]);
  await ensureBackendProfilesMigrated(storage.local);

  assert.equal(storage.setCalls.length, 0);
});

test('Given a failed initial migration write When readiness is awaited Then it rejects rather than reporting misleading success', async () => {
  const storage = createStorage({ user: { userId: 'legacy-user' } });
  storage.failNextWrite();

  await assert.rejects(ensureBackendProfilesMigrated(storage.local), /storage write failed/);
  assert.equal(Object.hasOwn(storage.data(), 'backendProfiles'), false);
});

test('Given local profile operations When profiles change Then callers receive safe snapshots and credentials remain internal', async () => {
  const storage = createStorage({ backendProfiles: defaultStore() });

  const before = await listBackendProfiles(storage.local);
  assert.equal(before.length, 1);
  assert.deepEqual(Object.keys(before[0]).sort(), ['endpoint', 'hasJwt', 'id', 'isActive', 'queueCounts', 'userIdMasked'].sort());
  assert.equal(before[0].userIdMasked.includes('default-user-1234'), false);
  assert.equal(Object.hasOwn(before[0], 'maskedUserId'), false);
  assert.equal(Object.hasOwn(before[0], 'counts'), false);
  assert.equal(Object.hasOwn(before[0], 'jwt'), false);

  const created = await createBackendProfile(storage.local, { endpoint: 'http://localhost:8787/v1/' });
  assert.equal(created.endpoint, 'http://localhost:8787/v1');
  assert.notEqual(created.id, DEFAULT_BACKEND_PROFILE_ID);
  assert.equal(created.hasJwt, false);
  assert.equal(Object.hasOwn(created, 'userId'), false);

  const resolved = await resolveBackendProfile(storage.local, created.id);
  assert.match(resolved.id, /^[0-9a-f-]{36}$/i);
  assert.match(resolved.userId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(resolved.id, resolved.userId, 'profile and user IDs must be independently generated');
  assert.equal(resolved.jwt, null);

  const credentialSnapshot = await setBackendProfileCredentials(storage.local, created.id, {
    endpoint: 'https://new.example.test/api/',
    userId: 'created-user-5678',
    jwt: 'created-jwt'
  });
  assert.deepEqual(Object.keys(credentialSnapshot).sort(), ['endpoint', 'hasJwt', 'id', 'isActive', 'queueCounts', 'userIdMasked'].sort());
  assert.equal(credentialSnapshot.endpoint, 'https://new.example.test/api');
  assert.equal(credentialSnapshot.hasJwt, true);
  await assert.rejects(
    setBackendProfileCredentials(storage.local, created.id, { endpoint: 'http://outside.example.test' }),
    /endpoint/i
  );

  const active = await activateBackendProfile(storage.local, created.id);
  assert.equal(active.id, created.id);
  assert.equal(active.isActive, true);
  await assert.rejects(activateBackendProfile(storage.local, 'missing-profile'), /profile/i);

  const directSnapshot = toBackendProfileSnapshot(resolved, created.id, {
    voteQueue: [{ backendProfileId: created.id, status: 'pending' }],
    translationQueue: [{ backendProfileId: created.id, status: 'syncing' }],
    replacementEventQueue: [{ backendProfileId: created.id, status: 'failed' }]
  });
  assert.deepEqual(directSnapshot.queueCounts, {
    pending: { vote: 1, translation: 0, replacementEvent: 0, total: 1 },
    syncing: { vote: 0, translation: 1, replacementEvent: 0, total: 1 },
    failed: { vote: 0, translation: 0, replacementEvent: 1, total: 1 }
  });
});

test('Given invalid create or delete options When profile operations are called Then they reject with stable profile-input errors', async () => {
  const storage = createStorage({
    backendProfiles: defaultStore({
      byId: {
        ...defaultStore().byId,
        target: { id: 'target', endpoint: 'https://target.example.test', userId: 'target-user', jwt: null }
      }
    })
  });

  for (const options of [null, [], 'invalid-options']) {
    await assert.rejects(
      createBackendProfile(storage.local, options),
      (error) => error.message === 'Invalid backend profile input'
    );
    await assert.rejects(
      deleteBackendProfile(storage.local, 'target', options),
      (error) => error.message === 'Invalid backend profile input'
    );
  }
  assert.equal(Object.hasOwn(storage.data().backendProfiles.byId, 'target'), true);
});

test('Given an inactive profile with only synced records When deleted without discard Then all and only its data is removed in one write', async () => {
  const targetRecord = (id) => ({ id, operationId: id, backendProfileId: 'target', status: 'synced' });
  const defaultRecord = (id) => ({ id, operationId: id, backendProfileId: 'default', status: 'synced' });
  const storage = createStorage({
    backendProfiles: defaultStore({
      byId: {
        ...defaultStore().byId,
        target: { id: 'target', endpoint: 'https://target.example.test', userId: 'target-user', jwt: null }
      }
    }),
    voteQueue: [targetRecord('target-vote'), defaultRecord('default-vote')],
    voteHistory: [targetRecord('target-vote-history'), defaultRecord('default-vote-history')],
    translationQueue: [targetRecord('target-translation'), defaultRecord('default-translation')],
    translationHistory: [targetRecord('target-translation-history'), defaultRecord('default-translation-history')],
    replacementEventQueue: [targetRecord('target-event'), defaultRecord('default-event')],
    replacementEventHistory: [targetRecord('target-event-history'), defaultRecord('default-event-history')],
    voteStateByTranslation: {
      target: { backendProfileId: 'target', voteState: 'like' },
      default: { backendProfileId: 'default', voteState: 'dislike' }
    }
  });

  assert.equal(await deleteBackendProfile(storage.local, 'target'), true);
  assert.equal(storage.setCalls.length, 1);
  assert.deepEqual(Object.keys(storage.setCalls[0]).sort(), [
    'backendProfiles', ...QUEUE_AND_HISTORY_KEYS, 'voteStateByTranslation'
  ].sort());

  const deleted = storage.data();
  assert.equal(Object.hasOwn(deleted.backendProfiles.byId, 'target'), false);
  for (const key of QUEUE_AND_HISTORY_KEYS) {
    assert.equal(deleted[key].some((record) => record.backendProfileId === 'target'), false, key);
    assert.equal(deleted[key].length, 1, key);
    assert.equal(deleted[key][0].backendProfileId, 'default', key);
  }
  assert.deepEqual(deleted.voteStateByTranslation, {
    default: { backendProfileId: 'default', voteState: 'dislike' }
  });
});

test('Given an active profile export and deletion request When records include sensitive or foreign data Then export is redacted and discard is profile-scoped', async () => {
  const storage = createStorage({
    backendProfiles: defaultStore({
      byId: {
        ...defaultStore().byId,
        target: { id: 'target', endpoint: 'https://target.example.test', userId: 'target-user', jwt: 'target-jwt' }
      }
    }),
    voteQueue: [
      {
        id: 'target-vote', operationId: 'target-vote', backendProfileId: 'target', status: 'failed',
        videoId: 'video-1', rawTTML: '<tt>secret</tt>', originalSubtitle: 'source', original: 'source',
        translation: 'translated', submissionReason: 'reason', contributorUserID: 'contributor',
        beneficiaryUserID: 'beneficiary', token: 'token', credential: 'credential',
        error: { stack: 'secret' }, arbitraryStorage: 'secret', clientVersion: { token: 'nested-secret' }
      },
      { id: 'default-vote', operationId: 'default-vote', backendProfileId: 'default', status: 'pending' },
      { id: 'foreign-vote', operationId: 'foreign-vote', backendProfileId: 'unknown-profile', status: 'syncing' }
    ],
    voteHistory: [{ id: 'target-vote-history', backendProfileId: 'target', status: 'synced' }, { id: 'default-vote-history', backendProfileId: 'default', status: 'synced' }],
    translationQueue: [{ id: 'target-translation', backendProfileId: 'target', status: 'pending' }, { id: 'default-translation', backendProfileId: 'default', status: 'pending' }],
    translationHistory: [{ id: 'target-translation-history', backendProfileId: 'target', status: 'synced' }, { id: 'default-translation-history', backendProfileId: 'default', status: 'synced' }],
    replacementEventQueue: [{ id: 'target-event', backendProfileId: 'target', status: 'syncing' }, { id: 'default-event', backendProfileId: 'default', status: 'syncing' }],
    replacementEventHistory: [{ id: 'target-event-history', backendProfileId: 'target', status: 'synced' }, { id: 'default-event-history', backendProfileId: 'default', status: 'synced' }],
    voteStateByTranslation: {
      target: { backendProfileId: 'target', voteState: 'like', error: 'secret' },
      default: { backendProfileId: 'default', voteState: 'dislike' },
      foreign: { backendProfileId: 'unknown-profile', voteState: 'like' }
    }
  });

  await activateBackendProfile(storage.local, 'target');
  const exported = await exportBackendProfileQueue(storage.local, 'target');
  assert.deepEqual(Object.keys(exported).sort(), ['histories', 'profile', 'queues', 'voteStateByTranslation'].sort());
  assert.equal(exported.profile.id, 'target');
  assert.deepEqual(exported.queues.vote, [{
    id: 'target-vote', operationId: 'target-vote', backendProfileId: 'target', status: 'failed', videoId: 'video-1'
  }]);
  assert.deepEqual(exported.voteStateByTranslation, {
    target: { backendProfileId: 'target', voteState: 'like' }
  });
  assertNoSensitiveData(exported);
  await assert.rejects(exportBackendProfileQueue(storage.local, DEFAULT_BACKEND_PROFILE_ID), /active profile/i);

  await assert.rejects(deleteBackendProfile(storage.local, 'target'), /active profile/i);
  await activateBackendProfile(storage.local, DEFAULT_BACKEND_PROFILE_ID);
  await assert.rejects(deleteBackendProfile(storage.local, 'target'), /pending|syncing|failed/i);
  assert.equal(await deleteBackendProfile(storage.local, 'target', { discard: true }), true);

  const afterDiscard = storage.data();
  assert.equal(Object.hasOwn(afterDiscard.backendProfiles.byId, 'target'), false);
  for (const key of QUEUE_AND_HISTORY_KEYS) {
    assert.equal(afterDiscard[key].some((record) => record.backendProfileId === 'target'), false, key);
    assert.equal(afterDiscard[key].some((record) => record.backendProfileId === 'default'), true, key);
  }
  assert.deepEqual(afterDiscard.voteStateByTranslation, {
    default: { backendProfileId: 'default', voteState: 'dislike' },
    foreign: { backendProfileId: 'unknown-profile', voteState: 'like' }
  });
});

test('Given eight sequential VM API module loads When coordinator dependencies are linked Then every context evaluates without a process crash', async () => {
  for (let loadCount = 0; loadCount < 8; loadCount += 1) {
    const api = await loadApiModule(async () => apiResponse({}));
    assert.equal(typeof api, 'object');
  }
});

test('Given active and explicit backend profiles When API calls are made Then existing URL body and response shapes use only the resolved profile', async () => {
  const storage = apiStorage();
  const requests = [];
  const api = await loadApiModule(async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://profiles.example.test/api/users/default-user') {
      return apiResponse({ success: true, data: { contributions: 3 } });
    }
    if (url === 'https://target.example.test/v2/users') {
      return apiResponse({ success: true, token: 'target-token' });
    }
    assert.fail(`Unexpected request: ${url}`);
  }, { storage });

  const stats = await api.fetchUserStats('default-user');
  const registration = await api.registerUser('target-user', 'target');

  assert.deepEqual(stats, { success: true, data: { contributions: 3 } });
  assert.deepEqual(registration, { success: true, token: 'target-token' });
  assert.equal(requests[0].url, 'https://profiles.example.test/api/users/default-user');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer default-jwt');
  assert.equal(Object.hasOwn(requests[0].options, 'body'), false);
  assert.equal(requests[1].url, 'https://target.example.test/v2/users');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer target-jwt');
  assert.deepEqual(JSON.parse(requests[1].options.body), { userID: 'target-user' });
  assert.equal(Object.hasOwn(JSON.parse(requests[1].options.body), 'backendProfileId'), false);
  assert.equal(Object.hasOwn(storage, 'jwt'), false);
  assert.equal(Object.hasOwn(storage, 'user'), false);
});

test('Given an explicit profile and stable local IDs When contribution APIs serialize requests Then every URL and JWT stays on that profile while bodies omit operationId and backendProfileId', async () => {
  const requests = [];
  const api = await loadApiModule(async (url, options) => {
    requests.push({ url, options });
    return apiResponse({ success: true, data: { myVote: 'like', upvotes: 2, downvotes: 1 } });
  }, { storage: apiStorage() });

  await api.submitVote({
    videoID: 'video-1', timestamp: 12.5, voteType: 'upvote', translationID: 'translation-1',
    originalSubtitle: 'Original subtitle', backendProfileId: 'target', operationId: 'vote-operation', clientVersion: 'test-client'
  });
  await api.setVoteState({
    translationID: 'translation-1', voteState: 'like', backendProfileId: 'target', operationId: 'vote-state-operation', clientVersion: 'test-client'
  });
  await api.submitTranslation({
    videoId: 'video-1', timestamp: 12.5, original: 'Original subtitle', translation: 'Improved subtitle',
    languageCode: 'zh-TW', backendProfileId: 'target', operationId: 'translation-operation', clientVersion: 'test-client'
  });
  await api.submitReplacementEvents([{
    translationID: 'translation-1', contributorUserID: 'contributor-1', beneficiaryUserID: 'beneficiary-1',
    occurredAt: '2026-07-31T00:00:00.000Z', backendProfileId: 'target', operationId: 'replacement-operation'
  }], true, 'target');

  assert.deepEqual(requests.map(({ url, options }) => [url, options.method, options.headers.Authorization]), [
    ['https://target.example.test/v2/votes', 'POST', 'Bearer target-jwt'],
    ['https://target.example.test/v2/votes/state', 'PUT', 'Bearer target-jwt'],
    ['https://target.example.test/v2/translations', 'POST', 'Bearer target-jwt'],
    ['https://target.example.test/v2/replacement-events', 'POST', 'Bearer target-jwt']
  ]);
  assert.deepEqual(requests.map(({ options }) => JSON.parse(options.body)), [
    { videoID: 'video-1', timestamp: 12.5, voteType: 'upvote', translationID: 'translation-1', originalSubtitle: 'Original subtitle', clientVersion: 'test-client' },
    { translationID: 'translation-1', voteState: 'like', clientVersion: 'test-client' },
    { videoID: 'video-1', timestamp: 12.5, originalSubtitle: 'Original subtitle', suggestedSubtitle: 'Improved subtitle', languageCode: 'zh-TW', submissionReason: '', clientVersion: 'test-client' },
    { events: [{ translationID: 'translation-1', contributorUserID: 'contributor-1', beneficiaryUserID: 'beneficiary-1', occurredAt: '2026-07-31T00:00:00.000Z' }] }
  ]);
  for (const { options } of requests) {
    const body = JSON.parse(options.body);
    assert.equal(JSON.stringify(body).includes('backendProfileId'), false);
    assert.equal(JSON.stringify(body).includes('operationId'), false);
  }
});

test('Given an activation during an in-flight operation When the next operation starts Then only the future operation uses the new active profile', async () => {
  const storage = apiStorage();
  const firstResponse = deferred();
  const requests = [];
  const api = await loadApiModule(async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return await firstResponse.promise;
    return apiResponse({ success: true, data: { source: 'target' } });
  }, { storage });

  const firstOperation = api.fetchUserStats('first-user');
  await waitFor(() => requests.length === 1, 'the first request');
  storage.backendProfiles = { ...storage.backendProfiles, activeProfileId: 'target' };
  firstResponse.resolve(apiResponse({ success: true, data: { source: 'default' } }));

  assert.deepEqual(await firstOperation, { success: true, data: { source: 'default' } });
  assert.deepEqual(await api.fetchUserStats('second-user'), { success: true, data: { source: 'target' } });
  assert.equal(requests[0].url, 'https://profiles.example.test/api/users/first-user');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer default-jwt');
  assert.equal(requests[1].url, 'https://target.example.test/v2/users/second-user');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer target-jwt');
});

test('Given a 401 followed by profile activation When the request refreshes and retries Then endpoint user and JWT remain pinned to the original profile', async () => {
  const storage = apiStorage();
  const storageCalls = [];
  const requests = [];
  const api = await loadApiModule(async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://profiles.example.test/api/users/pinned-user' && options.headers.Authorization === 'Bearer default-jwt') {
      storage.backendProfiles = { ...storage.backendProfiles, activeProfileId: 'target' };
      return unauthorizedResponse();
    }
    if (url === 'https://profiles.example.test/api/users') {
      assert.deepEqual(JSON.parse(options.body), { userID: 'default-user-1234' });
      return apiResponse({ token: 'default-refreshed-jwt' });
    }
    if (url === 'https://profiles.example.test/api/users/pinned-user') {
      return apiResponse({ success: true, data: { retried: true } });
    }
    assert.fail(`Unexpected request: ${url}`);
  }, { storage, storageCalls });

  assert.deepEqual(await api.fetchUserStats('pinned-user'), { success: true, data: { retried: true } });
  assert.deepEqual(requests.map(({ url, options }) => [url, options.headers.Authorization]), [
    ['https://profiles.example.test/api/users/pinned-user', 'Bearer default-jwt'],
    ['https://profiles.example.test/api/users', 'Bearer default-jwt'],
    ['https://profiles.example.test/api/users/pinned-user', 'Bearer default-refreshed-jwt']
  ]);
  assert.equal(storage.backendProfiles.byId.default.jwt, 'default-refreshed-jwt');
  assert.equal(storage.backendProfiles.byId.target.jwt, 'target-jwt');
  assert.deepEqual(storageCalls.filter((call) => call.operation === 'set').map((call) => call.keys), [
    ['storageSchemaVersion', 'storageMigrationState'],
    ['backendProfiles']
  ]);
});

test('Given concurrent 401s for one profile When refresh starts Then only one registration is sent and both retries use its JWT', async () => {
  const storage = apiStorage();
  const refreshResponse = deferred();
  const requests = [];
  const api = await loadApiModule(async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://profiles.example.test/api/users') return await refreshResponse.promise;
    if (options.headers.Authorization === 'Bearer default-jwt') return unauthorizedResponse();
    return apiResponse({ success: true, data: { refreshed: true } });
  }, { storage });

  const first = api.fetchUserStats('first-user');
  const second = api.fetchUserStats('second-user');
  await waitFor(() => requests.filter(({ url }) => url.endsWith('/users')).length === 1, 'the shared profile refresh');
  refreshResponse.resolve(apiResponse({ token: 'shared-refreshed-jwt' }));

  await Promise.all([first, second]);
  assert.equal(requests.filter(({ url }) => url === 'https://profiles.example.test/api/users').length, 1);
  assert.equal(requests.filter(({ options }) => options.headers.Authorization === 'Bearer shared-refreshed-jwt').length, 2);
});

test('Given a completed refresh and externally updated profile credentials When a later operation receives 401 Then it refreshes from the newly pinned JWT', async () => {
  const storage = apiStorage();
  const registrationTokens = ['refreshed-jwt', 'second-refreshed-jwt'];
  const registrationAuthorizations = [];
  const api = await loadApiModule(async (url, options) => {
    const authorization = options.headers.Authorization;
    if (url === 'https://profiles.example.test/api/users') {
      registrationAuthorizations.push(authorization);
      return apiResponse({ token: registrationTokens.shift() });
    }
    if (url === 'https://profiles.example.test/api/users/first-user') {
      if (authorization === 'Bearer default-jwt') return unauthorizedResponse();
      assert.equal(authorization, 'Bearer refreshed-jwt');
      return apiResponse({ success: true, data: { operation: 'first' } });
    }
    if (url === 'https://profiles.example.test/api/users/second-user') {
      if (authorization === 'Bearer externally-updated-jwt') return unauthorizedResponse();
      assert.equal(authorization, 'Bearer second-refreshed-jwt');
      return apiResponse({ success: true, data: { operation: 'second' } });
    }
    assert.fail(`Unexpected request: ${url}`);
  }, { storage });

  assert.deepEqual(await api.fetchUserStats('first-user'), { success: true, data: { operation: 'first' } });
  storage.backendProfiles = {
    ...storage.backendProfiles,
    byId: {
      ...storage.backendProfiles.byId,
      default: { ...storage.backendProfiles.byId.default, jwt: 'externally-updated-jwt' }
    }
  };

  assert.deepEqual(await api.fetchUserStats('second-user'), { success: true, data: { operation: 'second' } });
  assert.deepEqual(registrationAuthorizations, [
    'Bearer default-jwt',
    'Bearer externally-updated-jwt'
  ]);
});

test('Given a cold direct API operation and legacy userID When migrations are held Then no fetch occurs before the default profile preserves that identity', async () => {
  const storage = {
    api: { baseUrl: 'https://legacy.example.test' },
    userID: 'legacy-direct-user'
  };
  const migrationStarted = deferred();
  const migrationRelease = deferred();
  let migrationHeld = false;
  let fetchCalls = 0;
  const storageApi = {
    async get(keys) {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      if (requestedKeys.includes('userID') && !migrationHeld) {
        migrationHeld = true;
        migrationStarted.resolve();
        await migrationRelease.promise;
      }
      return Object.fromEntries(requestedKeys.map((key) => [key, storage[key]]));
    },
    async set(values) { Object.assign(storage, structuredClone(values)); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
    }
  };
  const api = await loadApiModule(async (url, options) => {
    fetchCalls += 1;
    if (url === 'https://legacy.example.test/users/requested-user' && !options.headers.Authorization) return unauthorizedResponse();
    if (url === 'https://legacy.example.test/users') {
      assert.deepEqual(JSON.parse(options.body), { userID: 'legacy-direct-user' });
      return apiResponse({ token: 'legacy-refreshed-jwt' });
    }
    assert.equal(options.headers.Authorization, 'Bearer legacy-refreshed-jwt');
    return apiResponse({ success: true });
  }, { storage, storageApi });

  const operation = api.fetchUserStats('requested-user');
  operation.catch(() => {});
  await new Promise(setImmediate);
  assert.equal(migrationHeld, true);
  assert.equal(fetchCalls, 0);
  migrationRelease.resolve();

  assert.deepEqual(await operation, { success: true });
  assert.equal(storage.backendProfiles.byId.default.userId, 'legacy-direct-user');
  assert.equal(storage.userID, 'legacy-direct-user', 'legacy identity is retained for one rollback-compatible release');
});

test('Given a rejected cold-start migration When a direct API operation starts Then it fails before fetch', async () => {
  let fetchCalls = 0;
  const api = await loadApiModule(async () => {
    fetchCalls += 1;
    assert.fail('Rejected migration must prevent fetch');
  }, {
    storage: { userID: 'legacy-user' },
    storageApi: {
      async get() { throw new Error('migration rejected'); },
      async set() {},
      async remove() {}
    }
  });

  await assert.rejects(api.fetchUserStats('requested-user'), /migration rejected/);
  assert.equal(fetchCalls, 0);
});

test('Given a hostile backend error body When an API operation rejects Then diagnostic logs contain only safe status and code metadata', async () => {
  const secret = 'secret-jwt-token submitted subtitle contribution text';
  const logs = [];
  const api = await loadApiModule(async () => ({
    ok: false,
    status: 422,
    async json() {
      return {
        error: { code: 'HOSTILE_BACKEND_CODE', message: secret },
        token: secret,
        originalSubtitle: secret,
        contribution: secret
      };
    }
  }), { logs, storage: apiStorage() });

  await assert.rejects(api.fetchUserStats('requested-user'), /API request failed with status 422/);
  const diagnosticText = JSON.stringify(logs);
  assert.match(diagnosticText, /422/);
  assert.match(diagnosticText, /HOSTILE_BACKEND_CODE/);
  assert.equal(diagnosticText.includes(secret), false);
});

test('Given simultaneous 401s for separate profiles and a failed refresh When operations continue Then refreshes are independent and only the failed entry is cleared', async () => {
  const storage = apiStorage();
  const defaultRefresh = deferred();
  const registrationCalls = [];
  const api = await loadApiModule(async (url, options) => {
    if (url.endsWith('/users/default-user') && options.headers.Authorization === 'Bearer default-jwt') return unauthorizedResponse();
    if (url.endsWith('/users/target-user') && options.headers.Authorization === 'Bearer target-jwt') return unauthorizedResponse();
    if (url === 'https://profiles.example.test/api/users') {
      registrationCalls.push(url);
      return await defaultRefresh.promise;
    }
    if (url === 'https://target.example.test/v2/users') {
      registrationCalls.push(url);
      return apiResponse({ token: 'target-refreshed-jwt' });
    }
    if (url === 'https://target.example.test/v2/users/target-user') {
      return apiResponse({ success: true, data: { target: true } });
    }
    assert.fail(`Unexpected request: ${url}`);
  }, { storage });

  const failedDefault = api.fetchUserStats('default-user');
  await waitFor(() => registrationCalls.includes('https://profiles.example.test/api/users'), 'the default refresh');
  const refreshedTarget = api.fetchUserStats('target-user', true, 'target');
  assert.deepEqual(await refreshedTarget, { success: true, data: { target: true } });
  assert.deepEqual(registrationCalls.sort(), [
    'https://profiles.example.test/api/users',
    'https://target.example.test/v2/users'
  ]);

  defaultRefresh.resolve(apiResponse({ error: 'refresh rejected' }));
  await assert.rejects(failedDefault, /認證已過期且刷新失敗/);
  await assert.rejects(api.fetchUserStats('default-user'), /認證已過期且刷新失敗/);
  assert.equal(registrationCalls.filter((url) => url === 'https://profiles.example.test/api/users').length, 2);
});

test('Given an unknown explicit backend profile When an API operation starts Then it fails before sending a request', async () => {
  const api = await loadApiModule(async () => {
    assert.fail('Unknown profiles must not reach fetch');
  }, { storage: apiStorage() });

  await assert.rejects(api.fetchUserStats('missing-user', true, 'missing-profile'), /Unknown backend profile: missing-profile/);
});

test('Given activation B and a JWT update for A overlap When the first write is delayed Then both committed effects survive', async () => {
  const storage = createWriteBarrierStorage({
    backendProfiles: profileStore(DEFAULT_BACKEND_PROFILE_ID, { b: namedProfile('b') })
  });

  const activation = activateBackendProfile(storage.local, 'b');
  await storage.firstWriteStarted;
  const credentialUpdate = setBackendProfileCredentials(storage.local, DEFAULT_BACKEND_PROFILE_ID, { jwt: 'updated-a-jwt' });
  await new Promise(setImmediate);
  assert.equal(storage.setCalls.length, 1, 'the second mutation must not read and write a stale store');
  storage.releaseFirstWrite();

  await Promise.all([activation, credentialUpdate]);
  assert.equal(storage.data().backendProfiles.activeProfileId, 'b');
  assert.equal(storage.data().backendProfiles.byId.default.jwt, 'updated-a-jwt');
});

test('Given create C and activate B overlap When the first write is delayed Then C remains and B is active', async () => {
  const storage = createWriteBarrierStorage({
    backendProfiles: profileStore(DEFAULT_BACKEND_PROFILE_ID, { b: namedProfile('b') })
  });

  const activation = activateBackendProfile(storage.local, 'b');
  await storage.firstWriteStarted;
  const creation = createBackendProfile(storage.local, { endpoint: 'https://c.example.test' });
  await new Promise(setImmediate);
  assert.equal(storage.setCalls.length, 1);
  storage.releaseFirstWrite();

  const [, created] = await Promise.all([activation, creation]);
  const committed = storage.data().backendProfiles;
  assert.equal(committed.activeProfileId, 'b');
  assert.equal(Object.hasOwn(committed.byId, created.id), true);
});

test('Given two profile creations overlap When the first write is delayed Then neither new profile disappears', async () => {
  const storage = createWriteBarrierStorage({ backendProfiles: profileStore() });

  const firstCreation = createBackendProfile(storage.local, { endpoint: 'https://first.example.test' });
  await storage.firstWriteStarted;
  const secondCreation = createBackendProfile(storage.local, { endpoint: 'https://second.example.test' });
  await new Promise(setImmediate);
  assert.equal(storage.setCalls.length, 1);
  storage.releaseFirstWrite();

  const [first, second] = await Promise.all([firstCreation, secondCreation]);
  const byId = storage.data().backendProfiles.byId;
  assert.equal(Object.hasOwn(byId, first.id), true);
  assert.equal(Object.hasOwn(byId, second.id), true);
});

test('Given delete T and a credential update for T overlap When deletion commits first Then the update rejects without resurrection', async () => {
  const storage = createWriteBarrierStorage({
    backendProfiles: profileStore(DEFAULT_BACKEND_PROFILE_ID, { t: namedProfile('t') })
  });

  const deletion = deleteBackendProfile(storage.local, 't');
  await storage.firstWriteStarted;
  const credentialUpdate = setBackendProfileCredentials(storage.local, 't', { jwt: 'resurrection-jwt' });
  await new Promise(setImmediate);
  assert.equal(storage.setCalls.length, 1);
  storage.releaseFirstWrite();

  assert.equal(await deletion, true);
  await assert.rejects(credentialUpdate, /Unknown backend profile: t/);
  assert.equal(Object.hasOwn(storage.data().backendProfiles.byId, 't'), false);
});

test('Given activate T and delete T overlap When activation commits first Then deletion rejects against the latest active profile', async () => {
  const storage = createWriteBarrierStorage({
    backendProfiles: profileStore(DEFAULT_BACKEND_PROFILE_ID, { t: namedProfile('t') })
  });

  const activation = activateBackendProfile(storage.local, 't');
  await storage.firstWriteStarted;
  const deletion = deleteBackendProfile(storage.local, 't');
  await new Promise(setImmediate);
  assert.equal(storage.setCalls.length, 1);
  storage.releaseFirstWrite();

  assert.equal((await activation).id, 't');
  await assert.rejects(deletion, /active profile/);
  assert.equal(storage.data().backendProfiles.activeProfileId, 't');
  assert.equal(Object.hasOwn(storage.data().backendProfiles.byId, 't'), true);
});

test('Given deletes for inactive T and U overlap When the first write is delayed Then both profiles are removed', async () => {
  const storage = createWriteBarrierStorage({
    backendProfiles: profileStore(DEFAULT_BACKEND_PROFILE_ID, { t: namedProfile('t'), u: namedProfile('u') })
  });

  const deleteT = deleteBackendProfile(storage.local, 't');
  await storage.firstWriteStarted;
  const deleteU = deleteBackendProfile(storage.local, 'u');
  await new Promise(setImmediate);
  assert.equal(storage.setCalls.length, 1);
  storage.releaseFirstWrite();

  await Promise.all([deleteT, deleteU]);
  const byId = storage.data().backendProfiles.byId;
  assert.equal(Object.hasOwn(byId, 't'), false);
  assert.equal(Object.hasOwn(byId, 'u'), false);
});

test('Given a rejected profile mutation When a later mutation runs Then the coordinator recovers', async () => {
  const storage = createStorage({ backendProfiles: profileStore() });

  await assert.rejects(
    createBackendProfile(storage.local, { endpoint: 'http://outside.example.test' }),
    /Invalid backend endpoint/
  );
  const created = await createBackendProfile(storage.local, { endpoint: 'https://recovered.example.test' });

  assert.equal(Object.hasOwn(storage.data().backendProfiles.byId, created.id), true);
});

test('Given a current-schema store without default and a valid other active profile When migration runs Then it remains canonical without legacy resurrection', async () => {
  const storage = createStorage({
    api: { baseUrl: 'https://legacy-resurrection.example.test' },
    user: { userId: 'legacy-resurrection-user' },
    jwt: 'legacy-resurrection-jwt',
    backendProfiles: {
      schemaVersion: BACKEND_PROFILE_SCHEMA_VERSION,
      activeProfileId: 'other',
      byId: { other: namedProfile('other', 'other-jwt') }
    }
  });

  await ensureBackendProfilesMigrated(storage.local);

  assert.deepEqual(storage.data().backendProfiles, {
    schemaVersion: BACKEND_PROFILE_SCHEMA_VERSION,
    activeProfileId: 'other',
    byId: { other: namedProfile('other', 'other-jwt') }
  });
  assert.equal(storage.setCalls.length, 0, 'the canonical current-schema store is a migration no-op');
});

test('Given an absent or old profile store When migration runs Then it creates default while retaining a valid old active profile', async () => {
  const absentStorage = createStorage({
    api: { baseUrl: 'https://legacy.example.test' },
    user: { userId: 'legacy-user' },
    jwt: 'legacy-jwt'
  });
  const oldStorage = createStorage({
    api: { baseUrl: 'https://legacy.example.test' },
    user: { userId: 'legacy-user' },
    jwt: 'legacy-jwt',
    backendProfiles: {
      schemaVersion: 0,
      activeProfileId: 'other',
      byId: { other: namedProfile('other', 'other-jwt') }
    }
  });

  await Promise.all([
    ensureBackendProfilesMigrated(absentStorage.local),
    ensureBackendProfilesMigrated(oldStorage.local)
  ]);

  assert.deepEqual(absentStorage.data().backendProfiles.byId.default, {
    id: 'default', endpoint: 'https://legacy.example.test', userId: 'legacy-user', jwt: 'legacy-jwt'
  });
  assert.equal(oldStorage.data().backendProfiles.activeProfileId, 'other');
  assert.deepEqual(oldStorage.data().backendProfiles.byId.default, {
    id: 'default', endpoint: 'https://legacy.example.test', userId: 'legacy-user', jwt: 'legacy-jwt'
  });
});

test('Given an inactive default is deleted When a fresh worker migrates retained legacy keys Then default and its bound data stay deleted', async () => {
  const defaultRecord = (id) => ({ id, operationId: id, backendProfileId: 'default', status: 'synced' });
  const storage = createStorage({
    api: { baseUrl: 'https://legacy-resurrection.example.test' },
    user: { userId: 'legacy-resurrection-user' },
    jwt: 'legacy-resurrection-jwt',
    backendProfiles: profileStore('other', { other: namedProfile('other', 'other-jwt') }),
    voteQueue: [defaultRecord('default-vote')],
    voteHistory: [defaultRecord('default-vote-history')],
    translationQueue: [defaultRecord('default-translation')],
    translationHistory: [defaultRecord('default-translation-history')],
    replacementEventQueue: [defaultRecord('default-event')],
    replacementEventHistory: [defaultRecord('default-event-history')],
    voteStateByTranslation: { default: { backendProfileId: 'default', voteState: 'like' } }
  });

  assert.equal(await deleteBackendProfile(storage.local, DEFAULT_BACKEND_PROFILE_ID), true);
  const freshModule = await loadFreshBackendProfilesModule();
  await freshModule.ensureBackendProfilesMigrated(storage.local);

  const restarted = storage.data();
  assert.equal(restarted.backendProfiles.activeProfileId, 'other');
  assert.equal(Object.hasOwn(restarted.backendProfiles.byId, DEFAULT_BACKEND_PROFILE_ID), false);
  assert.equal(restarted.backendProfiles.byId.other.jwt, 'other-jwt');
  for (const key of QUEUE_AND_HISTORY_KEYS) {
    assert.equal(restarted[key].some((record) => record.backendProfileId === DEFAULT_BACKEND_PROFILE_ID), false, key);
  }
  assert.deepEqual(restarted.voteStateByTranslation, {});
  assert.equal(storage.setCalls.length, 1, 'the fresh worker must not rewrite a deleted default profile');
});
