import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadTranslationBridge(request) {
  const source = await readFile(new URL('../content/core/translation-bridge.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, window: {}, __request: request });
  const contributionsModule = new vm.SourceTextModule(
    'export const createPageContributions = () => Object.freeze({ enqueue: input => globalThis.__request("enqueue", input), retry: operationId => globalThis.__request("retry", operationId) });',
    { context }
  );
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/core/translation-bridge.js'
  });

  await module.link((specifier) => {
    if (specifier === '../system/capabilities/contributions.js') return contributionsModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.translationBridge;
}

function legacyTranslation(overrides = {}) {
  return {
    videoId: 'netflix-81234567',
    timestamp: 12.5,
    original: 'Original subtitle',
    translation: 'Improved subtitle',
    languageCode: 'zh-TW',
    submissionReason: 'normal subtitle hover submission',
    ...overrides
  };
}

function resolutionContext(overrides = {}) {
  return {
    taskID: 'official:netflix-81234567:zh-TW:slot-000124',
    targetType: 'official-subtitle',
    action: 'submit-improvement',
    slotKey: 'slot-000124',
    timestamp: 124.5,
    ...overrides
  };
}

test('Given a normal subtitle hover submission When translationBridge enqueues it Then it uses the narrow contribution interface with the existing payload', async () => {
  const messages = [];
  const translationBridge = await loadTranslationBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: 'hover-translation-1' } };
  });

  await translationBridge.enqueue(legacyTranslation({ slotKey: 'slot-000124' }));

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    variant: 'enqueue-translation',
    payload: {
      videoId: 'netflix-81234567',
      timestamp: 12.5,
      original: 'Original subtitle',
      translation: 'Improved subtitle',
      languageCode: 'zh-TW',
      submissionReason: 'normal subtitle hover submission',
      slotKey: 'slot-000124'
    }
  }]);
});

test('Given the page contribution client returns a failure When translationBridge enqueues Then the normalized error is wrapped', async () => {
  const translationBridge = await loadTranslationBridge(async () => ({ ok: false, error: { kind: 'domain-rejected', code: 'queue-rejected-translation', retryable: false } }));

  await assert.rejects(
    translationBridge.enqueue(legacyTranslation()),
    /翻譯提交加入隊列失敗: queue-rejected-translation/
  );
});

test('Given a translation operation When translationBridge retries it Then it sends the typed retry intent, returns retryScheduled, and exposes no history or status reads', async () => {
  const messages = [];
  const translationBridge = await loadTranslationBridge(async (operation, input) => {
    messages.push({ operation, input });
    return { ok: true, value: { retryScheduled: true, operationId: 'translation-operation-1' } };
  });

  const retried = await translationBridge.retry('translation-operation-1');

  assert.equal(retried, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ operation: 'retry', input: 'translation-operation-1' }]);
  assert.equal(typeof translationBridge.getHistory, 'undefined');
  assert.equal(typeof translationBridge.getStatus, 'undefined');
});

test('Given an official subtitle task When its improvement is submitted Then translationID is not required and exact resolutionContext is preserved', async () => {
  const messages = [];
  const translationBridge = await loadTranslationBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: 'official-submit-1' } };
  });
  const context = resolutionContext();

  await translationBridge.enqueue({
    ...legacyTranslation(),
    translationID: null,
    resolutionContext: context
  });

  const payload = JSON.parse(JSON.stringify(messages[0].payload));
  assert.equal(payload.translationID, null);
  assert.deepEqual(payload.resolutionContext, context);
  assert.deepEqual(Object.keys(payload.resolutionContext).sort(), [
    'action', 'slotKey', 'targetType', 'taskID', 'timestamp'
  ]);
});

test('Given a candidate task When a better translation is submitted Then sourceTranslationID and exact resolutionContext are preserved', async () => {
  const messages = [];
  const translationBridge = await loadTranslationBridge(async (_operation, message) => {
    messages.push(message);
    return { ok: true, value: { status: 'queued-locally', operationId: 'candidate-submit-1' } };
  });
  const context = resolutionContext({ action: 'submit-better-candidate' });

  await translationBridge.enqueue({
    ...legacyTranslation({
      translation: 'A better candidate',
      submissionReason: 'candidate improvement'
    }),
    sourceTranslationID: '550e8400-e29b-41d4-a716-446655440000',
    resolutionContext: context
  });

  const payload = JSON.parse(JSON.stringify(messages[0].payload));
  assert.equal(payload.sourceTranslationID, '550e8400-e29b-41d4-a716-446655440000');
  assert.deepEqual(payload.resolutionContext, context);
  assert.deepEqual(Object.keys(payload.resolutionContext).sort(), [
    'action', 'slotKey', 'targetType', 'taskID', 'timestamp'
  ]);
});
