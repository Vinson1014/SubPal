import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadDiagnostics() {
  const source = await readFile(new URL('../content/system/capabilities/private-transport-diagnostics.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context: vm.createContext({}) });
  await module.link(() => { throw new Error('diagnostics must not import dependencies'); });
  await module.evaluate();
  return module.namespace;
}

test('Given unsafe nested transport inputs When safe diagnostics are built Then only allowlisted metadata survives serialization', async () => {
  const adapters = await loadDiagnostics();
  assert.ok(adapters, 'private transport adapters are missing');
  const diagnostic = adapters.buildSafeDiagnostic({
    requestId: 'req-1', capability: 'subtitle-query', operation: 'forward', protocolVersion: 1,
    result: { ok: false, error: { kind: 'timeout', code: 'page-response-timeout', retryable: true } }, deadlineMs: 100, elapsedMs: 20,
    context: { playback: { videoId: '81234567', sessionId: 'watch-1', epoch: 4, rawMetadata: 'metadata-secret' }, profile: { profileId: 'profile-1', userId: 'user-1', token: 'profile-secret' }, Authorization: 'Bearer authorization-secret' },
    payload: { jwt: 'jwt-secret', endpoint: 'https://name:credential-secret@example.test', original: 'original-secret', translation: 'translation-secret', originalSubtitle: 'subtitle-secret', submissionReason: 'reason-secret', rawContent: 'content-secret', rawTTML: 'ttml-secret', cueText: 'cue-secret', domText: 'dom-secret', rawMetadata: 'raw-metadata-secret', storage: { values: 'storage-secret' } }
  });
  assert.deepEqual(plain(diagnostic), {
    requestId: 'req-1', capability: 'subtitle-query', operation: 'forward', protocolVersion: 1,
    result: { kind: 'timeout', code: 'page-response-timeout' }, retryable: true, deadlineMs: 100, elapsedMs: 20,
    playback: { videoId: '81234567', sessionId: 'watch-1', epoch: 4 }, profile: { profileId: 'profile-1', userId: 'user-1' }
  });
  const serialized = JSON.stringify(diagnostic);
  for (const secret of ['jwt-secret', 'authorization-secret', 'credential-secret', 'original-secret', 'translation-secret', 'subtitle-secret', 'reason-secret', 'content-secret', 'ttml-secret', 'cue-secret', 'dom-secret', 'raw-metadata-secret', 'storage-secret']) assert.equal(serialized.includes(secret), false);
});

test('Given unsafe values in allowlisted diagnostic fields When projected Then semantic value constraints remove them', async () => {
  const adapters = await loadDiagnostics();
  assert.ok(adapters, 'private transport adapters are missing');
  const diagnostic = adapters.buildSafeDiagnostic({
    requestId: 'https://name:password@example.test', capability: 'header.payload.signature', operation: 'contribution prose with spaces', protocolVersion: 1,
    result: { ok: false, error: { kind: 'timeout', code: 'page-response-timeout', retryable: true } }, deadlineMs: 5, elapsedMs: 2,
    context: { playback: { videoId: '<tt><body>', sessionId: 'raw metadata body text', epoch: 3 }, profile: { profileId: 'Bearer abc.def.ghi', userId: 'endpoint=https://example.test' } }
  });
  assert.deepEqual(plain(diagnostic), {
    protocolVersion: 1, result: { kind: 'timeout', code: 'page-response-timeout' }, retryable: true, deadlineMs: 5, elapsedMs: 2,
    playback: { epoch: 3 }
  });
});
