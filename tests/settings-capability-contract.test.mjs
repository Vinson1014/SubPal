import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function settleMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, at: this.now + delay, delay });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  count() {
    return this.tasks.size;
  }

  delays() {
    return [...this.tasks.values()].map(task => task.delay);
  }

  advanceBy(duration) {
    const target = this.now + duration;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

async function loadSettings() {
  const [resultSource, schemaSource, settingsSource] = await Promise.all([
    readFile(new URL('../content/system/capabilities/result.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/config/config-schema.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/settings.js', import.meta.url), 'utf8')
  ]);
  const context = vm.createContext({ clearTimeout, setTimeout, structuredClone });
  const result = new vm.SourceTextModule(resultSource, {
    context,
    identifier: 'content/system/capabilities/result.js'
  });
  const schema = new vm.SourceTextModule(schemaSource, {
    context,
    identifier: 'content/system/config/config-schema.js'
  });
  const settings = new vm.SourceTextModule(settingsSource, {
    context,
    identifier: 'content/system/capabilities/settings.js'
  });

  await result.link(() => { throw new Error('result.js has no dependencies'); });
  await schema.link(() => { throw new Error('config-schema.js has no dependencies'); });
  await settings.link((specifier) => {
    if (specifier === './result.js') return result;
    if (specifier === '../config/config-schema.js') return schema;
    throw new Error(`Unexpected settings dependency: ${specifier}`);
  });
  await result.evaluate();
  await schema.evaluate();
  await settings.evaluate();
  return settings.namespace.createSettings;
}

function subtitleLanguages(primaryLanguage = 'en', secondaryLanguage = 'zh-Hant') {
  return {
    category: 'settings-change',
    variant: 'subtitle-languages',
    payload: { primaryLanguage, secondaryLanguage }
  };
}

function dualSubtitles(enabled = true) {
  return {
    category: 'settings-change',
    variant: 'dual-subtitles',
    payload: { enabled }
  };
}

function expectedFailure(kind, code, retryable) {
  return { ok: false, error: { kind, code, retryable } };
}

test('Given allowlisted MAIN subtitle settings When Settings changes them Then one writer receives exact mapped values and only a variant-specific acknowledgement returns', async () => {
  const createSettings = await loadSettings();
  const calls = [];
  const clock = new FakeClock();
  const settings = createSettings({
    write(changes) {
      calls.push(changes);
      return { token: 'writer-secret', fullConfig: { crowdsourcing: true } };
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  const languages = subtitleLanguages();
  const languageChange = settings.change(languages);
  languages.payload.primaryLanguage = 'ja';
  const dual = dualSubtitles();
  const dualChange = settings.change(dual);
  dual.payload.enabled = false;

  assert.deepEqual(plain(await languageChange), {
    ok: true,
    value: { variant: 'subtitle-languages', primaryLanguage: 'en', secondaryLanguage: 'zh-Hant' }
  });
  assert.deepEqual(plain(await dualChange), {
    ok: true,
    value: { variant: 'dual-subtitles', enabled: true }
  });
  assert.deepEqual(plain(calls), [
    { 'subtitle.primaryLanguage': 'en', 'subtitle.secondaryLanguage': 'zh-Hant' },
    { 'subtitle.dualModeEnabled': true }
  ]);
  assert.equal(clock.count(), 0);
});

test('Given malformed, non-plain, symbolic, accessor, or proxy settings data When Settings changes it Then it rejects structurally without writing', async () => {
  const createSettings = await loadSettings();
  let calls = 0;
  const settings = createSettings({ write() { calls += 1; } });
  const symbolPayload = subtitleLanguages();
  symbolPayload.payload[Symbol('extra')] = 'value';
  let getterCalls = 0;
  const accessorPayload = subtitleLanguages();
  Object.defineProperty(accessorPayload.payload, 'primaryLanguage', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'en';
    }
  });
  const customEnvelope = Object.assign(Object.create({ inherited: true }), subtitleLanguages());
  const revoked = Proxy.revocable(subtitleLanguages(), {});
  revoked.revoke();
  const malformed = [
    null,
    [],
    () => {},
    { category: 'settings-change', variant: 'subtitle-languages' },
    { ...subtitleLanguages(), category: 'settings' },
    { ...subtitleLanguages(), extra: true },
    { ...subtitleLanguages(), payload: { primaryLanguage: 'en' } },
    { ...subtitleLanguages(), payload: ['en', 'zh-Hant'] },
    symbolPayload,
    accessorPayload,
    customEnvelope,
    new Proxy(subtitleLanguages(), {}),
    revoked.proxy
  ];

  for (const input of malformed) {
    assert.deepEqual(plain(await settings.change(input)), expectedFailure('invalid', 'settings-change', false));
  }
  assert.equal(getterCalls, 0);
  assert.equal(calls, 0);
});

test('Given null-prototype records and custom prototype chains When Settings changes them Then only direct null prototypes are accepted', async () => {
  const createSettings = await loadSettings();
  const calls = [];
  const settings = createSettings({ write(changes) { calls.push(changes); } });
  const nullEnvelope = Object.assign(Object.create(null), dualSubtitles());
  nullEnvelope.payload = Object.assign(Object.create(null), { enabled: true });
  const nullRoot = Object.create(null);
  const customEnvelope = Object.assign(Object.create(nullRoot), dualSubtitles());
  const customPayload = Object.assign(Object.create(nullRoot), { enabled: true });

  assert.deepEqual(plain(await settings.change(nullEnvelope)), {
    ok: true,
    value: { variant: 'dual-subtitles', enabled: true }
  });
  for (const input of [customEnvelope, { ...dualSubtitles(), payload: customPayload }]) {
    assert.deepEqual(plain(await settings.change(input)), expectedFailure('invalid', 'settings-change', false));
  }
  assert.deepEqual(plain(calls), [{ 'subtitle.dualModeEnabled': true }]);
});

test('Given detectable generic, authority-bearing, and unknown setting inputs When Settings changes them Then it returns the forbidden settings-key result without writing', async () => {
  const createSettings = await loadSettings();
  let calls = 0;
  const settings = createSettings({ write() { calls += 1; } });
  const forbidden = [
    { category: 'settings-change', variant: 'subtitle-languages', payload: { key: 'subtitle.primaryLanguage', value: 'en' } },
    { ...subtitleLanguages(), items: {} },
    { ...subtitleLanguages(), payload: { primaryLanguage: 'en', secondaryLanguage: 'zh-Hant', style: {} } },
    { ...dualSubtitles(), payload: { enabled: true, storage: {} } },
    { ...dualSubtitles(), payload: { enabled: true, videoId: '81234567' } },
    { ...dualSubtitles(), payload: { enabled: true, JWT: 'secret' } },
    { ...dualSubtitles(), payload: { enabled: true, playbackContext: {} } },
    { ...dualSubtitles(), variant: 'subtitle-style' }
  ];

  for (const input of forbidden) {
    assert.deepEqual(plain(await settings.change(input)), expectedFailure('forbidden', 'settings-key', false));
  }
  assert.equal(calls, 0);
});

test('Given an inspectable authority-bearing Proxy When Settings changes it Then it preserves forbidden settings-key before rejecting benign Proxies structurally', async () => {
  const createSettings = await loadSettings();
  let calls = 0;
  const settings = createSettings({ write() { calls += 1; } });
  const authorityProxy = new Proxy({
    ...dualSubtitles(),
    payload: new Proxy({ enabled: true, token: 'secret' }, {})
  }, {});

  assert.deepEqual(plain(await settings.change(authorityProxy)), expectedFailure('forbidden', 'settings-key', false));
  assert.deepEqual(plain(await settings.change(new Proxy(dualSubtitles(), {}))), expectedFailure('invalid', 'settings-change', false));
  assert.equal(calls, 0);
});

test('Given unsupported or mistyped actual subtitle values When Settings changes them Then config validation rejects them without writing', async () => {
  const createSettings = await loadSettings();
  let calls = 0;
  const settings = createSettings({ write() { calls += 1; } });

  for (const input of [
    subtitleLanguages('not-a-language', 'zh-Hant'),
    subtitleLanguages('en', 1),
    dualSubtitles('true')
  ]) {
    assert.deepEqual(plain(await settings.change(input)), expectedFailure('domain-rejected', 'settings-validation-failed', false));
  }
  assert.equal(calls, 0);
});

test('Given a synchronous or asynchronous writer failure When Settings changes a valid setting Then it hides the failure and reports retryable settings-write-failed', async () => {
  const createSettings = await loadSettings();
  const secret = 'writer failure jwt token';
  const synchronous = createSettings({ write() { throw new Error(secret); } });
  const asynchronous = createSettings({ write() { return Promise.reject(new Error(secret)); } });

  for (const settings of [synchronous, asynchronous]) {
    const result = await settings.change(dualSubtitles());
    assert.deepEqual(plain(result), expectedFailure('domain-rejected', 'settings-write-failed', true));
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('Given a valid change whose writer never settles When its local deadline expires Then Settings reports one retryable timeout and never replays the writer', async () => {
  const createSettings = await loadSettings();
  const clock = new FakeClock();
  const pending = deferred();
  let calls = 0;
  const settings = createSettings({
    write() {
      calls += 1;
      return pending.promise;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const change = settings.change(dualSubtitles());

  assert.equal(calls, 1);
  assert.deepEqual(clock.delays(), [5000]);
  clock.advanceBy(4999);
  await settleMicrotasks();
  assert.equal(await Promise.race([change, Promise.resolve('pending')]), 'pending');
  clock.advanceBy(1);
  assert.deepEqual(plain(await change), expectedFailure('timeout', 'settings-write-timeout', true));
  assert.equal(calls, 1);
  assert.equal(clock.count(), 0);

  pending.resolve({ rawConfig: { token: 'late-secret' } });
  await settleMicrotasks();
  assert.equal(calls, 1);
});

test('Given a valid change whose writer settles before its deadline When Settings returns Then it clears the deadline and a late timer cannot change the acknowledgement', async () => {
  const createSettings = await loadSettings();
  const clock = new FakeClock();
  const pending = deferred();
  const settings = createSettings({
    write() { return pending.promise; },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const change = settings.change(subtitleLanguages('ja', 'en'));

  assert.equal(clock.count(), 1);
  pending.resolve({ config: { api: { endpoint: 'https://secret.example.test' } } });
  assert.deepEqual(plain(await change), {
    ok: true,
    value: { variant: 'subtitle-languages', primaryLanguage: 'ja', secondaryLanguage: 'en' }
  });
  assert.equal(clock.count(), 0);
  clock.advanceBy(5000);
  await settleMicrotasks();
});
