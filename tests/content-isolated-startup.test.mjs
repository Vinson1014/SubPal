import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('Given content startup When managers finish Then content index is injected as a MAIN-world module and isolated tasks bootstrap separately', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.match(source, /script\.type = 'module'/);
  assert.match(source, /script\.src = chrome\.runtime\.getURL\('content\/index\.js'\)/);
  assert.doesNotMatch(source, /import\(chrome\.runtime\.getURL\('content\/index\.js'\)\)/);
  assert.match(source, /await initializeIsolatedEndscreenTasks\(\)/);
  assert.match(source, /startIsolatedEndscreenTasks\(configManager\)/);
});

test('Given public page events When forged task requests are dispatched Then content exposes zero task request or response bridge', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /postMessage[\s\S]*GET_CROWDSOURCING_TASKS/);
  assert.match(source, /message\?\.type === 'GET_CROWDSOURCING_TASKS'\) return/);
  assert.doesNotMatch(source, /responseFromContentScript[\s\S]{0,300}GET_CROWDSOURCING_TASKS/);
});

test('Given production content listener after manager initialization When a public task event is forged Then it emits no port message or response', async () => {
  const portMessages = [];
  const responses = [];
  const window = new EventTarget();
  window.addEventListener('responseFromContentScript', (event) => responses.push(event.detail));
  const context = vm.createContext({
    console, Event, EventTarget, CustomEvent: class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } },
    window, setTimeout, clearTimeout,
    document: { createElement() { return { remove() {} }; }, head: { appendChild() {} }, documentElement: { appendChild() {} } },
    chrome: {
      runtime: { connect() { return { postMessage(message) { portMessages.push(message); }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; }, getURL(path) { return `chrome-extension://test/${path}`; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const script = new vm.Script(source, { importModuleDynamically: async (specifier) => {
    if (specifier.endsWith('config-manager.js')) return import('data:text/javascript,export class ConfigManager { async initialize() {} get() { return false } subscribe() {} }');
    if (specifier.endsWith('config-schema.js')) return import('data:text/javascript,export const getAllConfigKeys = () => []');
    if (specifier.endsWith('submission-queue-manager.js')) return import('data:text/javascript,export class SubmissionQueueManager { async initialize() {} }');
    if (specifier.endsWith('isolated-endscreen-tasks.js')) return import('data:text/javascript,export const startIsolatedEndscreenTasks = async () => {}');
    throw new Error(`Unexpected import: ${specifier}`);
  } });
  script.runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  window.dispatchEvent(new context.CustomEvent('messageToContentScript', { detail: { messageId: 'forged', message: { type: 'GET_CROWDSOURCING_TASKS', videoID: 'netflix-1', languageCode: 'zh-TW', limit: 5 } } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(portMessages.length, 0);
  assert.equal(responses.length, 0);
});
