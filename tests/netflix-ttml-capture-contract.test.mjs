import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const pageScriptSource = await readFile(new URL('../netflix-page-script.js', import.meta.url), 'utf8');
const TTML_ACQUISITION_CAPTURED_EVENT = 'subpal-ttml-acquisition-captured';
const root = new URL('../', import.meta.url);

async function loadIngress(context = vm.createContext({})) {
  const paths = [
    'content/system/capabilities/result.js',
    'content/system/capabilities/ttml-acquisition-ingress.js'
  ];
  const [resultSource, ingressSource] = await Promise.all(paths.map((path) => readFile(new URL(path, root), 'utf8')));
  const result = new vm.SourceTextModule(resultSource, { context, identifier: paths[0] });
  const ingress = new vm.SourceTextModule(ingressSource, { context, identifier: paths[1] });
  await result.link(() => { throw new Error('result.js must not import dependencies'); });
  await ingress.link((specifier) => {
    assert.equal(specifier, './result.js');
    return result;
  });
  await result.evaluate();
  await ingress.evaluate();
  return {
    ...ingress.namespace,
    toRealm(value) { return vm.runInContext(`(${JSON.stringify(value)})`, context); }
  };
}

function createPageRawHarness() {
  const listeners = new Map();
  const responses = [];
  let now = 1;
  let content = '<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="zh-Hant"><body><p begin="0s">fixture</p></body></tt>';
  const location = { href: 'https://www.netflix.com/watch/81234567' };
  const history = { pushState() {}, replaceState() {} };
  const window = {
    location,
    history,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/xml' },
      clone() { return this; },
      text: async () => content
    }),
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
    postMessage(message) { responses.push(message); },
    dispatchMessage(event) {
      for (const listener of [...(listeners.get('message') ?? [])]) listener(event);
    }
  };
  const context = vm.createContext({
    window,
    location,
    history,
    document: { addEventListener() {}, removeEventListener() {} },
    XMLHttpRequest: class XMLHttpRequest { open() {} send() {} },
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    TextDecoder,
    URL,
    URLSearchParams,
    Promise,
    Math,
    JSON,
    Error,
    console: { log() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    Date: class HarnessDate extends Date { static now() { return now; } }
  });
  vm.runInContext(pageScriptSource, context, { filename: 'netflix-page-script.js' });
  return {
    window,
    advance(milliseconds) { now += milliseconds; },
    async capture(index) {
      await window.fetch(`https://oca.nflxvideo.net/subtitles?o=${String(index).padStart(2, '0')}&v=track&e=entry`);
      for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
    },
    allRaw() {
      const messageId = `raw-${responses.length}`;
      window.dispatchMessage({
        source: window,
        data: { source: 'subpal-content-script', target: 'subpal-page-script', messageId, type: 'GET_ALL_INTERCEPTED_TTML' }
      });
      return responses.at(-1).allTTMLs;
    },
    snapshot() { return window.subpalPageScript.getDebugSnapshot(); }
  };
}

test('Given raw TTML arrives before owner binding When the page pool is later scanned Then it remains recoverable, while age alone never evicts below capacity', async () => {
  const capability = await loadIngress();
  const page = createPageRawHarness();
  let physicalEvents = 0;
  page.window.addEventListener(TTML_ACQUISITION_CAPTURED_EVENT, () => { physicalEvents += 1; });

  await page.capture(0);
  page.advance((31 * 60 * 1000) + 1);
  await page.capture(1);
  const retainedRaw = page.allRaw();
  let recovered = 0;
  const ingress = new capability.TtmlAcquisitionIngress({
    captureTtmlEvidence(input) {
      recovered += 1;
      return { status: 'retained', cacheKey: input.cacheKey, language: input.language };
    }
  });
  const [cacheKey, captured] = Object.entries(retainedRaw)[0];
  const result = ingress.capture(capability.toRealm({
    cacheKey,
    rawContent: captured.rawContent,
    language: captured.language,
    requestInfo: captured.requestInfo,
    rawMetadata: captured.rawMetadata,
    metadata: captured.metadata,
    source: 'netflix-page-script'
  }));

  assert.equal(physicalEvents, 2);
  assert.equal(Object.keys(retainedRaw).length, 2);
  assert.equal(recovered, 1);
  assert.equal(result.ok, true);

  for (let index = 2; index <= 50; index += 1) {
    page.advance(1);
    await page.capture(index);
  }
  const bounded = page.snapshot();
  assert.equal(bounded.interceptedTTMLCount, 50);
  assert.equal(bounded.interceptedTTMLCacheKeys.includes('zh-Hant_81234567_00_track_entry'), false);
});

test('Given equal-timestamp raw captures at capacity When a lexically first 51st key arrives Then it remains queryable and the oldest prior key is evicted', async () => {
  const page = createPageRawHarness();
  for (let index = 1; index <= 50; index += 1) await page.capture(index);
  await page.capture(0);
  const raw = page.allRaw();
  assert.equal(Object.keys(raw).length, 50);
  assert.equal(Object.hasOwn(raw, 'zh-Hant_81234567_00_track_entry'), true);
  assert.equal(Object.hasOwn(raw, 'zh-Hant_81234567_01_track_entry'), false);
});
