import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const plain = (value) => JSON.parse(JSON.stringify(value));

function createEvents() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event) { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); },
    count(type) { return listeners.get(type)?.size ?? 0; }
  };
}

function createClock() {
  let nextId = 0;
  const tasks = new Map();
  return {
    clearTimeout(id) { tasks.delete(id); },
    count() { return tasks.size; },
    run(delay) { for (const [id, task] of [...tasks]) if (task.delay === delay) { tasks.delete(id); task.callback(); } },
    setTimeout(callback, delay) { const id = ++nextId; tasks.set(id, { callback, delay }); return id; }
  };
}

async function loadPageSettings() {
  const paths = [
    'content/system/capabilities/result.js',
    'content/system/capabilities/private-transport-diagnostics.js',
    'content/system/capabilities/private-transports.js',
    'content/system/config/config-schema.js',
    'content/system/capabilities/settings.js'
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
  const context = vm.createContext({ AbortController, CustomEvent: class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  }, structuredClone });
  const modules = sources.map((source, index) => new vm.SourceTextModule(source, { context, identifier: paths[index] }));
  const [result, diagnostics, transports, schema, settings] = modules;
  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await diagnostics.link(() => { throw new Error('diagnostics has no dependencies'); });
  await schema.link(() => { throw new Error('schema has no dependencies'); });
  await transports.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transport-diagnostics.js') return diagnostics;
    throw new Error(`Unexpected transport dependency: ${specifier}`);
  });
  await settings.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === './private-transports.js') return transports;
    if (specifier === '../config/config-schema.js') return schema;
    throw new Error(`Unexpected settings dependency: ${specifier}`);
  });
  await Promise.all([result.evaluate(), diagnostics.evaluate(), transports.evaluate(), schema.evaluate(), settings.evaluate()]);
  return settings.namespace.createPageSettings;
}

function languageChange() {
  return { category: 'settings-change', variant: 'subtitle-languages', payload: { primaryLanguage: 'ja', secondaryLanguage: 'en' } };
}

test('Given page Settings changes When valid input reaches content Then it exposes only change and sends one fixed typed envelope with its normalized Result', async () => {
  const createPageSettings = await loadPageSettings();
  assert.equal(typeof createPageSettings, 'function', 'page Settings client is missing');
  const events = createEvents();
  const clock = createClock();
  const envelopes = [];
  const client = createPageSettings({
    window: {
      ...events,
      dispatchEvent(event) {
        envelopes.push(plain(event.detail));
        events.emit('responseFromContentScript', { detail: { messageId: event.detail.messageId, response: { ok: true, value: { variant: 'subtitle-languages', primaryLanguage: 'ja', secondaryLanguage: 'en' } } } });
        return true;
      }
    },
    createRequestId: () => 'settings-change-1',
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  assert.deepEqual(Object.keys(client).sort(), ['change']);
  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(plain(await client.change(languageChange())), {
    ok: true, value: { variant: 'subtitle-languages', primaryLanguage: 'ja', secondaryLanguage: 'en' }
  });
  assert.deepEqual(envelopes, [{
    messageId: 'settings-change-1',
    message: { category: 'settings-change', variant: 'subtitle-languages', payload: { primaryLanguage: 'ja', secondaryLanguage: 'en' } }
  }]);
  assert.equal(events.count('responseFromContentScript'), 0);
  assert.equal(clock.count(), 0);
});

test('Given hostile page Settings inputs or raw and nested replies When change runs Then parsing rejects before DOM dispatch and replies normalize to failures', async () => {
  const createPageSettings = await loadPageSettings();
  const events = createEvents();
  const envelopes = [];
  let getterReads = 0;
  const inherited = Object.create(languageChange());
  const accessor = { category: 'settings-change', variant: 'subtitle-languages' };
  Object.defineProperty(accessor, 'payload', { enumerable: true, get() { getterReads += 1; return {}; } });
  const symbolic = languageChange();
  symbolic[Symbol('opaque')] = true;
  const hostile = [
    { ...languageChange(), payload: { primaryLanguage: 'ja', secondaryLanguage: 'en', endpoint: 'forged' } },
    { ...languageChange(), extra: true }, inherited, accessor, symbolic, new Proxy(languageChange(), {})
  ];
  const replies = [
    { variant: 'subtitle-languages', primaryLanguage: 'ja', secondaryLanguage: 'en' },
    { ok: true, value: { ok: true, value: { variant: 'subtitle-languages', primaryLanguage: 'ja', secondaryLanguage: 'en' } } }
  ];
  const client = createPageSettings({
    window: {
      ...events,
      dispatchEvent(event) {
        envelopes.push(event.detail);
        events.emit('responseFromContentScript', { detail: { messageId: event.detail.messageId, response: replies.shift() } });
        return true;
      }
    },
    createRequestId: () => `settings-change-${envelopes.length + 1}`,
    setTimeout,
    clearTimeout
  });

  for (const input of hostile) {
    assert.equal((await client.change(input)).ok, false);
  }
  assert.equal(getterReads, 0);
  assert.deepEqual(envelopes, []);
  assert.deepEqual(plain(await client.change(languageChange())), { ok: false, error: { kind: 'domain-rejected', code: 'settings-change-response-invalid', retryable: false } });
  assert.deepEqual(plain(await client.change(languageChange())), { ok: false, error: { kind: 'domain-rejected', code: 'settings-change-response-invalid', retryable: false } });
});

test('Given a page Settings request times out or is cancelled When a late response arrives Then each terminal path cleans listeners and never replays', async () => {
  const createPageSettings = await loadPageSettings();
  const events = createEvents();
  const clock = createClock();
  const envelopes = [];
  const client = createPageSettings({
    window: { ...events, dispatchEvent(event) { envelopes.push(event.detail); return true; } },
    createRequestId: () => `settings-change-${envelopes.length + 1}`,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const timedOut = client.change(languageChange());
  assert.equal(events.count('responseFromContentScript'), 1);
  clock.run(5000);
  assert.deepEqual(plain(await timedOut), { ok: false, error: { kind: 'timeout', code: 'settings-change-timeout', retryable: true } });
  assert.equal(events.count('responseFromContentScript'), 0);
  const controller = new AbortController();
  const cancelled = client.change(languageChange(), controller.signal);
  controller.abort();
  assert.deepEqual(plain(await cancelled), { ok: false, error: { kind: 'cancelled', code: 'settings-change-cancelled', retryable: false } });
  events.emit('responseFromContentScript', { detail: { messageId: envelopes[0].messageId, response: { ok: true, value: { variant: 'subtitle-languages', primaryLanguage: 'ja', secondaryLanguage: 'en' } } } });
  assert.equal(events.count('responseFromContentScript'), 0);
  assert.equal(clock.count(), 0);
});
