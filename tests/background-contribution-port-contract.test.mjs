import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPort, loadBackgroundWithApi, netflixSender, waitForResponse } from './crowdsourcing-test-harness.mjs';

function intent() {
  return {
    category: 'contribution-intent',
    variant: 'enqueue-vote',
    payload: { videoId: 'netflix-81234567', timestamp: 12.5, voteType: 'upvote' }
  };
}

async function send(background, request, sender = netflixSender(), name = 'subtitle-assistant-channel', beforeSend = () => {}) {
  const { port, send, sentMessages } = createPort();
  port.name = name;
  port.sender = sender;
  background.connect(port);
  beforeSend(port);
  send({ messageId: 'contribution-1', message: request });
  return await waitForResponse(sentMessages, 'contribution-1');
}

test('Given an authorized Netflix content Port When it submits the exact private contribution command Then the background owner persists once before ACK', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      parseContributionIntent(value) { return value?.category === 'contribution-intent' ? { accepted: true } : null; },
      async enqueueContribution(_storage, value) {
        calls.push(value);
        return { status: 'queued-locally', operationId: 'operation-1' };
      }
    }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, { type: 'CONTRIBUTION_ENQUEUE', intent: intent() }))), {
    ok: true,
    value: { status: 'queued-locally', operationId: 'operation-1' }
  });
  assert.deepEqual(calls, [intent()]);
});

test('Given malformed SPA-drift requests or hostile Ports When contribution commands arrive Then they reject without queue or migration effects', async () => {
  let calls = 0;
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      parseContributionIntent(value) { return value?.category === 'contribution-intent' && !Object.hasOwn(value, 'backendProfileId') ? { accepted: true } : null; },
      async enqueueContribution() { calls += 1; return { status: 'queued-locally', operationId: 'unexpected' }; }
    }
  });
  const baseline = background.storageCalls.length;
  const invalid = { ok: false, error: { kind: 'invalid', code: 'contribution-input', retryable: false } };

  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, { type: 'CONTRIBUTION_ENQUEUE', intent: { ...intent(), backendProfileId: 'forged' } }))), invalid);
  for (const sender of [
    netflixSender({
      tab: { id: 7, url: 'https://www.netflix.com/watch/82147770' },
      url: 'https://www.netflix.com/watch/81664909',
      origin: 'https://www.netflix.com'
    }),
    netflixSender({
      tab: { id: 7, url: 'https://www.netflix.com/watch/82147770?current=1' },
      url: 'https://www.netflix.com/watch/82147770?stale=1',
      origin: 'https://www.netflix.com'
    })
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await send(background, {
      type: 'CONTRIBUTION_ENQUEUE', intent: { ...intent(), backendProfileId: 'forged' }
    }, sender))), invalid);
  }
  assert.equal(calls, 0);
  assert.equal(background.storageCalls.length, baseline);
  assert.equal(background.profileMigrationCalls, 0);
});

test('Given a retired generic contribution command When it reaches the background Port Then it remains unhandled without owner, storage, or migration effects', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      async getContributionProjection() { calls.push('read'); return {}; },
      async retryContribution() { calls.push('retry'); return true; }
    }
  });
  const baseline = background.storageCalls.length;

  for (const type of ['VOTE_RETRY', 'TRANSLATION_RETRY', 'REPLACEMENT_EVENT_RETRY', 'VOTE_GET_AUTHORITY']) {
    assert.deepEqual(JSON.parse(JSON.stringify(await send(background, { type, payload: { itemId: 'operation-a' } }))), {
      success: false,
      error: `Unhandled message type (port) ${type}`
    });
  }
  assert.deepEqual(calls, []);
  assert.equal(background.storageCalls.length, baseline);
  assert.equal(background.profileMigrationCalls, 0);
});

test('Given an exact trusted contribution Port When it reads a projection or retries one operation Then the background independently validates and authorizes it with the active profile', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      async getContributionProjection(_storage, approvedRead) {
        calls.push(['read', approvedRead]);
        return { authority: { myVote: 'like', upvotes: 3, downvotes: 1 }, hasPendingVote: false, permanentFailure: null };
      },
      async retryContribution(_storage, operationId, profileId) {
        calls.push(['retry', operationId, profileId]);
        return true;
      }
    }
  });

  const projection = { variant: 'vote-authority', payload: { translationID: 'translation-a' } };
  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, {
    type: 'CONTRIBUTION_READ', projection
  }))), {
    ok: true,
    value: { authority: { myVote: 'like', upvotes: 3, downvotes: 1 }, hasPendingVote: false, permanentFailure: null }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, {
    type: 'CONTRIBUTION_RETRY', operationId: 'operation-a'
  }))), { ok: true, value: { retryScheduled: true, operationId: 'operation-a' } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['read', { variant: 'vote-authority', payload: { translationID: 'translation-a' } }],
    ['retry', 'operation-a', 'default']
  ]);
});

test('Given hostile contribution envelopes or non-canonical Ports When closed read and retry commands arrive Then they reject before queue or profile effects', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      async getContributionProjection() { calls.push('read'); return {}; },
      async retryContribution() { calls.push('retry'); return true; }
    }
  });
  const baseline = background.storageCalls.length;
  const inherited = Object.assign(Object.create({ operationId: 'operation-a' }), { type: 'CONTRIBUTION_RETRY' });
  const accessor = { type: 'CONTRIBUTION_RETRY' };
  Object.defineProperty(accessor, 'operationId', { enumerable: true, get() { return 'operation-a'; } });
  const symbol = { type: 'CONTRIBUTION_RETRY', operationId: 'operation-a' };
  symbol[Symbol('private')] = true;
  const invalid = { ok: false, error: { kind: 'invalid', code: 'contribution-input', retryable: false } };

  for (const request of [
    inherited,
    accessor,
    symbol,
    { type: 'CONTRIBUTION_RETRY', operationId: 'operation-a', backendProfileId: 'forged' },
    { type: 'CONTRIBUTION_READ', projection: { variant: 'vote-authority', payload: { translationID: 'translation-a', jwt: 'secret' } } },
    { type: 'CONTRIBUTION_READ', projection: { variant: 'vote-authority', payload: { translationID: 'translation-a' }, profileId: 'forged' } }
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await send(background, request))), invalid);
  }

  const forbidden = { ok: false, error: { kind: 'forbidden', code: 'contribution-port-access', retryable: false } };
  for (const [sender, name, beforeSend] of [
    [netflixSender({ id: 'other-extension' }), 'subtitle-assistant-channel'],
    [netflixSender(), 'subtitle-assistant-channel', (port) => { port.sender = netflixSender({ tab: { url: 'https://www.netflix.com/watch/82147770' } }); }],
    [netflixSender({ tab: { id: -1, url: 'https://www.netflix.com/watch/82147770' } }), 'subtitle-assistant-channel'],
    [netflixSender({ tab: { id: 7, url: 'http://www.netflix.com/watch/82147770' }, url: 'http://www.netflix.com/watch/82147770', origin: 'http://www.netflix.com' }), 'subtitle-assistant-channel'],
    [netflixSender({ tab: { id: 7, url: 'https://example.com/watch/82147770' }, url: 'https://example.com/watch/82147770', origin: 'https://example.com' }), 'subtitle-assistant-channel'],
    [netflixSender({ origin: 'https://evil.example.test' }), 'subtitle-assistant-channel'],
    [netflixSender({ tab: { id: 7, url: 'https://help.netflix.com/watch/82147770' } }), 'subtitle-assistant-channel'],
    [netflixSender(), 'options-page-channel']
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await send(background, {
      type: 'CONTRIBUTION_RETRY', operationId: 'operation-a'
    }, sender, name, beforeSend))), forbidden);
  }
  assert.deepEqual(calls, []);
  assert.equal(background.storageCalls.length, baseline);
  assert.equal(background.profileMigrationCalls, 0);
});

test('Given a trusted retry caller When T1 rejects a missing, foreign, or inactive operation Then it returns the same minimized operation-not-found Result', async () => {
  const secret = 'jwt profile-private-id must not escape';
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      async retryContribution() { throw new Error(secret); }
    }
  });

  const response = JSON.parse(JSON.stringify(await send(background, {
    type: 'CONTRIBUTION_RETRY', operationId: 'operation-hidden'
  })));
  assert.deepEqual(response, {
    ok: false,
    error: { kind: 'domain-rejected', code: 'operation-not-found', retryable: false }
  });
  assert.equal(JSON.stringify(response).includes(secret), false);
  assert.equal(JSON.stringify(response).includes('operation-hidden'), false);
});
