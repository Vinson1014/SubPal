import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPort,
  loadApiModule,
  loadBackgroundWithApi,
  loadBackgroundWithRealApi,
  loadRealContentTransport,
  netflixSender,
  plain,
  sendRuntimeMessage,
  waitForResponse
} from './crowdsourcing-test-harness.mjs';

function deferred() {
  let resolve;
  return { promise: new Promise((resolvePromise) => { resolve = resolvePromise; }), resolve };
}

test('Given existing subtitle route When CHECK_SUBTITLE is sent over content port Then subtitles are returned', async () => {
  const background = await loadBackgroundWithApi({
    async fetchSubtitles(options) {
        assert.equal(JSON.stringify(options), JSON.stringify({ videoId: 'netflix-81234567', startTime: 12, duration: 180 }));
      return [{ translationID: 'translation-1', originalSubtitle: 'Hello' }];
    }
  });
  const { port, sentMessages, send } = createPort();
  background.connect(port);
  send({ messageId: 'baseline-1', message: { type: 'CHECK_SUBTITLE', videoId: 'netflix-81234567', timestamp: 12 } });
  assert.equal(JSON.stringify(await waitForResponse(sentMessages, 'baseline-1')), JSON.stringify({
    success: true,
    subtitles: [{ translationID: 'translation-1', originalSubtitle: 'Hello' }]
  }));
});

test('Given a pending legacy DOM request When the real content Port disconnects Then the caller rejects with the normalized Port code', async () => {
  const pendingSubtitle = deferred();
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { return pendingSubtitle.promise; }
  });
  const transport = await loadRealContentTransport(background);
  const request = transport.sendLegacyMessage({ type: 'CHECK_SUBTITLE', videoId: 'netflix-81234567', timestamp: 12 });
  await new Promise(setImmediate);
  transport.disconnectContentPort();
  await assert.rejects(request, (error) => error?.kind === 'disconnected' && error.code === 'background-port-disconnected' && error.retryable === true && error.message === 'background-port-disconnected');
  pendingSubtitle.resolve([]);
});

test('Given a task query on the generic content port When GET_CROWDSOURCING_TASKS is sent Then it is rejected without API calls', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() {
      apiCalls += 1;
      return { tasks: [{ taskID: 'leaked' }] };
    }
  });
  const { port, sentMessages, send } = createPort();
  background.connect(port);
  send({ messageId: 'page-task-1', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 5 } });
  const response = await waitForResponse(sentMessages, 'page-task-1');
  assert.equal(apiCalls, 0);
  assert.deepEqual(plain(response), { success: false, error: 'Unhandled message type (port) GET_CROWDSOURCING_TASKS' });
});

test('Given invalid videoID from an authorized sender When GET_CROWDSOURCING_TASKS is sent Then validation fails without API calls', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() {
      apiCalls += 1;
      return { tasks: [{ taskID: 'leaked' }] };
    }
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: ' ', languageCode: 'zh-TW', limit: 5 }, netflixSender());
  assert.equal(apiCalls, 0);
  assert.equal(response.success, false);
  assert.match(response.error, /videoID/);
});

test('Given sender watch URL differs from requested video When task route is called Then it is rejected without API calls', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() {},
    async fetchCrowdsourcingTasks() { apiCalls += 1; return { tasks: [] }; }
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: '87654321', languageCode: 'zh-TW', limit: 5 }, netflixSender());
  assert.equal(apiCalls, 0);
  assert.equal(response.success, false);
  assert.match(response.error, /videoID/);
});

test('Given a prefixed request videoID When task route is called Then it is rejected without API calls', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() {},
    async fetchCrowdsourcingTasks() { apiCalls += 1; return { tasks: [] }; }
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-82147770', languageCode: 'zh-TW', limit: 5 }, netflixSender());
  assert.equal(apiCalls, 0);
  assert.equal(response.success, false);
  assert.match(response.error, /videoID/);
});

test('Given any limit other than five When task route is called Then it is rejected without API calls', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() {},
    async fetchCrowdsourcingTasks() { apiCalls += 1; return { tasks: [] }; }
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 4 }, netflixSender());
  assert.equal(apiCalls, 0);
  assert.equal(response.success, false);
  assert.match(response.error, /limit/);
});

test('Given invalid languageCode from an authorized sender When GET_CROWDSOURCING_TASKS is sent Then response is controlled and no network runs', async () => {
  let fetchCalls = 0;
  const background = await loadBackgroundWithRealApi(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-Hant', limit: 5 }, netflixSender());
  assert.equal(response.success, false);
  assert.match(response.error, /languageCode/);
  assert.equal(fetchCalls, 0);
});

test('Given invalid limit from an authorized sender When GET_CROWDSOURCING_TASKS is sent Then response is controlled and no network runs', async () => {
  let fetchCalls = 0;
  const background = await loadBackgroundWithRealApi(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 21 }, netflixSender());
  assert.equal(response.success, false);
  assert.match(response.error, /limit/);
  assert.equal(fetchCalls, 0);
});

test('Given API failure from an authorized sender When GET_CROWDSOURCING_TASKS is sent Then failure is controlled', async () => {
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { throw new Error('backend unavailable'); }
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 5 }, netflixSender());
  assert.equal(response.success, false);
  assert.match(response.error, /backend unavailable/);
});

test('Given valid task query When fetchCrowdsourcingTasks is called Then it uses authenticated encoded GET and preserves null translationID', async () => {
  const calls = [];
  const api = await loadApiModule(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return { success: true, data: { tasks: [{ translationID: null }] } }; } };
  });
  const result = await api.fetchCrowdsourcingTasks({ videoID: '82147770', languageCode: 'zh-TW', limit: 5 });
  assert.equal(calls[0].url, 'https://api.example.test/crowdsourcing-tasks?videoID=82147770&languageCode=zh-TW&limit=5');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer jwt-token');
  assert.equal(plain(result).tasks[0].translationID, null);
});

test('Given expired JWT When fetchCrowdsourcingTasks receives 401 Then it refreshes and retries once', async () => {
  const calls = [];
  const api = await loadApiModule(async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization, method: options.method });
    if (calls.length === 1) return { ok: false, status: 401, async json() { return { error: 'expired' }; } };
    if (url === 'https://api.example.test/users') return { ok: true, async json() { return { success: true, token: 'refreshed-token' }; } };
    return { ok: true, async json() { return { success: true, data: { tasks: [] } }; } };
  });
  await api.fetchCrowdsourcingTasks({ videoID: '82147770', languageCode: 'zh-TW', limit: 5 });
  assert.deepEqual(calls.map((call) => [call.url, call.auth]), [
    ['https://api.example.test/crowdsourcing-tasks?videoID=82147770&languageCode=zh-TW&limit=5', 'Bearer jwt-token'],
    ['https://api.example.test/users', 'Bearer jwt-token'],
    ['https://api.example.test/crowdsourcing-tasks?videoID=82147770&languageCode=zh-TW&limit=5', 'Bearer refreshed-token']
  ]);
});

test('Given invalid task query When fetchCrowdsourcingTasks is called Then it fails before network', async () => {
  let fetchCalls = 0;
  const api = await loadApiModule(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: ' ', languageCode: 'zh-TW', limit: 5 }), /videoID/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ languageCode: 'zh-TW', limit: 5 }), /videoID/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: '82147770', languageCode: '', limit: 5 }), /languageCode/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: '82147770', languageCode: 'zh-Hant', limit: 5 }), /languageCode/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: '82147770', languageCode: 'zh-TW', limit: 0 }), /limit/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: '82147770', languageCode: 'zh-TW', limit: 21 }), /limit/);
  assert.equal(fetchCalls, 0);
});

test('Given authorized Netflix content sender When runtime task route is called Then task data is returned with safe success envelope', async () => {
  const taskData = { success: false, videoID: '82147770', tasks: [{ translationID: null }] };
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks(options) {
      assert.equal(JSON.stringify(options), JSON.stringify({ videoID: '82147770', languageCode: 'zh-TW', limit: 5 }));
      return taskData;
    }
  });
  const response = await sendRuntimeMessage(
    background,
    { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 5 },
    netflixSender({ url: 'https://www.netflix.com/browse' })
  );
  assert.equal(JSON.stringify(response), JSON.stringify({ ...taskData, success: true }));
});

test('Given the real endscreen messaging transport When an authorized task query succeeds Then the controller dispatches returned tasks without using the generic port', async () => {
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { return { tasks: [{ taskID: 'task-through-runtime' }] }; }
  });
  const transport = await loadRealContentTransport(background);
  const taskBatches = [];
  const context = {
    videoId: '82147770',
    sessionId: 'watch-session-1',
    epoch: 3,
    state: 'ready'
  };
  const controller = new transport.EndscreenTaskController({
    clock: () => 0,
    schedule: () => 0,
    sendMessage: transport.sendMessage,
    onTasks(tasks) { taskBatches.push(tasks); },
    languageCode: 'zh-TW',
    debounceMs: 0
  });

  await controller.requestTasks(context, '82147770|watch-session-1|3', 0);

  assert.deepEqual(plain(taskBatches), [[{ taskID: 'task-through-runtime' }]]);
  assert.equal(transport.portMessages.length, 0);
});

test('Given Netflix page code dispatches the public message event When it requests crowdsourcing tasks Then no privileged runtime request or sensitive response is exposed', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { apiCalls += 1; return { tasks: [{ taskID: 'sensitive-task' }] }; }
  });
  const transport = await loadRealContentTransport(background);
  const responses = [];
  transport.window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));

  transport.dispatchPublicEvent('messageToContentScript', {
    messageId: 'oracle-poc',
    message: {
      type: 'GET_CROWDSOURCING_TASKS',
      videoID: '82147770',
      languageCode: 'zh-TW',
      limit: 5
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(transport.runtimeMessages.length, 0);
  assert.equal(transport.portMessages.length, 0);
  assert.equal(apiCalls, 0);
  assert.equal(responses.length, 0);
});

test('Given the real endscreen messaging transport When the API returns no tasks Then the controller dispatches an empty batch without using the generic port', async () => {
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { return { tasks: [] }; }
  });
  const transport = await loadRealContentTransport(background);
  const taskBatches = [];
  const controller = new transport.EndscreenTaskController({
    clock: () => 0,
    schedule: () => 0,
    sendMessage: transport.sendMessage,
    onTasks(tasks) { taskBatches.push(tasks); },
    languageCode: 'zh-TW',
    debounceMs: 0
  });
  const context = { videoId: '82147770', sessionId: 'watch-session-1', epoch: 3, state: 'ready' };

  await controller.requestTasks(context, '82147770|watch-session-1|3', 0);

  assert.deepEqual(plain(taskBatches), [[]]);
  assert.equal(transport.portMessages.length, 0);
});

test('Given the real endscreen messaging transport When the API fails Then the controller remains non-blocking and dispatches nothing', async () => {
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { throw new Error('backend unavailable'); }
  });
  const transport = await loadRealContentTransport(background);
  const taskBatches = [];
  const controller = new transport.EndscreenTaskController({
    clock: () => 0,
    schedule: () => 0,
    sendMessage: transport.sendMessage,
    onTasks(tasks) { taskBatches.push(tasks); },
    languageCode: 'zh-TW',
    debounceMs: 0
  });
  const context = { videoId: '82147770', sessionId: 'watch-session-1', epoch: 3, state: 'ready' };

  const result = await controller.requestTasks(context, '82147770|watch-session-1|3', 0);

  assert.equal(result, null);
  assert.deepEqual(taskBatches, []);
  assert.equal(transport.portMessages.length, 0);
});

test('Given missing or wrong extension identity or forged sender URLs When task route is called Then they fail without API calls', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { apiCalls += 1; return { tasks: [] }; }
  });
  const request = { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 5 };
  const responses = await Promise.all([
    sendRuntimeMessage(background, request, netflixSender({ id: undefined })),
    sendRuntimeMessage(background, request, netflixSender({ id: 'other-extension' })),
    sendRuntimeMessage(background, request, netflixSender({ tab: { id: 9, url: 'https://www.netflix.com/watch/87654321' } })),
    sendRuntimeMessage(background, request, netflixSender({
      tab: { id: 9, url: 'https://evil.example/watch/82147770' },
      url: 'https://www.netflix.com/watch/82147770'
    })),
    sendRuntimeMessage(background, request, netflixSender({ tab: { id: 9, url: 'https://www.netflix.com/browse' } }))
  ]);
  assert.equal(apiCalls, 0);
  assert.equal(responses.every((response) => response.success === false), true);
  assert.match(responses[0].error, /Unauthorized/);
  assert.match(responses[1].error, /Unauthorized/);
  assert.match(responses[2].error, /videoID/);
  assert.match(responses[3].error, /Unauthorized/);
  assert.match(responses[4].error, /videoID/);
});

test('Given invalid languageCode from authorized sender When runtime task route is called Then response is controlled and no network runs', async () => {
  let fetchCalls = 0;
  const background = await loadBackgroundWithRealApi(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  const response = await sendRuntimeMessage(
    background,
    { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-Hant', limit: 5 },
    netflixSender()
  );
  assert.equal(response.success, false);
  assert.match(response.error, /languageCode/);
  assert.equal(fetchCalls, 0);
});

test('Given invalid limit from authorized sender When runtime task route is called Then response is controlled and no network runs', async () => {
  let fetchCalls = 0;
  const background = await loadBackgroundWithRealApi(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  const response = await sendRuntimeMessage(
    background,
    { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 21 },
    netflixSender()
  );
  assert.equal(response.success, false);
  assert.match(response.error, /limit/);
  assert.equal(fetchCalls, 0);
});

test('Given API failure from authorized sender When runtime task route is called Then failure is controlled', async () => {
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { throw new Error('backend unavailable'); }
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: '82147770', languageCode: 'zh-TW', limit: 5 }, netflixSender());
  assert.equal(response.success, false);
  assert.match(response.error, /backend unavailable/);
});
