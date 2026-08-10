import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadBackendProfilesCapability() {
  let source;
  try {
    source = await readFile(new URL('content/system/capabilities/backend-profiles.js', root), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const context = vm.createContext({ Promise });
  const resultModule = new vm.SourceTextModule(
    await readFile(new URL('content/system/capabilities/result.js', root), 'utf8'),
    { context, identifier: 'content/system/capabilities/result.js' }
  );
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/system/capabilities/backend-profiles.js'
  });
  await resultModule.link(() => { throw new Error('result.js has no dependencies'); });
  await module.link((specifier) => {
    assert.equal(specifier, './result.js');
    return resultModule;
  });
  await resultModule.evaluate();
  await module.evaluate();
  return module.namespace;
}

test('Given Options profile operations When the client invokes each one Then it emits only its exact closed command and preserves normalized Results', async () => {
  const loaded = await loadBackendProfilesCapability();
  assert.ok(loaded, 'BackendProfiles capability is missing');
  const requests = [];
  const responses = [
    { ok: true, value: [{ id: 'default' }] },
    { ok: true, value: { id: 'created' } },
    { ok: true, value: { id: 'created', isActive: true } },
    { ok: true, value: true },
    { ok: true, value: { profile: { id: 'created' }, queues: {} } },
    { ok: true, value: { vote: 1, translation: 0, replacementEvent: 2 } },
    { ok: true, value: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 } },
    { ok: true, value: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 } }
  ];
  let nextRequestId = 0;
  const profiles = loaded.createBackendProfiles({
    createRequestId: () => `profile-request-${++nextRequestId}`,
    request(value) {
      requests.push(value);
      return responses.shift();
    }
  });

  const results = await Promise.all([
    profiles.list(),
    profiles.create({ endpoint: 'http://localhost:8787/api' }),
    profiles.activate('created'),
    profiles.deleteProfile('created'),
    profiles.exportQueue('created'),
    profiles.retryFailed('created', { confirmInactiveProfile: true }),
    profiles.migrationStatus(),
    profiles.resolveMigrationEndpoint({ endpoint: 'https://recovered.example.test' })
  ]);

  assert.deepEqual(plain(results), [
    { ok: true, value: [{ id: 'default' }] },
    { ok: true, value: { id: 'created' } },
    { ok: true, value: { id: 'created', isActive: true } },
    { ok: true, value: true },
    { ok: true, value: { profile: { id: 'created' }, queues: {} } },
    { ok: true, value: { vote: 1, translation: 0, replacementEvent: 2 } },
    { ok: true, value: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 } },
    { ok: true, value: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 } }
  ]);
  assert.deepEqual(plain(requests), [
    { requestId: 'profile-request-1', message: { type: 'BACKEND_PROFILES_LIST' } },
    { requestId: 'profile-request-2', message: { type: 'BACKEND_PROFILES_CREATE', endpoint: 'http://localhost:8787/api' } },
    { requestId: 'profile-request-3', message: { type: 'BACKEND_PROFILES_ACTIVATE', profileId: 'created' } },
    { requestId: 'profile-request-4', message: { type: 'BACKEND_PROFILES_DELETE', profileId: 'created', discard: false } },
    { requestId: 'profile-request-5', message: { type: 'BACKEND_PROFILES_EXPORT_QUEUE', profileId: 'created' } },
    { requestId: 'profile-request-6', message: { type: 'BACKEND_PROFILES_RETRY_FAILED', profileId: 'created', confirmInactiveProfile: true } },
    { requestId: 'profile-request-7', message: { type: 'STORAGE_MIGRATION_STATUS' } },
    { requestId: 'profile-request-8', message: { type: 'STORAGE_MIGRATION_RESOLVE_ENDPOINT', endpoint: 'https://recovered.example.test' } }
  ]);
});

test('Given invalid profile input or a hostile caller object When the client is invoked Then it returns profile-input without requesting or retrying', async () => {
  const loaded = await loadBackendProfilesCapability();
  assert.ok(loaded, 'BackendProfiles capability is missing');
  let calls = 0;
  const profiles = loaded.createBackendProfiles({
    request() { calls += 1; return { ok: true, value: 'unexpected' }; },
    createRequestId: () => 'must-not-be-used'
  });
  const throwingEndpoint = { get endpoint() { throw new Error('endpoint getter'); } };
  const hostileProfileId = new Proxy({}, { get() { throw new Error('profile getter'); } });

  const results = await Promise.all([
    profiles.create(null),
    profiles.create({}),
    profiles.create(throwingEndpoint),
    profiles.create(Object.create({ endpoint: 'https://inherited.example.test' })),
    profiles.activate(''),
    profiles.activate(hostileProfileId),
    profiles.deleteProfile('created', { discard: 'yes' }),
    profiles.deleteProfile('created', new Proxy({}, { ownKeys() { throw new Error('options proxy'); } })),
    profiles.exportQueue(''),
    profiles.retryFailed('', { confirmInactiveProfile: false }),
    profiles.retryFailed('created', { confirmInactiveProfile: 'yes' }),
    profiles.retryFailed('created', new Proxy({}, { ownKeys() { throw new Error('options proxy'); } })),
    profiles.resolveMigrationEndpoint({}),
    profiles.resolveMigrationEndpoint(throwingEndpoint)
  ]);

  for (const result of results) {
    assert.deepEqual(plain(result), {
      ok: false,
      error: { kind: 'invalid', code: 'profile-input', retryable: false }
    });
  }
  assert.equal(calls, 0);
});

test('Given repeated or terminal Options profile requests When the transport settles Then the client forwards each Result without retries or raw faults', async () => {
  const loaded = await loadBackendProfilesCapability();
  assert.ok(loaded, 'BackendProfiles capability is missing');
  const responses = [
    { ok: false, error: { kind: 'timeout', code: 'options-profile-timeout', retryable: true } },
    { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } },
    { ok: true, value: [] }
  ];
  const requests = [];
  const profiles = loaded.createBackendProfiles({
    createRequestId: (() => {
      let id = 0;
      return () => `repeated-${++id}`;
    })(),
    request(value) {
      requests.push(value);
      return responses.shift();
    }
  });

  assert.deepEqual(plain(await profiles.list()), {
    ok: false,
    error: { kind: 'timeout', code: 'options-profile-timeout', retryable: true }
  });
  assert.deepEqual(plain(await profiles.list()), {
    ok: false,
    error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true }
  });
  assert.deepEqual(plain(await profiles.list()), { ok: true, value: [] });
  assert.deepEqual(requests.map(({ requestId }) => requestId), ['repeated-1', 'repeated-2', 'repeated-3']);

  const throwing = loaded.createBackendProfiles({
    createRequestId: () => 'fault',
    request() { throw new Error('JWT should not escape'); }
  });
  assert.deepEqual(plain(await throwing.list()), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'backend-profiles-request-failed', retryable: false }
  });
});

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.style = {};
    this.children = [];
    this.clickCount = 0;
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  add(option) {
    this.children.push(option);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    this.clickCount += 1;
  }

  async dispatch(type) {
    const event = { target: this, preventDefault() {} };
    await Promise.all((this.listeners.get(type) || []).map(listener => listener(event)));
  }

  querySelector() {
    return null;
  }

  closest() {
    return { classList: this.classList };
  }
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

function queueCounts(total = 0) {
  return {
    pending: { vote: total, translation: 0, replacementEvent: 0, total },
    syncing: { vote: 0, translation: 0, replacementEvent: 0, total: 0 },
    failed: { vote: 0, translation: 0, replacementEvent: 0, total: 0 }
  };
}

function profile(id, isActive, total = 0) {
  return {
    id,
    endpoint: `https://${id}.example.test`,
    userIdMasked: 'ab...yz',
    hasJwt: isActive,
    isActive,
    queueCounts: queueCounts(total)
  };
}

function createScheduler() {
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++nextId;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    run(delay) {
      for (const [id, task] of [...tasks]) {
        if (task.delay === delay) {
          tasks.delete(id);
          task.callback();
        }
      }
    },
    count() {
      return tasks.size;
    }
  };
}

async function loadOptionsProfilesHarness({ confirmations = [], initialProfiles, listResult, exportResult, retryResult, migrationStatusResult } = {}) {
  const elements = Object.fromEntries([
    'backendProfileSelect', 'backendProfileEndpoint', 'createBackendProfileButton',
    'activateBackendProfileButton', 'exportBackendProfileButton', 'deleteBackendProfileButton',
    'backendProfileStatus', 'backendProfileIdentity', 'backendProfileQueueCounts', 'backendProfileError',
    'storageMigrationRecovery', 'storageMigrationEndpoint', 'resolveStorageMigrationButton', 'storageMigrationError',
    'retryAllSyncButton', 'voteQueueCount', 'translationQueueCount', 'replacementEventsQueueCount',
    'clearVoteQueueButton', 'clearTranslationQueueButton', 'clearReplacementEventsQueueButton',
    'debugModeCheckbox', 'endscreenTasksEnabledCheckbox'
  ].map(id => [id, new FakeElement(id)]));
  const profiles = initialProfiles || [profile('active', true), profile('idle', false)];
  const calls = [];
  const alerts = [];
  let blockDelete = false;
  let migrationStatus = migrationStatusResult || { ok: true, value: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 } };
  let factoryArguments;
  const scheduler = createScheduler();
  const ports = [];
  const profileClient = {
    async list() { return listResult || { ok: true, value: plain(profiles) }; },
    async create({ endpoint }) {
      calls.push(['create', endpoint]);
      profiles.push({ ...profile('created', false), endpoint });
      return { ok: true, value: plain(profiles.at(-1)) };
    },
    async activate(id) {
      calls.push(['activate', id]);
      for (const item of profiles) item.isActive = item.id === id;
      return { ok: true, value: plain(profiles.find(item => item.id === id)) };
    },
    async deleteProfile(id, { discard = false } = {}) {
      calls.push(['delete', id, discard]);
      if (blockDelete && !discard) {
        return { ok: false, error: { kind: 'domain-rejected', code: 'profile-delete-blocked', retryable: false } };
      }
      const index = profiles.findIndex(item => item.id === id);
      if (index >= 0) profiles.splice(index, 1);
      return { ok: true, value: true };
    },
    async exportQueue(id) {
      calls.push(['export', id]);
      return exportResult || { ok: true, value: { profile: profile(id, true), queues: {} } };
    },
    async retryFailed(id, { confirmInactiveProfile }) {
      calls.push(['retry', id, confirmInactiveProfile]);
      return retryResult || { ok: true, value: { vote: 0, translation: 0, replacementEvent: 0 } };
    },
    async migrationStatus() {
      return migrationStatus;
    },
    async resolveMigrationEndpoint({ endpoint }) {
      calls.push(['resolve-migration', endpoint]);
      migrationStatus = { ok: true, value: { status: 'ready', targetVersion: 1, malformedRecordCount: 0 } };
      return migrationStatus;
    }
  };
  const domListeners = new Map();
  const storageCalls = { gets: [], sets: [] };
  const downloads = { created: [], revoked: [], appended: [], removed: [], bodyChildren: [] };
  const body = {
    appendChild(element) {
      downloads.appended.push(element);
      downloads.bodyChildren.push(element);
      return element;
    },
    removeChild(element) {
      downloads.removed.push(element);
      const index = downloads.bodyChildren.indexOf(element);
      if (index >= 0) downloads.bodyChildren.splice(index, 1);
      return element;
    }
  };
  const source = await readFile(new URL('../options.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    structuredClone,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    confirm: () => confirmations.shift() ?? false,
    alert(message) { alerts.push(message); },
    Blob: FakeBlob,
    URL: {
      createObjectURL(blob) {
        const url = `blob:subpal-test-${downloads.created.length + 1}`;
        downloads.created.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) {
        downloads.revoked.push(url);
      }
    },
    Option: class extends FakeElement { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
    document: {
      addEventListener(type, listener) { domListeners.set(type, listener); },
      getElementById(id) { return elements[id] || null; },
      querySelectorAll() { return []; },
      createElement(tagName) { return new FakeElement(tagName); },
      body
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '0.0.0-test' }),
        connect: () => {
          const messageListeners = [];
          const disconnectListeners = [];
          const port = {
            sent: [],
            onMessage: { addListener(listener) { messageListeners.push(listener); } },
            onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
            postMessage(value) { port.sent.push(value); }
          };
          ports.push({
            port,
            emit(message) { for (const listener of messageListeners) listener(message); },
            disconnect() { for (const listener of disconnectListeners) listener(); }
          });
          return port;
        }
      },
      storage: {
        local: {
          async get(keys) {
            storageCalls.gets.push(structuredClone(keys));
            return {};
          },
          async set(value) {
            storageCalls.sets.push(structuredClone(value));
          }
        }
      }
    }
  });
  const backendProfilesModule = new vm.SyntheticModule(['createBackendProfiles'], function initialize() {
    this.setExport('createBackendProfiles', (argumentsValue) => {
      factoryArguments = argumentsValue;
      return profileClient;
    });
  }, { context, identifier: 'backend-profiles.js' });
  await backendProfilesModule.link(() => { throw new Error('backend profiles has no dependencies'); });
  await backendProfilesModule.evaluate();
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'options.js',
    importModuleDynamically: async (specifier) => {
      assert.equal(specifier, './content/system/capabilities/backend-profiles.js');
      return backendProfilesModule;
    }
  });
  await module.link(specifier => {
    if (specifier === './content/system/config/config-schema.js') {
      return new vm.SyntheticModule(
        ['SUPPORTED_LANGUAGES', 'SUBTITLE_FONT_PRESETS', 'SUBTITLE_FONT_WEIGHT_OPTIONS', 'SUBTITLE_STYLE_MODES', 'getDefaultValues'],
        function initialize() {
          this.setExport('SUPPORTED_LANGUAGES', []);
          this.setExport('SUBTITLE_FONT_PRESETS', []);
          this.setExport('SUBTITLE_FONT_WEIGHT_OPTIONS', []);
          this.setExport('SUBTITLE_STYLE_MODES', []);
          this.setExport('getDefaultValues', () => ({ debugMode: false, 'crowdsourcing.endscreenTasksEnabled': true }));
        },
        { context }
      );
    }
    if (specifier === './shared/subtitle-preview-renderer.js') {
      return new vm.SyntheticModule(['renderSubtitlePreview'], function initialize() {
        this.setExport('renderSubtitlePreview', () => {});
      }, { context });
    }
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await domListeners.get('DOMContentLoaded')();
  return { elements, profiles, calls, ports, profileClient, factoryArguments, scheduler, storageCalls, downloads, alerts, setBlockDelete(value) { blockDelete = value; } };
}

test('Given the production Options profile port When it times out, disconnects, receives a late reply, and reconnects Then each Result is normalized and pending work is cleaned', async () => {
  const options = await loadOptionsProfilesHarness();
  const request = options.factoryArguments.request;

  const timedOut = request({ requestId: 'profile-timeout', message: { type: 'BACKEND_PROFILES_LIST' } });
  let timeoutSettlements = 0;
  void timedOut.then(() => { timeoutSettlements += 1; });
  assert.equal(options.ports.length, 1);
  assert.deepEqual(plain(options.ports[0].port.sent), [{ messageId: 'profile-timeout', message: { type: 'BACKEND_PROFILES_LIST' } }]);
  assert.equal(options.scheduler.count(), 1);
  options.scheduler.run(10000);
  assert.deepEqual(plain(await timedOut), {
    ok: false,
    error: { kind: 'timeout', code: 'options-profile-timeout', retryable: true }
  });
  assert.equal(options.scheduler.count(), 0);

  options.ports[0].emit({ messageId: 'profile-timeout', response: { ok: true, value: ['late'] } });
  await Promise.resolve();
  assert.equal(timeoutSettlements, 1);
  const afterTimeout = request({ requestId: 'profile-timeout', message: { type: 'BACKEND_PROFILES_LIST' } });
  options.ports[0].emit({ messageId: 'profile-timeout', response: { ok: true, value: ['after-timeout'] } });
  assert.deepEqual(plain(await afterTimeout), { ok: true, value: ['after-timeout'] });

  const disconnected = request({ requestId: 'profile-disconnect', message: { type: 'BACKEND_PROFILES_LIST' } });
  options.ports[0].disconnect();
  assert.deepEqual(plain(await disconnected), {
    ok: false,
    error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true }
  });
  assert.equal(options.scheduler.count(), 0);

  const fresh = request({ requestId: 'profile-disconnect', message: { type: 'BACKEND_PROFILES_LIST' } });
  assert.equal(options.ports.length, 2);
  options.ports[0].emit({ messageId: 'profile-disconnect', response: { ok: true, value: ['stale'] } });
  options.ports[1].emit({ messageId: 'profile-disconnect', response: { ok: true, value: ['fresh'] } });
  assert.deepEqual(plain(await fresh), { ok: true, value: ['fresh'] });
  assert.equal(options.scheduler.count(), 0);
});

test('Given a real backend profile snapshot When Options renders queue counts Then it displays the nested numeric totals', async () => {
  const options = await loadOptionsProfilesHarness({
    initialProfiles: [{
      ...profile('active', true),
      queueCounts: {
        pending: { vote: 2, translation: 1, replacementEvent: 0, total: 3 },
        syncing: { vote: 0, translation: 1, replacementEvent: 0, total: 1 },
        failed: { vote: 0, translation: 0, replacementEvent: 2, total: 2 }
      }
    }]
  });

  assert.equal(options.elements.backendProfileQueueCounts.textContent, '待處理：3；同步中：1；失敗：2');
  assert.equal(options.elements.backendProfileQueueCounts.textContent.includes('[object Object]'), false);
});

test('Given selected safe profile snapshots When Options renders pending queue counts or selection changes Then it uses only the selected nested profile counts', async () => {
  const options = await loadOptionsProfilesHarness({
    initialProfiles: [
      {
        ...profile('active', true),
        queueCounts: {
          pending: { vote: 2, translation: 3, replacementEvent: 4, total: 9 },
          syncing: { vote: 5, translation: 6, replacementEvent: 7, total: 18 },
          failed: { vote: 8, translation: 9, replacementEvent: 10, total: 27 }
        }
      },
      {
        ...profile('idle', false),
        queueCounts: {
          pending: { vote: 11, translation: 12, replacementEvent: 13, total: 36 },
          syncing: { vote: 0, translation: 0, replacementEvent: 0, total: 0 },
          failed: { vote: 0, translation: 0, replacementEvent: 0, total: 0 }
        }
      }
    ]
  });

  assert.equal(options.elements.voteQueueCount.textContent, '2');
  assert.equal(options.elements.translationQueueCount.textContent, '3');
  assert.equal(options.elements.replacementEventsQueueCount.textContent, '4');
  assert.equal(options.storageCalls.gets.some(keys => Array.isArray(keys) && keys.some(key => ['voteQueue', 'translationQueue', 'replacementEventQueue'].includes(key))), false);

  options.elements.backendProfileSelect.value = 'idle';
  await options.elements.backendProfileSelect.dispatch('change');
  assert.equal(options.elements.voteQueueCount.textContent, '11');
  assert.equal(options.elements.translationQueueCount.textContent, '12');
  assert.equal(options.elements.replacementEventsQueueCount.textContent, '13');
});

test('Given an unsafe legacy endpoint blocks migration When Options loads Then it exposes only the explicit safe-endpoint recovery flow', async () => {
  const options = await loadOptionsProfilesHarness({
    confirmations: [true],
    migrationStatusResult: {
      ok: true,
      value: { status: 'needs-attention', targetVersion: 1, reason: 'unsupported-legacy-endpoint' }
    }
  });

  assert.equal(options.elements.storageMigrationRecovery.hidden, false);
  assert.equal(options.elements.createBackendProfileButton.disabled, true);
  assert.equal(options.elements.backendProfileError.textContent.includes('完成既有資料升級'), true);
  options.elements.storageMigrationEndpoint.value = 'https://recovered.example.test/api';
  await options.elements.resolveStorageMigrationButton.dispatch('click');

  assert.deepEqual(options.calls.at(-1), ['resolve-migration', 'https://recovered.example.test/api']);
  assert.equal(options.elements.storageMigrationRecovery.hidden, true);
  assert.equal(options.elements.storageMigrationEndpoint.value, '');
  assert.equal(JSON.stringify(options.elements).includes('legacy-jwt'), false);
});

test('Given malformed nested queue counts When Options receives profile snapshots Then each invalid count is rendered as zero without exposing unsafe data', async () => {
  const options = await loadOptionsProfilesHarness({
    initialProfiles: [{
      ...profile('active', true),
      queueCounts: {
        pending: { vote: 'secret-token', translation: 2, replacementEvent: -1, total: 1 },
        syncing: { vote: 0, translation: 0, replacementEvent: 0, total: 0 },
        failed: { vote: 0, translation: 0, replacementEvent: 0, total: 0 }
      }
    }]
  });

  assert.equal(options.elements.voteQueueCount.textContent, '0');
  assert.equal(options.elements.translationQueueCount.textContent, '2');
  assert.equal(options.elements.replacementEventsQueueCount.textContent, '0');
  assert.equal(JSON.stringify(options.elements).includes('secret-token'), false);
});

test('Given an active or inactive selected profile When Options retries failed contributions Then it uses the trusted retry capability with the required confirmation', async () => {
  const active = await loadOptionsProfilesHarness();
  await active.elements.retryAllSyncButton.dispatch('click');
  assert.deepEqual(active.calls, [['retry', 'active', false]]);
  assert.equal(active.alerts.includes('已觸發重試，背景持續處理中。'), true);

  const cancelled = await loadOptionsProfilesHarness({ confirmations: [false] });
  cancelled.elements.backendProfileSelect.value = 'idle';
  await cancelled.elements.backendProfileSelect.dispatch('change');
  await cancelled.elements.retryAllSyncButton.dispatch('click');
  assert.deepEqual(cancelled.calls, []);

  const inactive = await loadOptionsProfilesHarness({ confirmations: [true] });
  inactive.elements.backendProfileSelect.value = 'idle';
  await inactive.elements.backendProfileSelect.dispatch('change');
  await inactive.elements.retryAllSyncButton.dispatch('click');
  assert.deepEqual(inactive.calls, [['retry', 'idle', true]]);
  assert.equal(JSON.stringify(inactive.elements).includes('jwt'), false);
  assert.equal(JSON.stringify(inactive.alerts).includes('secret-token'), false);
});

test('Given a retry failure containing raw backend data When Options reports it Then no raw error reaches the DOM or alert', async () => {
  const options = await loadOptionsProfilesHarness({
    retryResult: { ok: false, error: { kind: 'domain-rejected', code: 'jwt-secret-token', retryable: false } }
  });

  await options.elements.retryAllSyncButton.dispatch('click');

  assert.deepEqual(options.calls, [['retry', 'active', false]]);
  assert.deepEqual(options.alerts, ['重試同步失敗，請稍後再試。']);
  assert.equal(options.elements.backendProfileError.textContent.includes('jwt-secret-token'), false);
});

test('Given profile snapshots When Options creates, activates, and deletes profiles Then it renders only safe data and uses the closed capability', async () => {
  const options = await loadOptionsProfilesHarness({ confirmations: [true] });
  const { elements } = options;

  assert.equal(typeof options.factoryArguments.request, 'function');
  assert.equal(options.storageCalls.sets.length, 0);
  assert.equal(options.storageCalls.gets.some(keys => keys.includes('backendProfiles')), false);
  assert.equal(options.storageCalls.gets.some(keys => keys.includes('api.baseUrl')), false);
  assert.equal(elements.backendProfileStatus.textContent, '使用中的端點：https://active.example.test');
  assert.equal(elements.backendProfileIdentity.textContent, '身分：ab...yz；已設定憑證');
  assert.equal(elements.backendProfileQueueCounts.textContent, '待處理：0；同步中：0；失敗：0');
  assert.equal(elements.exportBackendProfileButton.disabled, false);

  elements.backendProfileEndpoint.value = 'http://localhost:8787/api';
  await elements.createBackendProfileButton.dispatch('click');
  assert.deepEqual(options.calls.at(-1), ['create', 'http://localhost:8787/api']);
  assert.equal(elements.backendProfileSelect.value, 'created');
  assert.equal(elements.exportBackendProfileButton.disabled, true);

  await elements.activateBackendProfileButton.dispatch('click');
  assert.deepEqual(options.calls.at(-1), ['activate', 'created']);
  assert.equal(elements.backendProfileStatus.textContent, '使用中的端點：http://localhost:8787/api');
  assert.equal(elements.exportBackendProfileButton.disabled, false);

  await elements.deleteBackendProfileButton.dispatch('click');
  assert.equal(elements.backendProfileError.textContent, '使用中的設定檔無法刪除。');

  elements.backendProfileSelect.value = 'idle';
  await elements.backendProfileSelect.dispatch('change');
  await elements.deleteBackendProfileButton.dispatch('click');
  assert.deepEqual(options.calls.at(-1), ['delete', 'idle', false]);
  assert.equal(options.profiles.some(item => item.id === 'idle'), false);

  const serialized = JSON.stringify({ elements, profiles: options.profiles, calls: options.calls });
  assert.equal(serialized.includes('jwt'), false);
  assert.equal(serialized.includes('real-user-id'), false);
});

test('Given an active profile export When the download completes Then redacted JSON is downloaded and cleaned up', async () => {
  const exportedValue = {
    profile: { ...profile('active', true), id: 'active/profile?unsafe' },
    queues: { vote: [{ id: 'vote-1', voteState: 'like' }] },
    histories: { vote: [{ id: 'history-1', status: 'synced' }] },
    voteStateByTranslation: { translation1: { voteState: 'like' } }
  };
  const options = await loadOptionsProfilesHarness({
    initialProfiles: [exportedValue.profile],
    exportResult: { ok: true, value: exportedValue }
  });

  await options.elements.exportBackendProfileButton.dispatch('click');

  assert.equal(options.downloads.created.length, 1);
  const [{ url, blob }] = options.downloads.created;
  assert.equal(blob.type, 'application/json');
  const serialized = await blob.text();
  assert.deepEqual(JSON.parse(serialized), exportedValue);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('real-user-id'), false);
  assert.deepEqual(options.calls.at(-1), ['export', 'active/profile?unsafe']);
  assert.equal(options.downloads.appended.length, 1);
  const [anchor] = options.downloads.appended;
  assert.equal(anchor.href, url);
  assert.equal(anchor.download, 'subpal_backend_profile_active-profile-unsafe_queue.json');
  assert.equal(anchor.clickCount, 1);
  assert.deepEqual(options.downloads.removed, [anchor]);
  assert.deepEqual(options.downloads.bodyChildren, []);
  assert.deepEqual(options.downloads.revoked, [url]);
});

test('Given an export failure with a raw backend secret When the active profile is exported Then no download is attempted and the UI stays sanitized', async () => {
  const options = await loadOptionsProfilesHarness({
    exportResult: { ok: false, error: { kind: 'domain-rejected', code: 'raw-server-secret-token', retryable: false } }
  });

  await options.elements.exportBackendProfileButton.dispatch('click');

  assert.deepEqual(options.calls.at(-1), ['export', 'active']);
  assert.equal(options.elements.backendProfileError.textContent, '無法匯出使用中的後端設定檔資料。請稍後再試。');
  assert.equal(options.elements.backendProfileError.textContent.includes('raw-server-secret-token'), false);
  assert.deepEqual(options.downloads.created, []);
  assert.deepEqual(options.downloads.appended, []);
  assert.deepEqual(options.downloads.removed, []);
  assert.deepEqual(options.downloads.revoked, []);
});

test('Given a profile with pending records When Options deletion is blocked Then cancellation preserves it and confirmed discard is an explicit second operation', async () => {
  const options = await loadOptionsProfilesHarness({ confirmations: [true, false, true, true] });
  const { elements } = options;
  options.setBlockDelete(true);
  elements.backendProfileSelect.value = 'idle';
  await elements.backendProfileSelect.dispatch('change');

  await elements.deleteBackendProfileButton.dispatch('click');
  assert.deepEqual(options.calls.slice(-1), [['delete', 'idle', false]]);
  assert.equal(options.profiles.some(item => item.id === 'idle'), true);
  assert.equal(elements.backendProfileError.textContent, '此設定檔仍有待處理、同步中或失敗的資料（待處理：0；同步中：0；失敗：0）。');

  await elements.deleteBackendProfileButton.dispatch('click');
  assert.deepEqual(options.calls.slice(-2), [['delete', 'idle', false], ['delete', 'idle', true]]);
  assert.equal(options.profiles.some(item => item.id === 'idle'), false);
});

test('Given malformed snapshots or a failed list operation When Options renders profile management Then it keeps a stable safe error and never renders secrets', async () => {
  const malformed = await loadOptionsProfilesHarness({
    initialProfiles: [
      profile('safe', true),
      { id: 'malformed', endpoint: '', userIdMasked: 'raw-user-id', hasJwt: true, isActive: false, jwt: 'secret-token' }
    ]
  });
  assert.equal(malformed.elements.backendProfileSelect.children.length, 1);
  assert.equal(JSON.stringify(malformed.elements).includes('secret-token'), false);

  const unavailable = await loadOptionsProfilesHarness({
    listResult: { ok: false, error: { kind: 'disconnected', code: 'raw-server-error-secret', retryable: true } }
  });
  assert.equal(unavailable.elements.backendProfileError.textContent, '無法載入後端設定檔。請稍後再試。');
  assert.equal(unavailable.elements.backendProfileError.textContent.includes('raw-server-error-secret'), false);
});

test('Given retired legacy clear controls When Options receives clicks Then no raw queue storage mutation or destructive UI effect occurs', async () => {
  const options = await loadOptionsProfilesHarness({ confirmations: [true, true, true] });

  await options.elements.clearVoteQueueButton.dispatch('click');
  await options.elements.clearTranslationQueueButton.dispatch('click');
  await options.elements.clearReplacementEventsQueueButton.dispatch('click');

  assert.deepEqual(options.storageCalls.sets, []);
  assert.deepEqual(options.calls, []);
  assert.deepEqual(options.alerts, []);
});
