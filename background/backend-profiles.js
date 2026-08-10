import { runStorageMutation } from './storage-mutation-coordinator.js';

export const DEFAULT_BACKEND_PROFILE_ID = 'default';
export const DEFAULT_BACKEND_ENDPOINT = 'https://subnfbackend.zeabur.app';
export const BACKEND_PROFILE_SCHEMA_VERSION = 1;

const PROFILE_STORE_KEY = 'backendProfiles';
const QUEUE_KEYS = {
  vote: 'voteQueue',
  translation: 'translationQueue',
  replacementEvent: 'replacementEventQueue'
};
const HISTORY_KEYS = {
  vote: 'voteHistory',
  translation: 'translationHistory',
  replacementEvent: 'replacementEventHistory'
};
const CONTRIBUTION_KEYS = [
  ...Object.values(QUEUE_KEYS),
  ...Object.values(HISTORY_KEYS)
];
export const BACKEND_PROFILE_MIGRATION_KEYS = [
  PROFILE_STORE_KEY, 'api', 'user', 'userID', 'jwt', ...CONTRIBUTION_KEYS, 'voteStateByTranslation'
];
const EXPORT_RECORD_FIELDS = [
  'id', 'operationId', 'backendProfileId', 'status', 'videoId', 'timestamp',
  'createdAt', 'updatedAt', 'syncedAt', 'attempts', 'retryCount', 'lastAttemptAt',
  'translationID', 'voteType', 'eventType', 'language', 'sourceLanguage',
  'targetLanguage', 'clientVersion'
];
const migrationReadiness = new WeakMap();

function getStorage(storage) {
  const local = storage || globalThis.chrome?.storage?.local;
  if (!local?.get || !local?.set) throw new Error('Chrome local storage is unavailable');
  return local;
}

function assertProfileOptions(options) {
  if (!isRecord(options)) throw new Error('Invalid backend profile input');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function clone(value) {
  return structuredClone(value);
}

function serialize(value) {
  return JSON.stringify(value);
}

function createUuid() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is unavailable');
  }
  return globalThis.crypto.randomUUID();
}

function missingProfileBinding(value) {
  return !isNonEmptyString(value);
}

function normalizeJwt(value) {
  return typeof value === 'string' ? value : null;
}

function maskUserId(userId) {
  if (!isNonEmptyString(userId)) return null;
  if (userId.length <= 4) return '***';
  return `${userId.slice(0, 2)}...${userId.slice(-2)}`;
}

function normalizeProfile(id, value) {
  if (!isRecord(value)) return null;
  const endpoint = normalizeBackendEndpoint(value.endpoint);
  if (!endpoint || !isNonEmptyString(value.userId)) return null;
  return { id, endpoint, userId: value.userId, jwt: normalizeJwt(value.jwt) };
}

function legacyDefaultProfile(rawStore, legacy, endpointOverride) {
  const storedDefault = isRecord(rawStore.byId?.[DEFAULT_BACKEND_PROFILE_ID])
    ? rawStore.byId[DEFAULT_BACKEND_PROFILE_ID]
    : {};
  const endpoint = normalizeBackendEndpoint(storedDefault.endpoint)
    || normalizeBackendEndpoint(endpointOverride)
    || normalizeBackendEndpoint(legacy.api?.baseUrl);
  const hasLegacyEndpoint = isNonEmptyString(legacy.api?.baseUrl);
  if (!endpoint && hasLegacyEndpoint) {
    const error = new Error('Unsupported legacy backend endpoint');
    error.code = 'unsupported-legacy-endpoint';
    throw error;
  }
  const userId = isNonEmptyString(storedDefault.userId)
    ? storedDefault.userId
    : isNonEmptyString(legacy.user?.userId)
      ? legacy.user.userId
      : isNonEmptyString(legacy.userID)
        ? legacy.userID
        : createUuid();
  const jwt = Object.hasOwn(storedDefault, 'jwt')
    ? normalizeJwt(storedDefault.jwt)
    : normalizeJwt(legacy.jwt);
  return { id: DEFAULT_BACKEND_PROFILE_ID, endpoint: endpoint || DEFAULT_BACKEND_ENDPOINT, userId, jwt };
}

function buildProfileStore(data, endpointOverride) {
  const hasRawStore = isRecord(data[PROFILE_STORE_KEY]);
  const rawStore = hasRawStore ? data[PROFILE_STORE_KEY] : {};
  const rawProfiles = isRecord(rawStore.byId) ? rawStore.byId : {};
  const isCurrentSchema = rawStore.schemaVersion === BACKEND_PROFILE_SCHEMA_VERSION;
  const byId = {};

  for (const [id, profile] of Object.entries(rawProfiles)) {
    if (!isNonEmptyString(id)) continue;
    const normalized = normalizeProfile(id, profile);
    if (normalized) byId[id] = normalized;
  }

  const hasCorruptedCurrentDefault = isCurrentSchema &&
    Object.hasOwn(rawProfiles, DEFAULT_BACKEND_PROFILE_ID) &&
    !byId[DEFAULT_BACKEND_PROFILE_ID];
  if (!hasRawStore || !isCurrentSchema || hasCorruptedCurrentDefault) {
    byId[DEFAULT_BACKEND_PROFILE_ID] = legacyDefaultProfile(rawStore, data, endpointOverride);
  }

  const activeProfileId = isNonEmptyString(rawStore.activeProfileId) && byId[rawStore.activeProfileId]
    ? rawStore.activeProfileId
    : byId[DEFAULT_BACKEND_PROFILE_ID]
      ? DEFAULT_BACKEND_PROFILE_ID
      : Object.keys(byId)[0] || null;
  const store = {
    schemaVersion: BACKEND_PROFILE_SCHEMA_VERSION,
    activeProfileId,
    byId
  };
  return { store, changed: serialize(rawStore) !== serialize(store) };
}

function migrateContributionRecord(record) {
  if (!isRecord(record)) return { record, changed: false, malformed: true };
  if (!isNonEmptyString(record.id)) return { record, changed: false, malformed: true };
  let nextRecord = record;
  let changed = false;
  if (missingProfileBinding(record.backendProfileId)) {
    nextRecord = { ...nextRecord, backendProfileId: DEFAULT_BACKEND_PROFILE_ID };
    changed = true;
  }
  if (!isNonEmptyString(record.operationId) && isNonEmptyString(record.id)) {
    nextRecord = { ...nextRecord, operationId: record.id };
    changed = true;
  }
  return { record: nextRecord, changed, malformed: false };
}

function migrateContributionArray(value) {
  if (value === undefined) return { value, changed: false, malformedCount: 0 };
  if (!Array.isArray(value)) return { value, changed: false, malformedCount: 1 };
  let changed = false;
  let malformedCount = 0;
  const nextValue = value.map((record) => {
    const migrated = migrateContributionRecord(record);
    changed ||= migrated.changed;
    if (migrated.malformed) malformedCount += 1;
    return migrated.record;
  });
  return { value: nextValue, changed, malformedCount };
}

function migrateVoteState(value) {
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const nextValue = {};
  for (const [translationId, state] of Object.entries(value)) {
    if (isRecord(state) && missingProfileBinding(state.backendProfileId)) {
      nextValue[translationId] = { ...state, backendProfileId: DEFAULT_BACKEND_PROFILE_ID };
      changed = true;
    } else {
      nextValue[translationId] = state;
    }
  }
  return { value: nextValue, changed };
}

export function buildBackendProfileMigration(data, { endpointOverride } = {}) {
  const { store, changed: profileChanged } = buildProfileStore(data, endpointOverride);
  const updates = {};
  let malformedRecordCount = 0;
  if (profileChanged) updates[PROFILE_STORE_KEY] = store;

  for (const key of CONTRIBUTION_KEYS) {
    const migrated = migrateContributionArray(data[key]);
    if (migrated.changed) updates[key] = migrated.value;
    malformedRecordCount += migrated.malformedCount;
  }

  const migratedVoteState = migrateVoteState(data.voteStateByTranslation);
  if (migratedVoteState.changed) updates.voteStateByTranslation = migratedVoteState.value;

  return { updates, store, malformedRecordCount };
}

async function migrate(storage) {
  const data = await storage.get(BACKEND_PROFILE_MIGRATION_KEYS);
  const { updates } = buildBackendProfileMigration(data);
  if (Object.keys(updates).length > 0) await storage.set(updates);
}

export function normalizeBackendEndpoint(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!/^https?:\/\//i.test(input)) return null;

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return null;
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return null;
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

export async function ensureBackendProfilesMigrated(storage) {
  const local = getStorage(storage);
  const existing = migrationReadiness.get(local);
  if (existing) return existing;

  const readiness = migrate(local);
  migrationReadiness.set(local, readiness);
  try {
    await readiness;
  } catch (error) {
    migrationReadiness.delete(local);
    throw error;
  }
}

async function getMigratedData(storage) {
  const local = getStorage(storage);
  await ensureBackendProfilesMigrated(local);
  return { local, data: await local.get([PROFILE_STORE_KEY, ...CONTRIBUTION_KEYS, 'voteStateByTranslation']) };
}

function getProfile(store, profileId) {
  const id = profileId ?? store.activeProfileId;
  const profile = store.byId?.[id];
  if (!profile) throw new Error(`Unknown backend profile: ${id}`);
  return profile;
}

function contributionCounts(profileId, contributionData) {
  const counts = {};
  for (const status of ['pending', 'syncing', 'failed']) {
    const statusCounts = { vote: 0, translation: 0, replacementEvent: 0, total: 0 };
    for (const [type, key] of Object.entries(QUEUE_KEYS)) {
      const items = Array.isArray(contributionData?.[key]) ? contributionData[key] : [];
      const count = items.filter((item) => isRecord(item) && item.backendProfileId === profileId && item.status === status).length;
      statusCounts[type] = count;
      statusCounts.total += count;
    }
    counts[status] = statusCounts;
  }
  return counts;
}

export function toBackendProfileSnapshot(profile, activeProfileId, contributionData = {}) {
  return {
    id: profile.id,
    endpoint: profile.endpoint,
    userIdMasked: maskUserId(profile.userId),
    hasJwt: isNonEmptyString(profile.jwt),
    isActive: profile.id === activeProfileId,
    queueCounts: contributionCounts(profile.id, contributionData)
  };
}

export async function resolveBackendProfile(storage, profileId) {
  const { data } = await getMigratedData(storage);
  return clone(getProfile(data[PROFILE_STORE_KEY], profileId));
}

export async function listBackendProfiles(storage) {
  const { data } = await getMigratedData(storage);
  const store = data[PROFILE_STORE_KEY];
  return Object.values(store.byId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((profile) => toBackendProfileSnapshot(profile, store.activeProfileId, data));
}

export async function createBackendProfile(storage, options = {}) {
  const local = getStorage(storage);
  await ensureBackendProfilesMigrated(local);
  return await runStorageMutation(local, async () => {
    assertProfileOptions(options);
    const { data } = await getMigratedData(local);
    const endpoint = normalizeBackendEndpoint(options.endpoint);
    if (!endpoint) throw new Error('Invalid backend endpoint');

    const store = data[PROFILE_STORE_KEY];
    let id = createUuid();
    while (store.byId[id]) id = createUuid();
    const userId = createUuid();
    const profile = { id, endpoint, userId, jwt: null };
    const nextStore = { ...store, byId: { ...store.byId, [id]: profile } };
    await local.set({ [PROFILE_STORE_KEY]: nextStore });
    return toBackendProfileSnapshot(profile, nextStore.activeProfileId, data);
  });
}

export async function setBackendProfileCredentials(storage, profileId, credentials) {
  const local = getStorage(storage);
  await ensureBackendProfilesMigrated(local);
  return await runStorageMutation(local, async () => {
    if (!isRecord(credentials)) throw new Error('Backend profile credentials must be an object');
    const { data } = await getMigratedData(local);
    const store = data[PROFILE_STORE_KEY];
    const profile = getProfile(store, profileId);
    const nextProfile = { ...profile };

    if (Object.hasOwn(credentials, 'endpoint')) {
      const endpoint = normalizeBackendEndpoint(credentials.endpoint);
      if (!endpoint) throw new Error('Invalid backend endpoint');
      nextProfile.endpoint = endpoint;
    }
    if (Object.hasOwn(credentials, 'userId')) {
      if (!isNonEmptyString(credentials.userId)) throw new Error('Invalid backend user ID');
      nextProfile.userId = credentials.userId;
    }
    if (Object.hasOwn(credentials, 'jwt')) {
      if (credentials.jwt !== null && typeof credentials.jwt !== 'string') throw new Error('Invalid backend JWT');
      nextProfile.jwt = credentials.jwt;
    }

    if (serialize(nextProfile) !== serialize(profile)) {
      const nextStore = { ...store, byId: { ...store.byId, [profileId]: nextProfile } };
      await local.set({ [PROFILE_STORE_KEY]: nextStore });
      return toBackendProfileSnapshot(nextProfile, nextStore.activeProfileId, data);
    }
    return toBackendProfileSnapshot(profile, store.activeProfileId, data);
  });
}

export async function activateBackendProfile(storage, profileId) {
  const local = getStorage(storage);
  await ensureBackendProfilesMigrated(local);
  return await runStorageMutation(local, async () => {
    const { data } = await getMigratedData(local);
    const store = data[PROFILE_STORE_KEY];
    const profile = getProfile(store, profileId);
    if (store.activeProfileId !== profileId) {
      await local.set({ [PROFILE_STORE_KEY]: { ...store, activeProfileId: profileId } });
    }
    return toBackendProfileSnapshot(profile, profileId, data);
  });
}

function hasBlockingRecords(data, profileId) {
  return CONTRIBUTION_KEYS.some((key) => Array.isArray(data[key]) && data[key].some((record) => (
    isRecord(record)
    && record.backendProfileId === profileId
    && ['pending', 'syncing', 'failed'].includes(record.status)
  )));
}

export async function deleteBackendProfile(storage, profileId, options = {}) {
  const local = getStorage(storage);
  await ensureBackendProfilesMigrated(local);
  return await runStorageMutation(local, async () => {
    assertProfileOptions(options);
    const { data } = await getMigratedData(local);
    const store = data[PROFILE_STORE_KEY];
    getProfile(store, profileId);
    if (store.activeProfileId === profileId) throw new Error('Cannot delete the active profile');
    if (!options.discard && hasBlockingRecords(data, profileId)) {
      throw new Error('Cannot delete a profile with pending, syncing, or failed records');
    }

    const byId = { ...store.byId };
    delete byId[profileId];
    const updates = { [PROFILE_STORE_KEY]: { ...store, byId } };

    for (const key of CONTRIBUTION_KEYS) {
      if (!Array.isArray(data[key])) continue;
      const nextRecords = data[key].filter((record) => !isRecord(record) || record.backendProfileId !== profileId);
      if (nextRecords.length !== data[key].length) updates[key] = nextRecords;
    }
    if (isRecord(data.voteStateByTranslation)) {
      const nextVoteState = Object.fromEntries(
        Object.entries(data.voteStateByTranslation)
          .filter(([, state]) => !isRecord(state) || state.backendProfileId !== profileId)
      );
      if (Object.keys(nextVoteState).length !== Object.keys(data.voteStateByTranslation).length) {
        updates.voteStateByTranslation = nextVoteState;
      }
    }

    await local.set(updates);
    return true;
  });
}

function exportRecord(record) {
  const exported = {};
  for (const field of EXPORT_RECORD_FIELDS) {
    if (Object.hasOwn(record, field) && isExportValue(record[field])) exported[field] = record[field];
  }
  return exported;
}

function isExportValue(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function exportVoteState(voteStateByTranslation, profileId) {
  if (!isRecord(voteStateByTranslation)) return {};
  const exported = {};
  for (const [translationId, value] of Object.entries(voteStateByTranslation)) {
    if (!isRecord(value) || value.backendProfileId !== profileId) continue;
    const safeValue = {};
    for (const field of ['backendProfileId', 'voteState', 'updatedAt']) {
      if (Object.hasOwn(value, field) && isExportValue(value[field])) safeValue[field] = value[field];
    }
    exported[translationId] = safeValue;
  }
  return exported;
}

export async function exportBackendProfileQueue(storage, profileId) {
  const { data } = await getMigratedData(storage);
  const store = data[PROFILE_STORE_KEY];
  const activeProfile = getProfile(store);
  if (profileId !== undefined && profileId !== activeProfile.id) {
    throw new Error('Export requires the known active profile');
  }

  const targetProfileId = activeProfile.id;
  const exportFor = (key) => (Array.isArray(data[key]) ? data[key] : [])
    .filter((record) => isRecord(record) && record.backendProfileId === targetProfileId)
    .map(exportRecord);
  return {
    profile: toBackendProfileSnapshot(activeProfile, store.activeProfileId, data),
    queues: Object.fromEntries(Object.entries(QUEUE_KEYS).map(([type, key]) => [type, exportFor(key)])),
    histories: Object.fromEntries(Object.entries(HISTORY_KEYS).map(([type, key]) => [type, exportFor(key)])),
    voteStateByTranslation: exportVoteState(data.voteStateByTranslation, targetProfileId)
  };
}
