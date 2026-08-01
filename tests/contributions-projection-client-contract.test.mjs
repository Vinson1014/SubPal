import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadContributions() {
  const [resultSource, contributionsSource] = await Promise.all([
    readFile(new URL('../content/system/capabilities/result.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/contributions.js', import.meta.url), 'utf8')
  ]);
  const context = vm.createContext({ structuredClone });
  const result = new vm.SourceTextModule(resultSource, { context, identifier: 'content/system/capabilities/result.js' });
  const contributions = new vm.SourceTextModule(contributionsSource, { context, identifier: 'content/system/capabilities/contributions.js' });

  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await contributions.link((specifier) => {
    if (specifier === './result.js') return result;
    throw new Error(`Unexpected contribution dependency: ${specifier}`);
  });
  await result.evaluate();
  await contributions.evaluate();
  return contributions.namespace.createContributions;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const voteAuthorityRead = () => ({ variant: 'vote-authority', payload: { translationID: 'translation-1' } });
const reconciliationRead = () => ({ variant: 'translation-reconciliation', payload: { operationIds: ['operation-1', 'operation-2'] } });

test('Given approved contribution reads and a retry When MAIN invokes Contributions Then each reaches only its typed private operation with the capability deadline', async () => {
  const createContributions = await loadContributions();
  const reads = [];
  const retries = [];
  const contributions = createContributions({
    persistenceDeadlineMs: 4321,
    readProjection(read, options) {
      reads.push({ read, options });
      return read.variant === 'vote-authority'
        ? { ok: true, value: {
          authority: { myVote: 'like', upvotes: 4, downvotes: 1 },
          hasPendingVote: false,
          permanentFailure: { previousVoteState: 'none', previousCounts: { like: 2, dislike: 3 } }
        } }
        : { ok: true, value: [
          { operationId: 'operation-1', status: 'failed', syncedAt: null, terminal: false },
          { operationId: 'operation-2', status: 'completed', syncedAt: 20, terminal: true }
        ] };
    },
    retryOperation(operationId, options) {
      retries.push({ operationId, options });
      return { ok: true, value: { retryScheduled: true, operationId } };
    }
  });

  assert.deepEqual(plain(await contributions.getProjection(voteAuthorityRead())), {
    ok: true,
    value: {
      authority: { myVote: 'like', upvotes: 4, downvotes: 1 },
      hasPendingVote: false,
      permanentFailure: { previousVoteState: 'none', previousCounts: { like: 2, dislike: 3 } }
    }
  });
  assert.deepEqual(plain(await contributions.getProjection(reconciliationRead())), {
    ok: true,
    value: [
      { operationId: 'operation-1', status: 'failed', syncedAt: null, terminal: false },
      { operationId: 'operation-2', status: 'completed', syncedAt: 20, terminal: true }
    ]
  });
  assert.deepEqual(plain(await contributions.retry('operation-1')), {
    ok: true,
    value: { retryScheduled: true, operationId: 'operation-1' }
  });
  assert.deepEqual(plain(reads), [
    { read: voteAuthorityRead(), options: { deadlineMs: 4321 } },
    { read: reconciliationRead(), options: { deadlineMs: 4321 } }
  ]);
  assert.deepEqual(plain(retries), [{ operationId: 'operation-1', options: { deadlineMs: 4321 } }]);
});

test('Given authority-bearing, inherited, accessor, symbol, Proxy, or speculative inputs When MAIN invokes Contributions Then none reach private transport', async () => {
  const createContributions = await loadContributions();
  let reads = 0;
  let retries = 0;
  const contributions = createContributions({
    readProjection() { reads += 1; },
    retryOperation() { retries += 1; }
  });
  const inherited = Object.create({ variant: 'vote-authority' });
  inherited.payload = { translationID: 'translation-1' };
  const accessor = { variant: 'vote-authority' };
  Object.defineProperty(accessor, 'payload', { enumerable: true, get: () => ({ translationID: 'translation-1' }) });
  const symbol = voteAuthorityRead();
  symbol[Symbol('private')] = true;

  for (const input of [
    { variant: 'active-profile-summary', payload: {} },
    inherited,
    accessor,
    symbol,
    new Proxy(voteAuthorityRead(), {}),
    { variant: 'vote-authority', payload: { translationID: 'translation-1', profileId: 'private-profile' } },
    { variant: 'vote-authority', payload: { translationID: 'translation-1', endpoint: 'https://private.example.test' } },
    { variant: 'vote-authority', payload: { translationID: 'translation-1', jwt: 'private-jwt' } },
    { variant: 'vote-authority', payload: { translationID: 'translation-1', storage: 'local' } },
    { variant: 'vote-authority', payload: { translationID: 'translation-1', sync: true } },
    { variant: 'vote-authority', payload: { translationID: 'translation-1', authorization: 'Bearer private' } },
    { variant: 'translation-reconciliation', payload: { operationIds: ['operation-1', 'operation-1'] } }
  ]) {
    assert.deepEqual(plain(await contributions.getProjection(input)), {
      ok: false,
      error: { kind: 'invalid', code: 'contribution-projection', retryable: false }
    });
  }
  for (const operationId of ['', null, { operationId: 'private-operation' }]) {
    assert.deepEqual(plain(await contributions.retry(operationId)), {
      ok: false,
      error: { kind: 'invalid', code: 'contribution-retry', retryable: false }
    });
  }
  assert.equal(reads, 0);
  assert.equal(retries, 0);
});

test('Given terminal private results and malformed successes When Contributions reads or retries Then it returns one terminal result and never accepts raw fields', async () => {
  const createContributions = await loadContributions();
  let readCalls = 0;
  let retryCalls = 0;
  const contributions = createContributions({
    readProjection() {
      readCalls += 1;
      return { ok: true, value: {
        authority: null,
        hasPendingVote: false,
        permanentFailure: null,
        rawProfile: 'must-not-reach-main'
      } };
    },
    retryOperation() {
      retryCalls += 1;
      return { ok: false, error: { kind: 'timeout', code: 'background-port-timeout', retryable: true } };
    }
  });

  assert.deepEqual(plain(await contributions.getProjection(voteAuthorityRead())), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'contribution-projection-response', retryable: false }
  });
  assert.deepEqual(plain(await contributions.retry('operation-1')), {
    ok: false,
    error: { kind: 'timeout', code: 'background-port-timeout', retryable: true }
  });
  assert.equal(readCalls, 1);
  assert.equal(retryCalls, 1);

  const rejectedRetry = createContributions({
    retryOperation(operationId) {
      retryCalls += 1;
      return { ok: true, value: { retryScheduled: true, operationId: `${operationId}-other` } };
    }
  });
  assert.deepEqual(plain(await rejectedRetry.retry('operation-1')), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'contribution-retry-response', retryable: false }
  });

  const cancelledDuringRequest = createContributions({
    retryOperation(_, options) {
      retryCalls += 1;
      return new Promise((resolve) => options.signal.addEventListener('abort', () => {
        resolve({ ok: false, error: { kind: 'cancelled', code: 'caller-cancelled', retryable: false } });
      }, { once: true }));
    }
  });
  const controller = new AbortController();
  const inFlight = cancelledDuringRequest.retry('operation-1', controller.signal);
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(plain(await inFlight), {
    ok: false,
    error: { kind: 'cancelled', code: 'caller-cancelled', retryable: false }
  });
  assert.equal(retryCalls, 3);

  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(plain(await contributions.retry('operation-1', cancelled.signal)), {
    ok: false,
    error: { kind: 'cancelled', code: 'caller-cancelled-before-retry', retryable: false }
  });
  assert.equal(retryCalls, 3);
});

test('Given hostile transport failure metadata When Contributions reads or retries Then MAIN receives only the exact safe error fields', async () => {
  const createContributions = await loadContributions();
  const secret = 'jwt-and-raw-error-must-not-reach-main';
  const contributions = createContributions({
    readProjection() {
      return { ok: false, error: {
        kind: 'timeout', code: 'projection-timeout', retryable: true,
        meta: { secret, rawError: { message: secret, stack: secret } }
      } };
    },
    retryOperation() {
      return { ok: false, error: {
        kind: 'domain-rejected', code: 'retry-rejected', retryable: false,
        meta: { endpoint: 'https://private.example.test', jwt: secret }
      } };
    }
  });

  const results = plain([
    await contributions.getProjection(voteAuthorityRead()),
    await contributions.retry('operation-1')
  ]);
  assert.deepEqual(results, [
    { ok: false, error: { kind: 'timeout', code: 'projection-timeout', retryable: true } },
    { ok: false, error: { kind: 'domain-rejected', code: 'retry-rejected', retryable: false } }
  ]);
  assert.equal(JSON.stringify(results).includes(secret), false);
});

test('Given foreign duplicate unrequested excess or malformed reconciliation records When Contributions parses them Then none become MAIN results', async () => {
  const createContributions = await loadContributions();
  const valid = (operationId) => ({ operationId, status: 'completed', syncedAt: 20, terminal: true });
  const hostileResponses = [
    [valid('operation-1'), valid('operation-1')],
    [valid('operation-foreign')],
    [valid('operation-1'), valid('operation-2'), valid('operation-excess')],
    [{ ...valid('operation-1'), rawError: 'private' }],
    [{ ...valid('operation-1'), status: 'synced' }],
    [{ ...valid('operation-1'), syncedAt: '20' }],
    [{ ...valid('operation-1'), terminal: 'true' }]
  ];

  for (const value of hostileResponses) {
    const contributions = createContributions({ readProjection: () => ({ ok: true, value }) });
    assert.deepEqual(plain(await contributions.getProjection(reconciliationRead())), {
      ok: false,
      error: { kind: 'domain-rejected', code: 'contribution-projection-response', retryable: false }
    });
  }

  const subset = createContributions({
    readProjection: () => ({ ok: true, value: [valid('operation-2')] })
  });
  assert.deepEqual(plain(await subset.getProjection(reconciliationRead())), {
    ok: true,
    value: [valid('operation-2')]
  });
});
