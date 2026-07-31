import { fail, isResult } from './result.js';

const COMMANDS = Object.freeze({
  list: 'BACKEND_PROFILES_LIST',
  create: 'BACKEND_PROFILES_CREATE',
  activate: 'BACKEND_PROFILES_ACTIVATE',
  delete: 'BACKEND_PROFILES_DELETE',
  exportQueue: 'BACKEND_PROFILES_EXPORT_QUEUE'
});

function invalidProfileInput() {
  return fail('invalid', 'profile-input', false);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function parseCreateInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.hasOwn(input, 'endpoint') || Object.keys(input).length !== 1 || typeof input.endpoint !== 'string') return null;
    return { endpoint: input.endpoint };
  } catch {
    return null;
  }
}

function parseDeleteOptions(options) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'discard') ||
      (Object.hasOwn(options, 'discard') && typeof options.discard !== 'boolean')) return null;
    return { discard: Object.hasOwn(options, 'discard') ? options.discard : false };
  } catch {
    return null;
  }
}

function normalizeResponse(response) {
  return isResult(response)
    ? response
    : fail('domain-rejected', 'backend-profiles-request-failed', false);
}

export function createBackendProfiles({ request, createRequestId = () => crypto.randomUUID() }) {
  const execute = (message) => {
    try {
      return Promise.resolve(request({ requestId: createRequestId(), message }))
        .then(normalizeResponse, () => fail('domain-rejected', 'backend-profiles-request-failed', false));
    } catch {
      return Promise.resolve(fail('domain-rejected', 'backend-profiles-request-failed', false));
    }
  };

  return Object.freeze({
    list() {
      return execute({ type: COMMANDS.list });
    },
    create(input) {
      const parsed = parseCreateInput(input);
      return parsed ? execute({ type: COMMANDS.create, endpoint: parsed.endpoint }) : Promise.resolve(invalidProfileInput());
    },
    activate(profileId) {
      return isNonEmptyString(profileId)
        ? execute({ type: COMMANDS.activate, profileId })
        : Promise.resolve(invalidProfileInput());
    },
    deleteProfile(profileId, options = {}) {
      const parsed = parseDeleteOptions(options);
      return isNonEmptyString(profileId) && parsed
        ? execute({ type: COMMANDS.delete, profileId, discard: parsed.discard })
        : Promise.resolve(invalidProfileInput());
    },
    exportQueue(profileId) {
      return isNonEmptyString(profileId)
        ? execute({ type: COMMANDS.exportQueue, profileId })
        : Promise.resolve(invalidProfileInput());
    }
  });
}
