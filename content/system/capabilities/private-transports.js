import { fail, isResult, ok } from './result.js';
import { buildSafeDiagnostic } from './private-transport-diagnostics.js';

export const PRIVATE_PROTOCOL_VERSION = 1;
const PRIVATE_ENVELOPE_KEYS = new Set(['protocolVersion', 'requestId', 'kind', 'payload', 'context']);
const INVALID_TREE = Symbol('invalid-private-tree');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidEnvelope(code) {
  return fail('invalid', code, false);
}

export function createEnvelope({ requestId, kind, payload, context }) {
  const envelope = { protocolVersion: PRIVATE_PROTOCOL_VERSION, requestId, kind, payload };
  if (context !== undefined) envelope.context = context;
  return envelope;
}

export function validateEnvelope(envelope) {
  const parsed = strictOwnRecord(envelope, PRIVATE_ENVELOPE_KEYS, new Set());
  if (!parsed) return invalidEnvelope('malformed-private-envelope');
  if (parsed.protocolVersion !== PRIVATE_PROTOCOL_VERSION) return invalidEnvelope('unsupported-protocol-version');
  if (!Object.hasOwn(parsed, 'requestId') || !Object.hasOwn(parsed, 'kind') || !Object.hasOwn(parsed, 'payload') ||
    typeof parsed.requestId !== 'string' || !parsed.requestId || typeof parsed.kind !== 'string' || !parsed.kind ||
    (Object.hasOwn(parsed, 'context') && !isRecord(parsed.context)) || !isCloneable(envelope)) {
    return invalidEnvelope('malformed-private-envelope');
  }
  return ok(parsed);
}

export function dispatchEnvelope(envelope, receiver) {
  const parsed = validateEnvelope(envelope);
  if (!parsed.ok) return parsed;
  try {
    const response = receiver(parsed.value);
    return isResult(response) ? response : ok(response);
  } catch (error) {
    void error;
    return fail('domain-rejected', 'private-envelope-dispatch-failed', false);
  }
}

export function toCompatibilityError(result) {
  const error = result?.error ?? {};
  const code = typeof error.code === 'string' ? error.code : 'transport-failed';
  const compatibilityError = new Error(code);
  compatibilityError.kind = typeof error.kind === 'string' ? error.kind : 'disconnected';
  compatibilityError.code = code;
  compatibilityError.retryable = error.retryable === true;
  return compatibilityError;
}

function createRequestTransport({ responseEvent, listen, remove, send, receive, makeWire, timeoutCode, stopCode, setTimeout: schedule, clearTimeout: cancel }) {
  const pending = new Map();
  let stopped = false;
  const disconnected = () => fail('disconnected', stopCode, true);
  function request(envelope, { deadlineMs = 10000, signal, wire } = {}) {
    if (stopped) return Promise.resolve(disconnected());
    const parsed = validateEnvelope(envelope);
    if (!parsed.ok) return Promise.resolve(parsed);
    const { requestId } = parsed.value;
    if (pending.has(requestId)) return Promise.resolve(invalidEnvelope('duplicate-request-id'));
    return new Promise((resolve) => {
      let settled = false;
      let timerId;
      const cleanup = () => {
        remove(responseEvent, listener);
        if (timerId !== undefined) cancel(timerId);
        signal?.removeEventListener?.('abort', abort);
        pending.delete(requestId);
      };
      const settle = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const listener = (event) => {
        let response;
        try {
          response = receive(event, wire);
        } catch {
          return;
        }
        if (!response || response.requestId !== requestId) return;
        settle(response.result);
      };
      const abort = () => settle(fail('cancelled', 'caller-cancelled', false));
      listen(responseEvent, listener);
      timerId = schedule(() => settle(fail('timeout', timeoutCode, true)), deadlineMs);
      pending.set(requestId, { settle });
      signal?.addEventListener?.('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        send(makeWire(parsed.value, wire));
      } catch (error) {
        void error;
        settle(fail('disconnected', 'transport-send-failed', true));
      }
    });
  }
  return {
    request,
    pendingCount: () => pending.size,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const entry of [...pending.values()]) entry.settle(disconnected());
    }
  };
}

export function createDomTransport({ window, makeEvent, requestEvent = 'messageToContentScript', responseEvent = 'responseFromContentScript', strictResult = false, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  return createRequestTransport({
    responseEvent, listen: window.addEventListener.bind(window), remove: window.removeEventListener.bind(window),
    send: (detail) => window.dispatchEvent(makeEvent(requestEvent, detail)),
    receive: (event) => {
      const requestId = event?.detail?.messageId;
      const response = event?.detail?.response;
      if (typeof requestId !== 'string') return null;
      return {
        requestId,
        result: isResult(response)
          ? response
          : strictResult
            ? fail('domain-rejected', 'dom-response-result-required', false)
            : ok(response)
      };
    },
    makeWire: (envelope, wire) => wire ?? { envelope },
    timeoutCode: 'dom-response-timeout', stopCode: 'dom-transport-stopped', setTimeout, clearTimeout
  });
}

function isOrdinaryObjectPrototype(prototype) {
  if (prototype === Object.prototype) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return Boolean(constructor && Object.hasOwn(constructor, 'value') && typeof constructor.value === 'function' &&
    Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value === prototype &&
    Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(Object));
}

function isOrdinaryArrayPrototype(prototype) {
  if (prototype === Array.prototype) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return Boolean(constructor && Object.hasOwn(constructor, 'value') && typeof constructor.value === 'function' &&
    Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value === prototype &&
    Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(Array));
}

function isCloneablePrimitive(value) {
  return value === null || ['undefined', 'boolean', 'number', 'string', 'bigint'].includes(typeof value);
}

function materializeOwnData(value, ancestors = new Set()) {
  try {
    if (isCloneablePrimitive(value)) return value;
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

function strictOwnRecord(value, allowedKeys, requiredKeys) {
  try {
    const record = materializeOwnData(value);
    if (!record || record === INVALID_TREE || Array.isArray(record)) return null;
    const keys = Object.getOwnPropertyNames(record);
    if (
      (allowedKeys && keys.some(key => !allowedKeys.has(key))) || [...requiredKeys].some(key => !keys.includes(key))) return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
    }
    return record;
  } catch {
    return null;
  }
}

function isCloneable(value) {
  try {
    if (typeof structuredClone !== 'function') return true;
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function parsePageResult(value) {
  const result = strictOwnRecord(value, new Set(['ok', 'value', 'error']), new Set(['ok']));
  if (!result || typeof result.ok !== 'boolean') return null;
  if (result.ok) return Object.hasOwn(result, 'value') && !Object.hasOwn(result, 'error') ? result : null;
  const error = strictOwnRecord(result.error, new Set(['kind', 'code', 'retryable']), new Set(['kind', 'code', 'retryable']));
  return error && !Object.hasOwn(result, 'value') && typeof error.kind === 'string' &&
    typeof error.code === 'string' && typeof error.retryable === 'boolean' ? { ok: false, error } : null;
}

function parsePageResponse(event, window) {
  try {
    if (event?.source !== window || event.origin !== window.location?.origin) return null;
    const message = strictOwnRecord(event.data,
      new Set(['source', 'target', 'requestId', 'response']),
      new Set(['source', 'target', 'requestId', 'response']));
    if (!message || message.source !== 'subpal-page-script' || message.target !== 'subpal-content-script' ||
      typeof message.requestId !== 'string' || !message.requestId) return null;
    const response = parsePageResult(message.response);
    return response && isCloneable(event.data) ? { requestId: message.requestId, result: response } : null;
  } catch {
    return null;
  }
}

export function createPageTransport({ window, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  return createRequestTransport({
    responseEvent: 'message', listen: window.addEventListener.bind(window), remove: window.removeEventListener.bind(window),
    send: (message) => window.postMessage(message, window.location?.origin),
    receive: (event) => parsePageResponse(event, window),
    makeWire: (envelope) => ({ source: 'subpal-content-script', target: 'subpal-page-script', envelope }),
    timeoutCode: 'page-response-timeout', stopCode: 'page-adapter-disconnected', setTimeout, clearTimeout
  });
}

export function createPortTransport({ connect, onNotification = () => {}, isNotification = () => false, reconnectDelayMs = 1000, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  let port = null;
  let reconnectTimer;
  let stopped = false;
  const pending = new Map();
  const disconnected = () => fail('disconnected', 'background-port-disconnected', true);
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      start();
    }, reconnectDelayMs);
  };
  const settlePending = () => {
    for (const entry of pending.values()) entry.settle(disconnected());
  };
  const receive = (sourcePort, message) => {
    if (stopped || port !== sourcePort) return;
    if (isNotification(message)) {
      onNotification(message);
      return;
    }
    const entry = pending.get(message?.messageId);
    if (entry) {
      entry.settle(isResult(message.response) ? message.response : ok(message.response));
      return;
    }
    if (message?.messageId && Object.prototype.hasOwnProperty.call(message, 'response')) return;
    onNotification(message);
  };
  const start = () => {
    if (stopped || port || reconnectTimer !== undefined) return port;
    try {
      const nextPort = connect();
      if (!nextPort) throw new Error('missing port');
      port = nextPort;
      nextPort.onMessage.addListener((message) => receive(nextPort, message));
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) return;
        port = null;
        settlePending();
        scheduleReconnect();
      });
      return port;
    } catch (error) {
      void error;
      scheduleReconnect();
      return null;
    }
  };
  return {
    start,
    request(envelope, { deadlineMs, signal } = {}) {
      const parsed = validateEnvelope(envelope);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (!port) return Promise.resolve(disconnected());
      const { requestId, payload } = parsed.value;
      if (pending.has(requestId)) return Promise.resolve(invalidEnvelope('duplicate-request-id'));
      return new Promise((resolve) => {
        let settled = false;
        let timerId;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          pending.delete(requestId);
          if (timerId !== undefined) clearTimeout(timerId);
          signal?.removeEventListener?.('abort', abort);
          resolve(result);
        };
        const abort = () => settle(fail('cancelled', 'caller-cancelled', false));
        pending.set(requestId, { settle });
        if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
          timerId = setTimeout(() => settle(fail('timeout', 'background-port-timeout', true)), deadlineMs);
        }
        signal?.addEventListener?.('abort', abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          port.postMessage({ messageId: requestId, message: payload });
        } catch (error) {
          void error;
          settle(disconnected());
        }
      });
    },
    pendingCount: () => pending.size,
    reconnectPending: () => reconnectTimer !== undefined,
    stop() {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      port = null;
      settlePending();
    }
  };
}

export function createRuntimeTransport({ runtime, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  return {
    request(envelope, { deadlineMs = 10000, signal } = {}) {
      const parsed = validateEnvelope(envelope);
      if (!parsed.ok) return Promise.resolve(parsed);
      return new Promise((resolve) => {
        let settled = false;
        let timerId;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timerId);
          signal?.removeEventListener?.('abort', abort);
          resolve(result);
        };
        const abort = () => settle(fail('cancelled', 'caller-cancelled', false));
        timerId = setTimeout(() => settle(fail('timeout', 'runtime-response-timeout', true)), deadlineMs);
        signal?.addEventListener?.('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        try {
          runtime.sendMessage(parsed.value.payload, (response) => {
            if (runtime.lastError) return settle(fail('disconnected', 'runtime-last-error', true));
            if (response === undefined) return settle(fail('disconnected', 'runtime-response-missing', true));
            if (isResult(response)) return settle(response);
            if (isRecord(response) && Object.prototype.hasOwnProperty.call(response, 'error')) return settle(fail('domain-rejected', 'runtime-response-error', false));
            settle(ok(response));
          });
        } catch (error) {
          void error;
          settle(fail('disconnected', 'runtime-send-failed', true));
        }
      });
    }
  };
}

export { buildSafeDiagnostic };
