import { fail, ok } from './result.js';

const CONTRIBUTION_CATEGORY = 'contribution-intent';
const ENVELOPE_KEYS = new Set(['category', 'variant', 'payload']);
const PROJECTION_ENVELOPE_KEYS = new Set(['variant', 'payload']);
const VOTE_AUTHORITY_PROJECTION_KEYS = new Set(['translationID']);
const TRANSLATION_RECONCILIATION_PROJECTION_KEYS = new Set(['operationIds']);
const VOTE_AUTHORITY_RESPONSE_KEYS = new Set(['authority', 'hasPendingVote', 'permanentFailure']);
const VOTE_AUTHORITY_KEYS = new Set(['myVote', 'upvotes', 'downvotes']);
const PERMANENT_FAILURE_KEYS = new Set(['previousVoteState', 'previousCounts']);
const RECONCILIATION_RECORD_KEYS = new Set(['operationId', 'status', 'syncedAt', 'terminal']);
const RETRY_RESPONSE_KEYS = new Set(['retryScheduled', 'operationId']);
const RESULT_SUCCESS_KEYS = new Set(['ok', 'value']);
const RESULT_FAILURE_KEYS = new Set(['ok', 'error']);
const RESULT_ERROR_KEYS = new Set(['kind', 'code', 'retryable', 'meta']);
const RECONCILIATION_STATUSES = new Set(['pending', 'syncing', 'failed', 'completed']);
const AUTHORITY_KEYS = new Set([
  'backendProfileId', 'profileId', 'profileID', 'operationId', 'endpoint', 'jwt', 'token', 'auth', 'authorization', 'credential', 'credentials',
  'destination', 'command', 'backgroundCommand', 'storage', 'storageKey', 'sync', 'syncConfig',
  'lifecycle', 'lifecycleConfig', 'config', 'backendProfiles', 'activeProfileId', 'profile', 'user', 'userId'
]);
const RESOLUTION_CONTEXT_KEYS = new Set(['taskID', 'targetType', 'action', 'slotKey', 'timestamp']);
const PREVIOUS_COUNT_KEYS = new Set(['like', 'dislike']);
const VARIANTS = Object.freeze({
  'enqueue-vote': {
    method: 'enqueueVote',
    keys: new Set(['videoId', 'timestamp', 'voteType', 'translationID', 'originalSubtitle', 'slotKey', 'voteState', 'previousVoteState', 'previousCounts', 'resolutionContext'])
  },
  'enqueue-translation': {
    method: 'enqueueTranslation',
    keys: new Set(['videoId', 'timestamp', 'original', 'translation', 'languageCode', 'submissionReason', 'slotKey', 'translationID', 'sourceTranslationID', 'resolutionContext'])
  },
  'enqueue-replacement-event': {
    method: 'enqueueReplacementEvent',
    keys: new Set(['translationID', 'contributorUserID', 'beneficiaryUserID', 'occurredAt'])
  }
});

function strictOwnRecord(value, allowedKeys, requiredKeys, rejectAuthority = true) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof structuredClone === 'function') structuredClone(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return null;
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 || keys.some((key) => !allowedKeys.has(key) || (rejectAuthority && AUTHORITY_KEYS.has(key)))) return null;
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

function strictOwnArray(value) {
  try {
    if (!Array.isArray(value)) return null;
    if (typeof structuredClone === 'function') structuredClone(value);
    const prototype = Object.getPrototypeOf(value);
    if (!prototype || !Object.getPrototypeOf(prototype) || Object.getPrototypeOf(Object.getPrototypeOf(prototype)) !== null) return null;
    const length = value.length;
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== length + 1 || !names.includes('length')) return null;
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
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
  if (payload.voteState && !payload.translationID) return null;
  return payload;
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

function parseIntent(input) {
  const envelope = strictOwnRecord(input, ENVELOPE_KEYS, ENVELOPE_KEYS);
  if (!envelope || envelope.category !== CONTRIBUTION_CATEGORY || !Object.hasOwn(VARIANTS, envelope.variant)) return null;
  const variant = VARIANTS[envelope.variant];
  const payload = strictOwnRecord(envelope.payload, variant.keys, new Set());
  if (!payload) return null;
  const parser = envelope.variant === 'enqueue-vote'
    ? parseVote
    : envelope.variant === 'enqueue-translation'
      ? parseTranslation
      : parseReplacementEvent;
  const parsedPayload = parser(payload);
  return parsedPayload ? { variant: envelope.variant, payload: parsedPayload } : null;
}

function parseProjection(input) {
  const envelope = strictOwnRecord(input, PROJECTION_ENVELOPE_KEYS, PROJECTION_ENVELOPE_KEYS);
  if (!envelope || !isNonEmptyString(envelope.variant)) return null;
  if (envelope.variant === 'vote-authority') {
    const payload = strictOwnRecord(envelope.payload, VOTE_AUTHORITY_PROJECTION_KEYS, VOTE_AUTHORITY_PROJECTION_KEYS);
    return payload && isNonEmptyString(payload.translationID) ? { variant: envelope.variant, payload } : null;
  }
  if (envelope.variant === 'translation-reconciliation') {
    const payload = strictOwnRecord(envelope.payload, TRANSLATION_RECONCILIATION_PROJECTION_KEYS, TRANSLATION_RECONCILIATION_PROJECTION_KEYS);
    const operationIds = payload && strictOwnArray(payload.operationIds);
    return operationIds && operationIds.length <= 100 && operationIds.every(isNonEmptyString) &&
      new Set(operationIds).size === operationIds.length
      ? { variant: envelope.variant, payload: { operationIds } }
      : null;
  }
  return null;
}

function parseVoteAuthorityResponse(value) {
  const response = strictOwnRecord(value, VOTE_AUTHORITY_RESPONSE_KEYS, VOTE_AUTHORITY_RESPONSE_KEYS, false);
  if (!response || typeof response.hasPendingVote !== 'boolean') return null;
  let authority = null;
  if (response.authority !== null) {
    authority = strictOwnRecord(response.authority, VOTE_AUTHORITY_KEYS, VOTE_AUTHORITY_KEYS, false);
    if (!authority || ![null, 'like', 'dislike'].includes(authority.myVote) ||
        !Number.isFinite(authority.upvotes) || authority.upvotes < 0 ||
        !Number.isFinite(authority.downvotes) || authority.downvotes < 0) return null;
  }
  let permanentFailure = null;
  if (response.permanentFailure !== null) {
    permanentFailure = strictOwnRecord(response.permanentFailure, PERMANENT_FAILURE_KEYS, PERMANENT_FAILURE_KEYS, false);
    const previousCounts = permanentFailure && strictOwnRecord(permanentFailure.previousCounts, PREVIOUS_COUNT_KEYS, PREVIOUS_COUNT_KEYS, false);
    if (!permanentFailure || ![null, 'like', 'dislike', 'none'].includes(permanentFailure.previousVoteState) ||
        !previousCounts || !Number.isFinite(previousCounts.like) || previousCounts.like < 0 ||
        !Number.isFinite(previousCounts.dislike) || previousCounts.dislike < 0) return null;
    permanentFailure = { previousVoteState: permanentFailure.previousVoteState, previousCounts };
  }
  return { authority, hasPendingVote: response.hasPendingVote, permanentFailure };
}

function parseReconciliationResponse(value, requestedOperationIds) {
  const records = strictOwnArray(value);
  if (!records || records.length > requestedOperationIds.length) return null;
  const requested = new Set(requestedOperationIds);
  const seen = new Set();
  const parsed = [];
  for (const record of records) {
    const result = strictOwnRecord(record, RECONCILIATION_RECORD_KEYS, RECONCILIATION_RECORD_KEYS, false);
    if (!result || !isNonEmptyString(result.operationId) || !RECONCILIATION_STATUSES.has(result.status) ||
        !(result.syncedAt === null || Number.isFinite(result.syncedAt)) || typeof result.terminal !== 'boolean' ||
        !requested.has(result.operationId) || seen.has(result.operationId)) return null;
    seen.add(result.operationId);
    parsed.push(result);
  }
  return parsed;
}

function parseProjectionResponse(projection, value) {
  return projection.variant === 'vote-authority'
    ? parseVoteAuthorityResponse(value)
    : parseReconciliationResponse(value, projection.payload.operationIds);
}

function parseRetryResponse(value, operationId) {
  const response = strictOwnRecord(value, RETRY_RESPONSE_KEYS, RETRY_RESPONSE_KEYS, false);
  return response && response.retryScheduled === true && response.operationId === operationId ? response : null;
}

function parseTransportFailure(value) {
  const result = strictOwnRecord(value, RESULT_FAILURE_KEYS, RESULT_FAILURE_KEYS, false);
  if (!result || result.ok !== false) return null;
  const error = strictOwnRecord(result.error, RESULT_ERROR_KEYS, new Set(['kind', 'code', 'retryable']), false);
  return error && isNonEmptyString(error.kind) && isNonEmptyString(error.code) && typeof error.retryable === 'boolean'
    ? fail(error.kind, error.code, error.retryable)
    : null;
}

function parseTransportSuccess(value, parser) {
  const result = strictOwnRecord(value, RESULT_SUCCESS_KEYS, RESULT_SUCCESS_KEYS, false);
  if (!result || result.ok !== true) return null;
  const parsed = parser(result.value);
  return parsed === null ? null : ok(parsed);
}

function requestOptions(deadlineMs, signal) {
  return signal ? { deadlineMs, signal } : { deadlineMs };
}

async function execute(operation, cancellation, request, deadlineMs, cancelledCode, failedCode, responseCode, parser) {
  const signal = callerSignal(cancellation);
  if (signal?.aborted) return fail('cancelled', cancelledCode, false);
  return await Promise.resolve().then(async () => {
    if (signal?.aborted) return fail('cancelled', cancelledCode, false);
    let response;
    try {
      response = await request(operation, requestOptions(deadlineMs, signal));
    } catch {
      return fail('domain-rejected', failedCode, true);
    }
    const failure = parseTransportFailure(response);
    if (failure) return failure;
    return parseTransportSuccess(response, parser) ?? fail('domain-rejected', responseCode, false);
  });
}

function callerSignal(cancellation) {
  return cancellation?.signal ?? cancellation;
}

export function createContributions({ persist, readProjection, retryOperation, persistenceDeadlineMs = 10000 }) {
  return Object.freeze({
    async enqueue(input, cancellation) {
      const intent = parseIntent(input);
      if (!intent) return fail('invalid', 'contribution-payload', false);
      const signal = callerSignal(cancellation);
      if (signal?.aborted) return fail('cancelled', 'caller-cancelled-before-persistence', false);
      return await Promise.resolve().then(async () => {
        if (signal?.aborted) return fail('cancelled', 'caller-cancelled-before-persistence', false);
        let persisted;
        try {
          persisted = await persist(intent, { deadlineMs: persistenceDeadlineMs });
        } catch {
          return fail('domain-rejected', 'local-persistence-failed', true);
        }
        if (persisted?.ok === false) {
          if (persisted.error?.kind === 'timeout' && persisted.error?.code === 'background-port-timeout') {
            return fail('timeout', 'local-persistence-timeout', true);
          }
          return persisted;
        }
        const value = persisted?.ok === true ? persisted.value : persisted;
        return isNonEmptyString(value?.operationId) && value.status === 'queued-locally'
          ? ok({ status: 'queued-locally', operationId: value.operationId })
          : fail('domain-rejected', 'local-persistence-failed', true);
      });
    },
    async getProjection(approvedRead, cancellation) {
      const projection = parseProjection(approvedRead);
      return projection
        ? execute(projection, cancellation, readProjection, persistenceDeadlineMs,
          'caller-cancelled-before-projection', 'contribution-projection-failed', 'contribution-projection-response',
          (value) => parseProjectionResponse(projection, value))
        : fail('invalid', 'contribution-projection', false);
    },
    async retry(operationId, cancellation) {
      return isNonEmptyString(operationId)
        ? execute(operationId, cancellation, retryOperation, persistenceDeadlineMs,
          'caller-cancelled-before-retry', 'contribution-retry-failed', 'contribution-retry-response',
          (value) => parseRetryResponse(value, operationId))
        : fail('invalid', 'contribution-retry', false);
    }
  });
}
