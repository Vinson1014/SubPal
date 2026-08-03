import { ensureBackendProfilesMigrated, normalizeBackendEndpoint } from './backend-profiles.js';
import { runStorageMutation } from './storage-mutation-coordinator.js';

const CONTRIBUTION_CATEGORY = 'contribution-intent';
const PROFILE_STORE_KEY = 'backendProfiles';
const ENVELOPE_KEYS = new Set(['category', 'variant', 'payload']);
const AUTHORITY_KEYS = new Set([
  'backendProfileId', 'beneficiaryUserID', 'profileId', 'profileID', 'operationId', 'endpoint', 'jwt', 'token', 'auth', 'authorization', 'credential', 'credentials',
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
    keys: new Set(['translationID', 'contributorUserID', 'occurredAt'])
  }
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function ownDataValue(value, key) {
  try {
    if (!isRecord(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
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
    isNonEmptyString(payload.occurredAt) ? payload : null;
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

function queueReplacementEvent(queue, payload, profile) {
  const operationId = createOperationId();
  return {
    queue: append(queue, {
      id: operationId,
      operationId,
      backendProfileId: profile.id,
      translationID: payload.translationID,
      contributorUserID: payload.contributorUserID,
      beneficiaryUserID: profile.userId,
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

const QUEUE_TYPES = Object.freeze([
  { type: 'vote', key: 'voteQueue', historyKey: 'voteHistory' },
  { type: 'translation', key: 'translationQueue', historyKey: 'translationHistory' },
  { type: 'replacementEvent', key: 'replacementEventQueue', historyKey: 'replacementEventHistory' }
]);
const PROJECTION_ENVELOPE_KEYS = new Set(['variant', 'payload']);
const VOTE_AUTHORITY_PROJECTION_KEYS = new Set(['translationID']);
const TRANSLATION_RECONCILIATION_PROJECTION_KEYS = new Set(['operationIds']);
const RECONCILIATION_STATUSES = new Set(['pending', 'syncing', 'failed', 'completed']);

function canonicalProfile(store, profileId) {
  if (!isRecord(store) || !isNonEmptyString(profileId)) return null;
  const byId = ownDataValue(store, 'byId');
  const profile = isRecord(byId) ? ownDataValue(byId, profileId) : null;
  const endpoint = isRecord(profile) ? normalizeBackendEndpoint(ownDataValue(profile, 'endpoint')) : null;
  const userId = isRecord(profile) ? ownDataValue(profile, 'userId') : null;
  const jwt = isRecord(profile) ? ownDataValue(profile, 'jwt') : null;
  if (!isRecord(profile) || ownDataValue(profile, 'id') !== profileId || !endpoint || !isNonEmptyString(userId) ||
      (jwt !== null && typeof jwt !== 'string')) return null;
  return { id: profileId, endpoint, userId, jwt };
}

function retryFailedRecord(record) {
  const { errorMetadata, syncStartedAt, ...preserved } = record;
  return { ...preserved, status: 'pending', retryCount: 0, error: null };
}

function operationMatches(record, operationId) {
  return isRecord(record) && (record.operationId === operationId || record.id === operationId);
}

function collectOperationMatches(data, operationId) {
  return QUEUE_TYPES.flatMap(({ key }) => {
    const queue = Array.isArray(data[key]) ? data[key] : [];
    return queue.flatMap((record, index) => operationMatches(record, operationId) ? [{ key, index, record }] : []);
  });
}

export async function retryContribution(storage, operationId, authorizedProfileId) {
  if (!isNonEmptyString(operationId) || !isNonEmptyString(authorizedProfileId)) {
    throw new Error('Invalid contribution retry');
  }
  await ensureBackendProfilesMigrated(storage);
  return await runStorageMutation(storage, async () => {
    const data = await storage.get([PROFILE_STORE_KEY, ...QUEUE_TYPES.map(({ key }) => key)]);
    const activeProfile = canonicalActiveProfile(data[PROFILE_STORE_KEY]);
    if (!activeProfile || activeProfile.id !== authorizedProfileId) {
      throw new Error('Contribution retry is not authorized for this profile');
    }
    const matches = collectOperationMatches(data, operationId);
    if (matches.length !== 1) throw new Error('Contribution retry record not found or ambiguous');
    const match = matches[0];
    if (match.record.backendProfileId !== authorizedProfileId) {
      throw new Error('Contribution retry is not authorized for this profile');
    }
    if (match.record.status === 'pending' || match.record.status === 'syncing') return true;
    if (match.record.status !== 'failed') throw new Error('Contribution retry record not found');
    const queue = Array.isArray(data[match.key]) ? data[match.key] : [];
    const nextQueue = [...queue];
    nextQueue[match.index] = retryFailedRecord(match.record);
    await storage.set({ [match.key]: nextQueue });
    return true;
  });
}

export async function retryFailedContributions(storage, authorizedProfileId) {
  if (!isNonEmptyString(authorizedProfileId)) throw new Error('Invalid contribution retry');
  await ensureBackendProfilesMigrated(storage);
  return await runStorageMutation(storage, async () => {
    const queueKeys = QUEUE_TYPES.map(({ key }) => key);
    const data = await storage.get([PROFILE_STORE_KEY, ...queueKeys]);
    const profile = canonicalProfile(data[PROFILE_STORE_KEY], authorizedProfileId);
    if (!profile) {
      throw new Error('Contribution retry is not authorized for this profile');
    }
    const scheduled = {};
    const nextQueues = {};
    let changed = false;
    for (const { type, key } of QUEUE_TYPES) {
      const queue = Array.isArray(data[key]) ? data[key] : [];
      let count = 0;
      const nextQueue = queue.map((record) => {
        if (!isRecord(record) || record.backendProfileId !== authorizedProfileId || record.status !== 'failed') return record;
        count += 1;
        return retryFailedRecord(record);
      });
      scheduled[type] = count;
      nextQueues[key] = nextQueue;
      changed ||= count > 0;
    }
    if (changed) await storage.set(nextQueues);
    return scheduled;
  });
}

function parseContributionProjection(approvedRead) {
  const envelope = strictOwnRecord(approvedRead, PROJECTION_ENVELOPE_KEYS, PROJECTION_ENVELOPE_KEYS);
  if (!envelope || !isNonEmptyString(envelope.variant)) return null;
  if (envelope.variant === 'vote-authority') {
    const payload = strictOwnRecord(envelope.payload, VOTE_AUTHORITY_PROJECTION_KEYS, VOTE_AUTHORITY_PROJECTION_KEYS);
    return payload && isNonEmptyString(payload.translationID)
      ? { variant: envelope.variant, translationID: payload.translationID }
      : null;
  }
  if (envelope.variant === 'translation-reconciliation') {
    const payload = strictOwnRecord(envelope.payload, TRANSLATION_RECONCILIATION_PROJECTION_KEYS, TRANSLATION_RECONCILIATION_PROJECTION_KEYS);
    if (!payload || !Array.isArray(payload.operationIds) || payload.operationIds.length > 100 ||
        payload.operationIds.some((operationId) => !isNonEmptyString(operationId)) ||
        new Set(payload.operationIds).size !== payload.operationIds.length) return null;
    return { variant: envelope.variant, operationIds: [...payload.operationIds] };
  }
  return null;
}

function projectVoteAuthority(record, profileId) {
  if (!isRecord(record) || record.backendProfileId !== profileId) return null;
  const myVote = ownDataValue(record, 'myVote');
  const upvotes = ownDataValue(record, 'upvotes');
  const downvotes = ownDataValue(record, 'downvotes');
  if (!(myVote === null || ['like', 'dislike', 'none'].includes(myVote)) ||
      !Number.isFinite(upvotes) || upvotes < 0 || !Number.isFinite(downvotes) || downvotes < 0) return null;
  return { myVote: myVote === 'none' ? null : myVote, upvotes, downvotes };
}

function projectPermanentVoteFailure(record, profileId, translationID) {
  if (!isRecord(record) || ownDataValue(record, 'backendProfileId') !== profileId ||
      ownDataValue(record, 'translationID') !== translationID || ownDataValue(record, 'status') !== 'failed' ||
      ownDataValue(ownDataValue(record, 'errorMetadata'), 'isPermanent') !== true) return null;
  const previousVoteState = ownDataValue(record, 'previousVoteState');
  const previousCounts = parsePreviousCounts(ownDataValue(record, 'previousCounts'));
  if (!(previousVoteState === null || ['like', 'dislike', 'none'].includes(previousVoteState)) || !previousCounts) return null;
  return { previousVoteState, previousCounts };
}

function reconciliationRecord(queue, history, operationId, profileId) {
  const matchingRecord = (records) => records.find((record) => {
    if (!isRecord(record) || record.backendProfileId !== profileId) return false;
    return Object.hasOwn(record, 'operationId')
      ? ownDataValue(record, 'operationId') === operationId
      : ownDataValue(record, 'id') === operationId;
  });
  return matchingRecord(queue) || matchingRecord(history) || null;
}

function projectReconciliationRecord(record, operationId) {
  if (!isRecord(record)) return null;
  const status = ownDataValue(record, 'status');
  const syncedAt = ownDataValue(record, 'syncedAt');
  const errorMetadata = ownDataValue(record, 'errorMetadata');
  if (!isNonEmptyString(operationId) || !RECONCILIATION_STATUSES.has(status) ||
      !(syncedAt === null || Number.isFinite(syncedAt))) return null;
  return {
    operationId,
    status,
    syncedAt,
    terminal: isRecord(errorMetadata) && ownDataValue(errorMetadata, 'terminal') === true
  };
}

export async function getContributionProjection(storage, approvedRead) {
  const request = parseContributionProjection(approvedRead);
  if (!request) throw new Error('Invalid contribution projection');
  await ensureBackendProfilesMigrated(storage);
  return await runStorageMutation(storage, async () => {
    const keys = request.variant === 'vote-authority'
      ? [PROFILE_STORE_KEY, 'voteQueue', 'voteStateByTranslation']
      : [PROFILE_STORE_KEY, 'translationQueue', 'translationHistory'];
    const data = await storage.get(keys);
    const profile = canonicalActiveProfile(data[PROFILE_STORE_KEY]);
    if (!profile) throw new Error('Invalid active backend profile');
    if (request.variant === 'vote-authority') {
      const queue = Array.isArray(data.voteQueue) ? data.voteQueue : [];
      const failedIndex = queue.findIndex((record) => projectPermanentVoteFailure(record, profile.id, request.translationID));
      const permanentFailure = failedIndex === -1 ? null : projectPermanentVoteFailure(queue[failedIndex], profile.id, request.translationID);
      if (failedIndex !== -1) {
        const nextQueue = [...queue];
        nextQueue[failedIndex] = { ...queue[failedIndex], status: 'failed-reverted' };
        await storage.set({ voteQueue: nextQueue });
      }
      return {
        authority: projectVoteAuthority(data.voteStateByTranslation?.[request.translationID], profile.id),
        hasPendingVote: queue.some((record) => isRecord(record) && record.backendProfileId === profile.id &&
          record.translationID === request.translationID && (record.status === 'pending' || record.status === 'syncing')),
        permanentFailure
      };
    }
    const queue = Array.isArray(data.translationQueue) ? data.translationQueue : [];
    const history = Array.isArray(data.translationHistory) ? data.translationHistory : [];
    return request.operationIds.flatMap((operationId) => {
      const record = reconciliationRecord(queue, history, operationId, profile.id);
      const projection = projectReconciliationRecord(record, operationId);
      return projection ? [projection] : [];
    });
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
        : queueReplacementEvent(queue, intent.payload, profile);
    await storage.set({ [queueKey]: queued.queue });
    return { status: 'queued-locally', operationId: queued.operationId };
  });
}
