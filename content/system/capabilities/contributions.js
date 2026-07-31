import { fail, ok } from './result.js';

const CONTRIBUTION_CATEGORY = 'contribution-intent';
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

function strictOwnRecord(value, allowedKeys, requiredKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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

function callerSignal(cancellation) {
  return cancellation?.signal ?? cancellation;
}

export function createContributions({ persist, persistenceDeadlineMs = 10000 }) {
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
    }
  });
}
