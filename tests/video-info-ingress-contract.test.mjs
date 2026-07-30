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
  const window = { dispatchEvent(event) { domEvents.push(event.detail); return true; } };
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
  manager.saveVideoInfo = async () => {};
  return { directEvents, domEvents, manager };
}

test('Given video-info observes a changed video When extraction completes Then it emits one DOM observation and no duplicate direct internal event', async () => {
  const harness = await loadVideoInfoHarness();

  await harness.manager.extractVideoInfo();

  assert.deepEqual(harness.directEvents, []);
  assert.equal(harness.domEvents.length, 1);
  const { type, oldVideoId, newVideoId } = plain(harness.domEvents[0].message);
  assert.deepEqual({ type, oldVideoId, newVideoId }, {
    type: 'VIDEO_ID_CHANGED', oldVideoId: '81234567', newVideoId: '87654321'
  });
});
