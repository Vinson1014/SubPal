import { fail, ok } from './result.js';
import { createEnvelope, createPageTransport } from './private-transports.js';

export const TTML_ACQUISITION_CAPTURED_EVENT = 'subpal-ttml-acquisition-captured';

const PROTOCOL_VERSION = 1;
const ENVELOPE_KEYS = new Set(['protocolVersion', 'evidence']);
const EVIDENCE_KEYS = new Set([
  'cacheKey', 'rawContent', 'language', 'requestInfo', 'rawMetadata', 'metadata', 'source'
]);
const BINDING_REGISTRY_KEY = Symbol.for('subpal.ttml-acquisition-ingress.bindings');
const INVALID_TREE = Symbol('invalid-ttml-reader-tree');
const RAW_ENTRY_KEYS = new Set(['rawContent', 'requestInfo', 'rawMetadata', 'metadata', 'language', 'timestamp']);
const RAW_RESPONSE_KEYS = new Set(['variant', 'entries']);
const DIAGNOSTIC_RESPONSE_KEYS = new Set(['variant', 'count']);
const RESULT_KEYS = new Set(['ok', 'value', 'error']);
const ERROR_KEYS = new Set(['kind', 'code', 'retryable']);

function getBindings() {
  try {
    if (!globalThis[BINDING_REGISTRY_KEY]) {
      Object.defineProperty(globalThis, BINDING_REGISTRY_KEY, {
        value: new WeakMap(), configurable: false, enumerable: false, writable: false
      });
    }
    return globalThis[BINDING_REGISTRY_KEY];
  } catch {
    return null;
  }
}

function isPlainRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
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

function materializeOwnData(value, ancestors = new Set()) {
  try {
    if (value === null || ['undefined', 'boolean', 'number', 'string', 'bigint'].includes(typeof value)) return value;
    if (typeof value !== 'object' || ancestors.has(value)) return INVALID_TREE;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (!isOrdinaryArrayPrototype(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length !== 0) return INVALID_TREE;
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
      if ((prototype !== null && !isOrdinaryObjectPrototype(prototype)) || Object.getOwnPropertySymbols(value).length !== 0) return INVALID_TREE;
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
    if ((allowedKeys && keys.some((key) => !allowedKeys.has(key))) || [...requiredKeys].some((key) => !keys.includes(key))) return null;
    return record;
  } catch {
    return null;
  }
}

function readerFailure(variant, kind, retryable) {
  const prefix = variant === 'raw-pool' ? 'ttml-raw-pool' : 'ttml-diagnostic-summary';
  return fail(kind, `${prefix}-${kind === 'disconnected' ? 'disconnected' : kind === 'timeout' ? 'timeout' : 'cancelled'}`, retryable);
}

function rawPoolInvalid() {
  return fail('domain-rejected', 'ttml-raw-pool-invalid', false);
}

function diagnosticInvalid() {
  return fail('domain-rejected', 'ttml-diagnostic-summary-invalid', false);
}

function parseResult(result, invalid) {
  const parsed = strictOwnRecord(result, RESULT_KEYS, new Set(['ok']));
  if (!parsed || typeof parsed.ok !== 'boolean') return invalid();
  if (parsed.ok) return Object.hasOwn(parsed, 'value') && !Object.hasOwn(parsed, 'error') ? ok(parsed.value) : invalid();
  const error = strictOwnRecord(parsed.error, ERROR_KEYS, ERROR_KEYS);
  return error && !Object.hasOwn(parsed, 'value') && typeof error.kind === 'string' &&
    typeof error.code === 'string' && typeof error.retryable === 'boolean' ? fail(error.kind, error.code, error.retryable) : invalid();
}

function mapReaderFailure(variant, result, invalid) {
  if (result.error.kind === 'timeout' && result.error.retryable) return readerFailure(variant, 'timeout', true);
  if (result.error.kind === 'disconnected' && result.error.retryable) return readerFailure(variant, 'disconnected', true);
  if (result.error.kind === 'cancelled' && !result.error.retryable) return readerFailure(variant, 'cancelled', false);
  return invalid();
}

function normalizeRawEntries(entries) {
  const map = strictOwnRecord(entries, null, new Set());
  if (!map || Object.getOwnPropertyNames(map).length > 50) return null;
  const normalized = {};
  for (const cacheKey of Object.getOwnPropertyNames(map)) {
    const entry = strictOwnRecord(map[cacheKey], RAW_ENTRY_KEYS, RAW_ENTRY_KEYS);
    if (!isNonEmptyString(cacheKey) || !entry || !isNonEmptyString(entry.rawContent) || !isNonEmptyString(entry.language) ||
      !strictOwnRecord(entry.requestInfo, null, new Set()) ||
      (entry.rawMetadata !== null && !strictOwnRecord(entry.rawMetadata, null, new Set())) ||
      (entry.metadata !== null && !strictOwnRecord(entry.metadata, null, new Set())) ||
      !Number.isFinite(entry.timestamp) || entry.timestamp < 0) return null;
    normalized[cacheKey] = entry;
  }
  return normalized;
}

function normalizeRawPoolResult(result) {
  const parsed = parseResult(result, rawPoolInvalid);
  if (!parsed.ok) return parsed.error?.kind === 'domain-rejected' && parsed.error.code === 'ttml-raw-pool-invalid'
    ? parsed : mapReaderFailure('raw-pool', parsed, rawPoolInvalid);
  const response = strictOwnRecord(parsed.value, new Set(['entries']), new Set(['entries']));
  const entries = response && normalizeRawEntries(response.entries);
  return entries ? ok({ entries }) : rawPoolInvalid();
}

function normalizeDiagnosticResult(result) {
  const parsed = parseResult(result, diagnosticInvalid);
  if (!parsed.ok) return parsed.error?.kind === 'domain-rejected' && parsed.error.code === 'ttml-diagnostic-summary-invalid'
    ? parsed : mapReaderFailure('diagnostic-summary', parsed, diagnosticInvalid);
  const value = strictOwnRecord(parsed.value, new Set(['recentNonTtmlCandidateCount']), new Set(['recentNonTtmlCandidateCount']));
  return value && Number.isInteger(value.recentNonTtmlCandidateCount) && value.recentNonTtmlCandidateCount >= 0
    ? ok({ recentNonTtmlCandidateCount: value.recentNonTtmlCandidateCount }) : diagnosticInvalid();
}

function normalizePageTtmlResponse(variant, result) {
  const parsed = parseResult(result, variant === 'raw-pool' ? rawPoolInvalid : diagnosticInvalid);
  if (!parsed.ok) return mapReaderFailure(variant, parsed, variant === 'raw-pool' ? rawPoolInvalid : diagnosticInvalid);
  if (variant === 'raw-pool') {
    const response = strictOwnRecord(parsed.value, RAW_RESPONSE_KEYS, RAW_RESPONSE_KEYS);
    return response?.variant === 'raw-pool' ? normalizeRawPoolResult(ok({ entries: response.entries })) : rawPoolInvalid();
  }
  const response = strictOwnRecord(parsed.value, DIAGNOSTIC_RESPONSE_KEYS, DIAGNOSTIC_RESPONSE_KEYS);
  return response?.variant === 'diagnostic-summary'
    ? normalizeDiagnosticResult(ok({ recentNonTtmlCandidateCount: response.count })) : diagnosticInvalid();
}

export function createPageTtmlAcquisitionReader({
  window = globalThis.window,
  setTimeout,
  clearTimeout,
  createRequestId = () => window.crypto?.randomUUID?.() ?? `page-ttml-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  createTransport = createPageTransport
} = {}) {
  const transport = createTransport({ window, setTimeout, clearTimeout });
  let disposed = false;
  const query = (variant, deadlineMs, cancellation) => {
    if (disposed) return Promise.resolve(readerFailure(variant, 'disconnected', true));
    const signal = cancellation?.signal ?? cancellation;
    let response;
    try {
      response = transport.request(createEnvelope({
        requestId: createRequestId(),
        kind: 'ttml-acquisition-query',
        payload: { variant, payload: {} }
      }), { deadlineMs, signal });
    } catch {
      return Promise.resolve(readerFailure(variant, 'disconnected', true));
    }
    return Promise.resolve(response).then(
      (result) => normalizePageTtmlResponse(variant, result),
      () => variant === 'raw-pool' ? rawPoolInvalid() : diagnosticInvalid()
    );
  };
  return Object.freeze({
    readRawPool(cancellation) { return query('raw-pool', 5000, cancellation); },
    readDiagnosticSummary(cancellation) { return query('diagnostic-summary', 3000, cancellation); },
    dispose() {
      if (disposed) return;
      disposed = true;
      transport.stop();
    }
  });
}

function isOwnerOutcomeRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.getPrototypeOf(value)?.constructor?.name === 'Object';
  } catch {
    return false;
  }
}

function hasOnlyKeys(value, allowed) {
  try {
    return Object.keys(value).every((key) => allowed.has(key)) && Object.getOwnPropertySymbols(value).length === 0;
  } catch {
    return false;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function malformedEvidence() {
  return fail('invalid', 'malformed-ttml-evidence', false);
}

function parseEvidence(evidence) {
  try {
    if (!isPlainRecord(evidence) || !hasOnlyKeys(evidence, EVIDENCE_KEYS)) return malformedEvidence();
    if (!isNonEmptyString(evidence.cacheKey) || !isNonEmptyString(evidence.rawContent) || !isNonEmptyString(evidence.language)) {
      return malformedEvidence();
    }
    if (!isPlainRecord(evidence.requestInfo) || evidence.source !== 'netflix-page-script') return malformedEvidence();
    for (const key of ['rawMetadata', 'metadata']) {
      if (!Object.prototype.hasOwnProperty.call(evidence, key)) continue;
      if (evidence[key] !== null && !isPlainRecord(evidence[key])) return malformedEvidence();
    }
    return ok(evidence);
  } catch {
    return malformedEvidence();
  }
}

function parseEnvelope(envelope) {
  try {
    if (!isPlainRecord(envelope) || envelope.protocolVersion !== PROTOCOL_VERSION) {
      return fail('invalid', 'unsupported-protocol-version', false);
    }
    if (!hasOnlyKeys(envelope, ENVELOPE_KEYS) || !Object.prototype.hasOwnProperty.call(envelope, 'evidence')) {
      return malformedEvidence();
    }
    return parseEvidence(envelope.evidence);
  } catch {
    return malformedEvidence();
  }
}

function mapOwnerOutcome(outcome, evidence) {
  if (!isOwnerOutcomeRecord(outcome) || typeof outcome.status !== 'string') {
    return fail('domain-rejected', 'ttml-owner-outcome-invalid', false);
  }

  if (outcome.status === 'promoted' || outcome.status === 'retained') {
    const value = { status: outcome.status, cacheKey: evidence.cacheKey, language: evidence.language };
    if (outcome.role === 'primary' || outcome.role === 'secondary') value.role = outcome.role;
    return ok(value);
  }
  if (outcome.status === 'stale-context' && outcome.reason === 'playback-context-transitioning') {
    return fail('stale-context', 'ttml-playback-context-transitioning', true);
  }
  if (outcome.status === 'domain-rejected' && outcome.category === 'gate' && typeof outcome.reason === 'string') {
    return fail('domain-rejected', `ttml-gate-${outcome.reason}`, false);
  }
  if (outcome.status === 'domain-rejected' && outcome.category === 'parse' &&
      (outcome.reason === 'empty' || outcome.reason === 'error')) {
    return fail('domain-rejected', `ttml-parse-${outcome.reason}`, false);
  }
  return fail('domain-rejected', 'ttml-owner-outcome-invalid', false);
}

export class TtmlAcquisitionIngress {
  constructor(owner, reader = null) {
    if (!owner || typeof owner.captureTtmlEvidence !== 'function') {
      throw new TypeError('TtmlAcquisitionIngress requires a TTML owner');
    }
    if (reader && (typeof reader.readRawPool !== 'function' || typeof reader.readDiagnosticSummary !== 'function')) {
      throw new TypeError('TtmlAcquisitionIngress requires a TTML reader');
    }
    this.owner = owner;
    this.reader = reader;
    this.ownsReader = false;
    this.disposed = false;
    this.pendingReads = new Set();
  }

  capture(evidence, options = {}) {
    let parsed;
    try {
      parsed = parseEvidence(evidence);
    } catch {
      return malformedEvidence();
    }
    if (!parsed.ok) return parsed;
    try {
      return mapOwnerOutcome(this.owner.captureTtmlEvidence(parsed.value, options), parsed.value);
    } catch {
      return fail('domain-rejected', 'ttml-owner-capture-failed', false);
    }
  }

  acceptPhysicalCapture(envelope) {
    let parsed;
    try {
      parsed = parseEnvelope(envelope);
    } catch {
      return malformedEvidence();
    }
    if (!parsed.ok) return parsed;
    return this.capture(parsed.value, { resolveWaiters: true });
  }

  readRawPool(cancellation) {
    return this.read('raw-pool', cancellation);
  }

  readDiagnosticSummary(cancellation) {
    return this.read('diagnostic-summary', cancellation);
  }

  read(variant, cancellation) {
    if (this.disposed) return Promise.resolve(readerFailure(variant, 'disconnected', true));
    const reader = this.getReader();
    const read = variant === 'raw-pool' ? reader.readRawPool : reader.readDiagnosticSummary;
    const normalize = variant === 'raw-pool' ? normalizeRawPoolResult : normalizeDiagnosticResult;
    const invalid = variant === 'raw-pool' ? rawPoolInvalid : diagnosticInvalid;

    return new Promise((resolve) => {
      let settled = false;
      const entry = { variant, settle: null };
      entry.settle = (result) => {
        if (settled) return;
        settled = true;
        this.pendingReads.delete(entry);
        resolve(result);
      };
      this.pendingReads.add(entry);

      let result;
      try {
        result = read.call(reader, cancellation);
      } catch {
        entry.settle(invalid());
        return;
      }
      Promise.resolve(result).then(
        (value) => entry.settle(normalize(value)),
        () => entry.settle(invalid())
      );
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const reader = this.reader;
    const ownsReader = this.ownsReader;
    this.reader = null;
    this.ownsReader = false;
    if (ownsReader) reader?.dispose?.();
    for (const entry of [...this.pendingReads]) {
      entry.settle(readerFailure(entry.variant, 'disconnected', true));
    }
  }

  getReader() {
    if (!this.reader) {
      this.reader = createPageTtmlAcquisitionReader();
      this.ownsReader = true;
    }
    return this.reader;
  }
}

export function bindTtmlAcquisitionCapture(window, ingress) {
  if (!window || typeof window.addEventListener !== 'function' || typeof window.removeEventListener !== 'function' ||
      !ingress || typeof ingress.acceptPhysicalCapture !== 'function') {
    throw new TypeError('A MAIN window and TtmlAcquisitionIngress are required');
  }

  const bindings = getBindings();
  if (!bindings) throw new TypeError('TTML acquisition binding registry is unavailable');
  const existing = bindings.get(window);
  if (existing) {
    if (existing.ingress === ingress) return existing.dispose;
    throw new Error('TTML acquisition capture is already bound to a different owner');
  }

  const listener = (event) => {
    try {
      ingress.acceptPhysicalCapture(event?.detail);
    } catch {
      return;
    }
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener(TTML_ACQUISITION_CAPTURED_EVENT, listener);
    if (bindings.get(window)?.ingress === ingress) bindings.delete(window);
  };

  window.addEventListener(TTML_ACQUISITION_CAPTURED_EVENT, listener);
  bindings.set(window, { ingress, dispose });
  return dispose;
}
