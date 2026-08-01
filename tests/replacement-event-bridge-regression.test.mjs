import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadBridge(sendMessage) {
  const source = await readFile(new URL('../content/core/replacement-event-bridge.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, __sendMessage: sendMessage });
  const messaging = new vm.SourceTextModule('export const sendMessage = globalThis.__sendMessage;', { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messaging;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.replacementEventBridge;
}

test('Given a valid replacement event When its bridge enqueues it Then it emits only the typed intent and returns the queued result', async () => {
  const messages = [];
  const bridge = await loadBridge(async (message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: 'replacement-1' } };
  });

  const result = await bridge.enqueue({
    translationID: 'translation-1', contributorUserID: 'author-1', beneficiaryUserID: 'viewer-1', occurredAt: '2026-08-01T00:00:00.000Z'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    category: 'contribution-intent', variant: 'enqueue-replacement-event',
    payload: { translationID: 'translation-1', contributorUserID: 'author-1', beneficiaryUserID: 'viewer-1', occurredAt: '2026-08-01T00:00:00.000Z' }
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, value: { status: 'queued-locally', operationId: 'replacement-1' } });
});

test('Given invalid replacement input or a rejected enqueue When the bridge runs Then it emits no raw command and surfaces the error', async () => {
  const messages = [];
  const bridge = await loadBridge(async (message) => { messages.push(message); return { error: 'queue rejected' }; });
  await assert.rejects(bridge.enqueue({}), /translationID/);
  await assert.rejects(bridge.enqueue({ translationID: 'translation-1', contributorUserID: 'author-1', beneficiaryUserID: 'viewer-1', occurredAt: '2026-08-01T00:00:00.000Z' }), /queue rejected/);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ category: 'contribution-intent', variant: 'enqueue-replacement-event', payload: { translationID: 'translation-1', contributorUserID: 'author-1', beneficiaryUserID: 'viewer-1', occurredAt: '2026-08-01T00:00:00.000Z' } }]);
});

test('Given a replacement event operation When its bridge retries it Then it sends the typed retry intent, returns retryScheduled, and exposes no history read', async () => {
  const messages = [];
  const bridge = await loadBridge(async (message) => {
    messages.push(message);
    return { retryScheduled: true, operationId: 'replacement-operation-1' };
  });

  const retried = await bridge.retry('replacement-operation-1');

  assert.equal(retried, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    category: 'contribution-intent',
    variant: 'retry-operation',
    payload: { operationId: 'replacement-operation-1' }
  }]);
  assert.equal(typeof bridge.getHistory, 'undefined');
});
