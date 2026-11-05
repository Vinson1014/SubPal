import { fail, ok } from './result.js';
import { createDomTransport, createEnvelope } from './private-transports.js';
import { parseSecondaryRuntimeStatus, SECONDARY_RUNTIME_STATUS_KEY } from '../../../shared/secondary-runtime-status.js';

const OBJECT_SOURCE = Function.prototype.toString.call(Object);

function ownRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
      if (!constructor || !Object.hasOwn(constructor, 'value') || typeof constructor.value !== 'function' ||
          Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value !== prototype ||
          Function.prototype.toString.call(constructor.value) !== OBJECT_SOURCE) return null;
    }
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

export function parseSecondaryRuntimeStatusRequest(input) {
  const request = ownRecord(input, ['category', 'variant', 'payload']);
  const payload = request?.category === 'secondary-runtime-status' && request.variant === 'publish' ?
    ownRecord(request.payload, ['context', 'sequence', 'snapshot']) : null;
  const context = payload && ownRecord(payload.context, ['videoId', 'sessionId', 'epoch']);
  const snapshot = payload && parseSecondaryRuntimeStatus(payload.snapshot);
  if (!context || !snapshot || snapshot.videoId !== context.videoId ||
      typeof context.sessionId !== 'string' || !context.sessionId.startsWith('watch-') || context.sessionId.length > 256 ||
      !Number.isSafeInteger(context.epoch) || context.epoch < 0 ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return null;
  try {
    if (typeof structuredClone === 'function') structuredClone(input);
    return { context, sequence: payload.sequence, snapshot };
  } catch {
    return null;
  }
}

// isolated 唯一 owner：固定單鍵寫入，不接受 MAIN 指定 storage key／設定。
export function createSecondaryRuntimeStatusOwner({ storage, getCurrentContext }) {
  let queue = Promise.resolve();
  let latestSequence = 0;
  let latestEpoch = -1;
  return Object.freeze({
    publish(input) {
      const payload = parseSecondaryRuntimeStatusRequest(input);
      if (!payload) return Promise.resolve(fail('invalid', 'secondary-runtime-status-request', false));
      if (payload.sequence <= latestSequence || payload.context.epoch < latestEpoch) {
        return Promise.resolve(fail('stale', 'secondary-runtime-status-obsolete', false));
      }
      latestSequence = payload.sequence;
      latestEpoch = payload.context.epoch;
      const pending = queue.then(async () => {
        try {
          const current = getCurrentContext();
          // 各 world 的 epoch authority 不同；只比較本 owner 接收的 MAIN epoch，
          // 並以 isolated 的 video/session readiness 再驗一次當前歸屬。
          if (payload.sequence !== latestSequence || current?.state !== 'ready' ||
              current.videoId !== payload.context.videoId || current.sessionId !== payload.context.sessionId) {
            return fail('stale', 'secondary-runtime-status-context', false);
          }
          await storage.set({ [SECONDARY_RUNTIME_STATUS_KEY]: { ...payload.snapshot, updatedAt: Date.now() } });
          return ok({ published: true });
        } catch {
          return fail('disconnected', 'secondary-runtime-status-storage', true);
        }
      });
      queue = pending;
      return pending;
    }
  });
}

export function createPageSecondaryRuntimeStatus({ window = globalThis.window } = {}) {
  return Object.freeze({
    async publish(payload) {
      const message = { category: 'secondary-runtime-status', variant: 'publish', payload };
      if (!parseSecondaryRuntimeStatusRequest(message)) return fail('invalid', 'secondary-runtime-status-request', false);
      const transport = createDomTransport({
        window, strictResult: true,
        makeEvent: (type, detail) => new CustomEvent(type, { detail })
      });
      try {
        const requestId = window.crypto?.randomUUID?.() ?? `secondary-status-${Date.now()}-${Math.random()}`;
        const result = await transport.request(createEnvelope({ requestId, kind: 'secondary-runtime-status', payload: message }), {
          deadlineMs: 5000, wire: { messageId: requestId, message }
        });
        const success = ownRecord(result, ['ok', 'value']);
        const value = success?.ok === true && ownRecord(success.value, ['published']);
        if (value?.published === true) {
          if (typeof structuredClone === 'function') structuredClone(result);
          return ok({ published: true });
        }
        return fail('invalid', 'secondary-runtime-status-response', false);
      } catch {
        return fail('disconnected', 'secondary-runtime-status-disconnected', true);
      } finally {
        transport.stop();
      }
    }
  });
}
