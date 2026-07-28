import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const rootUrl = new URL('../', import.meta.url);

function createContext() {
  const appendAttempts = [];
  const window = {
    location: { hostname: 'www.netflix.com' },
    subpalPageScript: {}
  };
  const document = {
    head: { appendChild(node) { appendAttempts.push(node); } },
    documentElement: { appendChild(node) { appendAttempts.push(node); } }
  };
  const context = vm.createContext({
    console: { error() {}, log() {}, warn() {} },
    Date,
    Promise,
    clearTimeout() {},
    setTimeout() { return 0; },
    setInterval() { return 0; },
    clearInterval() {},
    window,
    document
  });

  return { appendAttempts, context };
}

async function createModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Unexpected synthetic dependency'); });
  await module.evaluate();
  return module;
}

async function loadInitializationManager({ waitForPageScript }) {
  const { appendAttempts, context } = createContext();
  let injectionRequests = 0;
  const messaging = await createModule(context, 'content/system/messaging.js', {
    sendMessage: async () => ({}),
    waitForPageScript,
    requestPageScriptInjection: async () => {
      injectionRequests += 1;
      appendAttempts.push('legacy-request');
    }
  });
  const videoInfo = await createModule(context, 'content/core/video-info.js', {
    getVideoId: () => '81234567'
  });
  const source = await readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/system/initialization-manager.js' });
  await module.link((specifier) => specifier === './messaging.js' ? messaging : videoInfo);
  await module.evaluate();

  return {
    appendAttempts,
    injectionRequests: () => injectionRequests,
    manager: new module.namespace.InitializationManager()
  };
}

async function loadNetflixApiBridge({ waitForPageScript, sendMessageToPageScript }) {
  const { appendAttempts, context } = createContext();
  let injectionRequests = 0;
  const messaging = await createModule(context, 'content/system/messaging.js', {
    registerInternalEventHandler() {},
    sendMessage() {},
    sendMessageToPageScript,
    waitForPageScript,
    requestPageScriptInjection: async () => {
      injectionRequests += 1;
      appendAttempts.push('legacy-request');
    }
  });
  const config = await createModule(context, 'content/system/config/config-bridge.js', {
    configBridge: { get: () => false, subscribe() {} }
  });
  const source = await readFile(new URL('../content/system/netflix-api-bridge.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/system/netflix-api-bridge.js',
    importModuleDynamically: async (specifier) => {
      if (specifier === './config/config-bridge.js') return config;
      throw new Error(`Unexpected dynamic import: ${specifier}`);
    }
  });
  await module.link((specifier) => {
    assert.equal(specifier, './messaging.js');
    return messaging;
  });
  await module.evaluate();

  return {
    appendAttempts,
    bridge: module.namespace.getNetflixAPIBridge(),
    injectionRequests: () => injectionRequests
  };
}

async function loadModeDetector(sendMessageToPageScript) {
  const { appendAttempts, context } = createContext();
  let injectionRequests = 0;
  const messaging = await createModule(context, 'content/system/messaging.js', {
    registerInternalEventHandler() {},
    sendMessage() {},
    sendMessageToPageScript,
    requestPageScriptInjection: async () => {
      injectionRequests += 1;
      appendAttempts.push('legacy-request');
    }
  });
  const source = await readFile(new URL('../content/subtitle-modes/mode-detector.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/subtitle-modes/mode-detector.js' });
  await module.link((specifier) => {
    assert.equal(specifier, '../system/messaging.js');
    return messaging;
  });
  await module.evaluate();

  return {
    appendAttempts,
    detector: new module.namespace.ModeDetector(),
    injectionRequests: () => injectionRequests
  };
}

test('Given MAIN requester sources When Todo 7 is complete Then request injection helpers and event registrations are absent', async () => {
  const sources = await Promise.all([
    'content/system/initialization-manager.js',
    'content/system/netflix-api-bridge.js',
    'content/subtitle-modes/mode-detector.js',
    'content/system/messaging.js',
    'content.js'
  ].map((path) => readFile(new URL(path, rootUrl), 'utf8')));

  for (const source of sources) assert.doesNotMatch(source, /requestPageScriptInjection/);
  assert.doesNotMatch(sources[4], /subpal-inject-page-script|subpal-request-page-script-injection/);
});

test('Given MAIN initialization When page readiness succeeds or times out Then it waits once and never requests an append', async (t) => {
  await t.test('success', async () => {
    const waits = [];
    const harness = await loadInitializationManager({
      waitForPageScript: async (timeout) => { waits.push(timeout); }
    });

    assert.equal(await harness.manager.initializePageScript(), true);
    assert.deepEqual(waits, [5000]);
    assert.equal(harness.injectionRequests(), 0);
    assert.deepEqual(harness.appendAttempts, []);
  });

  await t.test('timeout', async () => {
    const harness = await loadInitializationManager({
      waitForPageScript: async () => { throw new Error('readiness timeout'); }
    });

    await assert.rejects(harness.manager.initializePageScript(), /readiness timeout/);
    assert.equal(harness.injectionRequests(), 0);
    assert.deepEqual(harness.appendAttempts, []);
  });
});

test('Given the Netflix API bridge When it initializes after readiness Then it waits without requesting reinjection', async () => {
  const waits = [];
  const messages = [];
  const harness = await loadNetflixApiBridge({
    waitForPageScript: async (timeout) => { waits.push(timeout); },
    sendMessageToPageScript: async (message) => {
      messages.push(message.type);
      if (message.type === 'CHECK_API_AVAILABILITY') return { success: true, available: true };
      return { success: true };
    }
  });

  assert.equal(await harness.bridge.initialize(), true);
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(messages, ['CHECK_API_AVAILABILITY', 'INITIALIZE_PLAYER_HELPER', 'INITIALIZE_SUBTITLE_INTERCEPTOR']);
  assert.equal(harness.injectionRequests(), 0);
  assert.deepEqual(harness.appendAttempts, []);
});

test('Given the mode detector When PING succeeds or fails Then it reports readiness without reinjection', async (t) => {
  await t.test('PING succeeds', async () => {
    const messages = [];
    const harness = await loadModeDetector(async (message) => {
      messages.push(message.type);
      return { success: true };
    });

    assert.equal(await harness.detector.ensurePageScriptInjected(), true);
    assert.deepEqual(messages, ['PING']);
    assert.equal(harness.injectionRequests(), 0);
    assert.deepEqual(harness.appendAttempts, []);
  });

  await t.test('PING fails', async () => {
    const messages = [];
    const harness = await loadModeDetector(async (message) => {
      messages.push(message.type);
      throw new Error('PING unavailable');
    });

    const result = await harness.detector.detectInterceptModeStatus();
    assert.deepEqual({ status: result.status, mode: result.mode, reason: result.reason }, {
      status: 'hard_fail', mode: 'dom', reason: 'page-script-unavailable'
    });
    assert.deepEqual(messages, ['PING']);
    assert.equal(harness.injectionRequests(), 0);
    assert.deepEqual(harness.appendAttempts, []);
  });
});
