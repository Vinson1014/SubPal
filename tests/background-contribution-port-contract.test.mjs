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

async function send(background, request, sender = netflixSender()) {
  const { port, send, sentMessages } = createPort();
  port.sender = sender;
  background.connect(port);
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

test('Given malformed or authority-bearing requests and untrusted Ports When contribution commands arrive Then they have zero queue side effects', async () => {
  let calls = 0;
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      parseContributionIntent(value) { return value?.category === 'contribution-intent' && !Object.hasOwn(value, 'backendProfileId') ? { accepted: true } : null; },
      async enqueueContribution() { calls += 1; return { status: 'queued-locally', operationId: 'unexpected' }; }
    }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, { type: 'CONTRIBUTION_ENQUEUE', intent: { ...intent(), backendProfileId: 'forged' } }))), {
    ok: false,
    error: { kind: 'invalid', code: 'contribution-input', retryable: false }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, { type: 'CONTRIBUTION_ENQUEUE', intent: intent() }, netflixSender({ id: 'other-extension' })))), {
    ok: false,
    error: { kind: 'forbidden', code: 'contribution-port-access', retryable: false }
  });
  assert.equal(calls, 0);
});

test('Given an authorized legacy compatibility request When it reaches the background Port Then it preserves legacy retry and authority shapes without caller profile authority', async () => {
  const calls = [];
  const background = await loadBackgroundWithApi({}, {
    contributionQueue: {
      parseContributionIntent: () => null,
      async retryContribution(_storage, type, itemId) { calls.push([type, itemId]); return true; },
      async readVoteAuthority(_storage, translationID) {
        calls.push(['VOTE_GET_AUTHORITY', translationID]);
        return { authority: null, hasPendingVote: false, permanentFailure: null };
      }
    }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, { type: 'VOTE_RETRY', payload: { itemId: 'operation-a' } }))), { success: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await send(background, { type: 'VOTE_GET_AUTHORITY', payload: { translationID: 'translation-a' } }))), {
    authority: null,
    hasPendingVote: false,
    permanentFailure: null
  });
  assert.deepEqual(calls, [['VOTE_RETRY', 'operation-a'], ['VOTE_GET_AUTHORITY', 'translation-a']]);
});
