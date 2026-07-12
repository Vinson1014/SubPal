import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPort,
  loadApiModule,
  loadBackgroundWithApi,
  loadBackgroundWithRealApi,
  netflixSender,
  plain,
  sendRuntimeMessage,
  waitForResponse
} from './crowdsourcing-test-harness.mjs';

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

test('Given valid task query on content port When GET_CROWDSOURCING_TASKS is sent Then it reaches fetchCrowdsourcingTasks', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks(options) {
      apiCalls += 1;
      assert.equal(JSON.stringify(options), JSON.stringify({ videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 }));
      return { videoID: 'netflix-81234567', tasks: [{ taskID: 'task-1' }] };
    }
  });
  const { port, sentMessages, send } = createPort();
  background.connect(port);
  send({ messageId: 'page-task-1', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 } });
  const response = await waitForResponse(sentMessages, 'page-task-1');
  assert.equal(apiCalls, 1);
  assert.deepEqual(plain(response), { success: true, videoID: 'netflix-81234567', tasks: [{ taskID: 'task-1' }] });
});

test('Given invalid videoID on content port When GET_CROWDSOURCING_TASKS is sent Then validation fails without API calls', async () => {
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
  send({ messageId: 'page-task-2', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: ' ', languageCode: 'zh-TW', limit: 5 } });
  const response = await waitForResponse(sentMessages, 'page-task-2');
  assert.equal(apiCalls, 0);
  assert.equal(response.success, false);
  assert.match(response.error, /缺少或無效的 videoID/);
});

test('Given invalid languageCode on content port When GET_CROWDSOURCING_TASKS is sent Then response is controlled and no network runs', async () => {
  let fetchCalls = 0;
  const background = await loadBackgroundWithRealApi(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  const { port, sentMessages, send } = createPort();
  background.connect(port);
  send({ messageId: 'page-task-3', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-Hant', limit: 5 } });
  const response = await waitForResponse(sentMessages, 'page-task-3');
  assert.equal(response.success, false);
  assert.match(response.error, /languageCode/);
  assert.equal(fetchCalls, 0);
});

test('Given invalid limit on content port When GET_CROWDSOURCING_TASKS is sent Then response is controlled and no network runs', async () => {
  let fetchCalls = 0;
  const background = await loadBackgroundWithRealApi(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  const { port, sentMessages, send } = createPort();
  background.connect(port);
  send({ messageId: 'page-task-4', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 21 } });
  const response = await waitForResponse(sentMessages, 'page-task-4');
  assert.equal(response.success, false);
  assert.match(response.error, /limit/);
  assert.equal(fetchCalls, 0);
});

test('Given API failure on content port When GET_CROWDSOURCING_TASKS is sent Then failure is controlled', async () => {
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { throw new Error('backend unavailable'); }
  });
  const { port, sentMessages, send } = createPort();
  background.connect(port);
  send({ messageId: 'page-task-5', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 } });
  const response = await waitForResponse(sentMessages, 'page-task-5');
  assert.equal(response.success, false);
  assert.match(response.error, /backend unavailable/);
});

test('Given valid task query When fetchCrowdsourcingTasks is called Then it uses authenticated encoded GET and preserves null translationID', async () => {
  const calls = [];
  const api = await loadApiModule(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return { success: true, data: { tasks: [{ translationID: null }] } }; } };
  });
  const result = await api.fetchCrowdsourcingTasks({ videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 });
  assert.equal(calls[0].url, 'https://api.example.test/crowdsourcing-tasks?videoID=netflix-81234567&languageCode=zh-TW&limit=5');
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
  await api.fetchCrowdsourcingTasks({ videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 });
  assert.deepEqual(calls.map((call) => [call.url, call.auth]), [
    ['https://api.example.test/crowdsourcing-tasks?videoID=netflix-81234567&languageCode=zh-TW&limit=5', 'Bearer jwt-token'],
    ['https://api.example.test/users', 'Bearer jwt-token'],
    ['https://api.example.test/crowdsourcing-tasks?videoID=netflix-81234567&languageCode=zh-TW&limit=5', 'Bearer refreshed-token']
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
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: 'netflix-81234567', languageCode: '', limit: 5 }), /languageCode/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: 'netflix-81234567', languageCode: 'zh-Hant', limit: 5 }), /languageCode/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 0 }), /limit/);
  await assert.rejects(() => api.fetchCrowdsourcingTasks({ videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 21 }), /limit/);
  assert.equal(fetchCalls, 0);
});

test('Given authorized Netflix content sender When runtime task route is called Then task data is returned with safe success envelope', async () => {
  const taskData = { success: false, videoID: 'netflix-81234567', tasks: [{ translationID: null }] };
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks(options) {
      assert.equal(JSON.stringify(options), JSON.stringify({ videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 }));
      return taskData;
    }
  });
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 }, netflixSender());
  assert.equal(JSON.stringify(response), JSON.stringify({ ...taskData, success: true }));
});

test('Given unauthorized runtime senders When task route is called Then they fail without API calls', async () => {
  let apiCalls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { throw new Error('unexpected subtitle call'); },
    async fetchCrowdsourcingTasks() { apiCalls += 1; return { tasks: [] }; }
  });
  const request = { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 };
  const responses = await Promise.all([
    sendRuntimeMessage(background, request, {}),
    sendRuntimeMessage(background, request, netflixSender({ tab: undefined })),
    sendRuntimeMessage(background, request, netflixSender({ id: 'other-extension' })),
    sendRuntimeMessage(background, request, netflixSender({ tab: { id: 9, url: 'https://example.com/watch' }, url: 'https://example.com/watch' }))
  ]);
  assert.equal(apiCalls, 0);
  assert.equal(responses.every((response) => response.success === false && /Unauthorized/.test(response.error)), true);
});

test('Given invalid languageCode from authorized sender When runtime task route is called Then response is controlled and no network runs', async () => {
  let fetchCalls = 0;
  const background = await loadBackgroundWithRealApi(async () => {
    fetchCalls += 1;
    throw new Error('network should not be called');
  });
  const response = await sendRuntimeMessage(
    background,
    { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-Hant', limit: 5 },
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
    { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 21 },
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
  const response = await sendRuntimeMessage(background, { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-81234567', languageCode: 'zh-TW', limit: 5 }, netflixSender());
  assert.equal(response.success, false);
  assert.match(response.error, /backend unavailable/);
});
