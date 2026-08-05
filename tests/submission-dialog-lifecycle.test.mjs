import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadDialog(configBridge) {
  const context = vm.createContext({ console });
  const source = await readFile(new URL('../content/ui/submission-dialog.js', import.meta.url), 'utf8');
  const language = new vm.SyntheticModule(['toAPILanguageCode'], function () {
    this.setExport('toAPILanguageCode', (value) => value);
  }, { context });
  const config = new vm.SyntheticModule(['configBridge'], function () {
    this.setExport('configBridge', configBridge);
  }, { context });
  const modules = new Map([
    ['../utils/language-code.js', language],
    ['../system/config/config-bridge.js', config]
  ]);
  const module = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: async (specifier) => {
      const dependency = modules.get(specifier);
      if (!dependency) throw new Error(`Unexpected dynamic import: ${specifier}`);
      if (dependency.status === 'unlinked') await dependency.link(() => { throw new Error('Unexpected dependency'); });
      if (dependency.status === 'linked') await dependency.evaluate();
      return dependency;
    }
  });
  await module.link(async (specifier) => {
    const dependency = modules.get(specifier);
    if (!dependency) throw new Error(`Unexpected static import: ${specifier}`);
    return dependency;
  });
  await module.evaluate();
  return module.namespace.SubmissionDialog;
}

function createTrackedConfigBridge() {
  const callbacks = new Set();
  let unsubscribeCalls = 0;
  return {
    bridge: {
      get: () => false,
      subscribe: (_key, callback) => {
        callbacks.add(callback);
        return () => {
          unsubscribeCalls += 1;
          callbacks.delete(callback);
        };
      }
    },
    emit(value) {
      for (const callback of callbacks) callback(value);
    },
    get activeSubscriptions() { return callbacks.size; },
    get unsubscribeCalls() { return unsubscribeCalls; }
  };
}

function createSubmissionHarness(SubmissionDialog, submitResult) {
  const dialog = new SubmissionDialog();
  const submissionStates = [];
  let closeCalls = 0;
  let callbackCalls = 0;

  dialog.currentSubtitleData = {
    videoId: 'video-1',
    timestamp: 42,
    original: 'Original subtitle'
  };
  dialog.inputs = {
    languageDisplay: { getAttribute: () => 'en' },
    translationInput: { value: 'Corrected subtitle' },
    reasonInput: { value: 'More natural wording' }
  };
  dialog.setSubmitting = (...args) => {
    submissionStates.push(args);
  };
  dialog.close = () => {
    closeCalls += 1;
  };
  dialog.onSubmit(() => {
    callbackCalls += 1;
    return submitResult;
  });

  return {
    dialog,
    get callbackCalls() { return callbackCalls; },
    get closeCalls() { return closeCalls; },
    submissionStates
  };
}

test('Given an initialized dialog When per-open resources close and the dialog is reused Then its config subscription remains active until final cleanup', async () => {
  const config = createTrackedConfigBridge();
  const SubmissionDialog = await loadDialog(config.bridge);
  const dialog = new SubmissionDialog();
  await dialog.initialize();
  dialog.isOpen = true;

  dialog.close();
  config.emit(true);

  assert.equal(config.activeSubscriptions, 1);
  assert.equal(config.unsubscribeCalls, 0);
  assert.equal(dialog.debug, true);

  dialog.cleanup();
  assert.equal(config.activeSubscriptions, 0);
  assert.equal(config.unsubscribeCalls, 1);
});

test('Given owner-capturing callbacks and current payload When final cleanup repeats Then no subscription, callback, payload, or owner reference remains', async () => {
  const config = createTrackedConfigBridge();
  const SubmissionDialog = await loadDialog(config.bridge);
  const dialog = new SubmissionDialog();
  const owner = { id: 'owner' };
  await dialog.initialize();
  dialog.currentSubtitleData = { owner };
  dialog.onSubmit(() => owner);
  dialog.onCancel(() => owner);
  dialog.onClose(() => owner);

  dialog.cleanup();
  dialog.cleanup();

  assert.equal(config.activeSubscriptions, 0);
  assert.equal(config.unsubscribeCalls, 1);
  assert.equal(dialog.currentSubtitleData, null);
  assert.equal(dialog.eventCallbacks.onSubmit, null);
  assert.equal(dialog.eventCallbacks.onCancel, null);
  assert.equal(dialog.eventCallbacks.onClose, null);
  assert.equal(dialog.configBridge, null);
});

test('Given a locally queued translation When submission completes Then the dialog closes without a failure state', async () => {
  const SubmissionDialog = await loadDialog(createTrackedConfigBridge().bridge);
  const queuedResult = { status: 'queued-locally', operationId: 'operation-1' };
  const harness = createSubmissionHarness(SubmissionDialog, queuedResult);

  const result = await harness.dialog.handleSubmit();

  assert.equal(result, queuedResult);
  assert.equal(harness.callbackCalls, 1);
  assert.equal(harness.closeCalls, 1);
  assert.deepEqual(harness.submissionStates, [[true]]);
});

test('Given an explicit submission error When submission completes Then the dialog stays open and displays the error', async () => {
  const SubmissionDialog = await loadDialog(createTrackedConfigBridge().bridge);
  const errorResult = { status: 'error', error: 'queue unavailable' };
  const harness = createSubmissionHarness(SubmissionDialog, errorResult);

  const result = await harness.dialog.handleSubmit();

  assert.equal(result.status, errorResult.status);
  assert.equal(result.error, errorResult.error);
  assert.equal(harness.callbackCalls, 1);
  assert.equal(harness.closeCalls, 0);
  assert.deepEqual(harness.submissionStates, [[true], [false, 'queue unavailable']]);
});

test('Given a legacy success acknowledgement When submission completes Then the dialog stays open with a retryable error', async () => {
  const SubmissionDialog = await loadDialog(createTrackedConfigBridge().bridge);
  const harness = createSubmissionHarness(SubmissionDialog, { status: 'success' });
  harness.dialog.isOpen = true;

  const result = await harness.dialog.handleSubmit();

  assert.equal(result.status, 'error');
  assert.equal(result.error, '翻譯提交失敗，請再試一次。');
  assert.equal(harness.callbackCalls, 1);
  assert.equal(harness.closeCalls, 0);
  assert.equal(harness.dialog.isOpen, true);
  assert.deepEqual(harness.submissionStates, [[true], [false, '翻譯提交失敗，請再試一次。']]);
});
