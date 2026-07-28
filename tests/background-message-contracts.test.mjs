import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPort, loadApiModule, loadBackgroundWithApi, waitForResponse } from './crowdsourcing-test-harness.mjs';
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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const removedSyncMessages = [
  'SYNC_DATA',
  'SYNC_VOTES',
  'SYNC_TRANSLATIONS',
  'SYNC_REPLACEMENT_EVENTS',
  'GET_SYNC_STATUS',
  'TRIGGER_VOTE_SYNC',
  'TRIGGER_TRANSLATION_SYNC',
  'TRIGGER_REPLACEMENT_EVENT_SYNC'
];

const retrySyncMessages = [
  ['RETRY_FAILED_VOTES', 'retryFailedVotes'],
  ['RETRY_FAILED_TRANSLATIONS', 'retryFailedTranslations'],
  ['RETRY_FAILED_REPLACEMENT_EVENTS', 'retryFailedReplacementEvents']
];

async function sendPortMessage(background, messageId, type) {
  const { port, send, sentMessages } = createPort();
  port.name = 'options-page-channel';
  background.connect(port);
  send({ messageId, message: { type } });
  return JSON.parse(JSON.stringify(await waitForResponse(sentMessages, messageId)));
}

function createRetrySyncModule(retryFunctions) {
  return {
    handleMessage(request, _sender, portSendResponse) {
      const retry = retryFunctions[request.type];
      if (!retry) {
        portSendResponse({ success: false, error: `Unexpected sync request: ${request.type}` });
        return;
      }
      retry().then(portSendResponse).catch((error) => {
        portSendResponse({ success: false, error: error.message });
      });
    }
  };
}

function invokeSyncMessage(syncModule, type) {
  return new Promise((resolve) => {
    syncModule.namespace.handleMessage({ type }, {}, (response) => {
      resolve(JSON.parse(JSON.stringify(response)));
    });
  });
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
    error: null
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
    error: null
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
    error: null
  };
}

test('Given missing credentials When install runs Then it creates credentials through the raw registration API without a JWT alarm', async () => {
  const storage = { api: { baseUrl: apiBaseUrl } };
  const logs = [];
  let registrations = 0;
  const background = await loadBackgroundWithApi({
    async registerUser(userId) {
      registrations += 1;
      assert.equal(typeof userId, 'string');
      return { token: 'bootstrap-jwt' };
    }
  }, { logs, storage });

  await background.install();

  assert.equal(registrations, 1);
  assert.equal(typeof storage.user.userId, 'string');
  assert.equal(typeof storage.jwt, 'string');
  assert.deepEqual(background.alarmCalls, { clear: [], create: [] });
  assert.equal(logs.flatMap(({ args }) => args).includes(storage.jwt), false);
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
  assert.equal(storage.jwt, 'bootstrap-jwt');
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

test('Given a delayed 401 from an old request When another request already refreshed the JWT Then it retries without refreshing again', async () => {
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

  assert.equal(registrations, 1);
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

test('Given options retry commands When they reach the background port Then each returns its matching retry result', async () => {
  const calls = [];
  const retryFunctions = Object.fromEntries(retrySyncMessages.map(([type, retry]) => [type, async () => {
    calls.push(retry);
    return { success: true, retry };
  }]));
  const background = await loadBackgroundWithApi({}, {
    syncModule: createRetrySyncModule(retryFunctions)
  });

  for (const [type, retry] of retrySyncMessages) {
    assert.deepEqual(await sendPortMessage(background, `retry-${type}`, type), { success: true, retry });
  }

  assert.deepEqual(calls, retrySyncMessages.map(([, retry]) => retry));
});

test('Given a retained retry rejects When it reaches the background port Then the retry failure is returned without changing internal trigger paths', async () => {
  const background = await loadBackgroundWithApi({}, {
    syncModule: createRetrySyncModule({
      RETRY_FAILED_VOTES: async () => ({ success: true }),
      RETRY_FAILED_TRANSLATIONS: async () => { throw new Error('retry rejected'); },
      RETRY_FAILED_REPLACEMENT_EVENTS: async () => ({ success: true })
    })
  });

  assert.deepEqual(
    await sendPortMessage(background, 'retry-rejects', 'RETRY_FAILED_TRANSLATIONS'),
    { success: false, error: 'retry rejected' }
  );
});

test('Given a removed sync command When it reaches the background port Then it receives the ordinary unhandled response', async () => {
  const forwarded = [];
  const background = await loadBackgroundWithApi({}, {
    syncModule: {
      handleMessage(request, _sender, portSendResponse) {
        forwarded.push(request.type);
        portSendResponse({ success: true, forwarded: request.type });
      }
    }
  });

  for (const type of removedSyncMessages) {
    assert.deepEqual(
      await sendPortMessage(background, `removed-${type}`, type),
      { success: false, error: `Unhandled message type (port) ${type}` }
    );
  }

  assert.deepEqual(forwarded, []);
});

test('Given a removed sync command When it reaches the sync handler Then it receives the handler unhandled response', async () => {
  const { module } = await loadSync();

  for (const type of removedSyncMessages) {
    assert.deepEqual(
      await invokeSyncMessage(module, type),
      { success: false, error: `Unhandled message type in sync module: ${type}` }
    );
  }
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

test('Given pending queues When the three 5-minute alarms and startup listener run Then they retain direct sync paths', async () => {
  const { alarmCalls, apiCalls, startup, state, triggerAlarm } = await loadSync();
  assert.deepEqual(JSON.parse(JSON.stringify(alarmCalls)), [
    { name: 'syncVotesAlarm', alarmInfo: { periodInMinutes: 5 } },
    { name: 'syncTranslationsAlarm', alarmInfo: { periodInMinutes: 5 } },
    { name: 'syncReplacementEventsAlarm', alarmInfo: { periodInMinutes: 5 } }
  ]);

  state.voteQueue = [pendingVote('vote-alarm')];
  state.translationQueue = [pendingTranslation('translation-alarm')];
  state.replacementEventQueue = [pendingReplacementEvent('replacement-alarm')];
  triggerAlarm({ name: 'syncVotesAlarm' });
  triggerAlarm({ name: 'syncTranslationsAlarm' });
  triggerAlarm({ name: 'syncReplacementEventsAlarm' });
  await waitForCallCount(apiCalls, 3);
  assert.deepEqual(apiCalls.map(({ kind }) => kind), [
    'submitVote',
    'submitTranslation',
    'submitReplacementEvents'
  ]);

  apiCalls.length = 0;
  state.voteQueue = [{ ...pendingVote('vote-startup'), status: 'failed' }];
  state.translationQueue = [{ ...pendingTranslation('translation-startup'), status: 'failed' }];
  state.replacementEventQueue = [{ ...pendingReplacementEvent('replacement-startup'), status: 'failed' }];
  startup();
  await waitForCallCount(apiCalls, 3);
  assert.deepEqual(apiCalls.map(({ kind }) => kind), [
    'submitVote',
    'submitTranslation',
    'submitReplacementEvents'
  ]);
});

test('Given pending queues When the sync listener loads, observes storage, and starts Then each local trigger still calls its exported sync trigger', async () => {
  const state = {
    voteQueue: [pendingVote('vote-listener')],
    translationQueue: [pendingTranslation('translation-listener')],
    replacementEventQueue: [pendingReplacementEvent('replacement-listener')]
  };
  const listener = await loadSyncListener(state);
  await waitForCallCount(listener.syncCalls, 3);
  assert.deepEqual(listener.syncCalls, ['vote', 'translation', 'replacement-event']);

  listener.syncCalls.length = 0;
  listener.triggerStorageChange({
    voteQueue: { oldValue: [], newValue: state.voteQueue },
    translationQueue: { oldValue: [], newValue: state.translationQueue },
    replacementEventQueue: { oldValue: [], newValue: state.replacementEventQueue }
  });
  await waitForCallCount(listener.syncCalls, 3);
  assert.deepEqual(listener.syncCalls, ['vote', 'translation', 'replacement-event']);

  listener.syncCalls.length = 0;
  listener.startup();
  await waitForCallCount(listener.syncCalls, 3);
  assert.deepEqual(listener.syncCalls, ['vote', 'translation', 'replacement-event']);
});
