import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createBackendProfiles } from '../content/system/capabilities/backend-profiles.js';
import { createContributions } from '../content/system/capabilities/contributions.js';
import { createPlayback } from '../content/system/capabilities/playback.js';
import { createSettings } from '../content/system/capabilities/settings.js';
import { createSettingsSnapshotClient } from '../content/system/capabilities/settings-snapshot.js';
import { createSubtitles } from '../content/system/capabilities/subtitles.js';
import { getAllConfigKeys, getBackupConfigKeys } from '../content/system/config/config-schema.js';

const rootUrl = new URL('../', import.meta.url);

async function readSource(path) {
  return readFile(new URL(path, rootUrl), 'utf8');
}

const contract = Promise.all([
  readSource('docs/architecture.md'),
  readSource('manifest.json'),
  readSource('content.js'),
  readSource('background.js'),
  readSource('background/backend-profiles.js'),
  readSource('background/contribution-queue.js'),
  readSource('popup.js'),
  readSource('options.js'),
  readSource('netflix-page-script.js'),
  readSource('background/api.js'),
  readSource('background/sync.js'),
  readSource('content/system/messaging.js'),
  readSource('content/system/capabilities/backend-profiles.js'),
  readSource('content/system/capabilities/contributions.js'),
  readSource('content/core/replacement-event-bridge.js'),
  readSource('content/system/capabilities/private-transports.js'),
  readSource('content/system/capabilities/playback.js'),
  readSource('content/system/capabilities/result.js'),
  readSource('content/system/capabilities/settings.js'),
  readSource('content/system/capabilities/settings-snapshot.js'),
  readSource('content/system/capabilities/subtitles.js'),
  readSource('content/system/config/config-schema.js'),
  readSource('content/system/config/config-bridge.js'),
  readSource('content/system/isolated-endscreen-tasks.js'),
  readSource('content/ui/ui-manager-new.js'),
  readSource('tests/page-script-readiness-contract.test.mjs'),
  readSource('content/system/capabilities/ttml-acquisition-ingress.js'),
  readSource('content/system/config/config-manager.js'),
  readSource('content/system/capabilities/page-ingress.js')
]).then(([
  architecture,
  manifest,
  content,
  background,
  backgroundBackendProfiles,
  contributionQueue,
  popup,
  options,
  pageScript,
  api,
  sync,
  messaging,
  backendProfiles,
  contributions,
  replacementEventBridge,
  privateTransports,
  playback,
  result,
  settings,
  settingsSnapshot,
  subtitles,
  configSchema,
  configBridge,
  isolatedEndscreenTasks,
  uiManager,
  readinessTest,
  ttmlAcquisitionIngress,
  configManager,
  pageIngress
]) => ({
  api,
  background,
  backgroundBackendProfiles,
  contributionQueue,
  backendProfiles,
  architecture,
  contributions,
  replacementEventBridge,
  configSchema,
  configBridge,
  content,
  isolatedEndscreenTasks,
  manifest,
  messaging,
  options,
  popup,
  privateTransports,
  playback,
  result,
  settings,
  settingsSnapshot,
  subtitles,
  ttmlAcquisitionIngress,
  pageScript,
  readinessTest,
  sync,
  uiManager,
  configManager,
  pageIngress
}));

function fakeWindow() {
  return {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
  };
}

function exactMethodNames(object) {
  return Object.keys(object);
}

test('Given current capability factories When they are instantiated Then they expose the shipped method surfaces', async () => {
  assert.deepEqual(exactMethodNames(createBackendProfiles({ request: async () => ({ ok: true, value: {} }) })), ['list', 'create', 'activate', 'deleteProfile', 'exportQueue', 'retryFailed', 'migrationStatus', 'resolveMigrationEndpoint']);
  assert.deepEqual(exactMethodNames(createContributions({ persist: async () => ({ ok: true, value: { status: 'queued-locally', operationId: 'op-1' } }), readProjection: async () => ({ ok: true, value: { status: 'ready' } }), retryOperation: async () => ({ ok: true, value: { retryScheduled: true, operationId: 'op-1' } }) })), ['enqueue', 'getProjection', 'retry']);
  assert.deepEqual(exactMethodNames(createSettings({ write: async () => {} })), ['change']);
  assert.deepEqual(exactMethodNames(createSettingsSnapshotClient({ window: fakeWindow(), createRequestId: () => 'request-1' })), ['read', 'dispose']);
  assert.deepEqual(exactMethodNames(createPlayback({ getCurrentContext: () => ({ state: 'ready', videoId: 'v', sessionId: 'watch-1', epoch: 0 }), adapter: { request: async () => ({ ok: true, value: { variant: 'context-snapshot', playback: { pageUrlVideoId: 'v', playerApiVideoId: 'v', movieId: 'm', selectedSessionId: 'watch-1', selectedSessionReason: 'watch-player-api-video-id-match', sessionSelectionConfidence: 'high', currentTime: 0, duration: 1, currentTrack: null } } }) } })), ['perform', 'dispose']);
  assert.deepEqual(exactMethodNames(createSubtitles({ getCurrentContext: () => ({ videoId: 'v', sessionId: 'watch-1', epoch: 0 }), request: async () => ({ ok: true, value: { subtitles: [] } }), createRequestId: () => 'request-1' })), ['query']);
});

test('Given current configuration roots When the schema is inspected Then legacy user and JWT roots stay out of getAllConfigKeys while backup stays UX-config-only', async () => {
  assert.deepEqual(getBackupConfigKeys().sort(), ['crowdsourcing', 'debugMode', 'isEnabled', 'subtitle']);
  for (const key of ['user', 'jwt', 'profile', 'endpoint', 'credential']) {
    assert.ok(!getAllConfigKeys().includes(key));
  }
});

test('Given current one-shot and port transports When architecture is reviewed Then Popup, Options, and subtitle-assistant channel claims match the shipped surface', async () => {
  const { architecture, background, content, options, popup } = await contract;

  assert.match(popup, /chrome\.runtime\.sendMessage/);
  assert.match(options, /options-page-channel/);
  assert.match(options, /chrome\.runtime\.connect/);
  assert.match(content, /subtitle-assistant-channel/);
  assert.match(background, /subtitle-assistant-channel/);
  assert.match(architecture, /chrome\.runtime\.sendMessage/);
  assert.match(architecture, /options-page-channel/);
  assert.match(architecture, /subtitle-assistant-channel/);
});

test('Given current private DOM request/response When architecture is reviewed Then settings snapshot and projected notification claims stay separated', async () => {
  const { architecture, configBridge, messaging, privateTransports, settingsSnapshot } = await contract;

  assert.match(messaging, /messageFromContentScript/);
  assert.doesNotMatch(messaging, /responseFromContentScript/);
  assert.match(privateTransports, /createDomTransport/);
  assert.match(settingsSnapshot, /settings-read/);
  assert.match(settingsSnapshot, /snapshot/);
  assert.match(configBridge, /CONFIG_CHANGED/);
  assert.match(architecture, /messageFromContentScript/);
  assert.match(architecture, /responseFromContentScript/);
  assert.match(architecture, /settings-read\/snapshot/);
  assert.match(architecture, /private DOM request\/response/);
  assert.match(architecture, /projected one-way notification/);
  assert.match(architecture, /Content -> MAIN/);
  assert.match(architecture, /CONFIG_CHANGED/);
  assert.doesNotMatch(architecture, /PageIngress\.accept\(\) 目前接受的 sealed 路由是 [^\n]*settings-read/);
  assert.doesNotMatch(architecture, /SettingsSnapshot.*CONFIG_CHANGED/);
});

test('Given current backend profile ownership and legacy migration boundaries When architecture is reviewed Then active storage and migration-only legacy roots are described accurately', async () => {
  const { architecture, backendProfiles, backgroundBackendProfiles, api } = await contract;

  assert.match(backendProfiles, /BACKEND_PROFILES_(LIST|CREATE|ACTIVATE|DELETE|EXPORT_QUEUE|RETRY_FAILED)/);
  assert.match(backgroundBackendProfiles, /activeProfileId/);
  assert.match(backgroundBackendProfiles, /legacy/);
  assert.match(backgroundBackendProfiles, /api/);
  assert.match(backgroundBackendProfiles, /user/);
  assert.match(backgroundBackendProfiles, /jwt/);
  assert.match(api, /refreshJwtToken/);
  assert.match(architecture, /active profile/);
  assert.match(architecture, /backendProfiles/);
  assert.match(architecture, /legacy.*migration-only/);
  assert.match(architecture, /api\/user\/jwt/);
  assert.match(architecture, /401/);
  assert.match(architecture, /refresh/);
  assert.doesNotMatch(architecture, /top-level JWT/);
  assert.doesNotMatch(architecture, /^\s{2}api:/m);
  assert.doesNotMatch(architecture, /^\s{2}user:/m);
  assert.doesNotMatch(architecture, /^\s{2}jwt:/m);
  assert.match(architecture, /video\.\*/);
  assert.match(architecture, /runtime-owned current playback metadata/);
});

test('Given current replacement ownership and crowdsourcing boundaries When architecture is reviewed Then background owns replacement identity and the direct exception remains named', async () => {
  const { architecture, contributionQueue, replacementEventBridge } = await contract;

  assert.match(replacementEventBridge, /contributorUserID/);
  assert.match(replacementEventBridge, /replacement-event/);
  assert.match(contributionQueue, /beneficiaryUserID/);
  assert.match(contributionQueue, /backendProfileId/);
  assert.match(architecture, /contributorUserID/);
  assert.match(architecture, /MAIN 送出的事件資料/);
  assert.match(architecture, /background queue/);
  assert.match(architecture, /atomically/);
  assert.match(architecture, /beneficiaryUserID/);
  assert.match(architecture, /backendProfileId/);
  assert.match(architecture, /direct privileged crowdsourcing 例外/);
  assert.match(architecture, /GET_CROWDSOURCING_TASKS/);
  assert.match(architecture, /ReplacementEventBridge/);
  assert.match(architecture, /替換事件/);
  assert.doesNotMatch(architecture, /replacement beneficiary/);
});

test('Given current PageIngress envelopes When architecture is reviewed Then it names the sealed page-observation and query routes instead of legacy API_REQUEST traffic', async () => {
  const { architecture, content } = await contract;

  assert.match(content, /PageIngress/);
  assert.match(architecture, /PageIngress/);
  assert.match(architecture, /page-observation/);
  assert.match(architecture, /video-context-changed/);
  assert.match(architecture, /subtitle-query/);
  assert.match(architecture, /SUBTITLE_QUERY/);
  assert.match(architecture, /Subtitles\.query/);
  assert.doesNotMatch(architecture, /FETCH_SUBTITLES|SUBTITLES_DATA/);
  assert.doesNotMatch(architecture, /API_REQUEST/);
  assert.doesNotMatch(architecture, /GET_PLAYER_STATE/);
  assert.doesNotMatch(architecture, /PLAYER_STATE/);
});

test('Given current playback private route When architecture is reviewed Then it names the shipped variants instead of the retired GET_PLAYER_STATE traffic', async () => {
  const { architecture, playback } = await contract;

  for (const token of ['context-snapshot', 'available-languages', 'current-language', 'switch-language', 'switch-track', 'jump-to-timecode']) {
    assert.match(playback, new RegExp(token));
    assert.match(architecture, new RegExp(token));
  }
  assert.doesNotMatch(architecture, /GET_PLAYER_STATE/);
  assert.doesNotMatch(architecture, /PLAYER_STATE/);
});

test('Given current playback and retry seams When architecture is reviewed Then it names the capability and sealed retry variant instead of retired bridge vocabulary', async () => {
  const { architecture, playback } = await contract;

  assert.match(playback, /createPagePlayback/);
  assert.match(playback, /context-snapshot/);
  assert.match(architecture, /Playback\.perform\(\{ variant: 'context-snapshot' \}\)/);
  assert.match(architecture, /retry-operation/);
  assert.doesNotMatch(architecture, /NetflixApiBridge|content\/system\/netflix-api-bridge\.js/);
  assert.doesNotMatch(architecture, /enqueue-replacement-event\|retry`/);
});

test('Given current subtitle query diagram When architecture is reviewed Then MAIN, content, port, and response directions stay bound in the same block', async () => {
  const { architecture } = await contract;
  const start = architecture.indexOf('// Page Context → Content Script（sealed PageIngress: page observation）');
  const end = architecture.indexOf('#### 3. Page Context ↔ Netflix Page Script');

  assert.ok(start >= 0);
  assert.ok(end > start);

  const block = architecture.slice(start, end);
  const expectedSequence = [
    'Page Context MAIN → Content Script',
    'messageToContentScript',
    'Content Script → Page Context MAIN',
    'responseFromContentScript',
    'Content Script → Background',
    'Subtitles.query()',
    'SUBTITLE_QUERY',
    '{ messageId, response }'
  ];

  let cursor = -1;
  for (const token of expectedSequence) {
    const position = block.indexOf(token, cursor + 1);
    assert.ok(position > cursor, token);
    cursor = position;
  }
});

test('Given current messaging module exports When architecture is reviewed Then it exposes only internal events and readiness', async () => {
  const { messaging } = await contract;

  for (const token of [
    'initMessaging',
    'registerInternalEventHandler',
    'dispatchInternalEvent',
    'isPageScriptAvailable',
    'waitForPageScript'
  ]) {
    assert.match(messaging, new RegExp(`export function ${token}|export const ${token}`));
  }

  for (const token of ['sendMessage', 'onMessage', 'registerMessageHandler', 'registerAutoForwardingToInternalEvent']) {
    assert.doesNotMatch(messaging, new RegExp(`export function ${token}|export const ${token}`));
  }
  assert.doesNotMatch(messaging, /messageHandlers|messageTimeouts|legacyDomRequestEvent|legacyDomResponseEvent|createDomTransport/);
});

test('Given sealed messaging exports When its architecture section is reviewed Then it names only the shipped surface and rejects a generic public bus', async () => {
  const { architecture, messaging } = await contract;
  const start = architecture.indexOf('#### 1.2 Messaging System');
  const end = architecture.indexOf('\n#### 1.3 ', start);

  assert.ok(start >= 0);
  assert.ok(end > start);

  const section = architecture.slice(start, end);
  for (const token of [
    'initMessaging',
    'registerInternalEventHandler',
    'dispatchInternalEvent',
    'isPageScriptAvailable',
    'waitForPageScript'
  ]) {
    assert.match(messaging, new RegExp(`export function ${token}`));
    assert.match(section, new RegExp(`\\b${token}\\b`));
  }

  for (const token of ['sendMessage', 'onMessage', 'registerMessageHandler', 'registerAutoForwardingToInternalEvent']) {
    assert.doesNotMatch(messaging, new RegExp(`export function ${token}|export const ${token}`));
  }
  assert.doesNotMatch(section, /^(?:sendMessage|onMessage|registerMessageHandler|registerAutoForwardingToInternalEvent)\(/m);
  assert.doesNotMatch(section, /對外完整公開[^\n]*(?:sendMessage|onMessage|registerMessageHandler|registerAutoForwardingToInternalEvent)/);
  assert.match(section, /no generic public `sendMessage`\/`onMessage`\/register handler bus/);
});

test('Given current page capability seams When architecture is reviewed Then it describes typed clients, strict Result, and guarded reverse events', async () => {
  const { architecture, configManager, contributions, messaging, settings, settingsSnapshot, ttmlAcquisitionIngress } = await contract;

  assert.match(contributions, /export function createPageContributions/);
  assert.match(settings, /export function createPageSettings/);
  assert.match(settingsSnapshot, /export function subscribeSettingsChanges/);
  assert.match(ttmlAcquisitionIngress, /class TtmlAcquisitionIngress/);
  assert.match(messaging, /function parseContentScriptBridgeMessage/);
  assert.match(messaging, /function parseVideoIdChangedMessage/);
  assert.match(configManager, /oldValue/);

  for (const token of [
    'createPageContributions()',
    'createPageSettings()',
    'subscribeSettingsChanges()',
    'strict `Result`',
    'TtmlAcquisitionIngress',
    'parseContentScriptBridgeMessage',
    'parseVideoIdChangedMessage',
    'fresh normalized',
    '`oldValue` is `undefined`'
  ]) {
    assert.match(architecture, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Given current video storage schema When architecture is reviewed Then legacy video roots are inert while api user and jwt remain migration inputs', async () => {
  const { architecture, configSchema } = await contract;

  assert.match(configSchema, /video:\s*\{/);
  assert.match(configSchema, /currentVideoId/);
  assert.match(configSchema, /currentVideoTitle/);
  assert.match(configSchema, /currentVideoLanguage/);
  assert.match(architecture, /video\./);
  assert.match(architecture, /PlaybackContext/);
  assert.match(architecture, /migration-only/);
  assert.match(architecture, /video.*0\.4\.1.*遺留/);
});

test('Given current replacement event ownership When architecture is reviewed Then contributor data stays from MAIN while beneficiary and backend profile are derived together in background', async () => {
  const { architecture, contributionQueue } = await contract;

  assert.match(contributionQueue, /beneficiaryUserID/);
  assert.match(contributionQueue, /backendProfileId/);
  assert.match(contributionQueue, /contributorUserID/);
  assert.match(architecture, /contributorUserID/);
  assert.match(architecture, /beneficiaryUserID/);
  assert.match(architecture, /backendProfileId/);
  assert.match(architecture, /MAIN 送出的事件資料/);
  assert.match(architecture, /atomically/);
  assert.doesNotMatch(architecture, /background owner/);
  assert.doesNotMatch(architecture, /MAIN only passes/);
});

test('Given current settings and playback capability boundaries When architecture is reviewed Then the named methods match the shipped interfaces', async () => {
  const { architecture, playback, settings, settingsSnapshot, subtitles } = await contract;

  assert.match(settings, /change\(input\)/);
  assert.match(settingsSnapshot, /read\(\)/);
  assert.match(settingsSnapshot, /dispose\(\)/);
  assert.match(playback, /perform\(input, cancellation\)/);
  assert.match(subtitles, /query\(input, cancellation\)/);
  assert.match(architecture, /SettingsSnapshot/);
  assert.match(architecture, /Playback/);
  assert.match(architecture, /Subtitles/);
  assert.match(architecture, /change/);
  assert.match(architecture, /read/);
  assert.match(architecture, /dispose/);
  assert.match(architecture, /perform/);
  assert.match(architecture, /query/);
  assert.doesNotMatch(architecture, /read\(getProjection\)/);
});

test('Given current contribution projection semantics When architecture is reviewed Then it uses getProjection rather than a read alias', async () => {
  const { architecture, contributions } = await contract;

  assert.match(contributions, /getProjection/);
  assert.match(architecture, /getProjection/);
  assert.doesNotMatch(architecture, /read\(getProjection\)/);
  assert.doesNotMatch(architecture, /Contributions.*read\(/);
});

test('Given current messaging APIs When architecture is reviewed Then sendToContentScript sendToBackground and messaging.once are gone', async () => {
  const { architecture } = await contract;

  for (const token of [/sendToContentScript/, /sendToBackground/, /messaging\.once\(/]) {
    assert.doesNotMatch(architecture, token);
  }
});

test('Given current queue and config vocabulary When architecture is reviewed Then retired public CONFIG and queue claims stay absent', async () => {
  const { architecture } = await contract;

  for (const token of ['CONFIG_GET', 'CONFIG_SET', 'QUEUE_', 'getAllPending', 'retryFailedVotes', 'retryFailedTranslations', 'retryFailedReplacementEvents', 'ConfigBridge.set(', 'ConfigBridge.setMultiple(', 'SubmissionQueueManager', 'content/core/submission-queue-manager.js', 'getAllPending()', 'sendToContentScript']) {
    assert.doesNotMatch(architecture, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Given current active storage documentation When architecture is reviewed Then it does not list top-level api user jwt or video roots as runtime-owned state', async () => {
  const { architecture } = await contract;

  for (const token of [/^\s{2}api:/m, /^\s{2}user:/m, /^\s{2}jwt:/m]) {
    assert.doesNotMatch(architecture, token);
  }
  assert.match(architecture, /video\.\*/);
});

test('Given current SubmissionQueueManager wording When architecture is reviewed Then it no longer claims public ownership or generic retry paths', async () => {
  const { architecture } = await contract;

  assert.doesNotMatch(architecture, /SubmissionQueueManager[\s\S]*getAllPending/);
  assert.doesNotMatch(architecture, /SubmissionQueueManager[\s\S]*retryFailedVotes/);
  assert.doesNotMatch(architecture, /SubmissionQueueManager[\s\S]*retryFailedTranslations/);
  assert.doesNotMatch(architecture, /SubmissionQueueManager[\s\S]*retryFailedReplacementEvents/);
  assert.doesNotMatch(architecture, /content\/core\/submission-queue-manager\.js/);
  assert.match(architecture, /background\/contribution-queue\.js/);
  assert.match(architecture, /background queue/);
  assert.doesNotMatch(architecture, /public retry/);
});

test('Given current config bridge wording When architecture is reviewed Then ConfigBridge.set and setMultiple are not described as current APIs', async () => {
  const { architecture } = await contract;

  assert.doesNotMatch(architecture, /ConfigBridge\.set\(/);
  assert.doesNotMatch(architecture, /ConfigBridge\.setMultiple\(/);
  assert.doesNotMatch(architecture, /CONFIG_SET request/);
});

test('Given current architecture prose When it is reviewed Then the main stale current-interface tokens are absent everywhere', async () => {
  const { architecture } = await contract;

  for (const token of [
    'sendToContentScript',
    'sendToBackground',
    'messaging.once(',
    'CONFIG_GET',
    'CONFIG_SET',
    'QUEUE_',
    'getAllPending',
    'retryFailedVotes',
    'retryFailedTranslations',
    'retryFailedReplacementEvents',
    'ConfigBridge.set(',
    'ConfigBridge.setMultiple(',
    'read(getProjection)',
    'top-level JWT',
  ]) {
    assert.doesNotMatch(architecture, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const token of [/^\s{2}api:/m, /^\s{2}user:/m, /^\s{2}jwt:/m]) {
    assert.doesNotMatch(architecture, token);
  }
  assert.match(architecture, /video\.\*/);
});

test('Given current CustomEvent producers When architecture is reviewed Then VIDEO_ID_CHANGED remains internal and DOM requests stay private', async () => {
  const { architecture, messaging, privateTransports } = await contract;

  assert.match(messaging, /messageFromContentScript/);
  assert.doesNotMatch(messaging, /messageToContentScript|responseFromContentScript/);
  assert.match(privateTransports, /createDomTransport/);
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

  for (const root of ['crowdsourcing', 'subtitle', 'api', 'video']) {
    assert.match(configSchema, new RegExp(`${root}:`));
    assert.match(architecture, new RegExp(`\\b${root}\\b`));
  }
  assert.match(architecture, /user.*migration-only/);
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

test('Given current startup, TTML, cache, and queue flows When architecture is reviewed Then retired examples cannot return', async () => {
  const { architecture, content, pageScript, sync } = await contract;

  assert.match(content, /function initializeAllManagers/);
  assert.match(content, /connectToBackground\(\)/);
  assert.match(content, /ensureNetflixPageScriptReady\(\)/);
  assert.doesNotMatch(architecture, /initializeQueueManagers\(\)/);
  assert.doesNotMatch(architecture, /貢獻隊列初始化失敗/);

  assert.match(pageScript, /subpal-ttml-acquisition-captured/);
  assert.match(architecture, /subpal-ttml-acquisition-captured/);
  assert.match(architecture, /TtmlAcquisitionIngress\.capture\(\)/);
  assert.match(architecture, /captureTtmlEvidence\(\)/);
  assert.doesNotMatch(architecture, /handleRawTTMLIntercepted/);

  assert.match(architecture, /SubtitleFetchCoordinator/);
  assert.match(architecture, /interval union/);
  assert.match(architecture, /canonical `slotKey` 精確命中/);
  assert.doesNotMatch(architecture, /SubtitleCache/);
  assert.doesNotMatch(architecture, /LRU/);
  assert.doesNotMatch(architecture, /模糊匹配/);
  assert.doesNotMatch(architecture, /Math\.abs\(v\.timestamp/);

  assert.match(sync, /moveToHistory/);
  assert.match(architecture, /同步成功時[\s\S]*queue record[\s\S]*移除[\s\S]*completed/);
  assert.match(architecture, /history 依 profile 最多保留 100 筆/);

  const storageStart = architecture.indexOf('#### 3.3 存儲結構');
  const storageEnd = architecture.indexOf('`video.*`', storageStart);
  assert.ok(storageStart >= 0);
  assert.ok(storageEnd > storageStart);
  const storageSection = architecture.slice(storageStart, storageEnd);
  assert.match(storageSection, /operationId/);
  assert.match(storageSection, /backendProfileId/);
  assert.doesNotMatch(storageSection, /data: \{ videoID/);
});

test('Given the current SubtitleDisplay container contract When architecture is reviewed Then its bilingual example remains text-only', async () => {
  const { architecture } = await contract;
  const start = architecture.indexOf('#### 2.2 Region 容器設計');
  const end = architecture.indexOf('#### 2.3 語言配置', start);

  assert.ok(start >= 0);
  assert.ok(end > start);

  const section = architecture.slice(start, end);
  assert.match(section, /subpal-region-container/);
  assert.match(section, /subpal-primary-subtitle/);
  assert.match(section, /subpal-secondary-subtitle/);
  assert.match(section, /textContent/);
  assert.doesNotMatch(section, /\.innerHTML/);
  assert.doesNotMatch(section, /getOrCreateRegionContainer/);
});
