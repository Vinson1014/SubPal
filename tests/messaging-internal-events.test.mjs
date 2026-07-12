import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadMessagingModule() {
  const source = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/system/messaging.js'
  });
  await module.link(() => {
    throw new Error('messaging.js should not import dependencies for this test');
  });
  await module.evaluate();
  return module.namespace;
}

test('Given an internal event handler When it is registered Then a disposer is returned and removes only that handler', async () => {
  const messaging = await loadMessagingModule();
  const events = [];
  const firstHandler = (message) => events.push(`first:${message.type}`);
  const secondHandler = (message) => events.push(`second:${message.type}`);

  const firstDisposer = messaging.registerInternalEventHandler('SUBTITLE_READY', firstHandler);
  const secondDisposer = messaging.registerInternalEventHandler('SUBTITLE_READY', secondHandler);

  assert.equal(typeof firstDisposer, 'function');
  assert.equal(typeof secondDisposer, 'function');

  messaging.dispatchInternalEvent({ type: 'SUBTITLE_READY' });
  firstDisposer();
  firstDisposer();
  messaging.dispatchInternalEvent({ type: 'SUBTITLE_READY' });

  assert.deepEqual(events, [
    'first:SUBTITLE_READY',
    'second:SUBTITLE_READY',
    'second:SUBTITLE_READY'
  ]);
});

test('Given a caller that ignores the disposer When it registers and dispatches Then existing behavior remains unchanged', async () => {
  const messaging = await loadMessagingModule();
  const events = [];

  messaging.registerInternalEventHandler('RAW_TTML_INTERCEPTED', (message) => {
    events.push(message.type);
  });

  messaging.dispatchInternalEvent({ type: 'RAW_TTML_INTERCEPTED' });

  assert.deepEqual(events, ['RAW_TTML_INTERCEPTED']);
});
