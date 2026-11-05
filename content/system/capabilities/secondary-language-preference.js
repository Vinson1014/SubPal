import { fail, ok } from './result.js';
import { createDomTransport, createEnvelope } from './private-transports.js';
import { SUPPORTED_LANGUAGES } from '../config/config-schema.js';

const REQUEST = Object.freeze({ category: 'settings-read', variant: 'last-manual-secondary-language', payload: Object.freeze({}) });
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

export function parseLastManualSecondaryLanguageRequest(input) {
  const request = ownRecord(input, ['category', 'variant', 'payload']);
  if (!request || request.category !== REQUEST.category || request.variant !== REQUEST.variant ||
      !ownRecord(request.payload, [])) return false;
  try {
    if (typeof structuredClone === 'function') structuredClone(input);
    return true;
  } catch {
    return false;
  }
}

export function validateLastManualSecondaryLanguageResult(input) {
  const malformed = () => fail('invalid', 'last-manual-secondary-language-response', false);
  const success = ownRecord(input, ['ok', 'value']);
  const value = success?.ok === true ? ownRecord(success.value, ['language']) : null;
  if (value && SUPPORTED_LANGUAGES.some(item => item.code === value.language)) {
    try {
      if (typeof structuredClone === 'function') structuredClone(input);
      return ok({ language: value.language });
    } catch {
      return malformed();
    }
  }
  const failure = ownRecord(input, ['ok', 'error']);
  const error = failure?.ok === false ? ownRecord(failure.error, ['kind', 'code', 'retryable']) : null;
  if (error && ['timeout', 'disconnected', 'cancelled'].includes(error.kind)) {
    return fail(error.kind, `last-manual-secondary-language-${error.kind}`, error.kind !== 'cancelled');
  }
  return malformed();
}

// 單一用途唯讀能力；MAIN 不傳 storage key，也不能更新偏好。
export function createPageSecondaryLanguagePreference({ window = globalThis.window } = {}) {
  return Object.freeze({
    async read() {
      const transport = createDomTransport({
        window, strictResult: true,
        makeEvent: (type, detail) => new CustomEvent(type, { detail })
      });
      try {
        const requestId = window.crypto?.randomUUID?.() ?? `last-manual-${Date.now()}-${Math.random()}`;
        const result = await transport.request(createEnvelope({ requestId, kind: 'last-manual-secondary-language', payload: REQUEST }), {
          deadlineMs: 5000, wire: { messageId: requestId, message: REQUEST }
        });
        return validateLastManualSecondaryLanguageResult(result);
      } catch {
        return fail('disconnected', 'last-manual-secondary-language-disconnected', true);
      } finally {
        transport.stop();
      }
    }
  });
}
