import { fail, isResult, ok } from './result.js';
import { buildSafeDiagnostic } from './private-transport-diagnostics.js';

export const PRIVATE_PROTOCOL_VERSION = 1;

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
  if (!isRecord(envelope) || envelope.protocolVersion !== PRIVATE_PROTOCOL_VERSION) {
    return invalidEnvelope('unsupported-protocol-version');
  }
  const keys = Object.keys(envelope);
  if (!keys.every((key) => ['protocolVersion', 'requestId', 'kind', 'payload', 'context'].includes(key)) ||
    typeof envelope.requestId !== 'string' || !envelope.requestId || typeof envelope.kind !== 'string' || !envelope.kind ||
    !Object.prototype.hasOwnProperty.call(envelope, 'payload') ||
    (Object.prototype.hasOwnProperty.call(envelope, 'context') && !isRecord(envelope.context))) {
    return invalidEnvelope('malformed-private-envelope');
  }
  return ok(envelope);
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

function createRequestTransport({ responseEvent, listen, remove, send, responseId, responseValue, timeoutCode, setTimeout: schedule, clearTimeout: cancel }) {
  const pending = new Map();
  function request(envelope, { deadlineMs = 10000, signal, wire } = {}) {
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
        if (responseId(event) !== requestId) return;
        const response = responseValue(event);
        settle(isResult(response) ? response : ok(response));
      };
      const abort = () => settle(fail('cancelled', 'caller-cancelled', false));
      listen(responseEvent, listener);
      timerId = schedule(() => settle(fail('timeout', timeoutCode, true)), deadlineMs);
      pending.set(requestId, true);
      signal?.addEventListener?.('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        send(wire ?? { envelope: parsed.value });
      } catch (error) {
        void error;
        settle(fail('disconnected', 'transport-send-failed', true));
      }
    });
  }
  return { request, pendingCount: () => pending.size };
}

export function createDomTransport({ window, makeEvent, requestEvent = 'messageToContentScript', responseEvent = 'responseFromContentScript', setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  return createRequestTransport({
    responseEvent, listen: window.addEventListener.bind(window), remove: window.removeEventListener.bind(window),
    send: (detail) => window.dispatchEvent(makeEvent(requestEvent, detail)),
    responseId: (event) => event?.detail?.messageId, responseValue: (event) => event.detail.response,
    timeoutCode: 'dom-response-timeout', setTimeout, clearTimeout
  });
}

export function createPageTransport({ window, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  return createRequestTransport({
    responseEvent: 'message', listen: window.addEventListener.bind(window), remove: window.removeEventListener.bind(window),
    send: (message) => window.postMessage(message, '*'),
    responseId: (event) => event?.data?.source === 'subpal-page-script' ? event.data.messageId : undefined,
    responseValue: (event) => event.data, timeoutCode: 'page-response-timeout', setTimeout, clearTimeout
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
    for (const { resolve } of pending.values()) resolve(disconnected());
    pending.clear();
  };
  const receive = (sourcePort, message) => {
    if (stopped || port !== sourcePort) return;
    if (isNotification(message)) {
      onNotification(message);
      return;
    }
    const entry = pending.get(message?.messageId);
    if (entry) {
      pending.delete(message.messageId);
      entry.resolve(isResult(message.response) ? message.response : ok(message.response));
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
    request(envelope) {
      const parsed = validateEnvelope(envelope);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (!port) return Promise.resolve(disconnected());
      const { requestId, payload } = parsed.value;
      if (pending.has(requestId)) return Promise.resolve(invalidEnvelope('duplicate-request-id'));
      return new Promise((resolve) => {
        pending.set(requestId, { resolve });
        try {
          port.postMessage({ messageId: requestId, message: payload });
        } catch (error) {
          void error;
          pending.delete(requestId);
          resolve(disconnected());
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
