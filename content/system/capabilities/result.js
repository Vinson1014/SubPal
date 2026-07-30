export function ok(value) {
  return { ok: true, value };
}

export function fail(kind, code, retryable, meta) {
  const error = { kind, code, retryable };
  if (meta !== undefined) error.meta = meta;
  return { ok: false, error };
}

export function fromThrown(error, code) {
  void error;
  return fail('domain-rejected', code, false);
}

export function isResult(value) {
  if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'ok')) return false;
  const keys = Object.keys(value);
  if (value.ok === true) return keys.length === 2 && keys.includes('value');
  if (value.ok !== false || keys.length !== 2 || !keys.includes('error')) return false;
  const error = value.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const errorKeys = Object.keys(error);
  return typeof error.kind === 'string' && typeof error.code === 'string' && typeof error.retryable === 'boolean' &&
    errorKeys.every((key) => ['kind', 'code', 'retryable', 'meta'].includes(key)) &&
    ['kind', 'code', 'retryable'].every((key) => errorKeys.includes(key));
}
