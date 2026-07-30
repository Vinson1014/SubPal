import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadAdapters() {
  const paths = ['content/system/capabilities/result.js', 'content/system/capabilities/private-transport-diagnostics.js', 'content/system/capabilities/private-transports.js'];
  const sources = await Promise.all(paths.map(async (path) => {
    try { return await readFile(new URL(path, root), 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }));
  if (sources.some((source) => source === null)) return null;
  const context = vm.createContext({ clearTimeout, setTimeout });
  const [result, diagnostics, transports] = sources.map((source, index) => new vm.SourceTextModule(source, {
    context, identifier: paths[index]
  }));
  await result.link(() => { throw new Error('result.js must not import dependencies'); });
  await diagnostics.link(() => { throw new Error('diagnostics must not import dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected transport dependency: ${specifier}`);
  });
  await result.evaluate(); await diagnostics.evaluate(); await transports.evaluate();
  return transports.namespace;
}

function createEvents() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event) { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); },
    count(type) { return listeners.get(type)?.size ?? 0; }
  };
}

function createScheduler() {
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = ++nextId; tasks.set(id, { callback, delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    run(delay) { for (const [id, task] of [...tasks]) if (task.delay === delay) { tasks.delete(id); task.callback(); } },
    count() { return tasks.size; }
  };
}

function envelope(adapters, requestId, payload = { type: 'CHECK_SUBTITLE' }) {
  return adapters.createEnvelope({ requestId, kind: 'private-test', payload });
}

test('Given DOM requests When IDs, malformed envelopes, and terminal paths occur Then correlation and cleanup stay private', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const dispatched = [];
  const transport = adapters.createDomTransport({
    window: { ...events, dispatchEvent(event) { dispatched.push(event); return true; } },
    makeEvent: (type, detail) => ({ type, detail }), setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  const request = transport.request(envelope(adapters, 'dom-1'), {
    deadlineMs: 30, wire: { messageId: 'dom-1', message: { type: 'CHECK_SUBTITLE' } }
  });
  events.emit('responseFromContentScript', { detail: { messageId: 'other', response: { ignored: true } } });
  events.emit('responseFromContentScript', { detail: { messageId: 'dom-1', response: { success: true } } });
  assert.deepEqual(plain(await request), { ok: true, value: { success: true } });
  assert.deepEqual(dispatched.map((event) => event.detail), [{ messageId: 'dom-1', message: { type: 'CHECK_SUBTITLE' } }]);
  assert.equal(events.count('responseFromContentScript'), 0);
  assert.equal(scheduler.count(), 0);
  assert.deepEqual(plain(await transport.request({ protocolVersion: 1, requestId: 'bad', kind: 'private-test' })), {
    ok: false, error: { kind: 'invalid', code: 'malformed-private-envelope', retryable: false }
  });
  assert.equal(dispatched.length, 1);
});

test('Given absent, malformed, future, and unsupported protocol versions When dispatching Then receivers never run', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  let dispatches = 0;
  for (const protocolVersion of [undefined, null, '1', 0, 2]) {
    const input = { requestId: 'protocol', kind: 'private-test', payload: {}, ...(protocolVersion === undefined ? {} : { protocolVersion }) };
    assert.deepEqual(plain(adapters.dispatchEnvelope(input, () => { dispatches += 1; return { accepted: true }; })), {
      ok: false, error: { kind: 'invalid', code: 'unsupported-protocol-version', retryable: false }
    });
  }
  assert.equal(dispatches, 0);
});

test('Given a normalized Result from the DOM bridge When it settles Then the adapter preserves it instead of nesting it as a successful value', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const transport = adapters.createDomTransport({
    window: { ...events, dispatchEvent() { return true; } }, makeEvent: (type, detail) => ({ type, detail }), setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  const pending = transport.request(envelope(adapters, 'dom-result'));
  events.emit('responseFromContentScript', { detail: { messageId: 'dom-result', response: { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } } } });
  assert.deepEqual(plain(await pending), { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } });
});

test('Given page requests When they time out, cancel, respond late, or return partial Then each terminal outcome remains compatible', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const posts = [];
  const transport = adapters.createPageTransport({
    window: { ...events, postMessage(message) { posts.push(message); } }, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  const timeout = transport.request(envelope(adapters, 'page-timeout'), { deadlineMs: 10, wire: { messageId: 'page-timeout', type: 'PING' } });
  scheduler.run(10);
  assert.deepEqual(plain(await timeout), { ok: false, error: { kind: 'timeout', code: 'page-response-timeout', retryable: true } });
  const controller = new AbortController();
  const cancelled = transport.request(envelope(adapters, 'page-cancelled'), {
    deadlineMs: 20, signal: controller.signal, wire: { messageId: 'page-cancelled', type: 'PING' }
  });
  controller.abort();
  events.emit('message', { data: { source: 'subpal-page-script', messageId: 'page-cancelled', success: true } });
  assert.deepEqual(plain(await cancelled), { ok: false, error: { kind: 'cancelled', code: 'caller-cancelled', retryable: false } });
  const partial = { success: false, status: 'partial', reason: 'player-ui-restore-timeout' };
  const success = transport.request(envelope(adapters, 'page-partial'), { deadlineMs: 20, wire: { messageId: 'page-partial', type: 'PING' } });
  events.emit('message', { data: { source: 'subpal-page-script', messageId: 'page-partial', ...partial } });
  const partialResult = plain(await success);
  assert.equal(partialResult.ok, true);
  assert.equal(partialResult.value.status, 'partial');
  assert.equal(partialResult.value.reason, partial.reason);
  assert.equal(events.count('message'), 0);
  assert.equal(scheduler.count(), 0);
  assert.equal(posts.length, 3);
});

test('Given an in-flight Port request When background disconnects and reconnects Then pending calls settle immediately and only future work uses the new Port', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const scheduler = createScheduler();
  const ports = [];
  const notifications = [];
  const connect = () => {
    const message = []; const disconnect = []; const sent = [];
    const port = { sent, onMessage: { addListener(listener) { message.push(listener); } }, onDisconnect: { addListener(listener) { disconnect.push(listener); } }, postMessage(value) { sent.push(value); } };
    ports.push({ port, emit(value) { for (const listener of message) listener(value); }, disconnect() { for (const listener of disconnect) listener(); } });
    return port;
  };
  const transport = adapters.createPortTransport({ connect, setTimeout: scheduler.setTimeout, onNotification: (value) => notifications.push(value) });
  transport.start();
  const first = transport.request(envelope(adapters, 'port-1'));
  const second = transport.request(envelope(adapters, 'port-2'));
  ports[0].disconnect(); ports[0].disconnect();
  const expected = { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } };
  assert.deepEqual(plain(await first), expected); assert.deepEqual(plain(await second), expected);
  assert.equal(transport.pendingCount(), 0); assert.equal(scheduler.count(), 1);
  ports[0].emit({ messageId: 'port-1', response: { replayed: true } });
  assert.deepEqual(notifications, []);
  scheduler.run(1000);
  assert.equal(ports.length, 2); assert.equal(ports[1].port.sent.length, 0);
  const fresh = transport.request(envelope(adapters, 'port-fresh'));
  ports[1].emit({ messageId: 'port-fresh', response: { success: true } });
  assert.deepEqual(plain(await fresh), { ok: true, value: { success: true } });
  assert.equal(ports[1].port.sent.length, 1);
});

test('Given an already-normalized background Result When the Port response arrives Then it is preserved instead of wrapped as a successful value', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const listeners = [];
  const port = {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    onDisconnect: { addListener() {} },
    postMessage() {}
  };
  const transport = adapters.createPortTransport({ connect: () => port });
  transport.start();
  const pending = transport.request(envelope(adapters, 'port-normalized'));
  const response = { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } };
  for (const listener of listeners) listener({ messageId: 'port-normalized', response });
  assert.deepEqual(plain(await pending), response);
});

test('Given Port generations and notifications When an old Port speaks after reconnect Then it cannot settle fresh work while current broadcasts still arrive', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const scheduler = createScheduler();
  const ports = [];
  const notifications = [];
  const connect = () => {
    const messages = []; const disconnects = [];
    const port = { onMessage: { addListener(listener) { messages.push(listener); } }, onDisconnect: { addListener(listener) { disconnects.push(listener); } }, postMessage() {} };
    ports.push({ emit(message) { for (const listener of messages) listener(message); }, disconnect() { for (const listener of disconnects) listener(); } });
    return port;
  };
  const transport = adapters.createPortTransport({
    connect, setTimeout: scheduler.setTimeout, onNotification: (message) => notifications.push(message),
    isNotification: (message) => message?.messageId === 'subtitle-style-broadcast' || Boolean(message?.response?.type)
  });
  transport.start();
  const oldPending = transport.request(envelope(adapters, 'same-id'));
  ports[0].disconnect();
  await oldPending;
  scheduler.run(1000);
  const fresh = transport.request(envelope(adapters, 'same-id'));
  ports[0].emit({ messageId: 'same-id', response: { stale: true } });
  ports[0].emit({ messageId: 'subtitle-style-broadcast', response: { type: 'SUBTITLE_STYLE_UPDATED', stale: true } });
  assert.deepEqual(notifications, []);
  ports[1].emit({ messageId: 'subtitle-style-broadcast', response: { type: 'SUBTITLE_STYLE_UPDATED' } });
  ports[1].emit({ messageId: 'same-id', response: { fresh: true } });
  assert.deepEqual(plain(await fresh), { ok: true, value: { fresh: true } });
  assert.deepEqual(plain(notifications), [{ messageId: 'subtitle-style-broadcast', response: { type: 'SUBTITLE_STYLE_UPDATED' } }]);
});

test('Given a stopped Port transport When pending work and later disconnects occur Then it settles terminally and never reconnects', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const scheduler = createScheduler();
  let disconnect;
  let connects = 0;
  const transport = adapters.createPortTransport({
    connect() {
      connects += 1;
      const disconnects = [];
      disconnect = () => { for (const listener of disconnects) listener(); };
      return { onMessage: { addListener() {} }, onDisconnect: { addListener(listener) { disconnects.push(listener); } }, postMessage() {} };
    },
    setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  transport.start();
  const pending = transport.request(envelope(adapters, 'stop-pending'));
  transport.stop();
  const stopped = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve('unsettled')))]);
  assert.deepEqual(plain(stopped), { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } });
  disconnect();
  scheduler.run(1000);
  assert.equal(connects, 1);
  assert.deepEqual(plain(await transport.request(envelope(adapters, 'after-stop'))), { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } });
});

test('Given runtime callback outcomes When normalized Then failures stay structured without raw error text and successes preserve values', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const run = async (response, lastError) => {
    const runtime = { lastError, sendMessage(_message, callback) { callback(response); } };
    return plain(await adapters.createRuntimeTransport({ runtime }).request(envelope(adapters, 'runtime')));
  };
  assert.deepEqual(await run(undefined, { message: 'Bearer runtime-secret' }), {
    ok: false, error: { kind: 'disconnected', code: 'runtime-last-error', retryable: true }
  });
  assert.deepEqual(await run(undefined), { ok: false, error: { kind: 'disconnected', code: 'runtime-response-missing', retryable: true } });
  const structured = await run({ error: 'jwt=response-secret' });
  assert.deepEqual(structured, { ok: false, error: { kind: 'domain-rejected', code: 'runtime-response-error', retryable: false } });
  assert.equal(JSON.stringify(structured).includes('response-secret'), false);
  assert.deepEqual(await run({ tasks: [] }), { ok: true, value: { tasks: [] } });
});
