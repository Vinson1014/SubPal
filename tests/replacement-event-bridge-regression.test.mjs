import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadBridge(request) {
  const source = await readFile(new URL('../content/core/replacement-event-bridge.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, window: {}, __request: request });
  const contributions = new vm.SourceTextModule('export const createPageContributions = () => Object.freeze({ enqueue: input => globalThis.__request("enqueue", input), retry: operationId => globalThis.__request("retry", operationId) });', { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    if (specifier === '../system/capabilities/contributions.js') return contributions;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.replacementEventBridge;
}

function replacementEvent() {
  return {
    translationID: 'translation-1', contributorUserID: 'author-1', occurredAt: '2026-08-01T00:00:00.000Z'
  };
}

test('Given a valid replacement event When its bridge enqueues it Then it emits only the identity-free typed intent and returns the queued result', async () => {
  const messages = [];
  const bridge = await loadBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: 'replacement-1' } };
  });

  const result = await bridge.enqueue(replacementEvent());

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    variant: 'enqueue-replacement-event',
    payload: replacementEvent()
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, value: { status: 'queued-locally', operationId: 'replacement-1' } });
});

test('Given identity-bearing or invalid replacement input or a rejected enqueue When the bridge runs Then it emits no raw command and surfaces the error', async () => {
  const messages = [];
  const bridge = await loadBridge(async (_operation, message) => { messages.push(message); return { ok: false, error: { kind: 'domain-rejected', code: 'queue-rejected', retryable: false } }; });
  await assert.rejects(bridge.enqueue({}), /replacement event payload/i);
  for (const authority of [
    { beneficiaryUserID: 'forged-beneficiary' }, { userId: 'forged-user' }, { profile: 'forged-profile' },
    { endpoint: 'https://forged.example.test' }, { jwt: 'forged-jwt' }, { credential: 'forged-credential' }
  ]) {
    await assert.rejects(bridge.enqueue({ ...replacementEvent(), ...authority }), /replacement event payload/i);
  }
  await assert.rejects(bridge.enqueue(replacementEvent()), /queue-rejected/);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ variant: 'enqueue-replacement-event', payload: replacementEvent() }]);
});

test('Given a replacement event operation When its bridge retries it Then it sends the typed retry intent, returns retryScheduled, and exposes no history read', async () => {
  const messages = [];
  const bridge = await loadBridge(async (operation, input) => {
    messages.push({ operation, input });
    return { ok: true, value: { retryScheduled: true, operationId: 'replacement-operation-1' } };
  });

  const retried = await bridge.retry('replacement-operation-1');

  assert.equal(retried, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ operation: 'retry', input: 'replacement-operation-1' }]);
  assert.equal(typeof bridge.getHistory, 'undefined');
});
