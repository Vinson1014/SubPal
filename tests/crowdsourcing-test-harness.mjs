import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadBackgroundWithApi(apiModule, options = {}) {
  const modulesByContext = new WeakMap();
  return await loadBackground((specifier, context) => {
    if (specifier === './background/api.js' || specifier === './api.js') {
      if (!modulesByContext.has(context)) {
        modulesByContext.set(context, new vm.SyntheticModule(Object.keys(apiModule), function init() {
          for (const [name, value] of Object.entries(apiModule)) this.setExport(name, value);
        }, { context, identifier: 'api.js' }));
      }
      return modulesByContext.get(context);
    }
    if (specifier === './background/sync.js' && options.syncModule) {
      return new vm.SyntheticModule(Object.keys(options.syncModule), function init() {
        for (const [name, value] of Object.entries(options.syncModule)) this.setExport(name, value);
      }, { context, identifier: 'sync.js' });
    }
    return null;
  }, undefined, options);
}

export async function loadBackgroundWithRealApi(fetchImpl, options = {}) {
  return await loadBackground(async (specifier, context) => {
    if (specifier === './background/api.js') {
      return await loadRealApiModule(context);
    }
    return null;
  }, fetchImpl, options);
}

async function loadRealApiModule(context) {
  const backendProfilesModule = await loadBackendProfilesModule(context);
  const storageMigrationsModule = await loadStorageMigrationsModule(context, backendProfilesModule);
  const apiSource = await readFile(new URL('../background/api.js', import.meta.url), 'utf8');
  const apiModule = new vm.SourceTextModule(apiSource, { context, identifier: 'background/api.js' });
  await apiModule.link(async (specifier) => {
    if (specifier === './backend-profiles.js') return backendProfilesModule;
    if (specifier === './storage-migrations.js') return storageMigrationsModule;
    throw new Error(`Unexpected background/api.js import: ${specifier}`);
  });
  return apiModule;
}

async function loadBackendProfilesModule(context) {
  const source = await readFile(new URL('../background/backend-profiles.js', import.meta.url), 'utf8');
  const coordinatorSource = await readFile(new URL('../background/storage-mutation-coordinator.js', import.meta.url), 'utf8');
  const coordinator = new vm.SourceTextModule(coordinatorSource, {
    context,
    identifier: 'background/storage-mutation-coordinator.js'
  });
  const module = new vm.SourceTextModule(source, { context, identifier: 'background/backend-profiles.js' });
  await module.link((specifier) => {
    if (specifier === './storage-mutation-coordinator.js') return coordinator;
    throw new Error(`Unexpected background/backend-profiles.js import: ${specifier}`);
  });
  return module;
}

async function loadStorageMigrationsModule(context, backendProfilesModule) {
  const source = await readFile(new URL('../background/storage-migrations.js', import.meta.url), 'utf8');
  const coordinator = new vm.SourceTextModule(
    await readFile(new URL('../background/storage-mutation-coordinator.js', import.meta.url), 'utf8'),
    { context, identifier: 'background/storage-mutation-coordinator.js' }
  );
  const module = new vm.SourceTextModule(source, { context, identifier: 'background/storage-migrations.js' });
  await module.link((specifier) => {
    if (specifier === './backend-profiles.js') return backendProfilesModule;
    if (specifier === './storage-mutation-coordinator.js') return coordinator;
    throw new Error(`Unexpected background/storage-migrations.js import: ${specifier}`);
  });
  return module;
}

function createConsole(logs) {
  return Object.fromEntries(['log', 'warn', 'error'].map((level) => [level, (...args) => logs.push({ level, args })]));
}

async function loadActualBackgroundModules(context, { contributionQueue, sync }) {
  const paths = [
    'background/storage-mutation-coordinator.js',
    'background/backend-profiles.js',
    'background/storage-migrations.js',
    ...(contributionQueue ? ['background/contribution-queue.js'] : []),
    ...(sync ? ['background/sync.js'] : [])
  ];
  const modules = await Promise.all(paths.map(async (path) => [
    path,
    new vm.SourceTextModule(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), { context, identifier: path })
  ]));
  return Object.fromEntries(modules.map(([path, module]) => [path.split('/').at(-1).replace('.js', ''), module]));
}

async function loadBackground(resolveModule, fetchImpl = fetch, options = {}) {
  const onConnect = { listener: null };
  const onMessage = { listener: null };
  const onAlarm = { listener: null };
  const onInstalled = { listener: null };
  const onStartup = { listener: null };
  const alarmCalls = { clear: [], create: [] };
  const storageCalls = [];
  const logs = options.logs ?? [];
  const storage = options.storage ?? {
    jwt: 'jwt-token',
    user: { userId: 'user-1' },
    api: { baseUrl: 'https://api.example.test' }
  };
  const lifecycleEvents = options.lifecycleEvents ?? [];
  const legacyMigration = options.legacyMigration ?? Promise.resolve();
  let legacyMigrationCalls = 0;
  let storageMigrationReadiness = null;
  const profileMigration = options.profileMigration ?? Promise.resolve();
  let profileMigrationCalls = 0;
  let profileMigrationReadiness = null;
  let syncListenerImports = 0;
  const ensureBackendProfilesMigrated = async () => {
    if (!profileMigrationReadiness) {
      profileMigrationCalls += 1;
      lifecycleEvents.push('profile-migration');
      profileMigrationReadiness = (async () => {
        await profileMigration;
        if (!storage.backendProfiles) {
          storage.backendProfiles = {
            schemaVersion: 1,
            activeProfileId: 'default',
            byId: {
              default: {
                id: 'default',
                endpoint: storage.api?.baseUrl ?? 'https://subnfbackend.zeabur.app',
                userId: storage.user?.userId ?? 'generated-profile-user',
                jwt: storage.jwt ?? null
              }
            }
          };
          storageCalls.push({ operation: 'set', keys: ['backendProfiles'] });
        }
      })();
    }
    await profileMigrationReadiness;
  };
  const ensureStorageMigrationsComplete = async () => {
    if (!storageMigrationReadiness) {
      legacyMigrationCalls += 1;
      lifecycleEvents.push('legacy-migration');
      storageMigrationReadiness = (async () => {
        await legacyMigration;
        if (storage.userID && !storage.user?.userId) {
          storage.user = { userId: storage.userID };
          delete storage.userID;
        }
        if (storage.currentVideoId && !storage.video?.currentVideoId) {
          storage.video = { currentVideoId: storage.currentVideoId };
          delete storage.currentVideoId;
        }
        await ensureBackendProfilesMigrated();
      })();
    }
    await storageMigrationReadiness;
  };
  const getStorageMigrationStatus = async () => ({ status: 'ready', targetVersion: 1, malformedRecordCount: 0 });
  const resolveStorageMigrationEndpoint = async (_local, endpoint) => {
    if (typeof endpoint !== 'string' || !endpoint) throw new Error('Invalid backend endpoint');
    return { status: 'ready', targetVersion: 1, malformedRecordCount: 0 };
  };
  const resolveBackendProfile = async (_local, profileId) => {
    await ensureBackendProfilesMigrated();
    const id = profileId ?? storage.backendProfiles.activeProfileId;
    return structuredClone(storage.backendProfiles.byId[id]);
  };
  const setBackendProfileCredentials = async (_local, profileId, credentials) => {
    await ensureBackendProfilesMigrated();
    const profile = storage.backendProfiles.byId[profileId];
    storage.backendProfiles = {
      ...storage.backendProfiles,
      byId: {
        ...storage.backendProfiles.byId,
        [profileId]: { ...profile, ...credentials }
      }
    };
    storageCalls.push({ operation: 'set', keys: ['backendProfiles'] });
  };
  const profileOperations = options.profileOperations ?? {};
  const listBackendProfiles = async (...args) => await (profileOperations.list?.(...args) ?? []);
  const createBackendProfile = async (...args) => await profileOperations.create?.(...args);
  const activateBackendProfile = async (...args) => await profileOperations.activate?.(...args);
  const deleteBackendProfile = async (...args) => await profileOperations.delete?.(...args);
  const exportBackendProfileQueue = async (...args) => await profileOperations.exportQueue?.(...args);
  let profileModule;
  const syncModule = {
    async initializeSync() { lifecycleEvents.push('sync-initialize'); },
    ...options.syncModule
  };
  const contributionQueue = {
    enqueueContribution: async () => { throw new Error('Unexpected contribution enqueue'); },
    getContributionProjection: async () => { throw new Error('Unexpected contribution projection'); },
    parseContributionIntent: () => null,
    retryContribution: async () => { throw new Error('Unexpected contribution retry'); },
    retryFailedContributions: async () => { throw new Error('Unexpected contribution bulk retry'); },
    ...options.contributionQueue
  };
  const context = vm.createContext({
    AbortController,
    console: createConsole(logs),
    crypto: options.crypto ?? crypto,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    structuredClone,
    self: { addEventListener() {} },
    chrome: {
      alarms: {
        clear(name) { alarmCalls.clear.push(name); },
        create(name, alarmInfo) { alarmCalls.create.push({ name, alarmInfo }); },
        onAlarm: { addListener(listener) { onAlarm.listener = listener; } }
      },
      runtime: {
        id: 'subpal-extension-id',
        getManifest: () => ({ version: '0.0.0-test' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        onConnect: { addListener(listener) { onConnect.listener = listener; } },
        onInstalled: { addListener(listener) { onInstalled.listener = listener; } },
        onMessage: { addListener(listener) { onMessage.listener = listener; } },
        onStartup: { addListener(listener) { onStartup.listener = listener; } },
        sendMessage(_message, callback) { callback?.({ success: true }); }
      },
      storage: {
        local: {
          async get(keys, callback) {
            const requestedKeys = Array.isArray(keys) ? keys : [keys];
            const result = Object.fromEntries(requestedKeys.map((key) => [key, storage[key]]));
            storageCalls.push({ operation: 'get', keys: requestedKeys });
            callback?.(result);
            return result;
          },
          async set(values) {
            storageCalls.push({ operation: 'set', keys: Object.keys(values) });
            Object.assign(storage, values);
          },
          async remove(keys) {
            const removedKeys = Array.isArray(keys) ? keys : [keys];
            storageCalls.push({ operation: 'remove', keys: removedKeys });
            for (const key of removedKeys) delete storage[key];
          }
        }
      },
      tabs: { async create() {} }
    }
  });
  const actualModules = await loadActualBackgroundModules(context, {
    contributionQueue: options.realContributionQueue === true,
    sync: options.realSyncModule === true
  });
  profileModule = new vm.SyntheticModule([
    'ensureBackendProfilesMigrated',
    'resolveBackendProfile',
    'setBackendProfileCredentials',
    'listBackendProfiles',
    'createBackendProfile',
    'activateBackendProfile',
    'deleteBackendProfile',
    'exportBackendProfileQueue'
  ], function init() {
    this.setExport('ensureBackendProfilesMigrated', ensureBackendProfilesMigrated);
    this.setExport('resolveBackendProfile', resolveBackendProfile);
    this.setExport('setBackendProfileCredentials', setBackendProfileCredentials);
    this.setExport('listBackendProfiles', listBackendProfiles);
    this.setExport('createBackendProfile', createBackendProfile);
    this.setExport('activateBackendProfile', activateBackendProfile);
    this.setExport('deleteBackendProfile', deleteBackendProfile);
    this.setExport('exportBackendProfileQueue', exportBackendProfileQueue);
  }, { context, identifier: 'background/backend-profiles.js' });
  const storageMigrationsModule = new vm.SyntheticModule([
    'ensureStorageMigrationsComplete',
    'getStorageMigrationStatus',
    'resolveStorageMigrationEndpoint'
  ], function init() {
    this.setExport('ensureStorageMigrationsComplete', ensureStorageMigrationsComplete);
    this.setExport('getStorageMigrationStatus', getStorageMigrationStatus);
    this.setExport('resolveStorageMigrationEndpoint', resolveStorageMigrationEndpoint);
  }, { context, identifier: 'background/storage-migrations.js' });
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'background.js' });
  await module.link(async (specifier) => {
    const resolved = await resolveModule(specifier, context);
    if (resolved) return resolved;
    if (options.realSyncModule && specifier === './background/sync.js') return actualModules.sync;
    if (options.realContributionQueue && specifier === './background/contribution-queue.js') return actualModules['contribution-queue'];
    if ((options.realContributionQueue || options.realSyncModule) &&
        (specifier === './background/backend-profiles.js' || specifier === './backend-profiles.js')) return actualModules['backend-profiles'];
    if ((options.realContributionQueue || options.realSyncModule) &&
        (specifier === './background/storage-migrations.js' || specifier === './storage-migrations.js')) return actualModules['storage-migrations'];
    if ((options.realContributionQueue || options.realSyncModule) && specifier === './storage-mutation-coordinator.js') {
      return actualModules['storage-mutation-coordinator'];
    }
    if (specifier === './background/sync.js') {
      return new vm.SyntheticModule(Object.keys(syncModule), function init() {
        for (const [name, value] of Object.entries(syncModule)) this.setExport(name, value);
      }, { context, identifier: 'sync.js' });
    }
    if (specifier === './background/sync-listener.js') {
      syncListenerImports += 1;
      return new vm.SyntheticModule([], function init() {}, { context, identifier: 'sync-listener.js' });
    }
    if (specifier === './background/backend-profiles.js') {
      return profileModule;
    }
    if (specifier === './background/storage-migrations.js') return storageMigrationsModule;
    if (specifier === './background/contribution-queue.js') {
      return new vm.SyntheticModule(Object.keys(contributionQueue), function init() {
        for (const [name, value] of Object.entries(contributionQueue)) this.setExport(name, value);
      }, { context, identifier: 'contribution-queue.js' });
    }
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  assert.equal(typeof onConnect.listener, 'function');
  assert.equal(typeof onMessage.listener, 'function');
  return {
    alarmCalls,
    connect: onConnect.listener,
    install: async (details = { reason: 'install' }) => {
      assert.equal(typeof onInstalled.listener, 'function');
      await onInstalled.listener(details);
    },
    logs,
    actualSync: actualModules.sync?.namespace ?? null,
    lifecycleEvents,
    get legacyMigrationCalls() { return legacyMigrationCalls; },
    get profileMigrationCalls() { return profileMigrationCalls; },
    get syncListenerImports() { return syncListenerImports; },
    sendRuntimeMessage: onMessage.listener,
    startup: async () => {
      assert.equal(typeof onStartup.listener, 'function');
      await onStartup.listener();
    },
    storageCalls,
    storage,
    triggerAlarm: async (alarm) => {
      assert.equal(typeof onAlarm.listener, 'function');
      await onAlarm.listener(alarm);
    }
  };
}

export async function loadApiModule(fetchImpl, options = {}) {
  const logs = options.logs ?? [];
  const storageCalls = options.storageCalls ?? [];
  const storage = options.storage ?? {
    jwt: 'jwt-token',
    user: { userId: 'user-1' },
    api: { baseUrl: 'https://api.example.test' }
  };
  const localStorage = options.storageApi ?? {
    async get(keys) {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      storageCalls.push({ operation: 'get', keys: requestedKeys });
      return Object.fromEntries(requestedKeys.map((key) => [key, storage[key]]));
    },
    async set(values) {
      storageCalls.push({ operation: 'set', keys: Object.keys(values), values: structuredClone(values) });
      Object.assign(storage, values);
    },
    async remove(keys) {
      const removedKeys = Array.isArray(keys) ? keys : [keys];
      storageCalls.push({ operation: 'remove', keys: removedKeys });
      for (const key of removedKeys) delete storage[key];
    }
  };
  const context = vm.createContext({
    AbortController,
    console: createConsole(logs),
    crypto: options.crypto ?? crypto,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    structuredClone,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
      storage: {
        local: localStorage
      }
    }
  });
  const module = await loadRealApiModule(context);
  await module.evaluate();
  return module.namespace;
}

export function createPort() {
  const sentMessages = [];
  const onMessage = { listener: null };
  return {
    sentMessages,
    port: {
      name: 'subtitle-assistant-channel',
      sender: { tab: { id: 7 } },
      postMessage(message) { sentMessages.push(message); },
      disconnect() {},
      onDisconnect: { addListener() {} },
      onMessage: { addListener(listener) { onMessage.listener = listener; } }
    },
    send(message) {
      assert.equal(typeof onMessage.listener, 'function');
      onMessage.listener(message);
    }
  };
}

export async function waitForResponse(sentMessages, messageId) {
  for (let i = 0; i < 20; i += 1) {
    const found = sentMessages.find((message) => message.messageId === messageId);
    if (found) return found.response;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`No response for ${messageId}`);
}

export function netflixSender(overrides = {}) {
  return {
    id: 'subpal-extension-id',
    tab: { id: 7, url: 'https://www.netflix.com/watch/82147770' },
    url: 'https://www.netflix.com/watch/82147770',
    origin: 'https://www.netflix.com',
    ...overrides
  };
}

export async function sendRuntimeMessage(background, request, sender) {
  return await new Promise((resolve) => {
    const keepChannelOpen = background.sendRuntimeMessage(request, sender, resolve);
    if (keepChannelOpen !== true) setTimeout(() => resolve(undefined), 0);
  });
}

export async function loadRealContentTransport(background, sender = netflixSender()) {
  class TestCustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  }

  const window = new EventTarget();
  const portMessages = [];
  const runtimeMessages = [];
  const portMessageListeners = [];
  const portDisconnectListeners = [];
  const port = {
    name: 'subtitle-assistant-channel',
    sender,
    postMessage(message) {
      portMessages.push(message);
      backgroundPortListener(message);
    },
    disconnect() { for (const listener of portDisconnectListeners) listener(); },
    onDisconnect: { addListener(listener) { portDisconnectListeners.push(listener); } },
    onMessage: { addListener(listener) { portMessageListeners.push(listener); } }
  };
  let backgroundPortListener = null;
  const connectedPort = createPort();
  connectedPort.port.sender = sender;
  connectedPort.port.postMessage = (message) => {
    for (const listener of portMessageListeners) listener(message);
  };
  background.connect(connectedPort.port);
  backgroundPortListener = connectedPort.send;
  const failedTerminalMarker = {
    getAttribute(name) {
      const attributes = {
        'data-subpal-page-script-state': 'failed-terminal',
        'data-subpal-page-script-attempt': '2',
        'data-subpal-page-script-attempt-id': '00000000-0000-4000-8000-000000000002',
        'data-subpal-page-script-deadline': '0',
        'data-subpal-page-script-retry-not-before': ''
      };
      return attributes[name] ?? null;
    }
  };

  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    crypto,
    CustomEvent: TestCustomEvent,
    document: {
      createElement() { return {}; },
      querySelector(selector) {
        return selector === 'script[data-subpal-page-script-state]' ? failedTerminalMarker : null;
      },
      documentElement: { appendChild() {} },
      head: { appendChild() {} }
    },
    Event,
    EventTarget,
    Math,
    setTimeout,
    window,
    chrome: {
      runtime: {
        connect() { return port; },
        getURL(path) { return `chrome-extension://test/${path}`; },
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          const keepOpen = background.sendRuntimeMessage(message, sender, callback);
          if (keepOpen !== true && callback) setTimeout(() => callback(undefined), 0);
        }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const [resultSource, diagnosticsSource, transportsSource] = await Promise.all([
    readFile(new URL('../content/system/capabilities/result.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/private-transport-diagnostics.js', import.meta.url), 'utf8'),
    readFile(new URL('../content/system/capabilities/private-transports.js', import.meta.url), 'utf8')
  ]);
  const resultModule = new vm.SourceTextModule(resultSource, { context, identifier: 'content/system/capabilities/result.js' });
  const diagnosticsModule = new vm.SourceTextModule(diagnosticsSource, { context, identifier: 'content/system/capabilities/private-transport-diagnostics.js' });
  const transportsModule = new vm.SourceTextModule(transportsSource, { context, identifier: 'content/system/capabilities/private-transports.js' });
  await resultModule.link(() => { throw new Error('result.js should not import dependencies'); });
  await diagnosticsModule.link(() => { throw new Error('diagnostics should not import dependencies'); });
  await transportsModule.link((specifier) => {
    if (specifier === './result.js') return resultModule;
    if (specifier === './private-transport-diagnostics.js') return diagnosticsModule;
    throw new Error(`Unexpected private transport dependency: ${specifier}`);
  });
  await resultModule.evaluate();
  await diagnosticsModule.evaluate();
  await transportsModule.evaluate();
  const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  new vm.Script(contentSource, {
    filename: 'content.js',
    importModuleDynamically: async (specifier) => {
      if (specifier.endsWith('capabilities/private-transports.js')) return transportsModule;
      throw new Error(`Unexpected content import: ${specifier}`);
    }
  }).runInContext(context);
  const controllerSource = await readFile(new URL('../content/core/endscreen-task-controller.js', import.meta.url), 'utf8');
  const controllerModule = new vm.SourceTextModule(controllerSource, { context, identifier: 'content/core/endscreen-task-controller.js' });
  await controllerModule.link(() => { throw new Error('endscreen-task-controller.js should not import dependencies'); });
  await controllerModule.evaluate();
  const taskClientSource = await readFile(new URL('../content/system/crowdsourcing-task-client.js', import.meta.url), 'utf8');
  const taskClientModule = new vm.SourceTextModule(taskClientSource, { context, identifier: 'content/system/crowdsourcing-task-client.js' });
  await taskClientModule.link((specifier) => {
    assert.equal(specifier, './capabilities/private-transports.js');
    return transportsModule;
  });
  await taskClientModule.evaluate();
  await Promise.resolve();
  await Promise.resolve();

  return {
    EndscreenTaskController: controllerModule.namespace.EndscreenTaskController,
    sendMessage: taskClientModule.namespace.requestCrowdsourcingTasks,
    requestPrivateSubtitle(query) {
      const transport = transportsModule.namespace.createPortTransport({ connect: () => port });
      transport.start();
      return transport.request(transportsModule.namespace.createEnvelope({
        requestId: 'private-subtitle-disconnect-test',
        kind: 'subtitle-query',
        payload: { type: 'SUBTITLE_QUERY', query }
      })).then((result) => {
        transport.stop();
        if (!result.ok) throw transportsModule.namespace.toCompatibilityError(result);
        return result.value;
      });
    },
    disconnectContentPort() { port.disconnect(); },
    portMessages,
    runtimeMessages,
    window,
    dispatchPublicEvent(type, detail) {
      window.dispatchEvent(new TestCustomEvent(type, { detail }));
    }
  };
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
