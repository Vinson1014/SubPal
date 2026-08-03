import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const PAGE_SCRIPT_READY_EVENT = 'subpal-page-script-ready';
const PAGE_SCRIPT_READY_REQUEST_EVENT = 'subpal-request-page-script-ready';
const PAGE_SCRIPT_MARKER_SELECTOR = 'script[data-subpal-page-script-state]';

async function settleMicrotasks() {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

class FakeScheduler {
  constructor(now = 10_000) {
    this.now = now;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(owner, callback, delay = 0) {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { owner, callback, at: this.now + Math.max(0, Number(delay) || 0) });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  dispose(owner) {
    for (const [id, task] of this.tasks) {
      if (task.owner === owner) this.tasks.delete(id);
    }
  }

  pending(owner) {
    return [...this.tasks.values()].filter(task => task.owner === owner).length;
  }

  async advanceBy(duration) {
    const target = this.now + duration;
    while (true) {
      await settleMicrotasks();
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
    await settleMicrotasks();
  }
}

class SharedEventBus {
  constructor() {
    this.listeners = new Map();
  }

  add(owner, type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ owner, listener });
    this.listeners.set(type, listeners);
  }

  remove(owner, type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter(entry => entry.owner !== owner || entry.listener !== listener));
  }

  dispatch(event) {
    for (const { listener } of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return true;
  }

  dispose(owner) {
    for (const [type, listeners] of this.listeners) {
      this.listeners.set(type, listeners.filter(entry => entry.owner !== owner));
    }
  }

  count(type, owner = null) {
    return (this.listeners.get(type) ?? []).filter(entry => owner === null || entry.owner === owner).length;
  }
}

class ScriptElement {
  constructor(owner, dom) {
    this.owner = owner;
    this.dom = dom;
    this.attributes = new Map();
    this.parentNode = null;
    this.type = '';
    this.src = '';
    this.onload = null;
    this.onerror = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  remove() {
    this.dom.remove(this);
  }

  replaceWith(node) {
    this.dom.replace(this, node);
  }
}

function createContentStartupHarness({ pageMode = 'loaded-unready' } = {}) {
  const scheduler = new FakeScheduler();
  const bus = new SharedEventBus();
  const contextStates = new Map();
  const uuidCalls = [];
  const readinessRequests = [];
  const netflixAppends = [];
  const nodes = [];
  let uuidCounter = 0;
  let responderEnabled = pageMode === 'ready';

  const marker = () => nodes.find(node => node.getAttribute('data-subpal-page-script-state') !== null) ?? null;
  const remove = (node) => {
    const index = nodes.indexOf(node);
    if (index >= 0) nodes.splice(index, 1);
    node.parentNode = null;
  };
  const append = (node) => {
    node.parentNode = parent;
    nodes.push(node);
    const state = contextStates.get(node.owner);
    if (node.src.endsWith('/netflix-page-script.js')) {
      netflixAppends.push(node);
      if (pageMode !== 'manual') node.onload?.();
    } else if (node.src.endsWith('/content/index.js')) {
      state.mainAttempts += 1;
      if (state.configInitialized) state.mainInitialized += 1;
      node.onload?.();
    }
    return node;
  };
  const parent = {
    appendChild(node) {
      if (node.parentNode) remove(node);
      return append(node);
    },
    removeChild(node) {
      remove(node);
      return node;
    }
  };
  const dom = {
    remove,
    replace(current, replacement) {
      const index = nodes.indexOf(current);
      assert.notEqual(index, -1);
      current.parentNode = null;
      nodes.splice(index, 1);
      append(replacement);
    }
  };

  bus.add('harness', PAGE_SCRIPT_READY_REQUEST_EVENT, (event) => {
    readinessRequests.push(event.detail);
    if (!responderEnabled) return;
    bus.dispatch(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
      detail: { ...event.detail, readyAt: scheduler.now }
    }));
  });

  async function createRuntime(owner, { config = 'resolve' } = {}) {
    const state = {
      configAssigned: false,
      configInitialized: false,
      mainAttempts: 0,
      mainInitialized: 0,
      isolatedAttempts: 0,
      isolatedInitialized: 0
    };
    contextStates.set(owner, state);

    const window = {
      location: { pathname: '/watch/82147770' },
      addEventListener: (type, listener) => bus.add(owner, type, listener),
      removeEventListener: (type, listener) => bus.remove(owner, type, listener),
      dispatchEvent: event => bus.dispatch(event),
      setTimeout: (callback, delay) => scheduler.setTimeout(owner, callback, delay),
      clearTimeout: id => scheduler.clearTimeout(id)
    };
    const document = {
      createElement(tagName) {
        assert.equal(tagName, 'script');
        return new ScriptElement(owner, dom);
      },
      querySelector(selector) {
        assert.equal(selector, PAGE_SCRIPT_MARKER_SELECTOR);
        return marker();
      },
      head: parent,
      documentElement: parent
    };
    const SchedulerDate = class extends Date {
      constructor(...args) {
        super(...(args.length > 0 ? args : [scheduler.now]));
      }
      static now() { return scheduler.now; }
    };
    const context = vm.createContext({
      console: { log() {}, warn() {}, error() {} },
      Event,
      CustomEvent,
      window,
      document,
      Date: SchedulerDate,
      setTimeout: window.setTimeout,
      clearTimeout: window.clearTimeout,
      crypto: {
        randomUUID() {
          uuidCounter += 1;
          const value = `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
          uuidCalls.push({ owner, value });
          return value;
        }
      },
      chrome: {
        runtime: {
          connect() {
            return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
          },
          getURL(path) { return `chrome-extension://test/${path}`; }
        },
        storage: { local: { async get() { return {}; } } }
      }
    });

    const configModule = new vm.SyntheticModule(['ConfigManager'], function initializeConfigModule() {
      this.setExport('ConfigManager', class ConfigManager {
        constructor() {
          state.configAssigned = true;
          this.initialized = false;
        }
        async initialize() {
          if (config === 'initialize-fail') throw new Error('config initialization failed');
          this.initialized = true;
          state.configInitialized = true;
        }
        get() { return false; }
        subscribe() {}
      });
    }, { context, identifier: `${owner}/config-manager.js` });
    const schemaModule = new vm.SyntheticModule(['getAllConfigKeys'], function initializeSchemaModule() {
      this.setExport('getAllConfigKeys', () => {
        if (config === 'post-assignment-fail') throw new Error('config subscription failed');
        return [];
      });
    }, { context, identifier: `${owner}/config-schema.js` });
    const messagingModule = new vm.SyntheticModule(['initMessaging'], function initializeMessagingModule() {
      this.setExport('initMessaging', async () => {});
    }, { context, identifier: `${owner}/messaging.js` });
    const isolatedModule = new vm.SyntheticModule(['startIsolatedEndscreenTasks'], function initializeIsolatedModule() {
      this.setExport('startIsolatedEndscreenTasks', async (manager) => {
        state.isolatedAttempts += 1;
        if (manager?.initialized) state.isolatedInitialized += 1;
      });
    }, { context, identifier: `${owner}/isolated-endscreen-tasks.js` });
    const playbackModule = new vm.SyntheticModule(['playbackContextManager'], function initializePlaybackModule() {
      this.setExport('playbackContextManager', {});
    }, { context, identifier: `${owner}/playback-context-manager.js` });
    for (const module of [configModule, schemaModule, messagingModule, isolatedModule, playbackModule]) {
      await module.link(() => { throw new Error('Unexpected static import'); });
      await module.evaluate();
    }
    const privateTransportsModule = await createPrivateTransportStub(context);

    const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
    const script = new vm.Script(source, {
      importModuleDynamically: async (specifier) => {
        if (specifier.endsWith('config-manager.js')) {
          if (config === 'import-fail') throw new Error('config import failed');
          return configModule;
        }
        if (specifier.endsWith('config-schema.js')) return schemaModule;
        if (specifier.endsWith('messaging.js')) return messagingModule;
        if (specifier.endsWith('isolated-endscreen-tasks.js')) return isolatedModule;
        if (specifier.endsWith('playback-context-manager.js')) return playbackModule;
        if (specifier.endsWith('capabilities/private-transports.js')) return privateTransportsModule;
        throw new Error(`Unexpected import: ${specifier}`);
      }
    });
    script.runInContext(context);
    await settleMicrotasks();
    return { owner, context, state, window };
  }

  return {
    scheduler,
    bus,
    contextStates,
    uuidCalls,
    readinessRequests,
    netflixAppends,
    marker,
    createRuntime,
    enableResponder() { responderEnabled = true; },
    dispose(owner) {
      scheduler.dispose(owner);
      bus.dispose(owner);
    }
  };
}

let compatibilityUuidCounter = 1000;

async function createPrivateTransportStub(context, { onRequest = () => {} } = {}) {
  const module = new vm.SyntheticModule([
    'PRIVATE_PROTOCOL_VERSION', 'buildSafeDiagnostic', 'createDomTransport', 'createEnvelope', 'createPageTransport', 'createPortTransport', 'toCompatibilityError'
  ], function initializePrivateTransports() {
    const disconnected = { ok: false, error: { kind: 'disconnected', code: 'background-port-disconnected', retryable: true } };
    const requestTransport = () => ({
      request: async (request) => {
        onRequest(request);
        return disconnected;
      },
      pendingCount: () => 0
    });
    this.setExport('PRIVATE_PROTOCOL_VERSION', 1);
    this.setExport('buildSafeDiagnostic', () => ({}));
    this.setExport('toCompatibilityError', () => new Error('transport-failed'));
    this.setExport('createEnvelope', ({ requestId, kind, payload, context: contextValue }) => ({ protocolVersion: 1, requestId, kind, payload, ...(contextValue === undefined ? {} : { context: contextValue }) }));
    this.setExport('createDomTransport', requestTransport);
    this.setExport('createPageTransport', requestTransport);
    this.setExport('createPortTransport', ({ connect }) => {
      let port = null;
      return { start() { if (!port) port = connect(); return port; }, request: async () => disconnected, pendingCount: () => 0 };
    });
  }, { context, identifier: 'content/system/capabilities/private-transports.js' });
  await module.link(() => { throw new Error('Unexpected private transport dependency'); });
  await module.evaluate();
  return module;
}

function createCompatibilityCrypto() {
  return {
    randomUUID() {
      compatibilityUuidCounter += 1;
      return `00000000-0000-4000-8000-${String(compatibilityUuidCounter).padStart(12, '0')}`;
    }
  };
}

function createReadinessDocument(window, { onNetflixAppend, onMainAppend } = {}) {
  let marker = null;
  let responderInstalled = false;
  const activateResponder = () => {
    if (responderInstalled) return;
    responderInstalled = true;
    window.addEventListener(PAGE_SCRIPT_READY_REQUEST_EVENT, (event) => {
      window.dispatchEvent(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
        detail: { ...event.detail, readyAt: Date.now() }
      }));
    });
  };
  const parent = {
    appendChild(script) {
      script.parentNode = parent;
      if (script.src.endsWith('/netflix-page-script.js')) {
        marker = script;
        if (onNetflixAppend) onNetflixAppend(script, activateResponder);
        else {
          activateResponder();
          script.onload?.();
        }
      } else if (script.src.endsWith('/content/index.js')) {
        onMainAppend?.(script);
        script.onload?.();
      }
      return script;
    },
    removeChild(script) {
      if (marker === script) marker = null;
      script.parentNode = null;
      return script;
    }
  };
  return {
    createElement() {
      const attributes = new Map();
      const script = {
        src: '', type: '', parentNode: null,
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        remove() { parent.removeChild(script); },
        replaceWith(replacement) {
          if (marker === script) marker = null;
          parent.appendChild(replacement);
          script.parentNode = null;
        }
      };
      return script;
    },
    querySelector(selector) {
      assert.equal(selector, PAGE_SCRIPT_MARKER_SELECTOR);
      return marker;
    },
    head: parent,
    documentElement: parent
  };
}

test('Given two isolated globals and one DOM When page readiness is probed Then they join one physical UUID and accept only an in-deadline response with both matching IDs', async () => {
  const h = createContentStartupHarness();
  const first = await h.createRuntime('isolated-a');
  const sharedDeadline = Number(h.marker().getAttribute('data-subpal-page-script-deadline'));
  await h.scheduler.advanceBy(100);
  const second = await h.createRuntime('isolated-b');

  const marker = h.marker();
  assert.ok(marker, 'one shared script marker must exist');
  assert.equal(h.netflixAppends.length, 1, 'concurrent isolated contexts must append one physical script');
  assert.equal(marker.getAttribute('data-subpal-page-script-state'), 'loaded');
  assert.equal(marker.getAttribute('data-subpal-page-script-attempt'), '1');
  assert.match(marker.getAttribute('data-subpal-page-script-attempt-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(marker.getAttribute('data-subpal-page-script-retry-not-before'), '');

  const attemptId = marker.getAttribute('data-subpal-page-script-attempt-id');
  const probeIds = new Set(h.readinessRequests.map(request => request.probeId));
  assert.equal(probeIds.size, 2, 'each isolated context must retain one distinct local probe UUID');
  assert.equal(h.uuidCalls.length, 3, 'one physical UUID plus two local probe UUIDs are expected');
  assert.equal(h.bus.count(PAGE_SCRIPT_READY_EVENT), 2, 'independent contexts must retain separate readiness listeners');
  assert.equal(h.readinessRequests.every(request => request.deadline === sharedDeadline), true, 'late joiners must use the remaining marker deadline');

  const [firstProbe] = h.readinessRequests;
  h.bus.dispatch(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
    detail: { ...firstProbe, probeId: '00000000-0000-4000-8000-999999999999', readyAt: h.scheduler.now }
  }));
  h.bus.dispatch(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
    detail: { ...firstProbe, attemptId: '00000000-0000-4000-8000-999999999998', readyAt: h.scheduler.now }
  }));
  h.bus.dispatch(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
    detail: { ...firstProbe, readyAt: Number(firstProbe.deadline) + 1 }
  }));
  assert.equal(marker.getAttribute('data-subpal-page-script-state'), 'loaded', 'mismatched or out-of-clock responses must fail closed');

  h.enableResponder();
  await h.scheduler.advanceBy(50);

  assert.equal(h.readinessRequests.length >= 3, true, 'the 50 ms tick must reread and dispatch another correlated probe');
  assert.equal(attemptId, marker.getAttribute('data-subpal-page-script-attempt-id'));
  assert.equal(marker.getAttribute('data-subpal-page-script-state'), 'ready');
  assert.equal(first.state.mainInitialized, 1);
  assert.equal(first.state.isolatedInitialized, 1);
  assert.equal(second.state.mainInitialized, 1);
  assert.equal(second.state.isolatedInitialized, 1);
  assert.equal(h.bus.count(PAGE_SCRIPT_READY_EVENT), 0, 'all local readiness listeners must be removed');
  assert.equal(h.scheduler.pending('isolated-a'), 0, 'first context readiness timers must be cleared');
  assert.equal(h.scheduler.pending('isolated-b'), 0, 'second context readiness timers must be cleared');
});

test('Given two observers and an attempt-one error When the retry claimant disappears Then the remaining observer performs the one retry at 500 ms', async () => {
  const h = createContentStartupHarness({ pageMode: 'manual' });
  const first = await h.createRuntime('retry-a');
  const second = await h.createRuntime('retry-b');
  assert.equal(h.marker().getAttribute('data-subpal-page-script-state'), 'loading');
  const firstAttempt = h.netflixAppends[0];
  const firstAttemptId = h.marker().getAttribute('data-subpal-page-script-attempt-id');

  firstAttempt.onerror?.(new Error('first load failed'));
  assert.equal(h.marker().getAttribute('data-subpal-page-script-state'), 'error');
  await h.scheduler.advanceBy(50);

  const retryNotBefore = Number(h.marker().getAttribute('data-subpal-page-script-retry-not-before'));
  assert.equal(h.marker().getAttribute('data-subpal-page-script-state'), 'retry-claimed');
  assert.equal(retryNotBefore, h.scheduler.now + 500);
  h.dispose(first.owner);

  await h.scheduler.advanceBy(499);
  assert.equal(h.netflixAppends.length, 1, 'retry must not append before retry-not-before');
  await h.scheduler.advanceBy(1);

  const secondAttempt = h.marker();
  assert.equal(h.netflixAppends.length, 2);
  assert.equal(secondAttempt.getAttribute('data-subpal-page-script-attempt'), '2');
  assert.notEqual(secondAttempt.getAttribute('data-subpal-page-script-attempt-id'), firstAttemptId);
  firstAttempt.onload?.();
  assert.equal(secondAttempt.getAttribute('data-subpal-page-script-state'), 'loading', 'a stale attempt-one callback must not mutate attempt two');
  secondAttempt.onload?.();
  h.enableResponder();
  await h.scheduler.advanceBy(50);

  assert.equal(secondAttempt.getAttribute('data-subpal-page-script-state'), 'ready');
  assert.equal(first.state.mainAttempts, 0, 'disposed claimant must not continue startup');
  assert.equal(second.state.mainInitialized, 1);
  assert.equal(second.state.isolatedInitialized, 1);
  assert.equal(h.bus.count(PAGE_SCRIPT_READY_EVENT), 0);
  assert.equal(h.scheduler.pending('retry-b'), 0);
});

test('Given both physical attempts error When later callers and ready events arrive Then the terminal sentinel blocks a third attempt and dependent startup', async () => {
  const h = createContentStartupHarness({ pageMode: 'manual' });
  const runtime = await h.createRuntime('two-errors');

  h.netflixAppends[0].onerror?.(new Error('attempt one failed'));
  await h.scheduler.advanceBy(50);
  await h.scheduler.advanceBy(500);
  const secondAttempt = h.marker();
  secondAttempt.onerror?.(new Error('attempt two failed'));
  await h.scheduler.advanceBy(50);

  assert.equal(secondAttempt.getAttribute('data-subpal-page-script-state'), 'failed-terminal');
  assert.equal(h.netflixAppends.length, 2);
  assert.equal(runtime.state.mainAttempts, 0);
  assert.equal(runtime.state.isolatedAttempts, 0);
  assert.equal(h.bus.count(PAGE_SCRIPT_READY_EVENT), 0);
  assert.equal(h.scheduler.pending(runtime.owner), 0);

  const latestProbe = h.readinessRequests.at(-1);
  h.bus.dispatch(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
    detail: { ...latestProbe, readyAt: h.scheduler.now }
  }));
  await h.scheduler.advanceBy(1000);

  assert.equal(h.netflixAppends.length, 2, 'terminal failure must persist until document reload');
  assert.equal(secondAttempt.getAttribute('data-subpal-page-script-state'), 'failed-terminal');
  assert.equal(runtime.state.mainAttempts, 0);
  assert.equal(runtime.state.isolatedAttempts, 0);

  const reloaded = createContentStartupHarness({ pageMode: 'ready' });
  const reloadedRuntime = await reloaded.createRuntime('after-reload');
  await settleMicrotasks();
  assert.equal(reloaded.netflixAppends.length, 1, 'a fresh document must begin a new bounded sequence');
  assert.equal(reloaded.marker().getAttribute('data-subpal-page-script-attempt'), '1');
  assert.equal(reloaded.marker().getAttribute('data-subpal-page-script-state'), 'ready');
  assert.equal(reloadedRuntime.state.mainInitialized, 1);
  assert.equal(reloadedRuntime.state.isolatedInitialized, 1);
});

test('Given a loaded but unready page script When its marker deadline arrives Then it fails terminal and ignores a matching late response', async () => {
  const h = createContentStartupHarness();
  const runtime = await h.createRuntime('deadline');
  const marker = h.marker();
  const deadline = Number(marker.getAttribute('data-subpal-page-script-deadline'));

  await h.scheduler.advanceBy(deadline - h.scheduler.now);
  assert.equal(marker.getAttribute('data-subpal-page-script-state'), 'failed-terminal');
  assert.equal(runtime.state.mainAttempts, 0);
  assert.equal(runtime.state.isolatedAttempts, 0);

  const latestProbe = h.readinessRequests.at(-1);
  h.bus.dispatch(new CustomEvent(PAGE_SCRIPT_READY_EVENT, {
    detail: { ...latestProbe, readyAt: deadline }
  }));
  assert.equal(marker.getAttribute('data-subpal-page-script-state'), 'failed-terminal');
  assert.equal(h.bus.count(PAGE_SCRIPT_READY_EVENT), 0);
  assert.equal(h.scheduler.pending(runtime.owner), 0);
});

test('Given page readiness When startup branches settle Then each fallback row reports initialized and not-initialized owners rather than append-only evidence', async (t) => {
  const rows = [
    {
      name: 'normal config initialization', options: {},
      expected: { configAssigned: true, configInitialized: true, mainAttempts: 1, mainInitialized: 1, isolatedAttempts: 1, isolatedInitialized: 1 }
    },
    {
      name: 'config initialization failure', options: { config: 'initialize-fail' },
      expected: { configAssigned: true, configInitialized: false, mainAttempts: 1, mainInitialized: 0, isolatedAttempts: 0, isolatedInitialized: 0 }
    },
    {
      name: 'outer error before config assignment', options: { config: 'import-fail' },
      expected: { configAssigned: false, configInitialized: false, mainAttempts: 1, mainInitialized: 0, isolatedAttempts: 0, isolatedInitialized: 0 }
    },
    {
      name: 'outer error after config assignment', options: { config: 'post-assignment-fail' },
      expected: { configAssigned: true, configInitialized: true, mainAttempts: 1, mainInitialized: 1, isolatedAttempts: 1, isolatedInitialized: 1 }
    }
  ];

  for (const row of rows) {
    await t.test(row.name, async () => {
      const h = createContentStartupHarness({ pageMode: 'ready' });
      const runtime = await h.createRuntime(row.name, row.options);
      await settleMicrotasks();
      assert.deepEqual(runtime.state, row.expected);

      assert.equal(runtime.state.mainAttempts, row.expected.mainAttempts);
      assert.equal(runtime.state.isolatedAttempts, row.expected.isolatedAttempts);
      assert.equal(h.netflixAppends.length, 1);
    });
  }
});

test('Given the page-script readiness responder When its source is inspected Then the complete public object is assigned before the correlated listener exists', async () => {
  const source = await readFile(new URL('../netflix-page-script.js', import.meta.url), 'utf8');
  const assignmentIndex = source.lastIndexOf('window.subpalPageScript = {');
  const responderIndex = source.lastIndexOf('window.addEventListener(PAGE_SCRIPT_READY_REQUEST_EVENT');

  assert.notEqual(assignmentIndex, -1);
  assert.equal(responderIndex > assignmentIndex, true, 'readiness must be unobservable before the complete public object assignment');
  assert.doesNotMatch(source.slice(0, assignmentIndex), /dispatchEvent\(new CustomEvent\(PAGE_SCRIPT_READY_EVENT/);
  assert.match(source.slice(responderIndex), /detail: \{ attemptId, probeId, deadline, readyAt: Date\.now\(\) \}/);
});

test('Given content startup When managers finish Then content index is injected as a MAIN-world module and isolated tasks bootstrap separately', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.match(source, /script\.type = 'module'/);
  assert.match(source, /script\.src = chrome\.runtime\.getURL\('content\/index\.js'\)/);
  assert.doesNotMatch(source, /import\(chrome\.runtime\.getURL\('content\/index\.js'\)\)/);
  assert.match(source, /await startIsolatedEndscreenTasksOnce\(\)/);
  assert.match(source, /startIsolatedEndscreenTasks\(configManager, playbackContextManager\)/);
});

test('Given public page events When forged task requests are dispatched Then content exposes no task bridge', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /postMessage[\s\S]*GET_CROWDSOURCING_TASKS/);
  assert.doesNotMatch(source, /GET_CROWDSOURCING_TASKS/);
});

test('Given production content listener after manager initialization When a public task event is forged Then it emits no port message and one terminal denial', async () => {
  const portMessages = [];
  const responses = [];
  const window = new EventTarget();
  window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));
  const document = createReadinessDocument(window);
  const context = vm.createContext({
    console, Event, EventTarget, CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout, crypto: createCompatibilityCrypto(),
    chrome: {
      runtime: { connect() { return { postMessage(message) { portMessages.push(message); }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('messaging.js')) return import('data:text/javascript,export const initMessaging = async () => {}');
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return import('data:text/javascript,export const startIsolatedEndscreenTasks = async () => {}');
    if (specifier.endsWith('playback-context-manager.js')) return import('data:text/javascript,export const playbackContextManager = { initialize: async () => {}, getCurrentContext: () => null }');
    if (specifier.endsWith('capabilities/private-transports.js')) return createPrivateTransportStub(context);
    throw new Error(`Unexpected import: ${specifier}`);
  } });
  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  window.dispatchEvent(new context.CustomEvent('messageToContentScript', { detail: { messageId: 'forged', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-1', languageCode: 'zh-TW', limit: 5 } } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(portMessages.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    messageId: 'forged',
    response: { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } }
  }]);
});

test('Given production content listener after manager initialization When a legacy RAW event is forged Then it emits no internal or background event and one terminal denial', async () => {
  const backgroundRequests = [];
  const internalEvents = [];
  const responses = [];
  const window = new EventTarget();
  window.addEventListener('messageFromContentScript', (event) => internalEvents.push(event.detail));
  window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));
  const document = createReadinessDocument(window);
  const context = vm.createContext({
    console, Event, EventTarget, CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout, crypto: createCompatibilityCrypto(),
    chrome: {
      runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const privateTransportsModule = await createPrivateTransportStub(context, {
    onRequest(request) { backgroundRequests.push(request); }
  });
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('messaging.js')) return import('data:text/javascript,export const initMessaging = async () => {}');
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return import('data:text/javascript,export const startIsolatedEndscreenTasks = async () => {}');
    if (specifier.endsWith('playback-context-manager.js')) return import('data:text/javascript,export const playbackContextManager = { initialize: async () => {}, getCurrentContext: () => null }');
    if (specifier.endsWith('capabilities/private-transports.js')) return privateTransportsModule;
    throw new Error(`Unexpected import: ${specifier}`);
  } });
  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  window.dispatchEvent(new context.CustomEvent('messageToContentScript', {
    detail: { messageId: 'forged-raw', message: { type: 'RAW_TTML_INTERCEPTED', cacheKey: 'forged' } }
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(internalEvents, []);
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    messageId: 'forged-raw',
    response: { ok: false, error: { kind: 'forbidden', code: 'page-ingress-variant', retryable: false } }
  }]);
  assert.deepEqual(backgroundRequests, []);
});

test('Given cold page-script injection When isolated PlaybackContext starts Then readiness arrives before its first snapshot request', async () => {
  let pageReady = false;
  let firstSnapshots = 0;
  const window = new EventTarget();
  const document = createReadinessDocument(window, {
    onNetflixAppend(script, activateResponder) {
      setTimeout(() => {
        pageReady = true;
        activateResponder();
        script.onload?.();
      }, 0);
    }
  });
  const playbackContextManager = {
    async initialize() {
      if (pageReady) firstSnapshots += 1;
    },
    getCurrentContext: () => null
  };
  const context = vm.createContext({
    console, Event, EventTarget,
    CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout, crypto: createCompatibilityCrypto(),
    chrome: {
      runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  context.playbackContextManager = playbackContextManager;
  const messagingModule = new vm.SyntheticModule(['initMessaging'], function initializeMessagingModule() {
    this.setExport('initMessaging', async () => {});
  }, { context, identifier: 'content/system/messaging.js' });
  await messagingModule.link(() => { throw new Error('Unexpected messaging module import'); });
  await messagingModule.evaluate();
  const isolatedModule = new vm.SourceTextModule(
    'export const startIsolatedEndscreenTasks = async (_config, manager) => manager.initialize()',
    { context }
  );
  const playbackModule = new vm.SourceTextModule(
    'export const playbackContextManager = globalThis.playbackContextManager',
    { context }
  );
  await isolatedModule.link(() => { throw new Error('Unexpected isolated module import'); });
  await playbackModule.link(() => { throw new Error('Unexpected playback module import'); });
  await isolatedModule.evaluate();
  await playbackModule.evaluate();
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('messaging.js')) return messagingModule;
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return isolatedModule;
    if (specifier.endsWith('playback-context-manager.js')) return playbackModule;
    if (specifier.endsWith('capabilities/private-transports.js')) return createPrivateTransportStub(context);
    throw new Error(`Unexpected import: ${specifier}`);
  } });

  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(firstSnapshots, 1);
});

test('Given cold startup with page readiness delayed beyond the legacy timeout When MAIN startup runs Then isolated tasks wait for actual readiness', async () => {
  let mainModuleInjections = 0;
  let isolatedStarts = 0;
  const window = new EventTarget();
  const document = createReadinessDocument(window, {
    onMainAppend() { mainModuleInjections += 1; },
    onNetflixAppend(script, activateResponder) {
      setTimeout(() => {
        activateResponder();
        script.onload?.();
      }, 2200);
    }
  });
  const context = vm.createContext({
    console, Event, EventTarget,
    CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout, crypto: createCompatibilityCrypto(),
    chrome: {
      runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const messagingModule = new vm.SyntheticModule(['initMessaging'], function initializeMessagingModule() {
    this.setExport('initMessaging', async () => {});
  }, { context, identifier: 'content/system/messaging.js' });
  await messagingModule.link(() => { throw new Error('Unexpected messaging module import'); });
  await messagingModule.evaluate();
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('messaging.js')) return messagingModule;
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return isolatedModule;
    if (specifier.endsWith('playback-context-manager.js')) return playbackModule;
    if (specifier.endsWith('capabilities/private-transports.js')) return createPrivateTransportStub(context);
    throw new Error(`Unexpected import: ${specifier}`);
  } });
  Object.defineProperty(context, 'isolatedStarts', {
    get: () => isolatedStarts,
    set: value => { isolatedStarts = value; }
  });
  const isolatedModule = new vm.SourceTextModule(
    'export const startIsolatedEndscreenTasks = async () => { globalThis.isolatedStarts += 1 }',
    { context }
  );
  await isolatedModule.link(() => { throw new Error('Unexpected isolated module import'); });
  await isolatedModule.evaluate();
  const playbackModule = new vm.SourceTextModule(
    'export const playbackContextManager = {}',
    { context }
  );
  await playbackModule.link(() => { throw new Error('Unexpected playback module import'); });
  await playbackModule.evaluate();

  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 1900));

  assert.equal(mainModuleInjections, 0, 'MAIN subtitle startup must wait for bounded page readiness');
  assert.equal(isolatedStarts, 0, 'isolated tasks must not start while the page script is unready');

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(isolatedStarts, 1, 'isolated tasks should start once actual readiness arrives');
});

test('Given isolated startup with its own messaging module When content forwards VIDEO_ID_CHANGED Then the isolated handler runs exactly once', async () => {
  let isolatedVideoIdChanges = 0;
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    location: { pathname: '/watch/81234567' }
  };
  const document = createReadinessDocument(window);
  const context = vm.createContext({
    console, Event,
    CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, document, setTimeout, clearTimeout, crypto: createCompatibilityCrypto(),
    chrome: {
      runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  Object.defineProperty(context, 'isolatedVideoIdChanges', {
    get: () => isolatedVideoIdChanges,
    set: value => { isolatedVideoIdChanges = value; }
  });

  const configModule = new vm.SyntheticModule(['configBridge'], function initializeConfigModule() {
    this.setExport('configBridge', {
      isInitialized: true,
      get: () => false,
      subscribe() {}
    });
  }, { context, identifier: 'content/system/config/config-bridge.js' });
  await configModule.link(() => { throw new Error('Unexpected ConfigBridge import'); });
  await configModule.evaluate();

  const messagingSource = await readFile(new URL('../content/system/messaging.js', import.meta.url), 'utf8');
  const isolatedMessagingModule = new vm.SourceTextModule(messagingSource, {
    context,
    identifier: 'content/system/messaging.js',
    importModuleDynamically: async (specifier) => {
      if (specifier.endsWith('config/config-bridge.js')) return configModule;
      throw new Error(`Unexpected messaging import: ${specifier}`);
    }
  });
  const privateTransportsModule = await createPrivateTransportStub(context);
  await isolatedMessagingModule.link((specifier) => {
    assert.equal(specifier, './capabilities/private-transports.js');
    return privateTransportsModule;
  });
  await isolatedMessagingModule.evaluate();
  assert.equal(window.listenerCount('messageFromContentScript'), 0);

  const isolatedModule = new vm.SourceTextModule(
    "import { registerInternalEventHandler } from './messaging.js'; export const startIsolatedEndscreenTasks = async () => { registerInternalEventHandler('VIDEO_ID_CHANGED', () => { globalThis.isolatedVideoIdChanges += 1; }); }",
    { context, identifier: 'content/system/isolated-endscreen-tasks.js' }
  );
  await isolatedModule.link((specifier) => {
    if (specifier === './messaging.js') return isolatedMessagingModule;
    throw new Error(`Unexpected isolated task import: ${specifier}`);
  });
  await isolatedModule.evaluate();
  const playbackModule = new vm.SourceTextModule(
    'export const playbackContextManager = { initialize: async () => {}, getCurrentContext: () => null }',
    { context, identifier: 'content/core/playback-context-manager.js' }
  );
  await playbackModule.link(() => { throw new Error('Unexpected playback module import'); });
  await playbackModule.evaluate();

  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('messaging.js')) return isolatedMessagingModule;
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return isolatedModule;
    if (specifier.endsWith('playback-context-manager.js')) return playbackModule;
    if (specifier.endsWith('capabilities/private-transports.js')) return privateTransportsModule;
    throw new Error(`Unexpected import: ${specifier}`);
  } });

  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  window.dispatchEvent(new context.CustomEvent('messageFromContentScript', {
    detail: { messageId: 'route-change-1', message: { type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321' } }
  }));

  assert.equal(isolatedVideoIdChanges, 1, 'isolated VIDEO_ID_CHANGED handler should receive the bridge event exactly once');
  assert.equal(window.listenerCount('messageFromContentScript'), 1);
});
