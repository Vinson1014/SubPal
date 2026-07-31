import { fail, fromThrown, ok } from './result.js';
import { parseSubtitleQuery } from './subtitles.js';

const PAGE_OBSERVATION_CATEGORY = 'page-observation';
const VIDEO_CONTEXT_CHANGED_VARIANT = 'video-context-changed';
const SUBTITLE_QUERY_CATEGORY = 'subtitle-query';
const REPLACEMENT_SUBTITLE_QUERY_VARIANT = 'replacement-subtitle-query';
const PAYLOAD_KEYS = new Set(['oldVideoId', 'newVideoId', 'videoId']);
const ENVELOPE_KEYS = new Set(['category', 'variant', 'payload']);
const AUTHORITY_KEYS = new Set([
  'destination', 'command', 'backgroundCommand', 'storage', 'storageKey',
  'endpoint', 'credential', 'credentials', 'sync', 'syncConfig', 'lifecycle', 'lifecycleConfig', 'config'
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasForbiddenAuthority(value) {
  return Object.keys(value).some((key) => AUTHORITY_KEYS.has(key));
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

function parseIngress(input, options) {
  if (!isRecord(input) || options?.authorityEscalated === true) {
    return options?.authorityEscalated === true
      ? fail('forbidden', 'page-ingress-variant', false)
      : fail('invalid', 'malformed-page-observation', false);
  }
  if (hasForbiddenAuthority(input)) return fail('forbidden', 'page-ingress-variant', false);
  if (typeof input.category !== 'string' || typeof input.variant !== 'string' || !isRecord(input.payload)) {
    return fail('invalid', 'malformed-page-observation', false);
  }
  if (Object.keys(input).some((key) => !ENVELOPE_KEYS.has(key))) {
    return fail('invalid', 'malformed-page-observation', false);
  }
  if (input.category === SUBTITLE_QUERY_CATEGORY && input.variant === REPLACEMENT_SUBTITLE_QUERY_VARIANT) {
    return parseSubtitleQuery(input.payload);
  }
  if (input.category !== PAGE_OBSERVATION_CATEGORY || input.variant !== VIDEO_CONTEXT_CHANGED_VARIANT) {
    return fail('forbidden', 'page-ingress-variant', false);
  }
  if (hasForbiddenAuthority(input.payload) || Object.keys(input.payload).some((key) => !PAYLOAD_KEYS.has(key))) {
    return hasForbiddenAuthority(input.payload)
      ? fail('forbidden', 'page-ingress-variant', false)
      : fail('invalid', 'malformed-page-observation', false);
  }
  return normalizedVideoChange(input.payload);
}

function accept(input, options = {}) {
  const parsed = parseIngress(input, options);
  if (!parsed.ok) return parsed;
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
