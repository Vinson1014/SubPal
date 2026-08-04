import { fail, isResult, ok } from './result.js';
import { createDomTransport, createEnvelope } from './private-transports.js';
import { validateConfigValue } from '../config/config-schema.js';

const SETTINGS_CATEGORY = 'settings-change';
const SETTINGS_DEADLINE_MS = 5000;
const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);
const ENVELOPE_KEYS = new Set(['category', 'variant', 'payload']);
const FORBIDDEN_KEY_NAMES = new Set([
  'key', 'value', 'items', 'style', 'debug', 'isenabled', 'crowdsourcing', 'video',
  'endpoint', 'profile', 'jwt', 'token', 'auth', 'authorization', 'credential',
  'credentials', 'sync', 'lifecycle', 'storage', 'destination', 'command',
  'playbackcontext', 'videoid', 'sessionid', 'epoch', 'config', 'user', 'userid'
]);
const VARIANTS = Object.freeze({
  'subtitle-languages': {
    payloadKeys: new Set(['primaryLanguage', 'secondaryLanguage']),
    toChanges(payload) {
      return {
        'subtitle.primaryLanguage': payload.primaryLanguage,
        'subtitle.secondaryLanguage': payload.secondaryLanguage
      };
    },
    toSnapshot(payload) {
      return {
        variant: 'subtitle-languages',
        primaryLanguage: payload.primaryLanguage,
        secondaryLanguage: payload.secondaryLanguage
      };
    }
  },
  'dual-subtitles': {
    payloadKeys: new Set(['enabled']),
    toChanges(payload) {
      return { 'subtitle.dualModeEnabled': payload.enabled };
    },
    toSnapshot(payload) {
      return { variant: 'dual-subtitles', enabled: payload.enabled };
    }
  }
});

function isForbiddenKey(key) {
  const normalized = key.toLowerCase();
  return FORBIDDEN_KEY_NAMES.has(normalized) ||
    /(style|debug|crowdsourcing|endpoint|profile|jwt|token|auth|credential|sync|lifecycle|storage|destination|command|playback|video|session|epoch)/.test(normalized);
}

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
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && !isOrdinaryObjectPrototype(prototype)) return { status: 'invalid' };
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) return { status: 'invalid' };
    if (keys.some(isForbiddenKey)) return { status: 'forbidden' };
    if (keys.some(key => !allowedKeys.has(key))) return { status: 'invalid' };

    const record = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        return { status: 'invalid' };
      }
      record[key] = descriptor.value;
    }
    if ([...requiredKeys].some(key => !Object.hasOwn(record, key))) return { status: 'invalid' };
    return { status: 'ok', value: record };
  } catch {
    return { status: 'invalid' };
  }
}

function parseFailure(status) {
  return status === 'forbidden'
    ? fail('forbidden', 'settings-key', false)
    : fail('invalid', 'settings-change', false);
}

function settingsAreValid(changes) {
  try {
    return Object.entries(changes).every(([key, value]) => validateConfigValue(key, value).valid);
  } catch {
    return false;
  }
}

function isCloneable(value) {
  try {
    if (typeof structuredClone === 'function') structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

export function parseSettingsChange(input) {
  const envelope = strictOwnRecord(input, ENVELOPE_KEYS, ENVELOPE_KEYS);
  if (envelope.status !== 'ok') return parseFailure(envelope.status);
  if (envelope.value.category !== SETTINGS_CATEGORY || typeof envelope.value.variant !== 'string') {
    return fail('invalid', 'settings-change', false);
  }
  const variant = VARIANTS[envelope.value.variant];
  if (!variant) return fail('forbidden', 'settings-key', false);

  const payload = strictOwnRecord(envelope.value.payload, variant.payloadKeys, variant.payloadKeys);
  if (payload.status !== 'ok') return parseFailure(payload.status);
  return ok({
    changes: variant.toChanges(payload.value),
    snapshot: variant.toSnapshot(payload.value),
    uncloneable: !isCloneable(input)
  });
}

export function createSettings({ write, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  return Object.freeze({
    change(input) {
      const parsed = parseSettingsChange(input);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (!settingsAreValid(parsed.value.changes)) {
        return Promise.resolve(fail('domain-rejected', 'settings-validation-failed', false));
      }
      if (parsed.value.uncloneable) return Promise.resolve(fail('invalid', 'settings-change', false));

      return new Promise((resolve) => {
        let settled = false;
        let timerId;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timerId);
          resolve(result);
        };

        timerId = setTimeout(() => {
          settle(fail('timeout', 'settings-write-timeout', true));
        }, SETTINGS_DEADLINE_MS);

        let writeResult;
        try {
          writeResult = write(parsed.value.changes);
        } catch {
          settle(fail('domain-rejected', 'settings-write-failed', true));
          return;
        }
        Promise.resolve(writeResult).then(
          () => settle(ok(parsed.value.snapshot)),
          () => settle(fail('domain-rejected', 'settings-write-failed', true))
        );
      });
    }
  });
}

function pageChangeFailure(response) {
  if (!isResult(response)) return fail('domain-rejected', 'settings-change-response-invalid', false);
  if (response.ok) return null;
  if (response.error.kind === 'timeout') return fail('timeout', 'settings-change-timeout', true);
  if (response.error.kind === 'disconnected') return fail('disconnected', 'settings-change-disconnected', true);
  if (response.error.kind === 'cancelled') return fail('cancelled', 'settings-change-cancelled', false);
  if (response.error.kind === 'domain-rejected' && response.error.code === 'settings-validation-failed' && !response.error.retryable) {
    return fail('domain-rejected', 'settings-validation-failed', false);
  }
  if (response.error.kind === 'domain-rejected' && response.error.code === 'settings-write-failed' && response.error.retryable) {
    return fail('domain-rejected', 'settings-write-failed', true);
  }
  return fail('domain-rejected', 'settings-change-response-invalid', false);
}

function requestFromSnapshot(snapshot) {
  if (snapshot.variant === 'subtitle-languages') {
    return {
      category: SETTINGS_CATEGORY,
      variant: snapshot.variant,
      payload: { primaryLanguage: snapshot.primaryLanguage, secondaryLanguage: snapshot.secondaryLanguage }
    };
  }
  return { category: SETTINGS_CATEGORY, variant: snapshot.variant, payload: { enabled: snapshot.enabled } };
}

function normalizePageChangeResponse(response, expected) {
  const failure = pageChangeFailure(response);
  if (failure) return failure;
  const keys = expected.variant === 'subtitle-languages'
    ? new Set(['variant', 'primaryLanguage', 'secondaryLanguage'])
    : new Set(['variant', 'enabled']);
  const acknowledgement = strictOwnRecord(response.value, keys, keys);
  if (acknowledgement.status !== 'ok' || acknowledgement.value.variant !== expected.variant) {
    return fail('domain-rejected', 'settings-change-response-invalid', false);
  }
  for (const key of keys) {
    if (acknowledgement.value[key] !== expected[key]) return fail('domain-rejected', 'settings-change-response-invalid', false);
  }
  return ok(expected);
}

function createRequestId(window) {
  return window.crypto?.randomUUID?.() ?? `page-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createPageSettings({
  window = globalThis.window,
  createRequestId: requestId = () => createRequestId(window),
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout
} = {}) {
  const transport = createDomTransport({
    window,
    makeEvent: (type, detail) => new CustomEvent(type, { detail }),
    strictResult: true,
    setTimeout,
    clearTimeout
  });
  return Object.freeze({
    change(input, cancellation) {
      const parsed = parseSettingsChange(input);
      if (!parsed.ok || parsed.value.uncloneable) {
        return Promise.resolve(parsed.ok ? fail('invalid', 'settings-change', false) : parsed);
      }
      let id;
      try {
        id = requestId();
      } catch {
        return Promise.resolve(fail('disconnected', 'settings-change-disconnected', true));
      }
      if (typeof id !== 'string' || !id) return Promise.resolve(fail('disconnected', 'settings-change-disconnected', true));
      const request = requestFromSnapshot(parsed.value.snapshot);
      const signal = cancellation?.signal ?? cancellation;
      return transport.request(createEnvelope({ requestId: id, kind: SETTINGS_CATEGORY, payload: request }), {
        deadlineMs: SETTINGS_DEADLINE_MS,
        signal,
        wire: { messageId: id, message: request }
      }).then((response) => normalizePageChangeResponse(response, parsed.value.snapshot), () =>
        fail('disconnected', 'settings-change-disconnected', true));
    }
  });
}
