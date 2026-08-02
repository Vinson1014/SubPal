import { fail, ok } from './result.js';
import { createEnvelope, createPageTransport } from './private-transports.js';

const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);
const CONTEXT_KEYS = new Set(['videoId', 'sessionId', 'epoch']);
const EMPTY_KEYS = new Set();
const TRACK_KEYS = new Set(['code', 'name', 'trackId', 'trackType', 'rawTrackType']);
const SNAPSHOT_KEYS = new Set([
  'pageUrlVideoId', 'playerApiVideoId', 'movieId', 'selectedSessionId', 'selectedSessionReason',
  'sessionSelectionConfidence', 'currentTime', 'duration', 'currentTrack'
]);
const VARIANTS = Object.freeze({
  'context-snapshot': { payloadKeys: EMPTY_KEYS, deadlineMs: 3000, contextBound: false },
  'available-languages': { payloadKeys: EMPTY_KEYS, deadlineMs: 3000, contextBound: true },
  'current-language': { payloadKeys: EMPTY_KEYS, deadlineMs: 3000, contextBound: true },
  'switch-language': { payloadKeys: new Set(['languageCode']), deadlineMs: 10000, contextBound: true },
  'switch-track': { payloadKeys: new Set(['trackId']), deadlineMs: 10000, contextBound: true },
  'jump-to-timecode': {
    payloadKeys: new Set(['targetTimestamp', 'controlId', 'requestId', 'issuedAt']),
    deadlineMs: 3000,
    contextBound: true
  }
});

function isOrdinaryObjectPrototype(prototype) {
  if (prototype === Object.prototype) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !Object.hasOwn(constructor, 'value') || typeof constructor.value !== 'function') return false;
  const constructorPrototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
  return constructorPrototype?.value === prototype &&
    Function.prototype.toString.call(constructor.value) === OBJECT_CONSTRUCTOR_SOURCE;
}

function strictOwnRecord(value, allowedKeys, requiredKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && !isOrdinaryObjectPrototype(prototype)) return null;
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some(key => !allowedKeys.has(key)) ||
      [...requiredKeys].some(key => !keys.includes(key))) return null;
    const record = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function strictOwnArray(value) {
  try {
    if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length !== value.length + 1 || !keys.includes('length') ||
      keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return null;
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function parseExpected(value) {
  const expected = strictOwnRecord(value, CONTEXT_KEYS, CONTEXT_KEYS);
  if (!expected || !isNonEmptyString(expected.videoId) || !isNonEmptyString(expected.sessionId) ||
    !expected.sessionId.startsWith('watch-') || !Number.isInteger(expected.epoch) || expected.epoch < 0) {
    return null;
  }
  return expected;
}

function parsePayload(variant, value) {
  const payload = strictOwnRecord(value, VARIANTS[variant].payloadKeys, VARIANTS[variant].payloadKeys);
  if (!payload) return null;
  if (variant === 'switch-language' && !isNonEmptyString(payload.languageCode)) return null;
  if (variant === 'switch-track' && !(isNonEmptyString(payload.trackId) ||
    (Number.isInteger(payload.trackId) && payload.trackId >= 0))) return null;
  if (variant === 'jump-to-timecode' &&
    (!Number.isFinite(payload.targetTimestamp) || payload.targetTimestamp < 0 ||
      !isNonEmptyString(payload.controlId) || !isNonEmptyString(payload.requestId) ||
      !Number.isFinite(payload.issuedAt))) return null;
  return payload;
}

function isCloneable(value) {
  try {
    return typeof structuredClone === 'function' && (structuredClone(value), true);
  } catch {
    return false;
  }
}

export function parsePlaybackIntent(input) {
  const envelope = strictOwnRecord(input, new Set(['variant', 'payload', 'expected']), new Set(['variant', 'payload']));
  if (!envelope || !isNonEmptyString(envelope.variant) || !Object.hasOwn(VARIANTS, envelope.variant)) {
    return fail('invalid', 'playback-intent', false);
  }
  const variant = VARIANTS[envelope.variant];
  if (variant.contextBound !== Object.hasOwn(envelope, 'expected')) return fail('invalid', 'playback-intent', false);
  const payload = parsePayload(envelope.variant, envelope.payload);
  if (!payload) return fail('invalid', 'playback-intent', false);
  const parsed = { variant: envelope.variant, payload };
  if (variant.contextBound) {
    const expected = parseExpected(envelope.expected);
    if (!expected) return fail('invalid', 'playback-intent', false);
    parsed.expected = expected;
  }
  if (!isCloneable(input)) return fail('invalid', 'playback-intent', false);
  return ok(parsed);
}

function currentContextMatches(expected, getCurrentContext) {
  try {
    const current = getCurrentContext();
    return current?.state === 'ready' &&
      current.videoId === expected.videoId &&
      current.sessionId === expected.sessionId &&
      current.epoch === expected.epoch;
  } catch {
    return false;
  }
}

function parsePageResult(response) {
  const result = strictOwnRecord(response, new Set(['ok', 'value', 'error']), new Set(['ok']));
  if (!result || typeof result.ok !== 'boolean') return null;
  if (result.ok) return Object.hasOwn(result, 'value') && !Object.hasOwn(result, 'error') ? result : null;
  if (Object.hasOwn(result, 'value') || !Object.hasOwn(result, 'error')) return null;
  const error = strictOwnRecord(result.error, new Set(['kind', 'code', 'retryable']), new Set(['kind', 'code', 'retryable']));
  return error && typeof error.kind === 'string' && typeof error.code === 'string' && typeof error.retryable === 'boolean'
    ? { ok: false, error }
    : null;
}

function isControlledString(value) {
  return value === null || typeof value === 'string';
}

function isControlledNumber(value) {
  return value === null || Number.isFinite(value);
}

function projectTrack(value) {
  const track = strictOwnRecord(value, TRACK_KEYS, TRACK_KEYS);
  if (!track || !isControlledString(track.code) || !isControlledString(track.name) ||
    !(track.trackId === null || typeof track.trackId === 'string' || Number.isFinite(track.trackId)) ||
    !isControlledString(track.trackType) || !isControlledString(track.rawTrackType)) return null;
  return {
    code: track.code,
    name: track.name,
    trackId: track.trackId,
    trackType: track.trackType,
    rawTrackType: track.rawTrackType
  };
}

function projectLanguage(value) {
  return value === null ? null : projectTrack(value);
}

function projectSnapshot(value) {
  const playback = strictOwnRecord(value, SNAPSHOT_KEYS, SNAPSHOT_KEYS);
  if (!playback || !isControlledString(playback.pageUrlVideoId) || !isControlledString(playback.playerApiVideoId) ||
    !isControlledString(playback.movieId) || !isControlledString(playback.selectedSessionId) ||
    !isControlledString(playback.selectedSessionReason) || !isControlledString(playback.sessionSelectionConfidence) ||
    !isControlledNumber(playback.currentTime) || !isControlledNumber(playback.duration)) return null;
  const currentTrack = projectLanguage(playback.currentTrack);
  if (currentTrack === null && playback.currentTrack !== null) return null;
  return {
    pageUrlVideoId: playback.pageUrlVideoId,
    playerApiVideoId: playback.playerApiVideoId,
    movieId: playback.movieId,
    selectedSessionId: playback.selectedSessionId,
    selectedSessionReason: playback.selectedSessionReason,
    sessionSelectionConfidence: playback.sessionSelectionConfidence,
    currentTime: playback.currentTime,
    duration: playback.duration,
    currentTrack
  };
}

function projectSuccess(variant, value) {
  if (variant === 'context-snapshot') {
    const outcome = strictOwnRecord(value, new Set(['playback']), new Set(['playback']));
    const playback = outcome && projectSnapshot(outcome.playback);
    return playback ? ok({ variant, playback }) : null;
  }
  if (variant === 'available-languages') {
    const outcome = strictOwnRecord(value, new Set(['languages']), new Set(['languages']));
    const languages = outcome && strictOwnArray(outcome.languages);
    const projected = languages?.map(projectTrack);
    return projected && projected.every(Boolean) ? ok({ variant, languages: projected }) : null;
  }
  if (variant === 'current-language' || variant === 'switch-language' || variant === 'switch-track') {
    const outcome = strictOwnRecord(value, new Set(['language']), new Set(['language']));
    const language = outcome && projectLanguage(outcome.language);
    return language !== null || outcome?.language === null ? ok({ variant, language }) : null;
  }
  const outcome = strictOwnRecord(value, new Set(['status']), new Set(['status']));
  return outcome && ['success', 'partial'].includes(outcome.status) ? ok({ variant, status: outcome.status }) : null;
}

function isBoundedPageReason(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function normalizePageResponse(variant, response) {
  const parsed = parsePageResult(response);
  if (!parsed) return fail('domain-rejected', 'invalid-page-response', false);
  if (parsed.ok) return projectSuccess(variant, parsed.value) ?? fail('domain-rejected', 'invalid-page-response', false);
  switch (parsed.error.kind) {
    case 'timeout':
      return parsed.error.retryable ? fail('timeout', 'playback-timeout', true) : fail('domain-rejected', 'invalid-page-response', false);
    case 'disconnected':
      return parsed.error.retryable ? fail('disconnected', 'page-adapter-disconnected', true) : fail('domain-rejected', 'invalid-page-response', false);
    case 'cancelled':
      return fail('cancelled', 'playback-cancelled', false);
    case 'stale-context':
      return fail('stale-context', 'playback-stale-context', false);
    case 'domain-rejected':
      return isBoundedPageReason(parsed.error.code) && !parsed.error.retryable
        ? fail('domain-rejected', parsed.error.code, false)
        : fail('domain-rejected', 'invalid-page-response', false);
    case 'forbidden':
      return parsed.error.code === 'trusted-click-required' && !parsed.error.retryable
        ? fail('forbidden', 'trusted-click-required', false)
        : fail('domain-rejected', 'invalid-page-response', false);
    default:
      return fail('domain-rejected', 'invalid-page-response', false);
  }
}

function disconnected() {
  return fail('disconnected', 'page-adapter-disconnected', true);
}

export function createPlayback({ getCurrentContext, adapter, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  let disposed = false;
  const pending = new Set();
  return Object.freeze({
    perform(input, cancellation) {
      const parsed = parsePlaybackIntent(input);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (disposed) return Promise.resolve(disconnected());
      const definition = VARIANTS[parsed.value.variant];
      if (definition.contextBound && !currentContextMatches(parsed.value.expected, getCurrentContext)) {
        return Promise.resolve(fail('stale-context', 'playback-stale-context', false));
      }
      const callerSignal = cancellation?.signal ?? cancellation;
      return new Promise((resolve) => {
        const controller = new AbortController();
        let settled = false;
        let timerId;
        const entry = { settle: null, abort: () => controller.abort() };
        const cleanup = () => {
          if (timerId !== undefined) clearTimeout(timerId);
          callerSignal?.removeEventListener?.('abort', cancel);
          pending.delete(entry);
        };
        const settle = (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const cancel = () => {
          settle(fail('cancelled', 'playback-cancelled', false));
          controller.abort();
        };
        entry.settle = settle;
        pending.add(entry);
        timerId = setTimeout(() => {
          settle(fail('timeout', 'playback-timeout', true));
          controller.abort();
        }, definition.deadlineMs);
        callerSignal?.addEventListener?.('abort', cancel, { once: true });
        if (callerSignal?.aborted) {
          cancel();
          return;
        }
        let requestResult;
        try {
          requestResult = adapter.request(parsed.value, { deadlineMs: definition.deadlineMs, signal: controller.signal });
        } catch {
          settle(fail('domain-rejected', 'invalid-page-response', false));
          return;
        }
        Promise.resolve(requestResult).then((response) => {
          if (settled) return;
          if (definition.contextBound && !currentContextMatches(parsed.value.expected, getCurrentContext)) {
            settle(fail('stale-context', 'playback-stale-context', false));
            return;
          }
          settle(normalizePageResponse(parsed.value.variant, response));
        }, () => {
          if (settled) return;
          settle(fail('domain-rejected', 'invalid-page-response', false));
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...pending]) {
        entry.settle(disconnected());
        entry.abort();
      }
    }
  });
}

export function createPagePlayback({
  getCurrentContext,
  window = globalThis.window,
  setTimeout,
  clearTimeout,
  createRequestId = () => window.crypto?.randomUUID?.() ?? `page-playback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  createTransport = createPageTransport
}) {
  const transport = createTransport({ window, setTimeout, clearTimeout });
  const adapter = {
    request(intent, options) {
      const command = {
        requestId: createRequestId(),
        kind: 'playback',
        payload: { variant: intent.variant, payload: intent.payload }
      };
      if (Object.hasOwn(intent, 'expected')) command.context = intent.expected;
      return transport.request(createEnvelope(command), options);
    }
  };
  const playback = createPlayback({ getCurrentContext, adapter, setTimeout, clearTimeout });
  let disposed = false;
  return Object.freeze({
    perform: playback.perform,
    dispose() {
      if (disposed) return;
      disposed = true;
      playback.dispose();
      transport.stop();
    }
  });
}
