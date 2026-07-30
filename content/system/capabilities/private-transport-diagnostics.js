function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value) {
  if (typeof value !== 'string' || !value || value.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/.test(value) || /bearer|jwt|token|authorization|credential|password|endpoint/i.test(value) ||
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return undefined;
  return value;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function safeIds(value, names) {
  if (!isRecord(value)) return undefined;
  const output = {};
  for (const name of names) {
    const candidate = typeof value[name] === 'number' ? safeNumber(value[name]) : safeText(value[name]);
    if (candidate !== undefined) output[name] = candidate;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function buildSafeDiagnostic(input) {
  const output = {};
  for (const name of ['requestId', 'capability', 'operation']) {
    const value = safeText(input?.[name]);
    if (value !== undefined) output[name] = value;
  }
  const protocolVersion = safeNumber(input?.protocolVersion);
  if (protocolVersion !== undefined) output.protocolVersion = protocolVersion;
  const error = input?.result?.ok === false ? input.result.error : null;
  if (isRecord(error)) {
    const kind = safeText(error.kind);
    const code = safeText(error.code);
    if (kind !== undefined && code !== undefined) output.result = { kind, code };
    if (typeof error.retryable === 'boolean') output.retryable = error.retryable;
  }
  for (const name of ['deadlineMs', 'elapsedMs']) {
    const value = safeNumber(input?.[name]);
    if (value !== undefined) output[name] = value;
  }
  const context = isRecord(input?.context) ? input.context : {};
  const playback = safeIds(context.playback, ['videoId', 'sessionId', 'epoch']);
  const profile = safeIds(context.profile, ['profileId', 'userId']);
  if (playback) output.playback = playback;
  if (profile) output.profile = profile;
  return output;
}
