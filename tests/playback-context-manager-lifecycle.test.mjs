import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadManagerHarness() {
  const source = await readFile(new URL('../content/core/playback-context-manager.js', import.meta.url), 'utf8');
  const handlers = [];
  const dispatchedEvents = [];
  const scheduledTimeouts = [];
  const clearedTimeoutIds = [];
  let refreshAttempts = 0;
  let nextTimeoutId = 1;
  const messagingSource = `
    export async function sendMessageToPageScript() {
      globalThis.refreshAttempts += 1;
      if (globalThis.refreshAttempts === 1) throw new Error('cold snapshot failed');
      return { debugSnapshot: { playback: null } };
    }
    export function registerInternalEventHandler(_type, handler) {
      globalThis.handlers.push(handler);
      return () => {
        const index = globalThis.handlers.indexOf(handler);
        if (index !== -1) globalThis.handlers.splice(index, 1);
      };
    }
    export function dispatchInternalEvent(event) {
      globalThis.dispatchedEvents.push(event);
    }
  `;
  const context = vm.createContext({
    console,
    Date,
    setTimeout: (callback, delay) => {
      const id = nextTimeoutId;
      nextTimeoutId += 1;
      scheduledTimeouts.push({ id, callback, delay });
      return id;
    },
    clearTimeout: (id) => {
      clearedTimeoutIds.push(id);
    },
    setInterval: () => 1,
    clearInterval() {},
    handlers,
    dispatchedEvents,
    get refreshAttempts() { return refreshAttempts; },
    set refreshAttempts(value) { refreshAttempts = value; }
  });
  const messagingModule = new vm.SourceTextModule(messagingSource, { context, identifier: 'messaging-stub.js' });
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/core/playback-context-manager.js' });
  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messagingModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await messagingModule.evaluate();
  await module.evaluate();
  return {
    Manager: module.namespace.PlaybackContextManager,
    handlers,
    dispatchedEvents,
    scheduledTimeouts,
    clearedTimeoutIds,
    getRefreshAttempts: () => refreshAttempts
  };
}

test('Given failed and repeated PlaybackContext initialization When retried or cleaned up Then exactly one internal handler exists and its disposer runs', async () => {
  const { Manager, handlers } = await loadManagerHarness();
  const manager = new Manager();

  await assert.rejects(manager.initialize(), /cold snapshot failed/);
  assert.equal(handlers.length, 0);

  await manager.initialize();
  await manager.initialize();
  assert.equal(handlers.length, 1);

  manager.cleanup();
  manager.cleanup();
  assert.equal(handlers.length, 0);
});

test('Given a pending video-change refresh When cleanup runs before its delay Then firing the captured callback causes no late work', async () => {
  const {
    Manager,
    handlers,
    dispatchedEvents,
    scheduledTimeouts,
    clearedTimeoutIds,
    getRefreshAttempts
  } = await loadManagerHarness();
  const manager = new Manager();
  await assert.rejects(manager.initialize(), /cold snapshot failed/);
  await manager.initialize();

  handlers[0]({ oldVideoId: null, newVideoId: '81234567' });
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delay, 1000);

  manager.cleanup();
  const statusAfterCleanup = manager.getStatus();
  const refreshAttemptsAfterCleanup = getRefreshAttempts();
  const dispatchedEventCountAfterCleanup = dispatchedEvents.length;
  await scheduledTimeouts[0].callback();
  await Promise.resolve();

  assert.deepEqual(clearedTimeoutIds, [scheduledTimeouts[0].id]);
  assert.equal(getRefreshAttempts(), refreshAttemptsAfterCleanup);
  assert.equal(dispatchedEvents.length, dispatchedEventCountAfterCleanup);
  assert.deepEqual(manager.getStatus(), statusAfterCleanup);
});
