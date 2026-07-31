import { ensureBackendProfilesMigrated, normalizeBackendEndpoint } from './backend-profiles.js';
import { runStorageMutation } from './storage-mutation-coordinator.js';

const CONTRIBUTION_CATEGORY = 'contribution-intent';
const PROFILE_STORE_KEY = 'backendProfiles';
const ENVELOPE_KEYS = new Set(['category', 'variant', 'payload']);
const AUTHORITY_KEYS = new Set([
  'backendProfileId', 'operationId', 'endpoint', 'jwt', 'token', 'auth', 'credential', 'credentials',
  'destination', 'command', 'backgroundCommand', 'storage', 'storageKey', 'sync', 'syncConfig',
  'lifecycle', 'lifecycleConfig', 'config', 'backendProfiles', 'activeProfileId', 'profile', 'user', 'userId'
]);
const RESOLUTION_CONTEXT_KEYS = new Set(['taskID', 'targetType', 'action', 'slotKey', 'timestamp']);
const PREVIOUS_COUNT_KEYS = new Set(['like', 'dislike']);
const VARIANTS = Object.freeze({
  'enqueue-vote': {
    queueKey: 'voteQueue',
    keys: new Set(['videoId', 'timestamp', 'voteType', 'translationID', 'originalSubtitle', 'slotKey', 'voteState', 'previousVoteState', 'previousCounts', 'resolutionContext'])
  },
  'enqueue-translation': {
    queueKey: 'translationQueue',
    keys: new Set(['videoId', 'timestamp', 'original', 'translation', 'languageCode', 'submissionReason', 'slotKey', 'translationID', 'sourceTranslationID', 'resolutionContext'])
  },
  'enqueue-replacement-event': {
    queueKey: 'replacementEventQueue',
    keys: new Set(['translationID', 'contributorUserID', 'beneficiaryUserID', 'occurredAt'])
  }
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function strictOwnRecord(value, allowedKeys, requiredKeys) {
  try {
    if (!isRecord(value)) return null;
    if (typeof structuredClone === 'function') structuredClone(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return null;
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 || keys.some((key) => !allowedKeys.has(key) || AUTHORITY_KEYS.has(key))) return null;
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      result[key] = descriptor.value;
    }
    if ([...requiredKeys].some((key) => !Object.hasOwn(result, key))) return null;
    return result;
  } catch {
    return null;
  }
}

function nullableString(value) {
  return value === null || isNonEmptyString(value);
}

function parseResolutionContext(value) {
  const context = strictOwnRecord(value, RESOLUTION_CONTEXT_KEYS, RESOLUTION_CONTEXT_KEYS);
  return context && isNonEmptyString(context.taskID) && isNonEmptyString(context.targetType) &&
    isNonEmptyString(context.action) && (context.slotKey === null || isNonEmptyString(context.slotKey)) &&
    Number.isFinite(context.timestamp) && context.timestamp >= 0 ? context : null;
}

function parsePreviousCounts(value) {
  const counts = strictOwnRecord(value, PREVIOUS_COUNT_KEYS, PREVIOUS_COUNT_KEYS);
  return counts && Number.isFinite(counts.like) && counts.like >= 0 && Number.isFinite(counts.dislike) && counts.dislike >= 0
    ? counts
    : null;
}

function parseVote(payload) {
  if (!isNonEmptyString(payload.videoId) || !Number.isFinite(payload.timestamp) || payload.timestamp < 0 ||
      !['upvote', 'downvote'].includes(payload.voteType)) return null;
  if (Object.hasOwn(payload, 'translationID') && !nullableString(payload.translationID)) return null;
  if (Object.hasOwn(payload, 'originalSubtitle') && !nullableString(payload.originalSubtitle)) return null;
  if (Object.hasOwn(payload, 'slotKey') && !nullableString(payload.slotKey)) return null;
  if (Object.hasOwn(payload, 'voteState') && !['like', 'dislike', 'none'].includes(payload.voteState)) return null;
  if (Object.hasOwn(payload, 'previousVoteState') && !(payload.previousVoteState === null || ['like', 'dislike', 'none'].includes(payload.previousVoteState))) return null;
  if (Object.hasOwn(payload, 'previousCounts') && !(payload.previousCounts === null || parsePreviousCounts(payload.previousCounts))) return null;
  if (Object.hasOwn(payload, 'resolutionContext') && !(payload.resolutionContext === null || parseResolutionContext(payload.resolutionContext))) return null;
  return payload.voteState && !payload.translationID ? null : payload;
}

function parseTranslation(payload) {
  if (!isNonEmptyString(payload.videoId) || !Number.isFinite(payload.timestamp) || payload.timestamp < 0 ||
      !isNonEmptyString(payload.original) || !isNonEmptyString(payload.translation) ||
      !isNonEmptyString(payload.languageCode) || !isNonEmptyString(payload.submissionReason)) return null;
  if (Object.hasOwn(payload, 'slotKey') && !nullableString(payload.slotKey)) return null;
  if (Object.hasOwn(payload, 'translationID') && !nullableString(payload.translationID)) return null;
  if (Object.hasOwn(payload, 'sourceTranslationID') && !nullableString(payload.sourceTranslationID)) return null;
  if (Object.hasOwn(payload, 'resolutionContext') && !(payload.resolutionContext === null || parseResolutionContext(payload.resolutionContext))) return null;
  return payload;
}

function parseReplacementEvent(payload) {
  return isNonEmptyString(payload.translationID) && isNonEmptyString(payload.contributorUserID) &&
    isNonEmptyString(payload.beneficiaryUserID) && isNonEmptyString(payload.occurredAt) ? payload : null;
}

export function parseContributionIntent(input) {
  const envelope = strictOwnRecord(input, ENVELOPE_KEYS, ENVELOPE_KEYS);
  if (!envelope || envelope.category !== CONTRIBUTION_CATEGORY || !Object.hasOwn(VARIANTS, envelope.variant)) return null;
  const variant = VARIANTS[envelope.variant];
  const payload = strictOwnRecord(envelope.payload, variant.keys, new Set());
  if (!payload) return null;
  const parsedPayload = envelope.variant === 'enqueue-vote'
    ? parseVote(payload)
    : envelope.variant === 'enqueue-translation'
      ? parseTranslation(payload)
      : parseReplacementEvent(payload);
  return parsedPayload ? { variant: envelope.variant, payload: parsedPayload } : null;
}

function canonicalActiveProfile(store) {
  if (!isRecord(store)) return null;
  const activeProfileId = ownDataValue(store, 'activeProfileId');
  const byId = ownDataValue(store, 'byId');
  if (!isNonEmptyString(activeProfileId) || !isRecord(byId)) return null;
  const profile = ownDataValue(byId, activeProfileId);
  if (!isRecord(profile)) return null;
  const id = ownDataValue(profile, 'id');
  const endpoint = normalizeBackendEndpoint(ownDataValue(profile, 'endpoint'));
  const userId = ownDataValue(profile, 'userId');
  const jwt = ownDataValue(profile, 'jwt');
  if (id !== activeProfileId || !endpoint || !isNonEmptyString(userId) || (jwt !== null && typeof jwt !== 'string')) return null;
  return { id, endpoint, userId, jwt };
}

function createOperationId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

function append(queue, record) {
  const nextQueue = [...queue, record];
  return nextQueue.length > 100 ? nextQueue.slice(-100) : nextQueue;
}

function queueVote(queue, payload, backendProfileId) {
  if (payload.translationID) {
    const existingIndex = queue.findIndex((record) => (
      isRecord(record) && record.translationID === payload.translationID &&
      record.backendProfileId === backendProfileId && record.status === 'pending'
    ));
    if (existingIndex !== -1) {
      const existing = queue[existingIndex];
      const updated = {
        ...existing,
        voteState: payload.voteState,
        previousVoteState: existing.previousVoteState ?? payload.previousVoteState ?? null,
        previousCounts: existing.previousCounts ?? payload.previousCounts ?? null,
        updatedAt: Date.now()
      };
      if (payload.resolutionContext !== undefined && payload.resolutionContext !== null) {
        updated.resolutionContext = payload.resolutionContext;
      } else {
        delete updated.resolutionContext;
        if (payload.voteState === undefined) delete updated.voteState;
      }
      const nextQueue = [...queue];
      nextQueue[existingIndex] = updated;
      return { queue: nextQueue, operationId: existing.operationId || existing.id };
    }
  }

  const operationId = createOperationId();
  const record = {};
  Object.assign(record, {
    id: operationId,
    operationId,
    backendProfileId,
    videoId: payload.videoId,
    timestamp: payload.timestamp,
    voteType: payload.voteType,
    translationID: payload.translationID || null,
    originalSubtitle: payload.originalSubtitle || null,
    slotKey: payload.slotKey || null,
    voteState: payload.voteState || null,
    previousVoteState: payload.previousVoteState || null,
    previousCounts: payload.previousCounts || null,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncedAt: null,
    retryCount: 0,
    error: null
  });
  if (payload.resolutionContext !== undefined && payload.resolutionContext !== null) record.resolutionContext = payload.resolutionContext;
  return { queue: append(queue, record), operationId };
}

function queueTranslation(queue, payload, backendProfileId) {
  const operationId = createOperationId();
  const record = {};
  Object.assign(record, {
    id: operationId,
    operationId,
    backendProfileId,
    videoId: payload.videoId,
    timestamp: payload.timestamp,
    original: payload.original,
    translation: payload.translation,
    languageCode: payload.languageCode,
    submissionReason: payload.submissionReason,
    slotKey: payload.slotKey || null,
    status: 'pending',
    createdAt: Date.now(),
    syncedAt: null,
    retryCount: 0,
    error: null
  });
  if (payload.resolutionContext !== undefined && payload.resolutionContext !== null) {
    record.resolutionContext = payload.resolutionContext;
    record.translationID = payload.translationID ?? null;
  } else if (Object.hasOwn(payload, 'translationID')) {
    record.translationID = payload.translationID;
  }
  if (Object.hasOwn(payload, 'sourceTranslationID')) record.sourceTranslationID = payload.sourceTranslationID;
  return { queue: append(queue, record), operationId };
}

function queueReplacementEvent(queue, payload, backendProfileId) {
  const operationId = createOperationId();
  return {
    queue: append(queue, {
      id: operationId,
      operationId,
      backendProfileId,
      translationID: payload.translationID,
      contributorUserID: payload.contributorUserID,
      beneficiaryUserID: payload.beneficiaryUserID,
      occurredAt: payload.occurredAt,
      status: 'pending',
      createdAt: Date.now(),
      syncedAt: null,
      retryCount: 0,
      error: null
    }),
    operationId
  };
}

const RETRY_QUEUE_KEYS = Object.freeze({
  VOTE_RETRY: 'voteQueue',
  TRANSLATION_RETRY: 'translationQueue',
  REPLACEMENT_EVENT_RETRY: 'replacementEventQueue'
});

function hasKnownProfile(store, profileId) {
  return isRecord(store) && isRecord(store.byId) && isRecord(store.byId[profileId]) &&
    store.byId[profileId].id === profileId;
}

export async function retryContribution(storage, type, operationId) {
  const queueKey = RETRY_QUEUE_KEYS[type];
  if (!queueKey || !isNonEmptyString(operationId)) throw new Error('Invalid contribution retry');
  await ensureBackendProfilesMigrated(storage);
  return await runStorageMutation(storage, async () => {
    const data = await storage.get([PROFILE_STORE_KEY, queueKey]);
    const queue = Array.isArray(data[queueKey]) ? data[queueKey] : [];
    const index = queue.findIndex((record) => isRecord(record) &&
      (record.operationId === operationId || record.id === operationId) && record.status === 'failed' &&
      hasKnownProfile(data[PROFILE_STORE_KEY], record.backendProfileId));
    if (index === -1) throw new Error('Contribution retry record not found');
    const nextQueue = [...queue];
    nextQueue[index] = { ...queue[index], status: 'pending', retryCount: 0, error: null };
    await storage.set({ [queueKey]: nextQueue });
    return true;
  });
}

export async function readVoteAuthority(storage, translationID) {
  if (!isNonEmptyString(translationID)) throw new Error('Invalid vote authority request');
  await ensureBackendProfilesMigrated(storage);
  return await runStorageMutation(storage, async () => {
    const data = await storage.get([PROFILE_STORE_KEY, 'voteQueue', 'voteStateByTranslation']);
    const profile = canonicalActiveProfile(data[PROFILE_STORE_KEY]);
    if (!profile) throw new Error('Invalid active backend profile');
    const queue = Array.isArray(data.voteQueue) ? data.voteQueue : [];
    const failedIndex = queue.findIndex((record) => isRecord(record) && record.backendProfileId === profile.id &&
      record.translationID === translationID && record.status === 'failed' && record.errorMetadata?.isPermanent &&
      record.previousVoteState !== undefined && record.previousCounts !== undefined);
    const permanentFailure = failedIndex === -1 ? null : queue[failedIndex];
    if (failedIndex !== -1) {
      const nextQueue = [...queue];
      nextQueue[failedIndex] = { ...permanentFailure, status: 'failed-reverted' };
      await storage.set({ voteQueue: nextQueue });
    }
    const authority = isRecord(data.voteStateByTranslation?.[translationID]) &&
      data.voteStateByTranslation[translationID].backendProfileId === profile.id
      ? data.voteStateByTranslation[translationID]
      : null;
    return {
      authority,
      hasPendingVote: queue.some((record) => isRecord(record) && record.backendProfileId === profile.id &&
        record.translationID === translationID && (record.status === 'pending' || record.status === 'syncing')),
      permanentFailure: permanentFailure ? {
        previousVoteState: permanentFailure.previousVoteState,
        previousCounts: permanentFailure.previousCounts
      } : null
    };
  });
}

export async function enqueueContribution(storage, input) {
  const intent = parseContributionIntent(input);
  if (!intent) throw new Error('Invalid contribution intent');
  await ensureBackendProfilesMigrated(storage);
  return await runStorageMutation(storage, async () => {
    const queueKey = VARIANTS[intent.variant].queueKey;
    const data = await storage.get([PROFILE_STORE_KEY, queueKey]);
    const profile = canonicalActiveProfile(data[PROFILE_STORE_KEY]);
    if (!profile) throw new Error('Invalid active backend profile');
    const queue = Array.isArray(data[queueKey]) ? data[queueKey] : [];
    const queued = intent.variant === 'enqueue-vote'
      ? queueVote(queue, intent.payload, profile.id)
      : intent.variant === 'enqueue-translation'
        ? queueTranslation(queue, intent.payload, profile.id)
        : queueReplacementEvent(queue, intent.payload, profile.id);
    await storage.set({ [queueKey]: queued.queue });
    return { status: 'queued-locally', operationId: queued.operationId };
  });
}
