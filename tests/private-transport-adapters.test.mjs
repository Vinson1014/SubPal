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
  const context = vm.createContext({ clearTimeout, setTimeout, structuredClone });
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

test('Given hostile private envelopes When validated, dispatched, or transported Then descriptor parsing rejects them without getter reads, receiver calls, or sends', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  let getterReads = 0;
  const valid = () => ({ protocolVersion: 1, requestId: 'hostile', kind: 'private-test', payload: {} });
  const accessor = valid();
  Object.defineProperty(accessor, 'protocolVersion', {
    enumerable: true,
    get() { getterReads += 1; return 1; }
  });
  const inherited = Object.assign(Object.create({ protocolVersion: 1 }), { requestId: 'hostile', kind: 'private-test', payload: {} });
  const symbol = valid();
  symbol[Symbol('private')] = true;
  const nonEnumerable = valid();
  Object.defineProperty(nonEnumerable, 'payload', { value: {}, enumerable: false });
  const extra = { ...valid(), extra: true };
  const customPrototype = Object.assign(Object.create({}), valid());
  const benignProxy = new Proxy(valid(), {});
  const revoked = Proxy.revocable(valid(), {});
  revoked.revoke();
  const opaqueProxy = new Proxy(valid(), { ownKeys() { throw new Error('opaque envelope'); } });
  const hostile = [accessor, inherited, symbol, nonEnumerable, extra, customPrototype, benignProxy, revoked.proxy, opaqueProxy];
  const events = createEvents();
  const dispatched = [];
  const transport = adapters.createDomTransport({
    window: { ...events, dispatchEvent(event) { dispatched.push(event); return true; } },
    makeEvent: (type, detail) => ({ type, detail })
  });
  let receiverCalls = 0;

  for (const input of hostile) {
    const parsed = adapters.validateEnvelope(input);
    assert.equal(parsed.ok, false);
    assert.equal((await transport.request(input)).ok, false);
    assert.equal(adapters.dispatchEnvelope(input, () => { receiverCalls += 1; return { accepted: true }; }).ok, false);
  }
  assert.equal(getterReads, 0);
  assert.equal(receiverCalls, 0);
  assert.deepEqual(dispatched, []);
  assert.equal(events.count('responseFromContentScript'), 0);
});

test('Given nested hostile envelope payloads and contexts When validated, dispatched, or transported Then no nested getter, Proxy, or cycle crosses the transport seam', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  let getterReads = 0;
  const valid = () => ({
    protocolVersion: 1, requestId: 'nested-hostile', kind: 'private-test',
    payload: { nested: { value: 'safe' } }, context: { nested: { value: 'safe' } }
  });
  const payloadAccessor = valid();
  Object.defineProperty(payloadAccessor.payload.nested, 'value', {
    enumerable: true,
    get() { getterReads += 1; return 'unsafe'; }
  });
  const contextAccessor = valid();
  Object.defineProperty(contextAccessor.context.nested, 'value', {
    enumerable: true,
    get() { getterReads += 1; return 'unsafe'; }
  });
  const benignProxy = valid();
  benignProxy.payload.nested = new Proxy({ value: 'unsafe' }, {});
  const revoked = Proxy.revocable({ value: 'unsafe' }, {});
  revoked.revoke();
  const revokedProxy = valid();
  revokedProxy.context.nested = revoked.proxy;
  const opaqueProxy = valid();
  opaqueProxy.payload.nested = new Proxy({ value: 'unsafe' }, { ownKeys() { throw new Error('opaque nested value'); } });
  const cyclic = valid();
  cyclic.payload.nested.self = cyclic.payload;
  const events = createEvents();
  const dispatched = [];
  const transport = adapters.createDomTransport({
    window: { ...events, dispatchEvent(event) { dispatched.push(event); return true; } },
    makeEvent: (type, detail) => ({ type, detail })
  });
  let receiverCalls = 0;

  for (const input of [payloadAccessor, contextAccessor, benignProxy, revokedProxy, opaqueProxy, cyclic]) {
    assert.equal(adapters.validateEnvelope(input).ok, false);
    assert.equal((await transport.request(input)).ok, false);
    assert.equal(adapters.dispatchEnvelope(input, () => { receiverCalls += 1; return { accepted: true }; }).ok, false);
  }
  assert.equal(getterReads, 0);
  assert.equal(receiverCalls, 0);
  assert.deepEqual(dispatched, []);
  assert.equal(events.count('responseFromContentScript'), 0);
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

test('Given page requests When dispatched and answered Then they use one exact same-origin typed envelope and Result response', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const posts = [];
  const pageWindow = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage(message, targetOrigin) { posts.push({ message, targetOrigin }); }
  };
  const transport = adapters.createPageTransport({
    window: pageWindow, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  const pageEnvelope = adapters.createEnvelope({
    requestId: 'page-result',
    kind: 'playback',
    payload: { variant: 'context-snapshot', payload: {} }
  });
  const pending = transport.request(pageEnvelope, { deadlineMs: 20 });
  assert.deepEqual(plain(posts), [{
    message: {
      source: 'subpal-content-script',
      target: 'subpal-page-script',
      envelope: plain(pageEnvelope)
    },
    targetOrigin: 'https://www.netflix.com'
  }]);

  for (const event of [
    { source: {}, origin: 'https://www.netflix.com' },
    { source: pageWindow, origin: 'https://invalid.example' },
    { source: pageWindow, origin: 'https://www.netflix.com', target: 'wrong-target' }
  ]) {
    events.emit('message', {
      ...event,
      data: {
        source: 'subpal-page-script',
        target: event.target ?? 'subpal-content-script',
        requestId: 'page-result',
        response: { ok: true, value: { ignored: true } }
      }
    });
  }
  events.emit('message', {
    source: pageWindow,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script',
      target: 'subpal-content-script',
      requestId: 'page-result',
      response: { ok: true, value: { ignored: true }, extra: true }
    }
  });
  assert.equal(events.count('message'), 1);
  events.emit('message', {
    source: pageWindow,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script',
      target: 'subpal-content-script',
      requestId: 'page-result',
      response: { ok: true, value: { playback: 'accepted' } }
    }
  });
  assert.deepEqual(plain(await pending), { ok: true, value: { playback: 'accepted' } });
  assert.equal(events.count('message'), 0);
  assert.equal(scheduler.count(), 0);
});

test('Given nested hostile canonical Result values When they arrive Then no getter runs and no pending page request settles', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterReads += 1; return 'unsafe'; }
  });
  const benignProxy = new Proxy({ value: 'unsafe' }, {});
  const revoked = Proxy.revocable({ value: 'unsafe' }, {});
  revoked.revoke();
  const opaqueProxy = new Proxy({ value: 'unsafe' }, { ownKeys() { throw new Error('opaque nested result'); } });
  const cyclic = { value: 'unsafe' };
  cyclic.self = cyclic;

  for (const value of [accessor, benignProxy, revoked.proxy, opaqueProxy, cyclic]) {
    const events = createEvents();
    const scheduler = createScheduler();
    const pageWindow = {
      ...events,
      location: { origin: 'https://www.netflix.com' },
      postMessage() {}
    };
    const transport = adapters.createPageTransport({
      window: pageWindow, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
    });
    const pending = transport.request(adapters.createEnvelope({
      requestId: 'nested-result', kind: 'playback', payload: { variant: 'context-snapshot', payload: {} }
    }), { deadlineMs: 20 });
    events.emit('message', {
      source: pageWindow,
      origin: 'https://www.netflix.com',
      data: {
        source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'nested-result',
        response: { ok: true, value: { nested: value } }
      }
    });
    assert.equal(transport.pendingCount(), 1);
    assert.equal(events.count('message'), 1);
    transport.stop();
    assert.deepEqual(plain(await pending), {
      ok: false, error: { kind: 'disconnected', code: 'page-adapter-disconnected', retryable: true }
    });
  }
  assert.equal(getterReads, 0);
});

test('Given an in-flight page request When it duplicates, aborts, times out, or stops Then every terminal path cleans up and never replays', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const posts = [];
  const pageWindow = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage(message, targetOrigin) { posts.push({ message, targetOrigin }); }
  };
  const transport = adapters.createPageTransport({
    window: pageWindow, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  const command = adapters.createEnvelope({
    requestId: 'page-pending', kind: 'ttml-acquisition-query', payload: { variant: 'raw-pool', payload: {} }
  });
  const pending = transport.request(command, { deadlineMs: 10 });
  assert.deepEqual(plain(await transport.request(command, { deadlineMs: 10 })), {
    ok: false, error: { kind: 'invalid', code: 'duplicate-request-id', retryable: false }
  });
  assert.equal(posts.length, 1);
  transport.stop();
  transport.stop();
  assert.deepEqual(plain(await pending), {
    ok: false, error: { kind: 'disconnected', code: 'page-adapter-disconnected', retryable: true }
  });
  assert.equal(events.count('message'), 0);
  assert.equal(scheduler.count(), 0);
  events.emit('message', {
    source: pageWindow,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'page-pending',
      response: { ok: true, value: { replayed: true } }
    }
  });
  assert.deepEqual(plain(await transport.request(adapters.createEnvelope({
    requestId: 'page-after-stop', kind: 'playback', payload: { variant: 'context-snapshot', payload: {} }
  }))), {
    ok: false, error: { kind: 'disconnected', code: 'page-adapter-disconnected', retryable: true }
  });
});

test('Given page request terminal paths When timeout, abort, or send failure occurs Then each settles once without a replay', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const sent = [];
  const pageWindow = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage(message, targetOrigin) { sent.push({ message, targetOrigin }); }
  };
  const transport = adapters.createPageTransport({
    window: pageWindow, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  const request = (requestId) => adapters.createEnvelope({
    requestId, kind: 'playback', payload: { variant: 'context-snapshot', payload: {} }
  });
  const timeout = transport.request(request('page-timeout'), { deadlineMs: 10 });
  scheduler.run(10);
  assert.deepEqual(plain(await timeout), {
    ok: false, error: { kind: 'timeout', code: 'page-response-timeout', retryable: true }
  });

  const controller = new AbortController();
  const cancelled = transport.request(request('page-cancelled'), { deadlineMs: 10, signal: controller.signal });
  controller.abort();
  events.emit('message', {
    source: pageWindow,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'page-cancelled',
      response: { ok: true, value: { replayed: true } }
    }
  });
  assert.deepEqual(plain(await cancelled), {
    ok: false, error: { kind: 'cancelled', code: 'caller-cancelled', retryable: false }
  });
  assert.equal(transport.pendingCount(), 0);
  assert.equal(events.count('message'), 0);
  assert.equal(scheduler.count(), 0);

  const failureEvents = createEvents();
  const failureScheduler = createScheduler();
  const failingTransport = adapters.createPageTransport({
    window: {
      ...failureEvents,
      location: { origin: 'https://www.netflix.com' },
      postMessage() { throw new Error('post failed'); }
    },
    setTimeout: failureScheduler.setTimeout,
    clearTimeout: failureScheduler.clearTimeout
  });
  assert.deepEqual(plain(await failingTransport.request(request('page-send-failure'))), {
    ok: false, error: { kind: 'disconnected', code: 'transport-send-failed', retryable: true }
  });
  assert.equal(failingTransport.pendingCount(), 0);
  assert.equal(failureEvents.count('message'), 0);
  assert.equal(failureScheduler.count(), 0);
  assert.equal(sent.length, 2);
});

test('Given a page request with a flattened legacy wire override When flattened replies arrive Then neither can replace the canonical typed transport', async () => {
  const adapters = await loadAdapters();
  assert.ok(adapters, 'private transport adapters are missing');
  const events = createEvents();
  const scheduler = createScheduler();
  const posts = [];
  const pageWindow = {
    ...events,
    location: { origin: 'https://www.netflix.com' },
    postMessage(message, targetOrigin) { posts.push({ message, targetOrigin }); }
  };
  const transport = adapters.createPageTransport({
    window: pageWindow, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout
  });
  const command = adapters.createEnvelope({ requestId: 'typed-page', kind: 'ttml-acquisition-query', payload: { variant: 'raw-pool', payload: {} } });
  const pending = transport.request(command, {
    deadlineMs: 20,
    wire: { source: 'subpal-content-script', target: 'subpal-page-script', messageId: 'legacy-page', type: 'PING' }
  });
  assert.deepEqual(plain(posts), [{
    message: { source: 'subpal-content-script', target: 'subpal-page-script', envelope: plain(command) },
    targetOrigin: 'https://www.netflix.com'
  }]);
  events.emit('message', {
    source: pageWindow,
    origin: 'https://www.netflix.com',
    data: { source: 'subpal-page-script', target: 'subpal-content-script', messageId: 'typed-page', success: true }
  });
  assert.equal(events.count('message'), 1);
  events.emit('message', {
    source: pageWindow,
    origin: 'https://www.netflix.com',
    data: {
      source: 'subpal-page-script', target: 'subpal-content-script', requestId: 'typed-page',
      response: { ok: true, value: { variant: 'raw-pool', entries: [] } }
    }
  });
  assert.deepEqual(plain(await pending), {
    ok: true,
    value: { variant: 'raw-pool', entries: [] }
  });
  assert.equal(events.count('message'), 0);
  assert.equal(scheduler.count(), 0);
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

test('Given a deadline-bound Port request When its deadline expires Then it posts once, ignores a late ACK, and a fresh request remains independent', async () => {
  const adapters = await loadAdapters();
  const scheduler = createScheduler();
  const ports = [];
  const connect = () => {
    const messages = []; const disconnects = []; const sent = [];
    ports.push({ sent, emit(value) { for (const listener of messages) listener(value); }, disconnect() { for (const listener of disconnects) listener(); } });
    return { postMessage(value) { sent.push(value); }, onMessage: { addListener(listener) { messages.push(listener); } }, onDisconnect: { addListener(listener) { disconnects.push(listener); } } };
  };
  const transport = adapters.createPortTransport({ connect, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout });
  transport.start();
  const expired = transport.request(envelope(adapters, 'deadline'), { deadlineMs: 10 });
  assert.equal(ports[0].sent.length, 1);
  scheduler.run(10);
  assert.deepEqual(plain(await expired), { ok: false, error: { kind: 'timeout', code: 'background-port-timeout', retryable: true } });
  assert.equal(transport.pendingCount(), 0);
  ports[0].emit({ messageId: 'deadline', response: { late: true } });
  ports[0].disconnect();
  scheduler.run(1000);
  const fresh = transport.request(envelope(adapters, 'fresh'), { deadlineMs: 10 });
  ports[1].emit({ messageId: 'fresh', response: { fresh: true } });
  assert.deepEqual(plain(await fresh), { ok: true, value: { fresh: true } });
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
