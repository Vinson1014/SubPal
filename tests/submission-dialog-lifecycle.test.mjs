import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadDialog(configBridge) {
  const context = vm.createContext({ console });
  const source = await readFile(new URL('../content/ui/submission-dialog.js', import.meta.url), 'utf8');
  const messaging = new vm.SyntheticModule(['sendMessage', 'registerInternalEventHandler'], function () {
    this.setExport('sendMessage', async () => ({}));
    this.setExport('registerInternalEventHandler', () => () => {});
  }, { context });
  const language = new vm.SyntheticModule(['toAPILanguageCode'], function () {
    this.setExport('toAPILanguageCode', (value) => value);
  }, { context });
  const config = new vm.SyntheticModule(['configBridge'], function () {
    this.setExport('configBridge', configBridge);
  }, { context });
  const modules = new Map([
    ['../system/messaging.js', messaging],
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
