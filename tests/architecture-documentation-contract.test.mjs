import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const rootUrl = new URL('../', import.meta.url);

async function readSource(path) {
  return readFile(new URL(path, rootUrl), 'utf8');
}

const contract = Promise.all([
  readSource('docs/architecture.md'),
  readSource('manifest.json'),
  readSource('content.js'),
  readSource('netflix-page-script.js'),
  readSource('background/api.js'),
  readSource('background/sync.js'),
  readSource('content/system/messaging.js'),
  readSource('content/system/capabilities/private-transports.js'),
  readSource('content/system/config/config-schema.js'),
  readSource('content/system/isolated-endscreen-tasks.js'),
  readSource('content/ui/ui-manager-new.js'),
  readSource('tests/page-script-readiness-contract.test.mjs')
]).then(([
  architecture,
  manifest,
  content,
  pageScript,
  api,
  sync,
  messaging,
  privateTransports,
  configSchema,
  isolatedEndscreenTasks,
  uiManager,
  readinessTest
]) => ({
  api,
  architecture,
  configSchema,
  content,
  isolatedEndscreenTasks,
  manifest,
  messaging,
  privateTransports,
  pageScript,
  readinessTest,
  sync,
  uiManager
}));

test('Given current CustomEvent producers When architecture is reviewed Then it names responseFromContentScript and messageFromContentScript', async () => {
  const { architecture, messaging } = await contract;

  assert.match(messaging, /responseFromContentScript/);
  assert.match(messaging, /messageFromContentScript/);
  assert.match(architecture, /responseFromContentScript/);
  assert.match(architecture, /messageFromContentScript/);
  assert.doesNotMatch(architecture, /messageToPageContext/);
});

test('Given current bridge transport values When architecture is reviewed Then it names the current port and page-script source', async () => {
  const { architecture, content, privateTransports } = await contract;

  assert.match(content, /subtitle-assistant-channel/);
  assert.match(privateTransports, /subpal-content-script/);
  assert.match(architecture, /subtitle-assistant-channel/);
  assert.match(architecture, /subpal-content-script/);
  assert.doesNotMatch(architecture, /subpal-port|subpal-page-context/);
});

test('Given content-owned page-script readiness When architecture is reviewed Then it documents the marker protocol', async () => {
  const { architecture, content } = await contract;

  assert.match(content, /data-subpal-page-script-state/);
  assert.match(content, /subpal-page-script-ready/);
  assert.match(content, /failed-terminal/);
  assert.match(architecture, /data-subpal-page-script-state/);
  assert.match(architecture, /subpal-page-script-ready/);
  assert.match(architecture, /failed-terminal/);
});

test('Given isolated endscreen ownership When architecture is reviewed Then it documents the direct background task request', async () => {
  const { architecture, isolatedEndscreenTasks } = await contract;

  assert.match(isolatedEndscreenTasks, /GET_CROWDSOURCING_TASKS/);
  assert.match(architecture, /GET_CROWDSOURCING_TASKS/);
  assert.match(architecture, /isolated/i);
});

test('Given current API routes and registration When architecture is reviewed Then it documents translations, users, and POST registration', async () => {
  const { api, architecture } = await contract;

  assert.match(api, /\/translations\?videoID=/);
  assert.match(api, /\/users\/\$\{encodeURIComponent\(userID\)\}/);
  assert.match(architecture, /GET \/translations/);
  assert.match(architecture, /GET \/users\/\{id\}/);
  assert.match(architecture, /POST \/users/);
  assert.doesNotMatch(architecture, /每 24 小時/);
});

test('Given current nested configuration roots When architecture is reviewed Then it documents every persisted root', async () => {
  const { architecture, configSchema } = await contract;

  for (const root of ['crowdsourcing', 'api', 'user', 'video']) {
    assert.match(configSchema, new RegExp(`${root}:`));
    assert.match(architecture, new RegExp(`\\b${root}\\b`));
  }
  assert.doesNotMatch(architecture, /style\.primary\.fontSize|system\.debugMode|system\.isEnabled/);
});

test('Given current queue persistence When architecture is reviewed Then it documents histories and avoids invented exponential backoff', async () => {
  const { architecture, sync } = await contract;

  assert.match(sync, /VOTE_HISTORY_KEY = 'voteHistory'/);
  assert.match(sync, /TRANSLATION_HISTORY_KEY = 'translationHistory'/);
  assert.match(architecture, /voteHistory/);
  assert.match(architecture, /translationHistory/);
  assert.doesNotMatch(architecture, /1s, 2s, 4s/);
  assert.doesNotMatch(architecture, /QUEUE_SYNC|QUEUE_STATUS|FORCE_SYNC/);
});

test('Given current vote and translation payloads When architecture is reviewed Then it documents authoritative state and resolution metadata', async () => {
  const { api, architecture } = await contract;

  for (const field of ['voteState', 'resolutionContext', 'sourceTranslationID']) {
    assert.match(api, new RegExp(field));
    assert.match(architecture, new RegExp(field));
  }
  assert.match(api, /\/votes\/state/);
  assert.match(architecture, /PUT \/votes\/state/);
});

test('Given trusted playback session selection When architecture is reviewed Then it documents every selection reason', async () => {
  const { architecture, pageScript } = await contract;
  const reasons = [
    'watch-player-api-video-id-match',
    'watch-movie-id-match',
    'watch-reasonable-playback-state',
    'player-helper-session-fallback',
    'first-open-session-fallback',
    'no-open-playback-session'
  ];

  for (const reason of reasons) {
    assert.match(pageScript, new RegExp(reason));
    assert.match(architecture, new RegExp(reason));
  }
});

test('Given UIManager owns SubtitleReplacer When architecture is reviewed Then it documents that ownership', async () => {
  const { architecture, uiManager } = await contract;

  assert.match(uiManager, /this\.subtitleReplacer = new SubtitleReplacer\(\)/);
  assert.match(architecture, /UIManager[^\n]*SubtitleReplacer/);
  assert.doesNotMatch(architecture, /UIManager\.registerComponent/);
});

test('Given declared extension permissions and the test suite When architecture is reviewed Then it distinguishes permissions and gives the Node test command', async () => {
  const { architecture, manifest, readinessTest } = await contract;

  assert.match(manifest, /"storage"/);
  assert.match(manifest, /"alarms"/);
  assert.doesNotMatch(manifest, /"tabs"/);
  assert.match(readinessTest, /node:test/);
  assert.match(architecture, /storage/);
  assert.match(architecture, /alarms/);
  assert.doesNotMatch(architecture, /chrome\.tabs/);
  assert.match(architecture, /node --experimental-vm-modules --test tests\/\*\.test\.mjs/);
});
