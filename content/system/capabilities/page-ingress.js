import { fail, fromThrown, ok } from './result.js';
import { parseSubtitleQuery } from './subtitles.js';

const PAGE_OBSERVATION_CATEGORY = 'page-observation';
const VIDEO_CONTEXT_CHANGED_VARIANT = 'video-context-changed';
const SUBTITLE_QUERY_CATEGORY = 'subtitle-query';
const REPLACEMENT_SUBTITLE_QUERY_VARIANT = 'replacement-subtitle-query';
const BACKEND_PROFILE_CATEGORY = 'backend-profile';
const CONTRIBUTION_INTENT_CATEGORY = 'contribution-intent';
const CONTRIBUTION_READ_CATEGORY = 'contribution-read';
const CONTRIBUTION_ENQUEUE_VARIANTS = new Set(['enqueue-vote', 'enqueue-translation', 'enqueue-replacement-event']);
const CONTRIBUTION_READ_VARIANTS = new Set(['vote-authority', 'translation-reconciliation']);
const CONTRIBUTION_RETRY_VARIANT = 'retry-operation';
const PAYLOAD_KEYS = new Set(['oldVideoId', 'newVideoId', 'videoId']);
const ENVELOPE_KEYS = new Set(['category', 'variant', 'payload']);
const AUTHORITY_KEYS = new Set([
  'destination', 'command', 'backgroundCommand', 'storage', 'storageKey',
  'endpoint', 'credential', 'credentials', 'sync', 'syncConfig', 'lifecycle', 'lifecycleConfig', 'config',
  'backendProfileId', 'backendProfiles', 'activeProfileId', 'profile',
  'jwt', 'token', 'auth', 'user', 'userId'
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasForbiddenAuthority(value) {
  for (const key of AUTHORITY_KEYS) {
    for (let target = value; target !== null; target = Object.getPrototypeOf(target)) {
      if (Object.getOwnPropertyDescriptor(target, key)) return true;
    }
  }
  return false;
}

function normalizedVideoChange(payload) {
  const event = { type: 'VIDEO_ID_CHANGED' };
  try {
    for (const key of PAYLOAD_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      const value = payload[key];
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        return fail('invalid', 'malformed-page-observation', false);
      }
      event[key] = String(value);
    }
  } catch {
    return fail('invalid', 'malformed-page-observation', false);
  }
  return ok(event);
}

function parseRetryOperation(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return fail('invalid', 'malformed-page-observation', false);
    }
    if (typeof structuredClone === 'function') structuredClone(payload);
    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      return fail('invalid', 'malformed-page-observation', false);
    }
    const keys = Object.getOwnPropertyNames(payload);
    if (Object.getOwnPropertySymbols(payload).length !== 0 || keys.length !== 1 || keys[0] !== 'operationId') {
      return fail('invalid', 'malformed-page-observation', false);
    }
    const descriptor = Object.getOwnPropertyDescriptor(payload, 'operationId');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      return fail('invalid', 'malformed-page-observation', false);
    }
    return typeof descriptor.value === 'string' && descriptor.value.length > 0
      ? ok({ operationId: descriptor.value })
      : fail('invalid', 'malformed-page-observation', false);
  } catch {
    return fail('invalid', 'malformed-page-observation', false);
  }
}

function parseIngress(input, options) {
  try {
    if (!isRecord(input)) return fail('invalid', 'malformed-page-observation', false);
    if (input.category === BACKEND_PROFILE_CATEGORY) return fail('forbidden', 'page-profile-change', false);
    if (options?.authorityEscalated === true || hasForbiddenAuthority(input)) {
      return fail('forbidden', 'page-ingress-variant', false);
    }
    if (typeof input.category !== 'string' || typeof input.variant !== 'string' || !isRecord(input.payload)) {
      return fail('invalid', 'malformed-page-observation', false);
    }
    if (Object.keys(input).some((key) => !ENVELOPE_KEYS.has(key))) {
      return fail('invalid', 'malformed-page-observation', false);
    }
    if (hasForbiddenAuthority(input.payload)) return fail('forbidden', 'page-ingress-variant', false);
    if (input.category === CONTRIBUTION_READ_CATEGORY && CONTRIBUTION_READ_VARIANTS.has(input.variant)) return ok(input);
    if (input.category === CONTRIBUTION_INTENT_CATEGORY && input.variant === CONTRIBUTION_RETRY_VARIANT) {
      return parseRetryOperation(input.payload);
    }
    if (input.category === CONTRIBUTION_INTENT_CATEGORY && CONTRIBUTION_ENQUEUE_VARIANTS.has(input.variant)) return ok(input);
    if (input.category === SUBTITLE_QUERY_CATEGORY && input.variant === REPLACEMENT_SUBTITLE_QUERY_VARIANT) {
      return parseSubtitleQuery(input.payload);
    }
    if (input.category !== PAGE_OBSERVATION_CATEGORY || input.variant !== VIDEO_CONTEXT_CHANGED_VARIANT) {
      return fail('forbidden', 'page-ingress-variant', false);
    }
    if (Object.keys(input.payload).some((key) => !PAYLOAD_KEYS.has(key))) {
      return fail('invalid', 'malformed-page-observation', false);
    }
    return normalizedVideoChange(input.payload);
  } catch {
    return fail('invalid', 'malformed-page-observation', false);
  }
}

function accept(input, options = {}) {
  const parsed = parseIngress(input, options);
  if (!parsed.ok) return parsed;
  if (input.category === CONTRIBUTION_READ_CATEGORY) {
    if (typeof options.contributions?.getProjection !== 'function') {
      return fail('disconnected', 'contributions-unavailable', true);
    }
    try {
      return Promise.resolve(options.contributions.getProjection({ variant: parsed.value.variant, payload: parsed.value.payload }, options.cancellation));
    } catch (error) {
      return fromThrown(error, 'contribution-read-failed');
    }
  }
  if (input.category === CONTRIBUTION_INTENT_CATEGORY) {
    if (input.variant === CONTRIBUTION_RETRY_VARIANT) {
      if (typeof options.contributions?.retry !== 'function') return fail('disconnected', 'contributions-unavailable', true);
      try {
        return Promise.resolve(options.contributions.retry(parsed.value.operationId, options.cancellation));
      } catch (error) {
        return fromThrown(error, 'contribution-retry-failed');
      }
    }
    if (typeof options.contributions?.enqueue !== 'function') {
      return fail('disconnected', 'contributions-unavailable', true);
    }
    try {
      return Promise.resolve(options.contributions.enqueue(parsed.value, options.cancellation));
    } catch (error) {
      return fromThrown(error, 'contribution-enqueue-failed');
    }
  }
  if (input.category === SUBTITLE_QUERY_CATEGORY) {
    if (typeof options.query !== 'function') return fail('disconnected', 'background-port-disconnected', true);
    try {
      return options.query(parsed.value);
    } catch (error) {
      return fromThrown(error, 'subtitle-fetch-failed');
    }
  }
  try {
    options.dispatch?.(parsed.value);
  } catch (error) {
    return fromThrown(error, 'page-observation-dispatch-failed');
  }
  return ok({ status: 'accepted' });
}

export const PageIngress = Object.freeze({ accept });
