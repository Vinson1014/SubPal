import { fail, isResult } from './result.js';
import { createDomTransport, createEnvelope } from './private-transports.js';
import { validateConfigValue } from '../config/config-schema.js';

const DEADLINE_MS = 5000;
const INVALID_TREE = Symbol('invalid-settings-snapshot');
const OBJECT_SOURCE = Function.prototype.toString.call(Object);
const REQUEST = Object.freeze({ category: 'settings-read', variant: 'snapshot', payload: Object.freeze({}) });
const RESPONSE_KEYS = new Set(['messageId', 'response']);
const NOTIFICATION_KEYS = new Set(['type', 'key', 'newValue', 'oldValue']);
const NOTIFICATION_DETAIL_KEYS = new Set(['message']);
const RESULT_KINDS = new Set(['cancelled', 'disconnected', 'domain-rejected', 'forbidden', 'invalid', 'stale-context', 'timeout']);

function malformed() {
  return fail('invalid', 'settings-snapshot-malformed', false);
}

function disconnected() {
  return fail('disconnected', 'settings-snapshot-disconnected', true);
}

function timeout() {
  return fail('timeout', 'settings-snapshot-timeout', true);
}

function isOrdinaryObjectPrototype(prototype) {
  if (prototype === Object.prototype) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return Boolean(constructor && Object.hasOwn(constructor, 'value') && typeof constructor.value === 'function' &&
    Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value === prototype &&
    Function.prototype.toString.call(constructor.value) === OBJECT_SOURCE);
}

function isOrdinaryArrayPrototype(prototype) {
  if (prototype === Array.prototype) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return Boolean(constructor && Object.hasOwn(constructor, 'value') && typeof constructor.value === 'function' &&
    Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value === prototype &&
    Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(Array));
}

function materializeOwnData(value, ancestors = new Set()) {
  try {
    if (value === null || ['undefined', 'boolean', 'number', 'string', 'bigint'].includes(typeof value)) return value;
    if (typeof value !== 'object' || ancestors.has(value)) return INVALID_TREE;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (!isOrdinaryArrayPrototype(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length !== 0) {
          return INVALID_TREE;
        }
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        const keys = Object.getOwnPropertyNames(value);
        if (!length || !Object.hasOwn(length, 'value') || length.enumerable || !Number.isSafeInteger(length.value) ||
          length.value < 0 || keys.length !== length.value + 1) return INVALID_TREE;
        const copy = new Array(length.value);
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return INVALID_TREE;
          const nested = materializeOwnData(descriptor.value, ancestors);
          if (nested === INVALID_TREE) return INVALID_TREE;
          copy[index] = nested;
        }
        return copy;
      }
      const prototype = Object.getPrototypeOf(value);
      if ((prototype !== null && !isOrdinaryObjectPrototype(prototype)) || Object.getOwnPropertySymbols(value).length !== 0) {
        return INVALID_TREE;
      }
      const copy = Object.create(prototype);
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return INVALID_TREE;
        const nested = materializeOwnData(descriptor.value, ancestors);
        if (nested === INVALID_TREE) return INVALID_TREE;
        Object.defineProperty(copy, key, { value: nested, enumerable: true, configurable: true, writable: true });
      }
      return copy;
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return INVALID_TREE;
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

function copyResponse(detail, requestId) {
  const copy = materializeOwnData(detail);
  if (!copy || copy === INVALID_TREE || Array.isArray(copy) || !isCloneable(detail)) return null;
  const keys = Object.getOwnPropertyNames(copy);
  if (keys.length !== RESPONSE_KEYS.size || keys.some((key) => !RESPONSE_KEYS.has(key)) || copy.messageId !== requestId) {
    return null;
  }
  return Object.hasOwn(copy, 'response') ? copy.response : INVALID_TREE;
}

function parseSnapshot(value) {
  if (!value || value === INVALID_TREE || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!validateConfigValue(key, value[key]).valid) return null;
    snapshot[key] = value[key];
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function normalizeFailure(result) {
  const { kind } = result.error;
  if (!RESULT_KINDS.has(kind)) return malformed();
  if (kind === 'timeout') return timeout();
  if (kind === 'disconnected' || kind === 'cancelled') return disconnected();
  return fail('domain-rejected', 'settings-snapshot-rejected', false);
}

function normalizeResponse(response) {
  if (response === INVALID_TREE || !isResult(response)) return malformed();
  if (!response.ok) return normalizeFailure(response);
  const snapshot = parseSnapshot(response.value);
  return snapshot ? { ok: true, value: snapshot } : malformed();
}

export function validateSettingsSnapshotResult(result) {
  const copy = materializeOwnData(result);
  if (copy === INVALID_TREE || !isCloneable(result)) return malformed();
  return normalizeResponse(copy);
}

function parseNotificationChange(value) {
  const copy = materializeOwnData(value);
  if (!copy || copy === INVALID_TREE || Array.isArray(copy) || !isCloneable(value) ||
    (Object.getPrototypeOf(copy) !== null && !isOrdinaryObjectPrototype(Object.getPrototypeOf(copy)))) {
    return null;
  }
  const keys = Object.getOwnPropertyNames(copy);
  if (keys.length !== NOTIFICATION_KEYS.size || keys.some((key) => !NOTIFICATION_KEYS.has(key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(copy, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
  }
  if (copy.type !== 'CONFIG_CHANGED' || typeof copy.key !== 'string') return null;
  const next = validateSettingsSnapshotResult({ ok: true, value: { [copy.key]: copy.newValue } });
  const previous = copy.oldValue === undefined
    ? undefined
    : validateSettingsSnapshotResult({ ok: true, value: { [copy.key]: copy.oldValue } });
  return next.ok && (!previous || previous.ok)
    ? { key: copy.key, newValue: next.value[copy.key], oldValue: previous?.value[copy.key] }
    : null;
}

function parseNotificationEvent(event) {
  try {
    const detail = materializeOwnData(event?.detail);
    if (!detail || detail === INVALID_TREE || Array.isArray(detail) || !isCloneable(event?.detail) ||
      (Object.getPrototypeOf(detail) !== null && !isOrdinaryObjectPrototype(Object.getPrototypeOf(detail)))) {
      return null;
    }
    const keys = Object.getOwnPropertyNames(detail);
    if (keys.length !== NOTIFICATION_DETAIL_KEYS.size || keys[0] !== 'message') return null;
    const descriptor = Object.getOwnPropertyDescriptor(detail, 'message');
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable ? parseNotificationChange(descriptor.value) : null;
  } catch {
    return null;
  }
}

export function subscribeSettingsChanges(callback, { window = globalThis.window } = {}) {
  const listener = (event) => {
    const change = parseNotificationEvent(event);
    if (change) callback(change);
  };
  window.addEventListener('messageFromContentScript', listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('messageFromContentScript', listener);
  };
}

function createRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `settings-snapshot-${Date.now()}-${Math.random()}`;
}

export function createSettingsSnapshotClient(options = {}) {
  const window = options.window ?? globalThis.window;
  const makeEvent = options.makeEvent ?? ((type, detail) => new CustomEvent(type, { detail }));
  const requestId = options.createRequestId ?? createRequestId;
  const transport = createDomTransport({
    window,
    makeEvent,
    setTimeout: options.setTimeout ?? globalThis.setTimeout,
    clearTimeout: options.clearTimeout ?? globalThis.clearTimeout
  });
  const pendingReads = new Set();
  let disposed = false;

  const settlePending = () => {
    for (const entry of [...pendingReads]) entry.settle(disconnected());
  };

  return {
    read() {
      if (disposed) return Promise.resolve(disconnected());
      let id;
      try {
        id = requestId();
      } catch {
        return Promise.resolve(disconnected());
      }
      if (typeof id !== 'string' || !id) return Promise.resolve(disconnected());
      return new Promise((resolve) => {
        let settled = false;
        const entry = {
          settle(result) {
            if (settled) return;
            settled = true;
            window.removeEventListener('responseFromContentScript', receive);
            pendingReads.delete(entry);
            resolve(result);
          }
        };
        const receive = (event) => {
          const response = copyResponse(event?.detail, id);
          if (response === null) return;
          entry.settle(validateSettingsSnapshotResult(response));
        };
        pendingReads.add(entry);
        window.addEventListener('responseFromContentScript', receive);
        let request;
        try {
          request = transport.request(createEnvelope({
            requestId: id,
            kind: 'settings-snapshot',
            payload: REQUEST
          }), {
            deadlineMs: DEADLINE_MS,
            wire: { messageId: id, message: REQUEST }
          });
        } catch {
          entry.settle(disconnected());
          return;
        }
        Promise.resolve(request).then((result) => {
          if (settled) return;
          entry.settle(result?.ok === false ? normalizeFailure(result) : malformed());
        }, () => entry.settle(disconnected()));
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      settlePending();
      transport.stop();
    }
  };
}
