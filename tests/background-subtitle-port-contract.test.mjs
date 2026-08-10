import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPort,
  loadBackgroundWithApi,
  netflixSender,
  waitForResponse
} from './crowdsourcing-test-harness.mjs';

function request(overrides = {}) {
  return {
    type: 'SUBTITLE_QUERY',
    query: {
      videoId: '82147770',
      timestamp: 12,
      duration: 180,
      context: { videoId: '82147770', sessionId: 'watch-session-1', epoch: 3 }
    },
    ...overrides
  };
}

async function send(background, payload, sender = netflixSender(), name = 'subtitle-assistant-channel') {
  const { port, send: sendPortMessage, sentMessages } = createPort();
  port.name = name;
  port.sender = sender;
  background.connect(port);
  sendPortMessage({ messageId: 'subtitle-1', message: payload });
  return await waitForResponse(sentMessages, 'subtitle-1');
}

test('Given a trusted Netflix content Port When an exact subtitle query arrives Then only the fixed backend range is fetched', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({
    async fetchSubtitles(value) { calls.push(value); return []; }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, request()))), {
    ok: true,
    value: { subtitles: [] }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ videoId: '82147770', startTime: 12, duration: 180 }]);
});

test('Given hostile authority fields, Options-like Ports, or untrusted senders When subtitle queries arrive Then they fail closed before network', async () => {
  let calls = 0;
  const background = await loadBackgroundWithApi({
    async fetchSubtitles() { calls += 1; return []; }
  });
  const invalid = { ok: false, error: { kind: 'invalid', code: 'subtitle-query', retryable: false } };
  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'subtitle-port-access', retryable: false } };

  for (const payload of [
    { ...request(), endpoint: 'https://private.example' },
    { ...request(), command: 'FETCH' },
    { ...request(), backendProfileId: 'private' },
    request({ query: { ...request().query, destination: 'background' } }),
    request({ query: { ...request().query, context: { ...request().query.context, profile: 'private' } } }),
    request({ query: { ...request().query, duration: 179 } })
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await send(background, payload))), invalid);
  }

  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, request(), {
    id: 'subpal-extension-id',
    url: 'chrome-extension://subpal-extension-id/options.html',
    origin: 'chrome-extension://subpal-extension-id'
  }, 'options-page-channel'))), forbidden);
  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, request(), netflixSender({ id: 'other-extension' })))), forbidden);
  assert.equal(calls, 0);
});

test('Given a cold active profile without credentials When the first subtitle query arrives Then profile readiness completes before fetch', async () => {
  const order = [];
  const storage = {
    backendProfiles: {
      schemaVersion: 1,
      activeProfileId: 'default',
      byId: {
        default: { id: 'default', endpoint: 'https://api.example.test', userId: 'user-1', jwt: null }
      }
    }
  };
  const background = await loadBackgroundWithApi({
    async registerUser() { order.push('register'); return { token: 'registered-token' }; },
    async fetchSubtitles() { order.push('fetch'); return []; }
  }, { storage });

  const result = await send(background, request());

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, value: { subtitles: [] } });
  assert.deepEqual(order, ['register', 'fetch']);
  assert.equal(storage.backendProfiles.byId.default.jwt, 'registered-token');
});
