import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadTranslationBridge(sendMessage) {
  const source = await readFile(new URL('../content/core/translation-bridge.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, __sendMessage: sendMessage });
  const messagingModule = new vm.SourceTextModule(
    'export const sendMessage = globalThis.__sendMessage;',
    { context }
  );
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/core/translation-bridge.js'
  });

  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messagingModule;
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

test('Given a normal subtitle hover submission When translationBridge enqueues it Then it uses a typed contribution intent with the existing payload', async () => {
  const messages = [];
  const translationBridge = await loadTranslationBridge(async (message) => {
    messages.push(message);
    return { itemId: 'hover-translation-1' };
  });

  await translationBridge.enqueue(legacyTranslation({ slotKey: 'slot-000124' }));

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    category: 'contribution-intent',
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

test('Given sendMessage returns an error When translationBridge enqueues Then the response error is wrapped', async () => {
  const translationBridge = await loadTranslationBridge(async () => ({ error: 'queue rejected translation' }));

  await assert.rejects(
    translationBridge.enqueue(legacyTranslation()),
    /翻譯提交加入隊列失敗: queue rejected translation/
  );
});

test('Given a translation operation When translationBridge retries it Then it sends the typed retry intent, returns retryScheduled, and exposes no history or status reads', async () => {
  const messages = [];
  const translationBridge = await loadTranslationBridge(async (message) => {
    messages.push(message);
    return { retryScheduled: true, operationId: 'translation-operation-1' };
  });

  const retried = await translationBridge.retry('translation-operation-1');

  assert.equal(retried, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    category: 'contribution-intent',
    variant: 'retry-operation',
    payload: { operationId: 'translation-operation-1' }
  }]);
  assert.equal(typeof translationBridge.getHistory, 'undefined');
  assert.equal(typeof translationBridge.getStatus, 'undefined');
});

test('Given an official subtitle task When its improvement is submitted Then translationID is not required and exact resolutionContext is preserved', async () => {
  const messages = [];
  const translationBridge = await loadTranslationBridge(async (message) => {
    messages.push(message);
    return { itemId: 'official-submit-1' };
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
  const translationBridge = await loadTranslationBridge(async (message) => {
    messages.push(message);
    return { itemId: 'candidate-submit-1' };
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
