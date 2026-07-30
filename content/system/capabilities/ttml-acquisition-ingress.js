import { fail, ok } from './result.js';

export const TTML_ACQUISITION_CAPTURED_EVENT = 'subpal-ttml-acquisition-captured';

const PROTOCOL_VERSION = 1;
const ENVELOPE_KEYS = new Set(['protocolVersion', 'evidence']);
const EVIDENCE_KEYS = new Set([
  'cacheKey', 'rawContent', 'language', 'requestInfo', 'rawMetadata', 'metadata', 'source'
]);
const BINDING_REGISTRY_KEY = Symbol.for('subpal.ttml-acquisition-ingress.bindings');

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
  constructor(owner) {
    if (!owner || typeof owner.captureTtmlEvidence !== 'function') {
      throw new TypeError('TtmlAcquisitionIngress requires a TTML owner');
    }
    this.owner = owner;
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
