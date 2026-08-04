import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createEvents() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    }
  };
}

function createClock() {
  let nextId = 0;
  const tasks = new Map();
  return {
    clearTimeout(id) {
      tasks.delete(id);
    },
    count() {
      return tasks.size;
    },
    delays() {
      return [...tasks.values()].map(({ delay }) => delay);
    },
    run(delay) {
      for (const [id, task] of [...tasks]) {
        if (task.delay === delay) {
          tasks.delete(id);
          task.callback();
        }
      }
    },
    setTimeout(callback, delay) {
      const id = ++nextId;
      tasks.set(id, { callback, delay });
      return id;
    }
  };
}

async function loadClient() {
  const paths = [
    'content/system/capabilities/result.js',
    'content/system/capabilities/private-transport-diagnostics.js',
    'content/system/capabilities/private-transports.js',
    'content/system/config/config-schema.js',
    'content/system/capabilities/settings-snapshot.js'
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, root), 'utf8')));
  const context = vm.createContext({ clearTimeout, setTimeout, structuredClone });
  const modules = sources.map((source, index) => new vm.SourceTextModule(source, {
    context,
    identifier: paths[index]
  }));
  const [result, diagnostics, transports, schema, client] = modules;
  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await diagnostics.link(() => { throw new Error('diagnostics have no dependencies'); });
  await schema.link(() => { throw new Error('config-schema.js has no dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected private transport dependency: ${specifier}`);
  });
  await client.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transports.js') return transports;
    if (specifier === '../config/config-schema.js') return schema;
    throw new Error(`Unexpected snapshot client dependency: ${specifier}`);
  });
  await Promise.all([result.evaluate(), diagnostics.evaluate(), transports.evaluate(), schema.evaluate(), client.evaluate()]);
  return client.namespace;
}

function createContentRoute() {
  const events = createEvents();
  const requests = [];
  const window = {
    ...events,
    dispatchEvent(event) {
      if (event.type === 'messageToContentScript') requests.push(plain(event.detail));
      events.emit(event.type, event);
      return true;
    }
  };
  return {
    requests,
    respond(messageId, response) {
      events.emit('responseFromContentScript', { detail: { messageId, response } });
    },
    window
  };
}

function clientOptions(route, clock) {
  return {
    clearTimeout: clock.clearTimeout,
    createRequestId: () => 'settings-snapshot-1',
    makeEvent: (type, detail) => ({ type, detail }),
    setTimeout: clock.setTimeout,
    window: route.window
  };
}

function invalidSnapshot() {
  return { ok: false, error: { kind: 'invalid', code: 'settings-snapshot-malformed', retryable: false } };
}

test('Given the private content route When a settings client reads Then it exposes only read/dispose, sends the exact request, and returns a validated non-identity snapshot', async () => {
  const { createSettingsSnapshotClient } = await loadClient();
  const clock = createClock();
  const route = createContentRoute();
  const client = createSettingsSnapshotClient(clientOptions(route, clock));
  const source = { 'subtitle.primaryLanguage': 'zh-Hant', isEnabled: true };
  route.window.addEventListener('messageToContentScript', (event) => {
    route.respond(event.detail.messageId, { ok: true, value: source });
  });

  const result = await client.read();

  assert.deepEqual(Object.keys(client).sort(), ['dispose', 'read']);
  assert.deepEqual(route.requests, [{
    messageId: 'settings-snapshot-1',
    message: { category: 'settings-read', variant: 'snapshot', payload: {} }
  }]);
  assert.deepEqual(plain(result), { ok: true, value: source });
  assert.notStrictEqual(result.value, source);
  source.isEnabled = false;
  assert.equal(result.value.isEnabled, true);
  assert.equal(clock.count(), 0);
  assert.equal(route.window.count('responseFromContentScript'), 0);
});

test('Given raw, legacy, malformed, authority-bearing, symbolic, accessor, or invalid schema replies When a settings client reads Then each becomes one normalized malformed Result without getter reads', async () => {
  const { createSettingsSnapshotClient } = await loadClient();
  let accessorReads = 0;
  const accessorSnapshot = {};
  Object.defineProperty(accessorSnapshot, 'subtitle.primaryLanguage', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'zh-Hant';
    }
  });
  const symbolicSnapshot = { 'subtitle.primaryLanguage': 'zh-Hant' };
  symbolicSnapshot[Symbol('secret')] = true;
  const replies = [
    { 'subtitle.primaryLanguage': 'zh-Hant' },
    { success: true, config: { 'subtitle.primaryLanguage': 'zh-Hant' } },
    { ok: true, value: { ok: true, value: { 'subtitle.primaryLanguage': 'zh-Hant' } } },
    { ok: true, value: { 'subtitle.primaryLanguage': 'zh-Hant' }, extra: true },
    { ok: false, error: { kind: 'invalid', code: 'settings-read' } },
    { ok: false, error: { kind: 'unexpected', code: 'settings-read', retryable: false } },
    { ok: true, value: { unknown: true } },
    { ok: true, value: { user: 'private-user' } },
    { ok: true, value: { profile: { id: 'private-profile' } } },
    { ok: true, value: { jwt: 'private-token' } },
    { ok: true, value: { credential: 'private-credential' } },
    { ok: true, value: accessorSnapshot },
    { ok: true, value: symbolicSnapshot },
    { ok: true, value: { 'subtitle.primaryLanguage': 'not-a-language' } }
  ];

  for (const response of replies) {
    const clock = createClock();
    const route = createContentRoute();
    const client = createSettingsSnapshotClient(clientOptions(route, clock));
    route.window.addEventListener('messageToContentScript', (event) => {
      route.respond(event.detail.messageId, response);
    });

    assert.deepEqual(plain(await client.read()), invalidSnapshot());
    assert.equal(clock.count(), 0);
    assert.equal(route.window.count('responseFromContentScript'), 0);
  }
  assert.equal(accessorReads, 0);
});

test('Given a timeout or disposed in-flight read When content replies late Then the client stays terminal, removes listeners/timers, and a new client can resume independently', async () => {
  const { createSettingsSnapshotClient } = await loadClient();
  const clock = createClock();
  const route = createContentRoute();
  const client = createSettingsSnapshotClient(clientOptions(route, clock));
  const timedOut = client.read();

  assert.deepEqual(clock.delays(), [5000]);
  clock.run(5000);
  assert.deepEqual(plain(await timedOut), {
    ok: false, error: { kind: 'timeout', code: 'settings-snapshot-timeout', retryable: true }
  });
  route.respond('settings-snapshot-1', { ok: true, value: { 'subtitle.primaryLanguage': 'zh-Hant' } });
  assert.equal(clock.count(), 0);
  assert.equal(route.window.count('responseFromContentScript'), 0);

  const pending = client.read();
  client.dispose();
  assert.deepEqual(plain(await pending), {
    ok: false, error: { kind: 'disconnected', code: 'settings-snapshot-disconnected', retryable: true }
  });
  route.respond('settings-snapshot-1', { ok: true, value: { 'subtitle.primaryLanguage': 'zh-Hant' } });
  assert.deepEqual(plain(await client.read()), {
    ok: false, error: { kind: 'disconnected', code: 'settings-snapshot-disconnected', retryable: true }
  });
  assert.equal(clock.count(), 0);
  assert.equal(route.window.count('responseFromContentScript'), 0);

  const resumedRoute = createContentRoute();
  const resumed = createSettingsSnapshotClient(clientOptions(resumedRoute, createClock()));
  resumedRoute.window.addEventListener('messageToContentScript', (event) => {
    resumedRoute.respond(event.detail.messageId, { ok: true, value: { isEnabled: false } });
  });
  assert.deepEqual(plain(await resumed.read()), { ok: true, value: { isEnabled: false } });
});

test('Given strict live settings notifications When valid and hostile events arrive Then only exact cloneable CONFIG_CHANGED payloads call the subscriber without getters', async () => {
  const { subscribeSettingsChanges } = await loadClient();
  assert.equal(typeof subscribeSettingsChanges, 'function', 'settings notification seam is missing');
  const events = createEvents();
  const values = [];
  let getterReads = 0;
  const accessor = { type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', oldValue: 'zh-Hant' };
  Object.defineProperty(accessor, 'newValue', { enumerable: true, get() { getterReads += 1; return 'ja'; } });
  const symbolic = { type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', newValue: 'ja', oldValue: 'zh-Hant' };
  symbolic[Symbol('identity')] = true;
  const inherited = Object.create({ type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', newValue: 'ja', oldValue: 'zh-Hant' });
  subscribeSettingsChanges((change) => values.push(change), { window: events });

  for (const message of [
    { type: 'CONFIG_CHANGED', key: 'unknown', newValue: true, oldValue: false },
    { type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', newValue: 'ja', oldValue: 'zh-Hant', extra: true },
    accessor, symbolic, inherited, new Proxy({ type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', newValue: 'ja', oldValue: 'zh-Hant' }, {})
  ]) {
    events.emit('messageFromContentScript', { detail: { message } });
  }
  events.emit('messageFromContentScript', { detail: { message: { type: 'CONFIG_CHANGED', key: 'subtitle.primaryLanguage', newValue: 'ja', oldValue: 'zh-Hant' } } });

  assert.deepEqual(plain(values), [{ key: 'subtitle.primaryLanguage', newValue: 'ja', oldValue: 'zh-Hant' }]);
  assert.equal(getterReads, 0);
});

test('Given a first-write settings notification When oldValue is own enumerable undefined Then the subscriber receives it once', async () => {
  const { subscribeSettingsChanges } = await loadClient();
  const events = createEvents();
  const values = [];
  subscribeSettingsChanges((change) => values.push(change), { window: events });

  events.emit('messageFromContentScript', {
    detail: { message: { type: 'CONFIG_CHANGED', key: 'isEnabled', newValue: true, oldValue: undefined } }
  });

  assert.equal(values.length, 1);
  assert.equal(values[0].key, 'isEnabled');
  assert.equal(values[0].newValue, true);
  assert.equal(Object.hasOwn(values[0], 'oldValue'), true);
  assert.equal(values[0].oldValue, undefined);
});

test('Given two settings subscriptions When one disposer repeats Then it removes only its own listener once', async () => {
  const { subscribeSettingsChanges } = await loadClient();
  const events = createEvents();
  const first = [];
  const second = [];
  const disposeFirst = subscribeSettingsChanges((change) => first.push(change), { window: events });
  subscribeSettingsChanges((change) => second.push(change), { window: events });

  assert.equal(events.count('messageFromContentScript'), 2);
  disposeFirst();
  disposeFirst();
  assert.equal(events.count('messageFromContentScript'), 1);
  events.emit('messageFromContentScript', { detail: { message: { type: 'CONFIG_CHANGED', key: 'isEnabled', newValue: false, oldValue: true } } });
  assert.deepEqual(first, []);
  assert.deepEqual(plain(second), [{ key: 'isEnabled', newValue: false, oldValue: true }]);
});
