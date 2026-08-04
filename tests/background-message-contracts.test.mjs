import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPort, loadApiModule, loadBackgroundWithApi, loadBackgroundWithRealApi, sendRuntimeMessage, waitForResponse } from './crowdsourcing-test-harness.mjs';
import { loadSync, loadSyncListener } from './background-sync-metadata-harness.mjs';

const apiBaseUrl = 'https://api.example.test';
const restartDiagnosticKeys = [
  'currentSWInstanceId',
  'previousSWInstanceIdForRestartCheck',
  'onInstalledSWInstanceId',
  'onStartupSWInstanceId'
];

function apiStorage() {
  return {
    api: { baseUrl: apiBaseUrl },
    jwt: 'initial-jwt',
    user: { userId: 'user-1' }
  };
}

function response(body) {
  return { ok: true, async json() { return body; } };
}

function unauthorized() {
  return { ok: false, status: 401, async json() { return { error: 'expired' }; } };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to reject');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const removedSyncMessages = [
  'SYNC_DATA',
  'SYNC_VOTES',
  'SYNC_TRANSLATIONS',
  'SYNC_REPLACEMENT_EVENTS',
  'GET_SYNC_STATUS',
  'TRIGGER_VOTE_SYNC',
  'TRIGGER_TRANSLATION_SYNC',
  'TRIGGER_REPLACEMENT_EVENT_SYNC',
  'RETRY_FAILED_VOTES',
  'RETRY_FAILED_TRANSLATIONS',
  'RETRY_FAILED_REPLACEMENT_EVENTS'
];

async function sendPortMessage(background, messageId, type) {
  const { port, send, sentMessages } = createPort();
  port.name = 'options-page-channel';
  background.connect(port);
  send({ messageId, message: { type } });
  return JSON.parse(JSON.stringify(await waitForResponse(sentMessages, messageId)));
}

function trustedOptionsSender(overrides = {}) {
  return {
    id: 'subpal-extension-id',
    tab: { id: 9, url: 'chrome-extension://test/options.html' },
    url: 'chrome-extension://test/options.html',
    origin: 'chrome-extension://test',
    ...overrides
  };
}

async function sendProfilePortMessage(background, messageId, message, sender = trustedOptionsSender(), name = 'options-page-channel') {
  const { port, send, sentMessages } = createPort();
  port.name = name;
  port.sender = sender;
  background.connect(port);
  send({ messageId, message });
  return JSON.parse(JSON.stringify(await waitForResponse(sentMessages, messageId)));
}

async function waitForCallCount(calls, count) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (calls.length === count) return;
    await new Promise(setImmediate);
  }
  assert.fail(`Expected ${count} calls but received ${calls.length}`);
}

function pendingVote(id) {
  return {
    id,
    videoId: 'netflix-81234567',
    timestamp: 12.5,
    voteType: 'upvote',
    translationID: null,
    originalSubtitle: 'Original subtitle',
    status: 'pending',
    createdAt: 0,
    retryCount: 0,
    error: null,
    backendProfileId: 'default',
    operationId: `vote-operation-${id}`
  };
}

function pendingTranslation(id) {
  return {
    id,
    videoId: 'netflix-81234567',
    timestamp: 12.5,
    original: 'Original subtitle',
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    status: 'pending',
    createdAt: 0,
    retryCount: 0,
    error: null,
    backendProfileId: 'default',
    operationId: `translation-operation-${id}`
  };
}

function pendingReplacementEvent(id) {
  return {
    id,
    translationID: 'translation-1',
    contributorUserID: 'contributor-1',
    beneficiaryUserID: 'beneficiary-1',
    occurredAt: '2026-07-26T20:03:24.000Z',
    status: 'pending',
    createdAt: 0,
    retryCount: 0,
    error: null,
    backendProfileId: 'default',
    operationId: `replacement-operation-${id}`
  };
}

test('Given missing credentials When install runs Then it migrates profiles, registers only the active profile, and initializes sync in order', async () => {
  const storage = { api: { baseUrl: apiBaseUrl } };
  const lifecycleEvents = [];
  let registrations = 0;
  const background = await loadBackgroundWithApi({
    async registerUser(userId, profileId) {
      registrations += 1;
      assert.equal(typeof userId, 'string');
      assert.equal(profileId, 'default');
      lifecycleEvents.push('register:default');
      return { token: 'bootstrap-jwt' };
    }
  }, { lifecycleEvents, storage });

  await background.install();

  assert.equal(registrations, 1);
  assert.deepEqual(lifecycleEvents, ['legacy-migration', 'profile-migration', 'register:default', 'sync-initialize']);
  assert.equal(storage.backendProfiles.byId.default.jwt, 'bootstrap-jwt');
  assert.equal(Object.hasOwn(storage, 'user'), false);
  assert.equal(Object.hasOwn(storage, 'jwt'), false);
  assert.deepEqual(background.alarmCalls, { clear: [], create: [] });
  assert.equal(background.syncListenerImports, 1);
});

test('Given profile migration is unresolved When startup occurs Then no registration or sync happens before readiness', async () => {
  const migration = deferred();
  const lifecycleEvents = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'active-a',
      byId: {
        'active-a': { id: 'active-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
        'inactive-b': { id: 'inactive-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: null }
      }
    }
  };
  const background = await loadBackgroundWithApi({
    async registerUser(userId, profileId) {
      lifecycleEvents.push(`register:${profileId}:${userId}`);
      return { token: 'active-token' };
    }
  }, { lifecycleEvents, profileMigration: migration.promise, storage });

  const startup = background.startup();
  await waitFor(() => background.profileMigrationCalls === 1, 'profile migration to begin');
  assert.deepEqual(lifecycleEvents, ['legacy-migration', 'profile-migration']);

  migration.resolve();
  await startup;

  assert.deepEqual(lifecycleEvents, [
    'legacy-migration',
    'profile-migration',
    'register:active-a:user-a',
    'sync-initialize'
  ]);
  assert.equal(storage.backendProfiles.byId['inactive-b'].jwt, null);
});

test('Given profile migration rejects When install and startup run again Then neither registration nor sync reports success', async () => {
  const migration = deferred();
  const lifecycleEvents = [];
  const background = await loadBackgroundWithApi({
    async registerUser() {
      lifecycleEvents.push('register');
      return { token: 'unexpected-token' };
    }
  }, { lifecycleEvents, profileMigration: migration.promise });

  const install = background.install();
  await waitFor(() => background.profileMigrationCalls === 1, 'profile migration to begin');
  migration.reject(new Error('profile migration rejected'));

  await assert.rejects(install, /profile migration rejected/);
  await assert.rejects(background.startup(), /profile migration rejected/);
  assert.deepEqual(lifecycleEvents, ['legacy-migration', 'profile-migration']);
  assert.equal(background.profileMigrationCalls, 1);
});

test('Given legacy user migration is held When alarms and storage events fire Then the shared barrier starts before profile work', async () => {
  const migration = deferred();
  const alarm = await loadSync({ migration: migration.promise });
  const listener = await loadSyncListener({ voteQueue: [pendingVote('legacy-storage')] }, { migration: migration.promise });

  const alarmRun = alarm.triggerAlarm({ name: 'syncVotesAlarm' });
  listener.triggerStorageChange({ voteQueue: { oldValue: [], newValue: [pendingVote('legacy-storage')] } });
  await new Promise(setImmediate);

  assert.equal(alarm.storageMigrationCalls, 1);
  assert.equal(listener.storageMigrationCalls, 1);
  assert.deepEqual(alarm.apiCalls, []);
  assert.deepEqual(listener.syncCalls, []);

  migration.resolve();
  await alarmRun;
  await waitForCallCount(listener.syncCalls, 1);
});

test('Given registration throws or returns no token When lifecycle initialization runs Then it rejects before direct sync', async () => {
  for (const registerUser of [
    async () => { throw new Error('register failed'); },
    async () => ({ error: 'missing token' })
  ]) {
    const lifecycleEvents = [];
    const background = await loadBackgroundWithApi({ registerUser }, {
      lifecycleEvents,
      storage: { api: { baseUrl: apiBaseUrl } }
    });
    await assert.rejects(background.startup(), /register failed|missing token/);
    assert.equal(lifecycleEvents.includes('sync-initialize'), false);
  }
});

test('Given install and startup overlap while registration is pending When it completes Then one registration and one sync initialize run', async () => {
  const registration = deferred();
  const lifecycleEvents = [];
  let registrations = 0;
  const background = await loadBackgroundWithApi({
    async registerUser() {
      registrations += 1;
      return await registration.promise;
    }
  }, { lifecycleEvents, storage: { api: { baseUrl: apiBaseUrl } } });

  const install = background.install({ reason: 'update' });
  const startup = background.startup();
  await waitFor(() => registrations > 0, 'registration to begin');
  assert.equal(registrations, 1);
  registration.resolve({ token: 'coalesced-token' });
  await Promise.all([install, startup]);
  assert.equal(lifecycleEvents.filter((event) => event === 'sync-initialize').length, 1);
});

test('Given active A and inactive B When startup repeats Then only A is registered and each lifecycle explicitly initializes sync', async () => {
  const lifecycleEvents = [];
  const registrations = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'active-a',
      byId: {
        'active-a': { id: 'active-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
        'inactive-b': { id: 'inactive-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: null }
      }
    }
  };
  const background = await loadBackgroundWithApi({
    async registerUser(userId, profileId) {
      registrations.push({ userId, profileId });
      lifecycleEvents.push(`register:${profileId}`);
      return { token: 'active-token' };
    }
  }, { lifecycleEvents, storage });

  await background.startup();
  await background.install({ reason: 'update' });

  assert.deepEqual(registrations, [{ userId: 'user-a', profileId: 'active-a' }]);
  assert.deepEqual(lifecycleEvents, [
    'legacy-migration',
    'profile-migration',
    'register:active-a',
    'sync-initialize',
    'sync-initialize'
  ]);
  assert.equal(background.profileMigrationCalls, 1);
  assert.equal(storage.backendProfiles.byId['active-a'].jwt, 'active-token');
  assert.equal(storage.backendProfiles.byId['inactive-b'].jwt, null);
});

test('Given the active profile changes while registration is in flight When startup finishes Then the original active profile alone receives its token', async () => {
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'active-a',
      byId: {
        'active-a': { id: 'active-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
        'inactive-b': { id: 'inactive-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: null }
      }
    }
  };
  const background = await loadBackgroundWithApi({
    async registerUser(userId, profileId) {
      assert.equal(userId, 'user-a');
      assert.equal(profileId, 'active-a');
      storage.backendProfiles = { ...storage.backendProfiles, activeProfileId: 'inactive-b' };
      return { token: 'token-for-a' };
    }
  }, { storage });

  await background.startup();

  assert.equal(storage.backendProfiles.byId['active-a'].jwt, 'token-for-a');
  assert.equal(storage.backendProfiles.byId['inactive-b'].jwt, null);
});

test('Given existing credentials When startup runs Then it avoids registration and any proactive JWT alarm', async () => {
  const storage = apiStorage();
  let registrations = 0;
  const background = await loadBackgroundWithApi({
    async registerUser() {
      registrations += 1;
      return { token: 'unexpected-jwt' };
    }
  }, { storage });

  await background.startup();

  assert.equal(registrations, 0);
  assert.deepEqual(background.alarmCalls, { clear: [], create: [] });
});

test('Given seeded legacy restart diagnostics When install, startup, and a second worker evaluation run Then they are ignored without warning while bootstrap and migration continue', async () => {
  const legacyDiagnostics = {
    currentSWInstanceId: 'legacy-current',
    previousSWInstanceIdForRestartCheck: 'legacy-previous',
    onInstalledSWInstanceId: 'legacy-installed',
    onStartupSWInstanceId: 'legacy-startup'
  };
  const storage = {
    api: { baseUrl: apiBaseUrl },
    userID: 'legacy-user',
    currentVideoId: 'legacy-video',
    previousSWSWInstanceIdForRestartCheck: 'legacy-typo',
    ...legacyDiagnostics
  };
  const logs = [];
  let registrations = 0;
  const apiModule = {
    async registerUser(userId) {
      registrations += 1;
      assert.equal(userId, 'legacy-user');
      return { token: 'bootstrap-jwt' };
    }
  };

  const firstWorker = await loadBackgroundWithApi(apiModule, { logs, storage });
  await firstWorker.install({ reason: 'update' });
  await firstWorker.startup();
  const secondWorker = await loadBackgroundWithApi(apiModule, { logs, storage });

  assert.equal(registrations, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.user)), { userId: 'legacy-user' });
  assert.deepEqual(JSON.parse(JSON.stringify(storage.video)), { currentVideoId: 'legacy-video' });
  assert.equal(Object.hasOwn(storage, 'jwt'), false);
  assert.equal(storage.backendProfiles.byId.default.jwt, 'bootstrap-jwt');
  assert.deepEqual(
    Object.fromEntries(restartDiagnosticKeys.map((key) => [key, storage[key]])),
    legacyDiagnostics
  );
  assert.deepEqual(
    [...firstWorker.storageCalls, ...secondWorker.storageCalls]
      .filter(({ keys }) => keys.some((key) => restartDiagnosticKeys.includes(key))),
    []
  );
  assert.equal(
    logs.some(({ level, args }) => level === 'warn' && args.some((value) => String(value).includes('appears to have restarted'))),
    false
  );

  const scriptExecutionLogs = logs.filter(({ level, args }) => (
    level === 'log' && typeof args[0] === 'string' && args[0].startsWith('[Background] Service Worker script executing.')
  ));
  assert.equal(scriptExecutionLogs.length, 2);
  for (const { args } of scriptExecutionLogs) {
    assert.equal(args.length, 1);
    assert.match(args[0], /^\[Background] Service Worker script executing\. Current Instance ID: sw-\d+-[a-z0-9]{5}$/);
  }
});

test('Given simultaneous old-token 401 responses When requests retry Then both share one refresh and retry exactly once', async () => {
  const storage = apiStorage();
  const originalResponses = deferred();
  const originalRequestsStarted = deferred();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) {
      registrations += 1;
      return response({ token: 'refreshed-jwt' });
    }

    requests += 1;
    if (requests <= 2) {
      if (requests === 2) originalRequestsStarted.resolve();
      return originalResponses.promise;
    }
    return response({ success: true });
  }, { storage });

  const first = api.fetchUserStats('first-request');
  const second = api.fetchUserStats('second-request');
  await originalRequestsStarted.promise;
  originalResponses.resolve(unauthorized());
  await Promise.all([first, second]);

  assert.equal(registrations, 1);
  assert.equal(requests, 4);
});

test('Given a second old-token 401 while refresh is in flight When both requests retry Then they join one refresh', async () => {
  const storage = apiStorage();
  const refreshStarted = deferred();
  const refreshResponse = deferred();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) {
      registrations += 1;
      if (registrations === 1) refreshStarted.resolve();
      return refreshResponse.promise;
    }

    requests += 1;
    if (requests <= 2) return unauthorized();
    return response({ success: true });
  }, { storage });

  const first = api.fetchUserStats('first-request');
  await refreshStarted.promise;
  const second = api.fetchUserStats('second-request');
  await new Promise(setImmediate);
  assert.equal(registrations, 1);
  refreshResponse.resolve(response({ token: 'refreshed-jwt' }));
  await Promise.all([first, second]);

  assert.equal(requests, 4);
});

test('Given a delayed 401 from an old request When another request already refreshed the JWT Then it starts a new refresh after the first completes', async () => {
  const storage = apiStorage();
  const refreshStarted = deferred();
  const refreshResponse = deferred();
  const delayedOriginalResponse = deferred();
  const secondOriginalRequestStarted = deferred();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) {
      registrations += 1;
      refreshStarted.resolve();
      return refreshResponse.promise;
    }

    requests += 1;
    if (requests === 1) return unauthorized();
    if (requests === 2) {
      secondOriginalRequestStarted.resolve();
      return delayedOriginalResponse.promise;
    }
    return response({ success: true });
  }, { storage });

  const first = api.fetchUserStats('first-request');
  await refreshStarted.promise;
  const second = api.fetchUserStats('second-request');
  await secondOriginalRequestStarted.promise;
  refreshResponse.resolve(response({ token: 'refreshed-jwt' }));
  await first;
  delayedOriginalResponse.resolve(unauthorized());
  await second;

  assert.equal(registrations, 2);
  assert.equal(requests, 4);
});

test('Given a retry receives another 401 When a later current-token request receives 401 Then the retry stops and the later request can refresh', async () => {
  const storage = apiStorage();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) {
      registrations += 1;
      return response({ token: `refreshed-jwt-${registrations}` });
    }

    requests += 1;
    if (requests === 1 || requests === 2 || requests === 3) return unauthorized();
    return response({ success: true });
  }, { storage });

  await assert.rejects(() => api.fetchUserStats('retry-fails'), /認證已過期且刷新失敗/);
  await api.fetchUserStats('later-request');

  assert.equal(registrations, 2);
  assert.equal(requests, 4);
});

test('Given refresh registration rejects When a later current-token request receives 401 Then the shared refresh state is cleared', async () => {
  const storage = apiStorage();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) {
      registrations += 1;
      if (registrations === 1) return response({ error: 'registration rejected' });
      return response({ token: 'refreshed-jwt' });
    }

    requests += 1;
    if (requests === 1 || requests === 2) return unauthorized();
    return response({ success: true });
  }, { storage });

  await assert.rejects(() => api.fetchUserStats('refresh-rejects'), /認證已過期且刷新失敗/);
  await api.fetchUserStats('later-request');

  assert.equal(registrations, 2);
  assert.equal(requests, 3);
});

test('Given subtitle retries are disabled When its request receives 401 Then it propagates that first response without refresh or retry', async () => {
  const storage = apiStorage();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) registrations += 1;
    requests += 1;
    return unauthorized();
  }, { storage });

  await assert.rejects(
    () => api.fetchSubtitles({ videoId: 'video-1', startTime: 0, duration: 1, autoRetryOn401: false }),
    (error) => error.status === 401
  );

  assert.equal(registrations, 0);
  assert.equal(requests, 1);
});

test('Given user-stat retries are disabled When its request receives 401 Then it propagates that first response without refresh or retry', async () => {
  const storage = apiStorage();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) registrations += 1;
    requests += 1;
    return unauthorized();
  }, { storage });

  await assert.rejects(() => api.fetchUserStats('user-1', false), (error) => error.status === 401);

  assert.equal(registrations, 0);
  assert.equal(requests, 1);
});

test('Given replacement-event retries are disabled When its request receives 401 Then it propagates that first response without refresh or retry', async () => {
  const storage = apiStorage();
  let registrations = 0;
  let requests = 0;
  const api = await loadApiModule(async (url) => {
    if (url === `${apiBaseUrl}/users`) registrations += 1;
    requests += 1;
    return unauthorized();
  }, { storage });

  await assert.rejects(() => api.submitReplacementEvents([], false), (error) => error.status === 401);

  assert.equal(registrations, 0);
  assert.equal(requests, 1);
});

test('Given a trusted popup and retired API proxy messages When they are received Then they are invalid without backend or storage effects', async () => {
  const callerIdentity = '../caller-a?token=malicious';
  const activeProfile = {
    id: 'profile-b',
    endpoint: 'https://backend-b.example.test/v2',
    userId: 'b user/../id',
    jwt: 'jwt-for-profile-b'
  };
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: activeProfile.id,
      byId: {
        'profile-a': { id: 'profile-a', endpoint: 'https://backend-a.example.test', userId: 'user-a', jwt: 'jwt-for-profile-a' },
        [activeProfile.id]: activeProfile
      }
    }
  };
  const requests = [];
  const popupSender = {
    id: 'subpal-extension-id',
    url: 'chrome-extension://test/popup.html',
    origin: 'chrome-extension://test'
  };
  const background = await loadBackgroundWithRealApi(async (url, options) => {
    requests.push({ url, options });
    return response({ success: true, data: { profile: 'b' } });
  }, { storage });

  const stats = await sendRuntimeMessage(background, {
    type: 'POPUP_API_REQUEST',
    api: 'fetchUserStats',
    params: { userId: callerIdentity }
  }, popupSender);
  const registration = await sendRuntimeMessage(background, {
    type: 'POPUP_API_REQUEST',
    api: 'registerUser',
    params: { userId: callerIdentity }
  }, popupSender);

  const invalid = { ok: false, error: { kind: 'invalid', code: 'popup-active-profile-stats', retryable: false } };
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), invalid);
  assert.deepEqual(JSON.parse(JSON.stringify(registration)), invalid);
  assert.deepEqual(requests, []);
  assert.equal(storage.backendProfiles.byId[activeProfile.id].jwt, 'jwt-for-profile-b');
  assert.equal(JSON.stringify({ registration, requests }).includes(callerIdentity), false);
});

test('Given a trusted popup and a retired registration proxy message When it contains hostile details Then it is invalid without exposing them', async () => {
  const secret = 'registration-token and backend identity must not escape';
  const logs = [];
  const background = await loadBackgroundWithRealApi(async () => ({
    ok: false,
    status: 422,
    async json() {
      return { error: { code: 'REGISTRATION_REJECTED', message: secret }, token: secret };
    }
  }), { logs, storage: apiStorage() });
  const response = await sendRuntimeMessage(background, {
    type: 'POPUP_API_REQUEST',
    api: 'registerUser',
    params: { userId: 'caller-controlled-id' }
  }, {
    id: 'subpal-extension-id',
    url: 'chrome-extension://test/popup.html',
    origin: 'chrome-extension://test'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: false,
    error: { kind: 'invalid', code: 'popup-active-profile-stats', retryable: false }
  });
  assert.equal(JSON.stringify({ response, logs }).includes(secret), false);
});

test('Given a hostile backend failure reaches sync When API throws it Then logs and persisted failure retain only status and code metadata', async () => {
  const secret = 'jwt-token subtitle contribution https://user:secret@backend.example.test';
  const logs = [];
  const api = await loadApiModule(async () => ({
    ok: false,
    status: 422,
    async json() {
      return {
        error: { code: 'BUSINESS_RULE_VIOLATION', message: secret },
        token: secret,
        jwt: secret,
        originalSubtitle: secret,
        contribution: secret,
        endpoint: secret
      };
    }
  }), { logs, storage: apiStorage() });
  const error = await captureRejection(api.submitVote({
    videoID: 'video-1',
    timestamp: 1,
    voteType: 'upvote',
    originalSubtitle: 'safe source'
  }));
  const { module, state } = await loadSync({
    isPermanentError: api.isPermanentError,
    submitVote: async () => { throw error; },
    state: {
      backendProfiles: {
        activeProfileId: 'default',
        byId: { default: { id: 'default' } }
      }
    }
  });
  state.voteQueue = [{
    id: 'hostile-vote',
    backendProfileId: 'default',
    status: 'pending',
    videoId: 'video-1',
    timestamp: 1,
    voteType: 'upvote',
    originalSubtitle: 'safe source'
  }];

  await module.namespace.triggerVoteSync();

  assert.equal(error.message, 'API request failed with status 422');
  assert.deepEqual(JSON.parse(JSON.stringify(error.details)), { status: 422, code: 'BUSINESS_RULE_VIOLATION' });
  assert.equal(api.isPermanentError(error), true);
  assert.equal(api.isRetryableError(error), false);
  assert.deepEqual(state.voteQueue.map(({ status, error: persistedError }) => ({ status, persistedError })), [
    { status: 'failed', persistedError: 'API request failed with status 422' }
  ]);
  const exposed = JSON.stringify({
    enumerable: error,
    ownValues: Object.getOwnPropertyNames(error).map((name) => error[name]),
    logs,
    stored: state.voteQueue
  });
  assert.equal(exposed.includes(secret), false);
});

test('Given a trusted Options Port When it invokes each closed profile operation Then it receives only normalized safe outcomes', async () => {
  const calls = [];
  const profiles = {
    async list() {
      calls.push(['list']);
      return [{ id: 'default', hasJwt: true }];
    },
    async create(_storage, options) {
      calls.push(['create', options]);
      return { id: 'created', endpoint: options.endpoint };
    },
    async activate(_storage, profileId) {
      calls.push(['activate', profileId]);
      return { id: profileId, isActive: true };
    },
    async delete(_storage, profileId, options) {
      calls.push(['delete', profileId, options]);
      return true;
    },
    async exportQueue(_storage, profileId) {
      calls.push(['export', profileId]);
      return { profile: { id: profileId }, queues: {}, histories: {}, voteStateByTranslation: {} };
    }
  };
  const background = await loadBackgroundWithApi({}, { profileOperations: profiles });
  const operations = [
    ['list', { type: 'BACKEND_PROFILES_LIST' }, { ok: true, value: [{ id: 'default', hasJwt: true }] }],
    ['create', { type: 'BACKEND_PROFILES_CREATE', endpoint: 'http://localhost:8787/api' }, { ok: true, value: { id: 'created', endpoint: 'http://localhost:8787/api' } }],
    ['activate', { type: 'BACKEND_PROFILES_ACTIVATE', profileId: 'created' }, { ok: true, value: { id: 'created', isActive: true } }],
    ['delete', { type: 'BACKEND_PROFILES_DELETE', profileId: 'created', discard: true }, { ok: true, value: true }],
    ['export', { type: 'BACKEND_PROFILES_EXPORT_QUEUE', profileId: 'created' }, { ok: true, value: { profile: { id: 'created' }, queues: {}, histories: {}, voteStateByTranslation: {} } }]
  ];

  for (const [id, message, expected] of operations) {
    assert.deepEqual(await sendProfilePortMessage(background, `profile-${id}`, message), expected);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['list'],
    ['create', { endpoint: 'http://localhost:8787/api' }],
    ['activate', 'created'],
    ['delete', 'created', { discard: true }],
    ['export', 'created']
  ]);
});

test('Given a cold tab-hosted Options page and legacy userID When its exact production envelope lists profiles Then the ordered migration barrier completes before profile access', async () => {
  const migration = deferred();
  const calls = [];
  const storage = { userID: 'legacy-options-user', api: { baseUrl: apiBaseUrl } };
  const background = await loadBackgroundWithApi({}, {
    profileMigration: migration.promise,
    profileOperations: {
      async list() {
        calls.push({ user: storage.user, userID: storage.userID });
        return [{ id: 'default' }];
      }
    },
    storage
  });
  const { port, send, sentMessages } = createPort();
  port.name = 'options-page-channel';
  port.sender = trustedOptionsSender();
  background.connect(port);

  send({ messageId: 'cold-options-list', message: { type: 'BACKEND_PROFILES_LIST' } });
  await waitFor(() => background.profileMigrationCalls === 1, 'the ordered migration barrier to begin');
  assert.deepEqual(calls, []);
  assert.equal(sentMessages.some(({ messageId }) => messageId === 'cold-options-list'), false);

  migration.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(await waitForResponse(sentMessages, 'cold-options-list'))), {
    ok: true,
    value: [{ id: 'default' }]
  });
  assert.deepEqual(calls, [{ user: { userId: 'legacy-options-user' }, userID: undefined }]);
});

test('Given a trusted Options profile request When the ordered migration barrier rejects Then it returns a sanitized terminal Result without invoking an operation', async () => {
  const migration = deferred();
  migration.promise.catch(() => {});
  let calls = 0;
  const background = await loadBackgroundWithApi({}, {
    profileMigration: migration.promise,
    profileOperations: { async list() { calls += 1; return []; } }
  });
  const { port, send, sentMessages } = createPort();
  port.name = 'options-page-channel';
  port.sender = trustedOptionsSender();
  background.connect(port);

  send({ messageId: 'migration-rejected', message: { type: 'BACKEND_PROFILES_LIST' } });
  await waitFor(() => background.profileMigrationCalls === 1, 'the ordered migration barrier to begin');
  migration.reject(new Error('legacy storage details must not escape'));

  assert.deepEqual(JSON.parse(JSON.stringify(await waitForResponse(sentMessages, 'migration-rejected'))), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'profile-migration-failed', retryable: false }
  });
  assert.equal(calls, 0);
});

test('Given a malformed trusted profile request When it reaches the closed Port route Then it returns profile-input before profile storage or operations', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({}, {
    profileOperations: { async list() { calls.push('list'); return []; } }
  });
  const baseline = background.storageCalls.length;
  const malformed = [
    { type: 'BACKEND_PROFILES_CREATE' },
    { type: 'BACKEND_PROFILES_CREATE', endpoint: 42 },
    { type: 'BACKEND_PROFILES_ACTIVATE', profileId: '' },
    { type: 'BACKEND_PROFILES_DELETE', profileId: 'target', discard: 'yes' },
    { type: 'BACKEND_PROFILES_EXPORT_QUEUE', profileId: 'target', extra: true },
    Object.assign(Object.create({ profileId: 'target' }), { type: 'BACKEND_PROFILES_ACTIVATE' }),
    { get type() { throw new Error('type getter'); } },
    new Proxy({ type: 'BACKEND_PROFILES_LIST' }, { ownKeys() { throw new Error('own keys'); } })
  ];

  for (const [index, message] of malformed.entries()) {
    assert.deepEqual(await sendProfilePortMessage(background, `malformed-${index}`, message), {
      ok: false,
      error: { kind: 'invalid', code: 'profile-input', retryable: false }
    });
  }
  assert.deepEqual(calls, []);
  assert.equal(background.storageCalls.length, baseline);
  assert.equal(background.profileMigrationCalls, 0);
});

test('Given profile commands from non-Options senders When they spoof ports or runtime messages Then they are forbidden without profile storage effects', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({}, {
    profileOperations: { async list() { calls.push('list'); return []; } }
  });
  const baseline = background.storageCalls.length;
  const message = { type: 'BACKEND_PROFILES_LIST' };
  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'options-profile-access', retryable: false } };
  const senders = [
    { id: 'subpal-extension-id', tab: { id: 7 }, url: 'https://www.netflix.com/watch/81234567' },
    { id: 'subpal-extension-id', url: 'chrome-extension://test/popup.html', origin: 'chrome-extension://test' },
    { id: 'subpal-extension-id', tab: { id: 9, url: 'chrome-extension://test/popup.html' }, url: 'chrome-extension://test/options.html', origin: 'chrome-extension://test' },
    { id: 'external-extension-id', url: 'chrome-extension://test/options.html', origin: 'chrome-extension://test' },
    { id: 'subpal-extension-id', url: 'chrome-extension://test/options.html?spoofed', origin: 'chrome-extension://test' },
    { id: 'subpal-extension-id', url: 'chrome-extension://test/options.html', origin: 'chrome-extension://other' },
    { id: 'wrong-id', url: 'chrome-extension://test/options.html', origin: 'chrome-extension://test' },
    {}
  ];

  for (const [index, sender] of senders.entries()) {
    assert.deepEqual(await sendProfilePortMessage(background, `forbidden-${index}`, message, sender), forbidden);
  }
  assert.deepEqual(await sendProfilePortMessage(
    background,
    'content-profile-command',
    message,
    { id: 'subpal-extension-id', tab: { id: 7 }, url: 'https://www.netflix.com/watch/81234567' },
    'subtitle-assistant-channel'
  ), {
    ok: false,
    error: { kind: 'forbidden', code: 'page-profile-change', retryable: false }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await sendRuntimeMessage(background, message, trustedOptionsSender()))), forbidden);
  assert.deepEqual(JSON.parse(JSON.stringify(await sendRuntimeMessage(background, message, {
    id: 'subpal-extension-id', tab: { id: 7 }, url: 'https://www.netflix.com/watch/81234567'
  }))), forbidden);
  assert.deepEqual(calls, []);
  assert.equal(background.storageCalls.length, baseline);
});

test('Given profile operation domain failures When a trusted Options Port invokes them Then it maps errors without raw endpoint or queue details', async () => {
  const background = await loadBackgroundWithApi({}, {
    profileOperations: {
      async create() { throw new Error('Invalid backend endpoint https://user:secret@example.test'); },
      async delete() { throw new Error('Cannot delete a profile with pending, syncing, or failed records'); },
      async activate() { throw new Error('Unknown backend profile: private-id'); },
      async exportQueue() { throw new Error('Export requires the known active profile'); }
    }
  });
  const responses = await Promise.all([
    sendProfilePortMessage(background, 'unsafe-endpoint', { type: 'BACKEND_PROFILES_CREATE', endpoint: 'https://user:secret@example.test' }),
    sendProfilePortMessage(background, 'delete-blocked', { type: 'BACKEND_PROFILES_DELETE', profileId: 'target', discard: false }),
    sendProfilePortMessage(background, 'unknown-profile', { type: 'BACKEND_PROFILES_ACTIVATE', profileId: 'private-id' }),
    sendProfilePortMessage(background, 'inactive-export', { type: 'BACKEND_PROFILES_EXPORT_QUEUE', profileId: 'inactive' })
  ]);

  assert.deepEqual(responses, [
    { ok: false, error: { kind: 'domain-rejected', code: 'unsafe-endpoint', retryable: false } },
    { ok: false, error: { kind: 'domain-rejected', code: 'profile-delete-blocked', retryable: false } },
    { ok: false, error: { kind: 'domain-rejected', code: 'profile-unavailable', retryable: false } },
    { ok: false, error: { kind: 'forbidden', code: 'profile-export-not-active', retryable: false } }
  ]);
  assert.equal(JSON.stringify(responses).includes('secret'), false);
  assert.equal(JSON.stringify(responses).includes('private-id'), false);
});

test('Given an exact trusted Options Port When it retries failed work for an inactive selected profile with confirmation Then it awaits only affected pinned queue triggers and minimizes the response', async () => {
  const retryCalls = [];
  const triggerCalls = [];
  const trigger = deferred();
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'active-a',
      byId: {
        'active-a': { id: 'active-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
        'inactive-b': { id: 'inactive-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: null }
      }
    }
  };
  const background = await loadBackgroundWithApi({}, {
    storage,
    contributionQueue: {
      async retryFailedContributions(_storage, profileId) {
        retryCalls.push(profileId);
        return { vote: 1, translation: 0, replacementEvent: 2 };
      }
    },
    syncModule: {
      async triggerVoteSync(profileId) {
        triggerCalls.push(['vote', profileId]);
        await trigger.promise;
      },
      async triggerTranslationSync(profileId) { triggerCalls.push(['translation', profileId]); },
      async triggerReplacementEventSync(profileId) {
        triggerCalls.push(['replacementEvent', profileId]);
        await trigger.promise;
      }
    }
  });
  const { port, send, sentMessages } = createPort();
  port.name = 'options-page-channel';
  port.sender = trustedOptionsSender();
  background.connect(port);
  send({
    messageId: 'retry-inactive',
    message: { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'inactive-b', confirmInactiveProfile: true }
  });

  await waitFor(() => triggerCalls.length === 2, 'pinned affected queue triggers');
  assert.deepEqual(retryCalls, ['inactive-b']);
  assert.deepEqual(triggerCalls, [['vote', 'inactive-b'], ['replacementEvent', 'inactive-b']]);
  assert.equal(sentMessages.some(({ messageId }) => messageId === 'retry-inactive'), false);
  trigger.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(await waitForResponse(sentMessages, 'retry-inactive'))), {
    ok: true,
    value: { retryScheduled: true }
  });
});

test('Given active A is syncing When confirmed inactive B retry starts through the real owner Then both profiles complete once and ACK waits for B', async () => {
  const activeEntered = deferred();
  const releaseActive = deferred();
  const inactiveEntered = deferred();
  const releaseInactive = deferred();
  const apiCalls = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'active-a',
      byId: {
        'active-a': { id: 'active-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
        'inactive-b': { id: 'inactive-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: null }
      }
    },
    voteQueue: [
      { ...pendingVote('active-vote'), backendProfileId: 'active-a', operationId: 'active-operation' },
      { ...pendingVote('inactive-vote'), backendProfileId: 'inactive-b', operationId: 'inactive-operation', status: 'failed', retryCount: 3, error: 'temporary failure' }
    ],
    voteHistory: [],
    translationQueue: [],
    translationHistory: [],
    replacementEventQueue: [],
    replacementEventHistory: [],
    voteStateByTranslation: {}
  };
  const background = await loadBackgroundWithApi({
    isPermanentError: () => false,
    setVoteState: async () => ({ myVote: null, upvotes: 0, downvotes: 0 }),
    async submitVote(payload) {
      apiCalls.push({ kind: 'vote', profileId: payload.backendProfileId });
      if (payload.backendProfileId === 'active-a') {
        activeEntered.resolve();
        await releaseActive.promise;
      } else {
        inactiveEntered.resolve();
        await releaseInactive.promise;
      }
      return { success: true };
    },
    submitTranslation: async () => ({ success: true }),
    submitReplacementEvents: async () => ({ success: true })
  }, { realContributionQueue: true, realSyncModule: true, storage });
  const { port, send, sentMessages } = createPort();
  port.name = 'options-page-channel';
  port.sender = trustedOptionsSender();
  background.connect(port);

  const activeSync = background.actualSync.triggerVoteSync('active-a');
  await activeEntered.promise;
  send({
    messageId: 'real-inactive-retry',
    message: { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'inactive-b', confirmInactiveProfile: true }
  });

  try {
    await waitFor(() => apiCalls.some(({ profileId }) => profileId === 'inactive-b') ||
      sentMessages.some(({ messageId }) => messageId === 'real-inactive-retry'), 'inactive B API contact or early ACK');
    assert.equal(apiCalls.filter(({ profileId }) => profileId === 'inactive-b').length, 1);
    assert.equal(sentMessages.some(({ messageId }) => messageId === 'real-inactive-retry'), false);

    const duplicateInactiveSync = background.actualSync.triggerVoteSync('inactive-b');
    await new Promise(setImmediate);
    assert.equal(apiCalls.filter(({ profileId }) => profileId === 'inactive-b').length, 1);
    releaseInactive.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(await waitForResponse(sentMessages, 'real-inactive-retry'))), {
      ok: true,
      value: { retryScheduled: true }
    });
    await duplicateInactiveSync;
  } finally {
    releaseInactive.resolve();
    releaseActive.resolve();
    await activeSync;
  }

  assert.deepEqual(apiCalls.map(({ profileId }) => profileId).sort(), ['active-a', 'inactive-b']);
  assert.deepEqual(storage.voteQueue, []);
  assert.deepEqual(storage.voteHistory.map(({ id, operationId, backendProfileId, status }) => ({ id, operationId, backendProfileId, status })).sort((left, right) => left.id.localeCompare(right.id)), [
    { id: 'active-vote', operationId: 'active-operation', backendProfileId: 'active-a', status: 'completed' },
    { id: 'inactive-vote', operationId: 'inactive-operation', backendProfileId: 'inactive-b', status: 'completed' }
  ]);
});

test('Given active A captured its vote snapshot When Options retries another A failure Then ACK waits for the queued same-profile run', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();
  const releaseSecond = deferred();
  const apiCalls = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'active-a',
      byId: { 'active-a': { id: 'active-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null } }
    },
    voteQueue: [
      { ...pendingVote('active-first'), videoId: 'video-first', backendProfileId: 'active-a', operationId: 'operation-first' },
      {
        ...pendingVote('active-retried'), videoId: 'video-retried', backendProfileId: 'active-a', operationId: 'operation-retried',
        status: 'failed', retryCount: 3, error: 'temporary failure',
        errorMetadata: { terminal: true, private: 'must-be-removed' }, syncStartedAt: 123
      }
    ],
    voteHistory: [],
    translationQueue: [],
    translationHistory: [],
    replacementEventQueue: [],
    replacementEventHistory: [],
    voteStateByTranslation: {}
  };
  const background = await loadBackgroundWithApi({
    isPermanentError: () => false,
    setVoteState: async () => ({ myVote: null, upvotes: 0, downvotes: 0 }),
    async submitVote(payload) {
      apiCalls.push(payload.videoID);
      if (apiCalls.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else {
        secondEntered.resolve();
        await releaseSecond.promise;
      }
      return { success: true };
    },
    submitTranslation: async () => ({ success: true }),
    submitReplacementEvents: async () => ({ success: true })
  }, { realContributionQueue: true, realSyncModule: true, storage });
  const { port, send, sentMessages } = createPort();
  port.name = 'options-page-channel';
  port.sender = trustedOptionsSender();
  background.connect(port);

  const activeSync = background.actualSync.triggerVoteSync('active-a');
  await firstEntered.promise;
  send({
    messageId: 'same-profile-retry',
    message: { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'active-a', confirmInactiveProfile: false }
  });

  try {
    await waitFor(() => storage.voteQueue.find(({ id }) => id === 'active-retried')?.status === 'pending', 'same-profile retry reset');
    for (let turn = 0; turn < 5; turn += 1) await new Promise(setImmediate);
    assert.equal(sentMessages.some(({ messageId }) => messageId === 'same-profile-retry'), false);

    releaseFirst.resolve();
    await waitFor(() => apiCalls.length === 2 || sentMessages.some(({ messageId }) => messageId === 'same-profile-retry'), 'trailing API contact or early ACK');
    assert.deepEqual(apiCalls, ['video-first', 'video-retried']);
    assert.equal(sentMessages.some(({ messageId }) => messageId === 'same-profile-retry'), false);
    releaseSecond.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(await waitForResponse(sentMessages, 'same-profile-retry'))), {
      ok: true,
      value: { retryScheduled: true }
    });
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await activeSync;
  }

  assert.deepEqual(storage.voteQueue, []);
  assert.deepEqual(storage.voteHistory.map(({ id }) => id).sort(), ['active-first', 'active-retried']);
});

test('Given startup retries failed records with private metadata When initializeSync completes Then all queue histories are sanitized', async () => {
  const secret = 'private-terminal-metadata-must-not-survive-startup';
  const failed = (record) => ({
    ...record,
    status: 'failed', retryCount: 3, error: 'temporary failure', syncStartedAt: 123,
    errorMetadata: { terminal: true, diagnostic: secret }
  });
  const { module, state, apiCalls } = await loadSync({
    state: {
      voteQueue: [failed(pendingVote('startup-vote'))],
      translationQueue: [failed(pendingTranslation('startup-translation'))],
      replacementEventQueue: [failed(pendingReplacementEvent('startup-replacement'))]
    }
  });

  await module.namespace.initializeSync();

  const histories = [state.voteHistory, state.translationHistory, state.replacementEventHistory];
  assert.deepEqual(histories.map((history) => history.map((record) => ({
    id: record.id,
    hasErrorMetadata: Object.hasOwn(record, 'errorMetadata'),
    hasSyncStartedAt: Object.hasOwn(record, 'syncStartedAt'),
    hasRetryCount: Object.hasOwn(record, 'retryCount'),
    hasError: Object.hasOwn(record, 'error')
  }))), [
    [{ id: 'startup-vote', hasErrorMetadata: false, hasSyncStartedAt: false, hasRetryCount: false, hasError: false }],
    [{ id: 'startup-translation', hasErrorMetadata: false, hasSyncStartedAt: false, hasRetryCount: false, hasError: false }],
    [{ id: 'startup-replacement', hasErrorMetadata: false, hasSyncStartedAt: false, hasRetryCount: false, hasError: false }]
  ]);
  assert.equal(JSON.stringify(apiCalls).includes(secret), false);
  assert.equal(JSON.stringify(histories).includes(secret), false);
});

test('Given unconfirmed, unknown, malformed, or untrusted bulk retry requests When they reach the closed profile route Then they have no retry effects and return safe Results', async () => {
  const retryCalls = [];
  const triggerCalls = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'active-a',
      byId: {
        'active-a': { id: 'active-a', endpoint: 'https://a.example.test', userId: 'user-a', jwt: null },
        'inactive-b': { id: 'inactive-b', endpoint: 'https://b.example.test', userId: 'user-b', jwt: null }
      }
    }
  };
  const background = await loadBackgroundWithApi({}, {
    storage,
    contributionQueue: {
      async retryFailedContributions(_storage, profileId) { retryCalls.push(profileId); return { vote: 1, translation: 1, replacementEvent: 1 }; }
    },
    syncModule: {
      async triggerVoteSync(profileId) { triggerCalls.push(['vote', profileId]); },
      async triggerTranslationSync(profileId) { triggerCalls.push(['translation', profileId]); },
      async triggerReplacementEventSync(profileId) { triggerCalls.push(['replacementEvent', profileId]); }
    }
  });
  const baseline = background.storageCalls.length;
  const request = { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'inactive-b', confirmInactiveProfile: false };
  assert.deepEqual(await sendProfilePortMessage(background, 'unconfirmed-inactive', request), {
    ok: false,
    error: { kind: 'forbidden', code: 'profile-inactive-confirmation-required', retryable: false }
  });
  assert.deepEqual(await sendProfilePortMessage(background, 'unknown-profile', {
    type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'missing-private-profile', confirmInactiveProfile: true
  }), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'profile-unavailable', retryable: false }
  });
  const accessor = { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'inactive-b' };
  Object.defineProperty(accessor, 'confirmInactiveProfile', { enumerable: true, get() { return true; } });
  const symbol = { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'inactive-b', confirmInactiveProfile: true };
  symbol[Symbol('authority')] = true;
  for (const message of [
    { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'inactive-b', confirmInactiveProfile: 'true' },
    { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'inactive-b', confirmInactiveProfile: true, backendProfileId: 'forged' },
    Object.assign(Object.create({ profileId: 'inactive-b' }), { type: 'BACKEND_PROFILES_RETRY_FAILED', confirmInactiveProfile: true }),
    accessor,
    symbol
  ]) {
    assert.deepEqual(await sendProfilePortMessage(background, 'malformed-retry', message), {
      ok: false,
      error: { kind: 'invalid', code: 'profile-input', retryable: false }
    });
  }
  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'options-profile-access', retryable: false } };
  assert.deepEqual(await sendProfilePortMessage(background, 'netflix-retry', request, {
    id: 'subpal-extension-id', tab: { id: 7, url: 'https://www.netflix.com/watch/81234567' }, url: 'https://www.netflix.com/watch/81234567', origin: 'https://www.netflix.com'
  }), forbidden);
  assert.deepEqual(JSON.parse(JSON.stringify(await sendRuntimeMessage(background, request, trustedOptionsSender()))), forbidden);
  assert.deepEqual(retryCalls, []);
  assert.deepEqual(triggerCalls, []);
  assert.equal(background.storageCalls.length, baseline);
});

test('Given a content Port When CONTENT_SCRIPT_READY is received Then it receives the ordinary unhandled response', async () => {
  const background = await loadBackgroundWithApi({}, {});
  const { port, send, sentMessages } = createPort();
  background.connect(port);

  send({ messageId: 'content-script-ready', message: { type: 'CONTENT_SCRIPT_READY' } });

  assert.deepEqual(
    JSON.parse(JSON.stringify(await waitForResponse(sentMessages, 'content-script-ready'))),
    { success: false, error: 'Unhandled message type (port) CONTENT_SCRIPT_READY' }
  );
});

test('Given retired generic sync commands When they reach the background port Then each receives the ordinary unhandled response without invoking a sync handler', async () => {
  const background = await loadBackgroundWithApi({}, {});

  for (const type of removedSyncMessages) {
    assert.deepEqual(
      await sendPortMessage(background, `removed-${type}`, type),
      { success: false, error: `Unhandled message type (port) ${type}` }
    );
  }
  assert.deepEqual(background.storageCalls, []);
  assert.equal(background.profileMigrationCalls, 0);
});

test('Given pending queues When each exported sync trigger runs Then votes, translations, and replacement events synchronize', async () => {
  const { module, state, apiCalls } = await loadSync();
  state.voteQueue = [pendingVote('vote-export')];
  state.translationQueue = [pendingTranslation('translation-export')];
  state.replacementEventQueue = [pendingReplacementEvent('replacement-export')];

  await module.namespace.triggerVoteSync();
  await module.namespace.triggerTranslationSync();
  await module.namespace.triggerReplacementEventSync();

  assert.deepEqual(apiCalls.map(({ kind }) => kind), [
    'submitVote',
    'submitTranslation',
    'submitReplacementEvents'
  ]);
});

test('Given active B and mixed queue bindings When sync runs Then only B-bound records mutate or reach explicitly pinned APIs', async () => {
  const { apiCalls, module, state } = await loadSync({
    state: {
      backendProfiles: {
        activeProfileId: 'b',
        byId: { a: { id: 'a' }, b: { id: 'b' } }
      }
    }
  });
  state.voteQueue = [
    { ...pendingVote('vote-a'), backendProfileId: 'a' },
    { ...pendingVote('vote-b'), backendProfileId: 'b' },
    { ...pendingVote('vote-unbound'), backendProfileId: undefined },
    { ...pendingVote('vote-unknown'), backendProfileId: 'missing' }
  ];
  state.translationQueue = [
    { ...pendingTranslation('translation-a'), backendProfileId: 'a' },
    { ...pendingTranslation('translation-b'), backendProfileId: 'b' }
  ];
  state.replacementEventQueue = [
    { ...pendingReplacementEvent('event-a'), backendProfileId: 'a' },
    { ...pendingReplacementEvent('event-b'), backendProfileId: 'b' }
  ];

  await module.namespace.triggerVoteSync();
  await module.namespace.triggerTranslationSync();
  await module.namespace.triggerReplacementEventSync();

  assert.deepEqual(apiCalls.map(({ kind, payload }) => [kind, payload.backendProfileId]), [
    ['submitVote', 'b'],
    ['submitTranslation', 'b'],
    ['submitReplacementEvents', undefined]
  ]);
  assert.deepEqual(state.voteQueue.map(({ id }) => id).sort(), ['vote-a', 'vote-unbound', 'vote-unknown']);
  assert.deepEqual(state.translationQueue.map(({ id }) => id), ['translation-a']);
  assert.deepEqual(state.replacementEventQueue.map(({ id }) => id), ['event-a']);
});

test('Given a migrated vote binding When vote-state sync succeeds Then storage preserves it without adding profile metadata to the API payload', async () => {
  const { apiCalls, module, state } = await loadSync({
    state: {
      backendProfiles: {
        activeProfileId: 'migrated-profile',
        byId: { 'migrated-profile': { id: 'migrated-profile' } }
      }
    }
  });
  state.voteQueue = [{
    ...pendingVote('vote-profile-binding'),
    translationID: 'translation-profile-binding',
    voteState: 'like',
    backendProfileId: 'migrated-profile'
  }];

  await module.namespace.triggerVoteSync();

  assert.equal(apiCalls[0].kind, 'setVoteState');
  assert.equal(apiCalls[0].payload.backendProfileId, 'migrated-profile');
  assert.equal(state.voteStateByTranslation['translation-profile-binding'].backendProfileId, 'migrated-profile');
});

test('Given records bound to active A and inactive B When the active profile switches Then each sync moves only the selected profile records with stable local IDs', async () => {
  const { apiProfileIds, module, state } = await loadSync({
    captureActiveProfile: true,
    state: {
      backendProfiles: {
        activeProfileId: 'active-a',
        byId: { 'active-a': { id: 'active-a' }, 'inactive-b': { id: 'inactive-b' } }
      }
    }
  });
  const queueTypes = [
    ['voteQueue', 'voteHistory', 'triggerVoteSync', pendingVote, 'vote'],
    ['translationQueue', 'translationHistory', 'triggerTranslationSync', pendingTranslation, 'translation'],
    ['replacementEventQueue', 'replacementEventHistory', 'triggerReplacementEventSync', pendingReplacementEvent, 'replacement']
  ];

  for (const [queueKey, , , createItem, prefix] of queueTypes) {
    state[queueKey] = [
      { ...createItem(`${prefix}-a`), backendProfileId: 'active-a', operationId: `${prefix}-operation-a` },
      { ...createItem(`${prefix}-b`), backendProfileId: 'inactive-b', operationId: `${prefix}-operation-b` }
    ];
  }

  for (const [, , trigger] of queueTypes) await module.namespace[trigger]();

  for (const [queueKey, , , , prefix] of queueTypes) {
    assert.deepEqual(state[queueKey].map(({ operationId, backendProfileId, status }) => ({ operationId, backendProfileId, status })), [
      { operationId: `${prefix}-operation-b`, backendProfileId: 'inactive-b', status: 'pending' }
    ], queueKey);
  }

  state.backendProfiles.activeProfileId = 'inactive-b';
  for (const [, , trigger] of queueTypes) await module.namespace[trigger]();

  assert.deepEqual(apiProfileIds, [
    'active-a', 'active-a', 'active-a', 'inactive-b', 'inactive-b', 'inactive-b'
  ]);
  for (const [queueKey, historyKey, , , prefix] of queueTypes) {
    assert.deepEqual(state[queueKey], [], queueKey);
    assert.deepEqual(
      state[historyKey]
        .map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId }))
        .sort((left, right) => left.operationId.localeCompare(right.operationId)),
      [
        { operationId: `${prefix}-operation-a`, backendProfileId: 'active-a' },
        { operationId: `${prefix}-operation-b`, backendProfileId: 'inactive-b' }
      ],
      historyKey
    );
  }
});

test('Given activation changes from A to B while initialization recovers stale work When initialization selects work Then recovery and delivery remain pinned to A', async () => {
  let activated = false;
  const { apiCalls, module, resolvedProfileIds, state } = await loadSync({
    state: {
      backendProfiles: {
        activeProfileId: 'active-a',
        byId: { 'active-a': { id: 'active-a' }, 'inactive-b': { id: 'inactive-b' } }
      }
    },
    beforeStorageGet({ keys, state: currentState }) {
      if (!activated && keys.includes('voteQueue')) {
        activated = true;
        currentState.backendProfiles.activeProfileId = 'inactive-b';
      }
    }
  });
  state.voteQueue = [
    { ...pendingVote('stale-a'), backendProfileId: 'active-a', operationId: 'stale-a-operation', status: 'syncing' },
    { ...pendingVote('failed-b'), backendProfileId: 'inactive-b', operationId: 'failed-b-operation', status: 'failed' }
  ];

  await module.namespace.initializeSync();

  assert.deepEqual(resolvedProfileIds, ['active-a']);
  assert.deepEqual(apiCalls.map(({ kind, payload }) => [kind, payload.backendProfileId]), [
    ['submitVote', 'active-a']
  ]);
  assert.deepEqual(state.voteQueue.map(({ id, operationId, backendProfileId, status }) => ({ id, operationId, backendProfileId, status })), [
    { id: 'failed-b', operationId: 'failed-b-operation', backendProfileId: 'inactive-b', status: 'failed' }
  ]);
  assert.deepEqual(state.voteHistory.map(({ id, operationId, backendProfileId }) => ({ id, operationId, backendProfileId })), [
    { id: 'stale-a', operationId: 'stale-a-operation', backendProfileId: 'active-a' }
  ]);
});

test('Given active A work is rebound after selection When a direct vote sync mutates it Then the now-cross-profile record is not sent or moved', async () => {
  let voteQueueReads = 0;
  const { apiCalls, module, state } = await loadSync({
    state: {
      backendProfiles: {
        activeProfileId: 'active-a',
        byId: { 'active-a': { id: 'active-a' }, 'inactive-b': { id: 'inactive-b' } }
      }
    },
    afterStorageGet({ keys, state: currentState }) {
      if (keys.includes('voteQueue') && ++voteQueueReads === 2) {
        currentState.voteQueue[0].backendProfileId = 'inactive-b';
      }
    }
  });
  state.voteQueue = [{ ...pendingVote('raced-vote'), backendProfileId: 'active-a' }];

  await module.namespace.triggerVoteSync();

  assert.deepEqual(apiCalls, []);
  assert.deepEqual(state.voteQueue.map(({ id, backendProfileId, status }) => ({ id, backendProfileId, status })), [
    { id: 'raced-vote', backendProfileId: 'inactive-b', status: 'pending' }
  ]);
  assert.deepEqual(state.voteHistory, []);
});

test('Given 101 active and 101 inactive replacement events When replacement sync runs Then only the active profile is submitted in homogeneous batches and removed once', async () => {
  const { apiCalls, module, state } = await loadSync({
    state: {
      backendProfiles: {
        activeProfileId: 'active-a',
        byId: { 'active-a': { id: 'active-a' }, 'inactive-b': { id: 'inactive-b' } }
      }
    }
  });
  const activeEvents = Array.from({ length: 101 }, (_, index) => ({
    ...pendingReplacementEvent(`active-${index}`),
    translationID: `active-translation-${index}`,
    backendProfileId: 'active-a'
  }));
  const inactiveEvents = Array.from({ length: 101 }, (_, index) => ({
    ...pendingReplacementEvent(`inactive-${index}`),
    translationID: `inactive-translation-${index}`,
    backendProfileId: 'inactive-b'
  }));
  state.replacementEventQueue = [...activeEvents, ...inactiveEvents];

  await module.namespace.triggerReplacementEventSync();

  const replacementCalls = apiCalls.filter(({ kind }) => kind === 'submitReplacementEvents');
  assert.deepEqual(replacementCalls.map(({ payload, backendProfileId }) => [payload.length, backendProfileId]), [
    [100, 'active-a'],
    [1, 'active-a']
  ]);
  assert.equal(replacementCalls.flatMap(({ payload }) => payload).every((event) => event.translationID.startsWith('active-')), true);
  assert.equal(state.replacementEventQueue.length, 101);
  assert.equal(state.replacementEventQueue.every(({ backendProfileId, status }) => backendProfileId === 'inactive-b' && status === 'pending'), true);
  assert.deepEqual(
    state.replacementEventQueue.map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId })),
    inactiveEvents.map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId }))
  );
  assert.equal(state.replacementEventHistory.length, 100);
  assert.equal(state.replacementEventHistory.every(({ backendProfileId }) => backendProfileId === 'active-a'), true);
  assert.deepEqual(
    state.replacementEventHistory.map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId })).sort((left, right) => left.operationId.localeCompare(right.operationId)),
    activeEvents.slice(1).map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId })).sort((left, right) => left.operationId.localeCompare(right.operationId))
  );
});

test('Given an active replacement batch rejects transiently When it is synchronized Then every active item returns to pending without leaving syncing records', async () => {
  const transient = new Error('temporary backend failure');
  const { apiCalls, module, state } = await loadSync({
    submitReplacementEvents: async () => { throw transient; },
    state: {
      backendProfiles: {
        activeProfileId: 'active-b',
        byId: { 'active-b': { id: 'active-b' }, 'inactive-a': { id: 'inactive-a' } }
      }
    }
  });
  state.replacementEventQueue = [
    { ...pendingReplacementEvent('active-b-1'), backendProfileId: 'active-b', operationId: 'active-b-operation-1' },
    { ...pendingReplacementEvent('active-b-2'), backendProfileId: 'active-b', operationId: 'active-b-operation-2' },
    { ...pendingReplacementEvent('inactive-a-1'), backendProfileId: 'inactive-a', operationId: 'inactive-a-operation-1' }
  ];

  await module.namespace.triggerReplacementEventSync();

  assert.deepEqual(apiCalls.map(({ backendProfileId, payload }) => [backendProfileId, payload.length]), [['active-b', 2]]);
  assert.deepEqual(state.replacementEventQueue.map(({ id, operationId, backendProfileId, status, retryCount, error, syncStartedAt }) => ({
    id, operationId, backendProfileId, status, retryCount, error, syncStartedAt
  })), [
    { id: 'active-b-1', operationId: 'active-b-operation-1', backendProfileId: 'active-b', status: 'pending', retryCount: 1, error: null, syncStartedAt: undefined },
    { id: 'active-b-2', operationId: 'active-b-operation-2', backendProfileId: 'active-b', status: 'pending', retryCount: 1, error: null, syncStartedAt: undefined },
    { id: 'inactive-a-1', operationId: 'inactive-a-operation-1', backendProfileId: 'inactive-a', status: 'pending', retryCount: 0, error: null, syncStartedAt: undefined }
  ]);
  assert.deepEqual(state.replacementEventHistory, []);
});

test('Given an active replacement batch rejects permanently When it is synchronized Then every active item fails without retrying or leaving syncing state', async () => {
  const permanent = new Error('invalid replacement event');
  const { apiCalls, module, state } = await loadSync({
    isPermanentError: (error) => error === permanent,
    submitReplacementEvents: async () => { throw permanent; },
    state: {
      backendProfiles: {
        activeProfileId: 'active-b',
        byId: { 'active-b': { id: 'active-b' }, 'inactive-a': { id: 'inactive-a' } }
      }
    }
  });
  state.replacementEventQueue = [
    { ...pendingReplacementEvent('active-b-permanent'), backendProfileId: 'active-b', retryCount: 2 },
    { ...pendingReplacementEvent('inactive-a-permanent'), backendProfileId: 'inactive-a' }
  ];

  await module.namespace.triggerReplacementEventSync();

  assert.deepEqual(apiCalls.map(({ backendProfileId, payload }) => [backendProfileId, payload.length]), [['active-b', 1]]);
  assert.deepEqual(state.replacementEventQueue.map(({ id, backendProfileId, status, retryCount, error, syncStartedAt }) => ({
    id, backendProfileId, status, retryCount, error, syncStartedAt
  })), [
    { id: 'active-b-permanent', backendProfileId: 'active-b', status: 'failed', retryCount: 2, error: 'invalid replacement event', syncStartedAt: undefined },
    { id: 'inactive-a-permanent', backendProfileId: 'inactive-a', status: 'pending', retryCount: 0, error: null, syncStartedAt: undefined }
  ]);
  assert.deepEqual(state.replacementEventHistory, []);
});

test('Given a pending record bound to a deleted profile When the active profile syncs replacements Then it stays pending without an API request', async () => {
  const { apiCalls, module, state } = await loadSync({
    state: {
      backendProfiles: {
        activeProfileId: 'active-b',
        byId: { 'active-b': { id: 'active-b' } }
      }
    }
  });
  state.replacementEventQueue = [{ ...pendingReplacementEvent('deleted-profile-event'), backendProfileId: 'deleted-profile' }];

  await module.namespace.triggerReplacementEventSync();

  assert.deepEqual(apiCalls, []);
  assert.deepEqual(state.replacementEventQueue.map(({ id, backendProfileId, status, retryCount }) => ({
    id, backendProfileId, status, retryCount
  })), [
    { id: 'deleted-profile-event', backendProfileId: 'deleted-profile', status: 'pending', retryCount: 0 }
  ]);
  assert.deepEqual(state.replacementEventHistory, []);
});

test('Given a duplicate replacement batch and oversized history When the API returns 409 Then it moves the active record once and keeps the history bound', async () => {
  const duplicate = Object.assign(new Error('replacement already exists'), { status: 409 });
  const { apiCalls, module, state } = await loadSync({
    submitReplacementEvents: async () => { throw duplicate; },
    state: {
      backendProfiles: {
        activeProfileId: 'active-b',
        byId: { 'active-b': { id: 'active-b' }, 'inactive-a': { id: 'inactive-a' } }
      }
    }
  });
  state.replacementEventHistory = [
    { ...pendingReplacementEvent('duplicate-b'), backendProfileId: 'active-b', status: 'completed' },
    ...Array.from({ length: 100 }, (_, index) => ({
      ...pendingReplacementEvent(`old-b-${index}`), backendProfileId: 'active-b', status: 'completed'
    }))
  ];
  state.replacementEventQueue = [
    { ...pendingReplacementEvent('duplicate-b'), backendProfileId: 'active-b' },
    { ...pendingReplacementEvent('inactive-a-duplicate'), backendProfileId: 'inactive-a' }
  ];

  await module.namespace.triggerReplacementEventSync();

  assert.deepEqual(apiCalls.map(({ backendProfileId, payload }) => [backendProfileId, payload.length]), [['active-b', 1]]);
  assert.deepEqual(state.replacementEventQueue.map(({ id, backendProfileId, status }) => ({ id, backendProfileId, status })), [
    { id: 'inactive-a-duplicate', backendProfileId: 'inactive-a', status: 'pending' }
  ]);
  assert.equal(state.replacementEventHistory.length, 100);
  assert.equal(state.replacementEventHistory.filter(({ id, backendProfileId }) => id === 'duplicate-b' && backendProfileId === 'active-b').length, 1);
  assert.deepEqual(state.replacementEventHistory[0].id, 'duplicate-b');
  assert.equal(state.replacementEventHistory.some(({ id }) => id === 'old-b-99'), false);
});

test('Given 100 foreign history records When each active profile queue type completes Then every foreign record stays and only the active completion is added', async () => {
  const historyTypes = [
    ['voteQueue', 'voteHistory', 'triggerVoteSync', pendingVote],
    ['translationQueue', 'translationHistory', 'triggerTranslationSync', pendingTranslation],
    ['replacementEventQueue', 'replacementEventHistory', 'triggerReplacementEventSync', pendingReplacementEvent]
  ];

  for (const [queueKey, historyKey, trigger, createItem] of historyTypes) {
    const { module, state } = await loadSync({
      state: {
        backendProfiles: {
          activeProfileId: 'active-a',
          byId: { 'active-a': { id: 'active-a' }, 'foreign-b': { id: 'foreign-b' } }
        }
      }
    });
    const foreignHistory = Array.from({ length: 100 }, (_, index) => ({
      ...createItem(index === 0 ? 'shared-item' : `foreign-${historyKey}-${index}`),
      backendProfileId: 'foreign-b',
      status: 'completed'
    }));
    state[historyKey] = foreignHistory;
    state[queueKey] = [{ ...createItem('shared-item'), backendProfileId: 'active-a' }];

    await module.namespace[trigger]();

    assert.equal(state[queueKey].length, 0, queueKey);
    assert.equal(state[historyKey].length, 101, historyKey);
    assert.deepEqual(
      state[historyKey].filter(({ backendProfileId }) => backendProfileId === 'foreign-b').map(({ id }) => id),
      foreignHistory.map(({ id }) => id),
      historyKey
    );
    assert.deepEqual(
      state[historyKey].filter(({ id }) => id === 'shared-item').map(({ backendProfileId }) => backendProfileId).sort(),
      ['active-a', 'foreign-b'],
      historyKey
    );
  }
});

test('Given oversized mixed histories When each active profile queue type completes Then only the oldest active entry is evicted and foreign ordering remains intact', async () => {
  const historyTypes = [
    ['voteQueue', 'voteHistory', 'triggerVoteSync', pendingVote],
    ['translationQueue', 'translationHistory', 'triggerTranslationSync', pendingTranslation],
    ['replacementEventQueue', 'replacementEventHistory', 'triggerReplacementEventSync', pendingReplacementEvent]
  ];

  for (const [queueKey, historyKey, trigger, createItem] of historyTypes) {
    const { module, state } = await loadSync({
      state: {
        backendProfiles: {
          activeProfileId: 'active-a',
          byId: { 'active-a': { id: 'active-a' }, 'foreign-b': { id: 'foreign-b' } }
        }
      }
    });
    const activeHistory = Array.from({ length: 100 }, (_, index) => ({
      ...createItem(`active-${historyKey}-${index}`), backendProfileId: 'active-a', status: 'completed'
    }));
    const foreignHistory = [
      { ...createItem(`foreign-${historyKey}-first`), backendProfileId: 'foreign-b', status: 'completed' },
      { ...createItem(`foreign-${historyKey}-middle`), backendProfileId: 'foreign-b', status: 'completed' },
      { ...createItem(`foreign-${historyKey}-last`), backendProfileId: 'foreign-b', status: 'completed' }
    ];
    state[historyKey] = [
      foreignHistory[0],
      ...activeHistory.slice(0, 50),
      foreignHistory[1],
      ...activeHistory.slice(50),
      foreignHistory[2]
    ];
    state[queueKey] = [{ ...createItem(`new-active-${historyKey}`), backendProfileId: 'active-a' }];

    await module.namespace[trigger]();

    assert.equal(state[historyKey].filter(({ backendProfileId }) => backendProfileId === 'active-a').length, 100, historyKey);
    assert.deepEqual(
      state[historyKey].filter(({ backendProfileId }) => backendProfileId === 'foreign-b').map(({ id }) => id),
      foreignHistory.map(({ id }) => id),
      historyKey
    );
    assert.equal(state[historyKey].some(({ id }) => id === `active-${historyKey}-99`), false, historyKey);
    assert.equal(state[historyKey][0].id, `new-active-${historyKey}`, historyKey);
    assert.equal(state[historyKey].length, 103, historyKey);
  }
});

test('Given sync module evaluation When the service worker is not initialized Then it only registers the three alarms', async () => {
  const { alarmCalls, apiCalls, startupRegistered, storageCalls } = await loadSync();
  assert.deepEqual(JSON.parse(JSON.stringify(alarmCalls)), [
    { name: 'syncVotesAlarm', alarmInfo: { periodInMinutes: 5 } },
    { name: 'syncTranslationsAlarm', alarmInfo: { periodInMinutes: 5 } },
    { name: 'syncReplacementEventsAlarm', alarmInfo: { periodInMinutes: 5 } }
  ]);
  assert.deepEqual(apiCalls, []);
  assert.deepEqual(storageCalls, []);
  assert.equal(startupRegistered, false);
});

test('Given pending queues and unresolved profile migration When the three 5-minute alarms fire Then they wait before queue or API work and use only active A', async () => {
  const migration = deferred();
  const { alarmCalls, apiCalls, apiProfileIds, state, storageCalls, triggerAlarm } = await loadSync({
    captureActiveProfile: true,
    migration: migration.promise,
    state: {
      backendProfiles: {
        activeProfileId: 'active-a',
        byId: {
          'active-a': { id: 'active-a' },
          'inactive-b': { id: 'inactive-b' }
        }
      }
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(alarmCalls)), [
    { name: 'syncVotesAlarm', alarmInfo: { periodInMinutes: 5 } },
    { name: 'syncTranslationsAlarm', alarmInfo: { periodInMinutes: 5 } },
    { name: 'syncReplacementEventsAlarm', alarmInfo: { periodInMinutes: 5 } }
  ]);

  state.voteQueue = [
    { ...pendingVote('vote-alarm'), backendProfileId: 'active-a', operationId: 'vote-alarm-operation-a' },
    { ...pendingVote('vote-alarm-inactive'), backendProfileId: 'inactive-b', operationId: 'vote-alarm-operation-b' }
  ];
  state.translationQueue = [
    { ...pendingTranslation('translation-alarm'), backendProfileId: 'active-a', operationId: 'translation-alarm-operation-a' },
    { ...pendingTranslation('translation-alarm-inactive'), backendProfileId: 'inactive-b', operationId: 'translation-alarm-operation-b' }
  ];
  state.replacementEventQueue = [
    { ...pendingReplacementEvent('replacement-alarm'), backendProfileId: 'active-a', operationId: 'replacement-alarm-operation-a' },
    { ...pendingReplacementEvent('replacement-alarm-inactive'), backendProfileId: 'inactive-b', operationId: 'replacement-alarm-operation-b' }
  ];
  const alarms = [
    triggerAlarm({ name: 'syncVotesAlarm' }),
    triggerAlarm({ name: 'syncTranslationsAlarm' }),
    triggerAlarm({ name: 'syncReplacementEventsAlarm' })
  ];
  await new Promise(setImmediate);
  assert.deepEqual(apiCalls, []);
  assert.deepEqual(storageCalls, []);

  migration.resolve();
  await Promise.all(alarms);
  await waitForCallCount(apiCalls, 3);
  assert.deepEqual(apiCalls.map(({ kind }) => kind), [
    'submitVote',
    'submitTranslation',
    'submitReplacementEvents'
  ]);
  assert.deepEqual(apiProfileIds, ['active-a', 'active-a', 'active-a']);
  for (const [queueKey, historyKey, operationPrefix] of [
    ['voteQueue', 'voteHistory', 'vote'],
    ['translationQueue', 'translationHistory', 'translation'],
    ['replacementEventQueue', 'replacementEventHistory', 'replacement']
  ]) {
    assert.deepEqual(state[queueKey].map(({ operationId, backendProfileId, status }) => ({ operationId, backendProfileId, status })), [
      { operationId: `${operationPrefix}-alarm-operation-b`, backendProfileId: 'inactive-b', status: 'pending' }
    ], queueKey);
    assert.deepEqual(state[historyKey].map(({ operationId, backendProfileId }) => ({ operationId, backendProfileId })), [
      { operationId: `${operationPrefix}-alarm-operation-a`, backendProfileId: 'active-a' }
    ], historyKey);
  }
});

test('Given pending queues and unresolved profile migration When the storage listener evaluates and observes changes Then registration is global and only active A syncs after readiness', async () => {
  const migration = deferred();
  const state = {
    backendProfiles: {
      activeProfileId: 'active-a',
      byId: {
        'active-a': { id: 'active-a' },
        'inactive-b': { id: 'inactive-b' }
      }
    },
    voteQueue: [{ ...pendingVote('vote-listener'), backendProfileId: 'active-a' }],
    translationQueue: [{ ...pendingTranslation('translation-listener'), backendProfileId: 'active-a' }],
    replacementEventQueue: [{ ...pendingReplacementEvent('replacement-listener'), backendProfileId: 'active-a' }]
  };
  const listener = await loadSyncListener(state, {
    captureActiveProfile: true,
    migration: migration.promise
  });
  assert.equal(listener.storageListenerRegistered, true);
  assert.equal(listener.startupRegistered, false);
  assert.deepEqual(listener.syncCalls, []);
  listener.triggerStorageChange({
    voteQueue: { oldValue: [], newValue: state.voteQueue },
    translationQueue: { oldValue: [], newValue: state.translationQueue },
    replacementEventQueue: { oldValue: [], newValue: state.replacementEventQueue }
  });
  await new Promise(setImmediate);
  assert.deepEqual(listener.syncCalls, []);

  migration.resolve();
  await waitForCallCount(listener.syncCalls, 3);
  assert.deepEqual(listener.syncCalls, ['vote', 'translation', 'replacement-event']);
  assert.deepEqual(listener.syncProfileIds, ['active-a', 'active-a', 'active-a']);
});

test('Given only inactive-profile queue additions When the storage listener observes them Then it leaves their local IDs untouched and triggers no active-profile sync', async () => {
  const state = {
    backendProfiles: {
      activeProfileId: 'active-a',
      byId: { 'active-a': { id: 'active-a' }, 'inactive-b': { id: 'inactive-b' } }
    },
    voteQueue: [{ ...pendingVote('listener-vote-b'), backendProfileId: 'inactive-b', operationId: 'listener-vote-operation-b' }],
    translationQueue: [{ ...pendingTranslation('listener-translation-b'), backendProfileId: 'inactive-b', operationId: 'listener-translation-operation-b' }],
    replacementEventQueue: [{ ...pendingReplacementEvent('listener-replacement-b'), backendProfileId: 'inactive-b', operationId: 'listener-replacement-operation-b' }]
  };
  const listener = await loadSyncListener(state, { captureActiveProfile: true });

  listener.triggerStorageChange({
    voteQueue: { oldValue: [], newValue: state.voteQueue },
    translationQueue: { oldValue: [], newValue: state.translationQueue },
    replacementEventQueue: { oldValue: [], newValue: state.replacementEventQueue }
  });
  await new Promise(setImmediate);

  assert.deepEqual(listener.syncCalls, []);
  assert.deepEqual(listener.syncProfileIds, []);
  assert.deepEqual([
    ...state.voteQueue,
    ...state.translationQueue,
    ...state.replacementEventQueue
  ].map(({ operationId, backendProfileId, status }) => ({ operationId, backendProfileId, status })), [
    { operationId: 'listener-vote-operation-b', backendProfileId: 'inactive-b', status: 'pending' },
    { operationId: 'listener-translation-operation-b', backendProfileId: 'inactive-b', status: 'pending' },
    { operationId: 'listener-replacement-operation-b', backendProfileId: 'inactive-b', status: 'pending' }
  ]);
});

test('Given profile migration rejects When a storage event is observed Then no sync trigger is called', async () => {
  const migration = deferred();
  migration.promise.catch(() => {});
  const state = { voteQueue: [pendingVote('vote-rejected')] };
  const listener = await loadSyncListener(state, { migration: migration.promise });

  listener.triggerStorageChange({ voteQueue: { oldValue: [], newValue: state.voteQueue } });
  await new Promise(setImmediate);
  migration.reject(new Error('profile migration rejected'));
  await new Promise(setImmediate);

  assert.deepEqual(listener.syncCalls, []);
});

test('Given a retired popup API proxy request When it reaches background Then it returns a normalized invalid result without API or credential effects', async () => {
  const calls = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'legacy-profile',
      byId: {
        'legacy-profile': { id: 'legacy-profile', endpoint: apiBaseUrl, userId: 'legacy-user', jwt: 'legacy-jwt' }
      }
    }
  };
  const background = await loadBackgroundWithRealApi(async (_url, options) => {
    calls.push(options);
    return response({ success: true, data: { profile: 'legacy-profile' } });
  }, {
    storage
  });

  const result = await sendRuntimeMessage(background, {
    type: 'POPUP_API_REQUEST',
    api: 'fetchUserStats',
    params: { userId: 'caller-supplied-user' }
  }, { id: 'subpal-extension-id', url: 'chrome-extension://test/popup.html', origin: 'chrome-extension://test' });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    error: { kind: 'invalid', code: 'popup-active-profile-stats', retryable: false }
  });
  assert.deepEqual(calls, []);
  assert.equal(storage.backendProfiles.byId['legacy-profile'].jwt, 'legacy-jwt');
});

test('Given a missing active-profile credential When the exact trusted Popup requests stats Then background registers and stores credentials only for that active profile', async () => {
  const calls = [];
  const storage = {
    storage: {
      backendProfiles: {
        schemaVersion: 1,
        activeProfileId: 'profile-a',
        byId: {
          'profile-a': { id: 'profile-a', endpoint: apiBaseUrl, userId: 'user-a', jwt: null },
          'profile-b': { id: 'profile-b', endpoint: apiBaseUrl, userId: 'user-b', jwt: null }
        }
      }
    }
  };
  const background = await loadBackgroundWithRealApi(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/users')) return response({ success: true, token: 'registered-token' });
    return response({ success: true, data: { points: 1, statistics: { translationSubmissions: 2, translationViews: 3, upvotesReceived: 4, subtitlesReplaced: 5 } } });
  }, { storage: storage.storage });

  const result = await sendRuntimeMessage(background, { type: 'POPUP_ACTIVE_PROFILE_STATS' }, {
    id: 'subpal-extension-id', url: 'chrome-extension://test/popup.html', origin: 'chrome-extension://test'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    value: {
      scope: 'active-backend-profile-user', backendProfileId: 'profile-a', userIdMasked: 'us...-a',
      totals: { points: 1, translationSubmissions: 2, translationViews: 3, upvotesReceived: 4, subtitlesReplaced: 5 }
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(storage.storage.backendProfiles.byId['profile-a'].jwt, 'registered-token');
  assert.equal(storage.storage.backendProfiles.byId['profile-b'].jwt, null);
});

test('Given the exact trusted Popup request When active profiles change between calls Then background resolves each profile independently and returns only the fixed masked projection', async () => {
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'profile-a',
      byId: {
        'profile-a': { id: 'profile-a', endpoint: apiBaseUrl, userId: 'user-a', jwt: 'jwt-a' },
        'profile-b': { id: 'profile-b', endpoint: apiBaseUrl, userId: 'user-b', jwt: 'jwt-b' }
      }
    }
  };
  const background = await loadBackgroundWithRealApi(async (url) => response({
    success: true,
    data: url.endsWith('user-a')
      ? { points: 1, statistics: { translationSubmissions: 2, translationViews: 3, upvotesReceived: 4, subtitlesReplaced: 5 } }
      : { points: 6, statistics: { translationSubmissions: 7, translationViews: 8, upvotesReceived: 9, subtitlesReplaced: 10 } }
  }), { storage });
  const sender = { id: 'subpal-extension-id', url: 'chrome-extension://test/popup.html', origin: 'chrome-extension://test' };
  const expected = (profileId, userIdMasked, totals) => ({
    ok: true,
    value: { scope: 'active-backend-profile-user', backendProfileId: profileId, userIdMasked, totals }
  });

  const first = await sendRuntimeMessage(background, { type: 'POPUP_ACTIVE_PROFILE_STATS' }, sender);
  storage.backendProfiles.activeProfileId = 'profile-b';
  const second = await sendRuntimeMessage(background, { type: 'POPUP_ACTIVE_PROFILE_STATS' }, sender);

  assert.deepEqual(JSON.parse(JSON.stringify(first)), expected('profile-a', 'us...-a', {
    points: 1, translationSubmissions: 2, translationViews: 3, upvotesReceived: 4, subtitlesReplaced: 5
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(second)), expected('profile-b', 'us...-b', {
    points: 6, translationSubmissions: 7, translationViews: 8, upvotesReceived: 9, subtitlesReplaced: 10
  }));
});

test('Given malformed, spoofed, or retired popup routes When they reach background Then each produces a sanitized normalized failure without API or credential side effects', async () => {
  const registrations = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'profile-a',
      byId: { 'profile-a': { id: 'profile-a', endpoint: apiBaseUrl, userId: 'user-a', jwt: null } }
    }
  };
  const background = await loadBackgroundWithRealApi(async (_url, options) => {
    registrations.push(options);
    return response({ success: true, token: 'must-not-persist' });
  }, { storage });
  const trusted = { id: 'subpal-extension-id', url: 'chrome-extension://test/popup.html', origin: 'chrome-extension://test' };
  const invalidAttempts = [
    [{ type: 'POPUP_ACTIVE_PROFILE_STATS', extra: true }, trusted],
    [{ type: 'POPUP_API_REQUEST', api: 'registerUser', params: { userId: 'forged' } }, trusted],
    [Object.assign(Object.create({ type: 'POPUP_ACTIVE_PROFILE_STATS' }), {}), trusted],
    [new Proxy({ type: 'POPUP_ACTIVE_PROFILE_STATS' }, { ownKeys() { throw new Error('proxy trap'); } }), trusted]
  ];

  for (const [request, sender] of invalidAttempts) {
    const result = await sendRuntimeMessage(background, request, sender);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      ok: false,
      error: { kind: 'invalid', code: 'popup-active-profile-stats', retryable: false }
    });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await sendRuntimeMessage(
    background,
    { type: 'POPUP_ACTIVE_PROFILE_STATS' },
    { ...trusted, url: 'chrome-extension://test/options.html' }
  ))), {
    ok: false,
    error: { kind: 'forbidden', code: 'popup-active-profile-access', retryable: false }
  });
  assert.deepEqual(registrations, []);
  assert.equal(storage.backendProfiles.byId['profile-a'].jwt, null);
});
