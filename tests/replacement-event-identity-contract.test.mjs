import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

import { loadSync } from './background-sync-metadata-harness.mjs';

async function loadSubtitleReplacer(enqueue) {
  const source = await readFile(new URL('../content/core/subtitle-replacer.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    AbortController,
    Date,
    Promise,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    window: {}
  });
  const messaging = new vm.SyntheticModule(['registerInternalEventHandler'], function initialize() {
    this.setExport('registerInternalEventHandler', () => () => {});
  }, { context, identifier: 'content/system/messaging.js' });
  const subtitles = new vm.SyntheticModule(['createPageSubtitles'], function initialize() {
    this.setExport('createPageSubtitles', () => ({}));
  }, { context, identifier: 'content/system/capabilities/subtitles.js' });
  const slotKey = new vm.SyntheticModule(['buildSlotKey'], function initialize() {
    this.setExport('buildSlotKey', () => 'slot');
  }, { context, identifier: 'content/utils/slot-key.js' });
  const playback = new vm.SyntheticModule(['playbackContextManager'], function initialize() {
    this.setExport('playbackContextManager', { getCurrentContext: () => null });
  }, { context, identifier: 'content/core/playback-context-manager.js' });
  const bridge = new vm.SyntheticModule(['replacementEventBridge'], function initialize() {
    this.setExport('replacementEventBridge', { isInitialized: true, enqueue });
  }, { context, identifier: 'content/core/replacement-event-bridge.js' });
  for (const dependency of [messaging, subtitles, slotKey, playback, bridge]) {
    await dependency.link(() => { throw new Error('test dependency has no imports'); });
    await dependency.evaluate();
  }
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/core/subtitle-replacer.js',
    importModuleDynamically(specifier) {
      if (specifier === './replacement-event-bridge.js') return bridge;
      throw new Error(`Unexpected dynamic import: ${specifier}`);
    }
  });
  await module.link((specifier) => {
    if (specifier === '../system/messaging.js') return messaging;
    if (specifier === '../system/capabilities/subtitles.js') return subtitles;
    if (specifier === '../utils/slot-key.js') return slotKey;
    if (specifier === './playback-context-manager.js') return playback;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.SubtitleReplacer;
}

function profileStore(activeProfileId = 'profile-b') {
  return {
    schemaVersion: 1,
    activeProfileId,
    byId: {
      'profile-a': { id: 'profile-a', endpoint: 'https://a.example.test', userId: 'current-user-a', jwt: null },
      'profile-b': { id: 'profile-b', endpoint: 'https://b.example.test', userId: 'current-user-b', jwt: null }
    }
  };
}

test('Given replacement applies twice within fifteen minutes When SubtitleReplacer records it Then it sends one identity-free event without consulting ConfigBridge', async () => {
  const events = [];
  const SubtitleReplacer = await loadSubtitleReplacer(async (event) => { events.push(event); });
  const replacer = new SubtitleReplacer();
  replacer.configBridge = { get() { throw new Error('replacement event must not read ConfigBridge identity'); } };

  await replacer.recordReplacementEvent('translation-1', 'contributor-1');
  await replacer.recordReplacementEvent('translation-1', 'contributor-2');

  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(events[0])), {
    translationID: 'translation-1',
    contributorUserID: 'contributor-1',
    occurredAt: events[0].occurredAt
  });
  assert.match(events[0].occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(JSON.stringify(replacer.recentReplacementEvents.map(({ translationID, timestamp }) => ({ translationID, timestamp })))), [
    { translationID: 'translation-1', timestamp: replacer.recentReplacementEvents[0].timestamp }
  ]);
  assert.equal(Object.hasOwn(replacer.recentReplacementEvents[0], 'beneficiaryUserID'), false);
});

test('Given a persisted replacement beneficiary differs from the current profile user When replacement sync runs Then it submits the persisted beneficiary unchanged', async () => {
  const runtime = await loadSync({
    state: {
      backendProfiles: profileStore(),
      replacementEventQueue: [{
        id: 'replacement-1', operationId: 'replacement-operation-1', backendProfileId: 'profile-b',
        translationID: 'translation-1', contributorUserID: 'contributor-1', beneficiaryUserID: 'persisted-user-b',
        occurredAt: '2026-08-01T00:00:00.000Z', status: 'pending', createdAt: 0, syncedAt: null, retryCount: 0, error: null
      }]
    }
  });

  await runtime.module.namespace.triggerReplacementEventSync('profile-b');

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.apiCalls.map(({ kind, payload, backendProfileId }) => ({ kind, payload, backendProfileId })))), [{
    kind: 'submitReplacementEvents',
    payload: [{
      translationID: 'translation-1', contributorUserID: 'contributor-1', beneficiaryUserID: 'persisted-user-b',
      occurredAt: '2026-08-01T00:00:00.000Z'
    }],
    backendProfileId: 'profile-b'
  }]);
});
