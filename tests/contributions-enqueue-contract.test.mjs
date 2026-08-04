import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadContributions() {
  const [resultSource, contributionsSource] = await Promise.all([
    readFile(new URL('../content/system/capabilities/result.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/contributions.js', import.meta.url), 'utf8')
  ]);
  const context = vm.createContext({ crypto: { randomUUID: () => 'operation-1' } });
  const result = new vm.SourceTextModule(resultSource, {
    context,
    identifier: 'content/system/capabilities/result.js'
  });
  const privateTransports = new vm.SourceTextModule(
    'export const createDomTransport = () => { throw new Error("unused"); }; export const createEnvelope = () => { throw new Error("unused"); };',
    { context, identifier: 'content/system/capabilities/private-transports.js' }
  );
  const contributions = new vm.SourceTextModule(contributionsSource, {
    context,
    identifier: 'content/system/capabilities/contributions.js'
  });

  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await privateTransports.link(() => { throw new Error('private transports has no dependencies'); });
  await contributions.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transports.js') return privateTransports;
    throw new Error(`Unexpected contribution dependency: ${specifier}`);
  });
  await result.evaluate();
  await privateTransports.evaluate();
  await contributions.evaluate();
  return contributions.namespace.createContributions;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function voteIntent() {
  return {
    category: 'contribution-intent',
    variant: 'enqueue-vote',
    payload: {
      videoId: 'netflix-81234567',
      timestamp: 12.5,
      voteType: 'upvote',
      translationID: 'translation-1',
      voteState: 'like'
    }
  };
}

function replacementEventIntent(extraPayload = {}) {
  return {
    category: 'contribution-intent',
    variant: 'enqueue-replacement-event',
    payload: {
      translationID: 'translation-1',
      contributorUserID: 'contributor-1',
      occurredAt: '2026-08-01T00:00:00.000Z',
      ...extraPayload
    }
  };
}

test('Given a profile-bound vote whose storage write is pending When Contributions enqueues it Then success waits for persistence and returns only queued-locally with its operation ID', async () => {
  const createContributions = await loadContributions();
  const storageWrite = deferred();
  const persistenceStarted = deferred();
  const calls = [];
  const contributions = createContributions({
    persist(intent) {
      calls.push(intent);
      persistenceStarted.resolve();
      return storageWrite.promise;
    }
  });

  const enqueue = contributions.enqueue(voteIntent());

  await persistenceStarted.promise;
  assert.equal(await Promise.race([enqueue, Promise.resolve('pending')]), 'pending');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    payload: voteIntent().payload,
    variant: 'enqueue-vote'
  }]);

  storageWrite.resolve({ ok: true, value: { status: 'queued-locally', operationId: 'operation-1' } });

  assert.deepEqual(JSON.parse(JSON.stringify(await enqueue)), {
    ok: true,
    value: { status: 'queued-locally', operationId: 'operation-1' }
  });
});

test('Given cancellation occurs after durable persistence starts When the write succeeds Then Contributions returns queued-locally instead of cancellation', async () => {
  const createContributions = await loadContributions();
  const write = deferred();
  const started = deferred();
  const controller = new AbortController();
  const contributions = createContributions({
    persist() { started.resolve(); return write.promise; }
  });
  const enqueue = contributions.enqueue(voteIntent(), controller.signal);
  await started.promise;
  controller.abort();
  write.resolve({ ok: true, value: { status: 'queued-locally', operationId: 'operation-1' } });
  assert.deepEqual(JSON.parse(JSON.stringify(await enqueue)), { ok: true, value: { status: 'queued-locally', operationId: 'operation-1' } });
});

test('Given cancellation before the private handoff When Contributions enqueues Then persistence is not called', async () => {
  const createContributions = await loadContributions();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await createContributions({ persist() { calls += 1; } }).enqueue(voteIntent(), controller.signal);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    error: { kind: 'cancelled', code: 'caller-cancelled-before-persistence', retryable: false }
  });
});

test('Given an identity-free replacement event When Contributions enqueues it Then it forwards exactly its event fields and rejects caller identity authority', async () => {
  const createContributions = await loadContributions();
  const calls = [];
  const contributions = createContributions({
    persist(intent) {
      calls.push(intent);
      return { ok: true, value: { status: 'queued-locally', operationId: 'replacement-1' } };
    }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await contributions.enqueue(replacementEventIntent()))), {
    ok: true,
    value: { status: 'queued-locally', operationId: 'replacement-1' }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    variant: 'enqueue-replacement-event',
    payload: replacementEventIntent().payload
  }]);

  for (const authority of [
    { beneficiaryUserID: 'forged-beneficiary' }, { userId: 'forged-user' }, { profile: 'forged-profile' },
    { endpoint: 'https://forged.example.test' }, { jwt: 'forged-jwt' }, { credential: 'forged-credential' }
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await contributions.enqueue(replacementEventIntent(authority)))), {
      ok: false,
      error: { kind: 'invalid', code: 'contribution-payload', retryable: false }
    });
  }
  assert.equal(calls.length, 1);
});

test('Given the private transport times out When Contributions persists Then it owns the ten-second deadline and normalizes the terminal code', async () => {
  const createContributions = await loadContributions();
  const calls = [];
  const contributions = createContributions({
    persist(intent, options) {
      calls.push({ intent, options });
      return { ok: false, error: { kind: 'timeout', code: 'background-port-timeout', retryable: true } };
    }
  });
  const result = await contributions.enqueue(voteIntent());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.deadlineMs, 10000);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    error: { kind: 'timeout', code: 'local-persistence-timeout', retryable: true }
  });
});
