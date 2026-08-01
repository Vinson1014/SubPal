import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function createModule(context, identifier, exports) {
  const module = new vm.SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  await module.link(() => { throw new Error('Unexpected synthetic dependency'); });
  await module.evaluate();
  return module;
}

async function loadVideoInfoHarness() {
  const directEvents = [];
  const domEvents = [];
  const persistenceCalls = [];
  const window = { dispatchEvent(event) { domEvents.push({ type: event.type, detail: event.detail }); return true; } };
  const context = vm.createContext({
    window,
    Date: class extends Date { static now() { return 1; } },
    Math: { ...Math, random: () => 0 },
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    console: { log() {}, error() {} }
  });
  const messaging = await createModule(context, 'messaging.js', { dispatchInternalEvent(event) { directEvents.push(event); } });
  const source = await readFile(new URL('../content/core/video-info.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    assert.equal(specifier, '../system/messaging.js');
    return messaging;
  });
  await module.evaluate();
  const manager = module.namespace.videoInfoManager;
  manager.currentVideoId = '81234567';
  manager.extractVideoId = () => '87654321';
  manager.extractVideoTitle = async () => 'Episode B';
  manager.configBridge = {
    setMultiple(values) {
      persistenceCalls.push(plain(values));
    }
  };
  return { directEvents, domEvents, manager, persistenceCalls };
}

test('Given video-info observes a changed video When extraction completes Then it retains metadata in memory, emits one DOM observation, and persists nothing', async () => {
  const harness = await loadVideoInfoHarness();

  await harness.manager.extractVideoInfo();

  assert.deepEqual(harness.directEvents, []);
  assert.equal(harness.domEvents.length, 1);
  const event = plain(harness.domEvents[0]);
  assert.equal(event.type, 'messageToContentScript');
  assert.equal(typeof event.detail.messageId, 'string');
  assert.ok(event.detail.messageId.startsWith('video-info-'));
  assert.ok(event.detail.messageId.length > 'video-info-'.length);
  const { type, oldVideoId, newVideoId, source } = event.detail.message;
  assert.deepEqual({ type, oldVideoId, newVideoId, source }, {
    type: 'VIDEO_ID_CHANGED',
    oldVideoId: '81234567',
    newVideoId: '87654321',
    source: 'video-info-manager'
  });
  assert.equal(harness.manager.getVideoId(), '87654321');
  assert.equal(harness.manager.getVideoTitle(), 'Episode B');
  assert.equal(harness.manager.getVideoLanguage(), 'unknown');

  await harness.manager.extractVideoInfo();

  assert.equal(harness.domEvents.length, 1);
  assert.deepEqual(harness.persistenceCalls, []);
});
