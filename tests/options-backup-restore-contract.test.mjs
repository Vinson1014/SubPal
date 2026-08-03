import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const BACKUP_ROOTS = ['debugMode', 'isEnabled', 'crowdsourcing', 'subtitle'];
const PROTECTED_KEYS = ['backendProfiles', 'voteQueue', 'translationHistory', 'user', 'jwt'];

function clone(value) {
  return structuredClone(value);
}

function stable(value) {
  return JSON.stringify(value);
}

function flatToNested(flatValues) {
  const nested = {};
  for (const [path, value] of Object.entries(flatValues)) {
    const segments = path.split('.');
    const leaf = segments.pop();
    let target = nested;
    for (const segment of segments) target = target[segment] ||= {};
    target[leaf] = value;
  }
  return nested;
}

function setNestedValue(target, path, value) {
  const segments = path.split('.');
  const leaf = segments.pop();
  let current = target;
  for (const segment of segments) current = current[segment] ||= {};
  current[leaf] = value;
}

function canonicalConfig(schema, overrides = {}) {
  const defaults = schema.getDefaultValues();
  const allowedValues = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => BACKUP_ROOTS.includes(key.split('.')[0]))
  );
  const config = flatToNested(allowedValues);
  for (const [path, value] of Object.entries(overrides)) setNestedValue(config, path, value);
  return config;
}

function canonicalEnvelope(schema, overrides = {}) {
  return {
    version: '3.0',
    backupDate: '2026-08-03T12:00:00.000Z',
    config: canonicalConfig(schema, overrides)
  };
}

function protectedStorage() {
  return {
    debugMode: false,
    subtitle: { dualModeEnabled: true, secretUnknownSubtitleValue: 'subtitle-secret' },
    backendProfiles: {
      activeProfileId: 'profile-a',
      byId: { 'profile-a': { endpoint: 'https://profile.example.test', userId: 'identity-secret', jwt: 'profile-jwt' } }
    },
    voteQueue: [{ id: 'vote-1', rawTTML: 'queue-secret' }],
    translationHistory: [{ id: 'history-1', originalSubtitle: 'history-secret' }],
    user: { userId: 'legacy-user-secret' },
    jwt: 'legacy-jwt-secret',
    api: { baseUrl: 'https://api-secret.example.test' },
    video: { currentVideoId: 'video-secret' },
    unknownStorage: { credential: 'unknown-secret' }
  };
}

class FakeBlob {
  constructor(parts, { type }) {
    this.parts = parts;
    this.type = type;
  }

  async text() {
    return this.parts.join('');
  }
}

class FakeElement {
  constructor() {
    this.href = '';
    this.download = '';
    this.clicks = 0;
  }

  click() {
    this.clicks += 1;
  }
}

async function loadOptionsBackupHarness({ initialStorage = protectedStorage() } = {}) {
  const source = `${await readFile(new URL('../options.js', import.meta.url), 'utf8')}\nglobalThis.__optionsBackupApi = { backupData, restoreData };\n`;
  const schemaSource = await readFile(new URL('../content/system/config/config-schema.js', import.meta.url), 'utf8');
  const storage = clone(initialStorage);
  const storageCalls = { gets: [], sets: [] };
  const alerts = [];
  const downloads = [];
  const readers = [];
  let parseOverride = null;
  let context;

  class FileReader {
    constructor() {
      this.done = new Promise((resolve) => { this.resolveDone = resolve; });
      readers.push(this);
    }

    readAsText(file) {
      queueMicrotask(async () => {
        if (file.error) {
          this.onerror?.();
          this.resolveDone();
          return;
        }
        await this.onload?.({ target: { result: file.text } });
        this.resolveDone();
      });
    }
  }

  const body = { appendChild() {}, removeChild() {} };
  context = vm.createContext({
    Blob: FakeBlob,
    FileReader,
    URL: {
      createObjectURL(blob) {
        const url = `blob:backup-${downloads.length + 1}`;
        downloads.push({ blob, url });
        return url;
      },
      revokeObjectURL() {}
    },
    alert(message) { alerts.push(message); },
    console: { error() {}, log() {}, warn() {} },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
      createElement() { return new FakeElement(); },
      body
    },
    chrome: {
      runtime: { getManifest: () => ({ version: 'test' }) },
      storage: {
        local: {
          async get(keys) {
            storageCalls.gets.push(clone(keys));
            return Object.fromEntries(
              keys.filter((key) => Object.hasOwn(storage, key)).map((key) => [key, clone(storage[key])])
            );
          },
          async set(items) {
            storageCalls.sets.push(clone(items));
            Object.assign(storage, clone(items));
          }
        }
      }
    }
  });
  context.__originalJsonParse = vm.runInContext('JSON.parse', context);
  const schemaModule = new vm.SourceTextModule(schemaSource, { context, identifier: 'config-schema.js' });
  const previewModule = new vm.SyntheticModule(['renderSubtitlePreview'], function initialize() {
    this.setExport('renderSubtitlePreview', () => {});
  }, { context, identifier: 'subtitle-preview-renderer.js' });
  await schemaModule.link(() => { throw new Error('Unexpected config schema dependency'); });
  await previewModule.link(() => { throw new Error('Unexpected preview dependency'); });
  await schemaModule.evaluate();
  await previewModule.evaluate();
  const optionsModule = new vm.SourceTextModule(source, {
    context,
    identifier: 'options.js',
    importModuleDynamically: async (specifier) => {
      if (specifier === './content/system/config/config-schema.js') return schemaModule;
      throw new Error(`Unexpected dynamic import: ${specifier}`);
    }
  });
  await optionsModule.link((specifier) => {
    if (specifier === './content/system/config/config-schema.js') return schemaModule;
    if (specifier === './shared/subtitle-preview-renderer.js') return previewModule;
    throw new Error(`Unexpected static import: ${specifier}`);
  });
  await optionsModule.evaluate();

  return {
    alerts,
    api: context.__optionsBackupApi,
    downloads,
    schema: schemaModule.namespace,
    storage,
    storageCalls,
    vmValue(sourceText) { return vm.runInContext(sourceText, context); },
    async restore(value, { parsedValue } = {}) {
      parseOverride = parsedValue ? () => parsedValue : null;
      if (parseOverride) {
        context.__parseOverride = parseOverride;
        vm.runInContext('JSON.parse = globalThis.__parseOverride', context);
      }
      context.__optionsBackupApi.restoreData({ text: value, error: value === 'reader-error' });
      await readers.at(-1).done;
      if (parseOverride) vm.runInContext('JSON.parse = globalThis.__originalJsonParse', context);
      parseOverride = null;
    }
  };
}

function assertRejectedWithoutWrites(harness, before, message) {
  assert.deepEqual(harness.storageCalls.sets, [], message);
  assert.equal(stable(harness.storage), before, message);
  assert.deepEqual(harness.alerts, ['備份檔案格式無效'], message);
}

test('Given the active schema When backup roots are requested Then it exposes a fresh four-root editable allowlist with no legacy identity root', async () => {
  const harness = await loadOptionsBackupHarness();

  assert.equal(typeof harness.schema.getBackupConfigKeys, 'function');
  const first = harness.schema.getBackupConfigKeys();
  const second = harness.schema.getBackupConfigKeys();
  assert.deepEqual([...first].sort(), [...BACKUP_ROOTS].sort());
  assert.notEqual(first, second);
  first.pop();
  assert.deepEqual([...second].sort(), [...BACKUP_ROOTS].sort());
  assert.equal(Object.hasOwn(harness.schema.CONFIG_SCHEMA, 'user'), false);
});

test('Given storage containing identity, profile, queue, credential, endpoint, and unknown data When Options exports a backup Then only validated canonical roots are read and emitted', async () => {
  const harness = await loadOptionsBackupHarness();
  const expectedConfig = canonicalConfig(harness.schema);
  expectedConfig.debugMode = false;

  await harness.api.backupData();

  assert.deepEqual(harness.storageCalls.gets, [BACKUP_ROOTS]);
  assert.equal(harness.downloads.length, 1);
  const exported = JSON.parse(await harness.downloads[0].blob.text());
  assert.equal(exported.version, '3.0');
  assert.match(exported.backupDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(exported.config, expectedConfig);
  assert.deepEqual(Object.keys(exported.config).sort(), [...BACKUP_ROOTS].sort());
  const serialized = JSON.stringify(exported);
  for (const secret of ['identity-secret', 'profile-jwt', 'queue-secret', 'history-secret', 'legacy-user-secret', 'legacy-jwt-secret', 'api-secret', 'video-secret', 'unknown-secret', 'subtitle-secret']) {
    assert.equal(serialized.includes(secret), false, `backup exposed ${secret}`);
  }
});

test('Given a complete canonical v3 backup When Options restores it Then it performs one atomic four-root write and leaves protected storage untouched', async () => {
  const harness = await loadOptionsBackupHarness();
  const envelope = canonicalEnvelope(harness.schema, {
    debugMode: true,
    isEnabled: false,
    'subtitle.primaryLanguage': 'en'
  });
  const protectedBefore = Object.fromEntries(PROTECTED_KEYS.map((key) => [key, clone(harness.storage[key])]));

  await harness.restore(JSON.stringify(envelope));

  assert.equal(harness.storageCalls.sets.length, 1);
  assert.deepEqual(Object.keys(harness.storageCalls.sets[0]).sort(), [...BACKUP_ROOTS].sort());
  assert.deepEqual(harness.storageCalls.sets[0], envelope.config);
  assert.deepEqual(Object.fromEntries(PROTECTED_KEYS.map((key) => [key, harness.storage[key]])), protectedBefore);
  assert.deepEqual(harness.alerts, ['資料已成功恢復']);
});

test('Given a canonical backup mixed with forbidden roots or nested fields When Options restores it Then it never writes protected storage', async () => {
  const forbiddenRoots = ['queue', 'history', 'voteState', 'backendProfiles', 'JWT', 'token', 'auth', 'credential', 'user', 'userId', 'api', 'video', 'unknown'];

  for (const forbiddenRoot of forbiddenRoots) {
    const harness = await loadOptionsBackupHarness();
    const envelope = canonicalEnvelope(harness.schema);
    envelope.config[forbiddenRoot] = { secret: `${forbiddenRoot}-secret` };
    const before = stable(harness.storage);

    await harness.restore(JSON.stringify(envelope));

    assertRejectedWithoutWrites(harness, before, `forbidden root ${forbiddenRoot}`);
  }

  for (const nestedPath of ['subtitle.token', 'subtitle.style.primary.credential', 'crowdsourcing.userId']) {
    const harness = await loadOptionsBackupHarness();
    const envelope = canonicalEnvelope(harness.schema);
    setNestedValue(envelope.config, nestedPath, 'nested-secret');
    const before = stable(harness.storage);

    await harness.restore(JSON.stringify(envelope));

    assertRejectedWithoutWrites(harness, before, `forbidden nested key ${nestedPath}`);
  }
});

test('Given malformed, stale, interrupted, or non-canonical backup inputs When Options restores them Then failures are sanitized and no writes occur', async () => {
  const invalidInputs = [
    '{not-json',
    JSON.stringify({ ...canonicalEnvelope((await loadOptionsBackupHarness()).schema), version: '2.0' }),
    JSON.stringify({ userID: 'legacy-user', settings: {} }),
    JSON.stringify({ ...canonicalEnvelope((await loadOptionsBackupHarness()).schema), backupDate: 'not-a-date' }),
    JSON.stringify({ version: '3.0', backupDate: '2026-08-03T12:00:00.000Z' }),
    JSON.stringify({ version: '3.0', backupDate: '2026-08-03T12:00:00.000Z', config: [] }),
    JSON.stringify({ version: '3.0', backupDate: '2026-08-03T12:00:00.000Z', config: null }),
    JSON.stringify({ version: '3.0', backupDate: '2026-08-03T12:00:00.000Z', config: false }),
    JSON.stringify({ ...canonicalEnvelope((await loadOptionsBackupHarness()).schema), extra: 'unknown-envelope-key' })
  ];

  for (const input of invalidInputs) {
    const harness = await loadOptionsBackupHarness();
    const before = stable(harness.storage);
    await harness.restore(input);
    assertRejectedWithoutWrites(harness, before, `invalid input ${input.slice(0, 24)}`);
  }

  const invalidType = await loadOptionsBackupHarness();
  const invalidTypeEnvelope = canonicalEnvelope(invalidType.schema, { debugMode: 'not-a-boolean' });
  const invalidTypeBefore = stable(invalidType.storage);
  await invalidType.restore(JSON.stringify(invalidTypeEnvelope));
  assertRejectedWithoutWrites(invalidType, invalidTypeBefore, 'invalid schema value type');

  const interrupted = await loadOptionsBackupHarness();
  const interruptedBefore = stable(interrupted.storage);
  await interrupted.restore('reader-error');
  await interrupted.restore('reader-error');
  assert.deepEqual(interrupted.storageCalls.sets, []);
  assert.equal(stable(interrupted.storage), interruptedBefore);
  assert.deepEqual(interrupted.alerts, ['讀取備份檔案失敗', '讀取備份檔案失敗']);
});

test('Given parser outputs with accessors, symbols, inherited properties, arrays, or non-enumerable extras When Options restores them Then strict object parsing rejects every one without writes', async () => {
  const hostileValues = [
    '(() => { const value = {}; Object.defineProperty(value, "version", { enumerable: true, get() { return "3.0"; } }); return value; })()',
    '(() => { const value = { version: "3.0", backupDate: "2026-08-03T12:00:00.000Z", config: {} }; value[Symbol("secret")] = "secret"; return value; })()',
    'Object.create({ version: "3.0", backupDate: "2026-08-03T12:00:00.000Z", config: {} })',
    '(() => { const value = { version: "3.0", backupDate: "2026-08-03T12:00:00.000Z", config: {} }; Object.defineProperty(value, "hidden", { value: "secret" }); return value; })()',
    '[]'
  ];

  for (const source of hostileValues) {
    const harness = await loadOptionsBackupHarness();
    const before = stable(harness.storage);
    await harness.restore('hostile-parser-output', { parsedValue: harness.vmValue(source) });
    assertRejectedWithoutWrites(harness, before, source);
  }
});
