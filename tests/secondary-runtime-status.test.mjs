import assert from 'node:assert/strict';
import { test } from 'node:test';

const snapshot = (extra = {}) => ({
  videoId: '801', effectiveLanguage: 'ja', quality: { isCC: false, degraded: false },
  status: 'ready', reason: 'original-language-subtitles-ready', isManualFallback: false, updatedAt: 123,
  ...extra
});

test('runtime snapshot has a strict non-config projection and reads only its fixed local key best effort', async () => {
  const { parseSecondaryRuntimeStatus, readSecondaryRuntimeStatus, SECONDARY_RUNTIME_STATUS_KEY } = await import('../shared/secondary-runtime-status.js');
  assert.equal(SECONDARY_RUNTIME_STATUS_KEY, 'subpalSecondaryRuntimeStatus');
  const { getAllConfigKeys, getBackupConfigKeys } = await import('../content/system/config/config-schema.js');
  assert.equal(getAllConfigKeys().includes(SECONDARY_RUNTIME_STATUS_KEY), false);
  assert.equal(getBackupConfigKeys().includes(SECONDARY_RUNTIME_STATUS_KEY), false);
  assert.deepEqual(parseSecondaryRuntimeStatus(snapshot()), snapshot());
  let getters = 0;
  const accessor = snapshot();
  Object.defineProperty(accessor, 'status', { enumerable: true, get() { getters++; return 'ready'; } });
  for (const value of [null, [], snapshot({ token: 'secret' }), snapshot({ effectiveLanguage: 'auto' }),
    snapshot({ quality: { isCC: false, degraded: false, track: {} } }), snapshot({ status: 'resolved' }),
    snapshot({ updatedAt: Infinity }), snapshot({ videoId: '' }), snapshot({ reason: {} }),
    snapshot({ isManualFallback: 'yes' }), snapshot({ [Symbol('hidden')]: 1 }), accessor,
    Object.assign(Object.create({ key: 'JWT' }), snapshot()), new Proxy(snapshot(), {})]) {
    assert.equal(parseSecondaryRuntimeStatus(value), null);
  }
  assert.equal(getters, 0);
  const reads = [];
  assert.deepEqual(await readSecondaryRuntimeStatus({ async get(key) { reads.push(key); return { [key]: snapshot() }; } }), snapshot());
  assert.deepEqual(reads, ['subpalSecondaryRuntimeStatus']);
  assert.equal(await readSecondaryRuntimeStatus({ async get() { throw new Error('offline'); } }), null);
  assert.equal(await readSecondaryRuntimeStatus({ async get() { return {}; } }), null);
});

test('late runtime storage reads cannot overwrite a newer manual UI choice and unavailable storage keeps the auto label', async () => {
  const { updateSecondaryRuntimeStatus } = await import('../shared/secondary-runtime-status.js');
  const element = { textContent: '' };
  let release;
  const pending = updateSecondaryRuntimeStatus(element, 'auto', { get: () => new Promise(resolve => { release = resolve; }) });
  assert.equal(element.textContent, '自動（跟隨影片原始語言）');
  await updateSecondaryRuntimeStatus(element, 'ja', {});
  release({ subpalSecondaryRuntimeStatus: snapshot() });
  await pending;
  assert.equal(element.textContent, '手動：日本語');
  await updateSecondaryRuntimeStatus(element, 'auto', { async get() { throw new Error('offline'); } });
  assert.equal(element.textContent, '自動（跟隨影片原始語言）');
});

test('runtime labels cover all statuses, exact/base/code language names, quality and fallback without mistaking suppression for failure', async () => {
  const { formatSecondaryRuntimeStatus } = await import('../shared/secondary-runtime-status.js');
  assert.equal(formatSecondaryRuntimeStatus('auto', null), '自動（跟隨影片原始語言）');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ status: 'manual' })), '自動（跟隨影片原始語言）');
  assert.equal(formatSecondaryRuntimeStatus('ja', snapshot()), '手動：日本語');
  for (const [status, expected] of [
    ['resolving', '自動：解析中…'], ['ready', '自動：日本語'], ['missing', '自動：此影片沒有日本語字幕'],
    ['unknown', '自動：無法判斷原始語言'], ['ambiguous', '自動：此影片有多種原始語言'],
    ['unavailable', '自動：目前無法讀取原始語言']
  ]) assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ status, ...(status === 'unavailable' ? { effectiveLanguage: null } : {}) })), expected);
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ effectiveLanguage: 'ja-JP' })), '自動：日本語');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ effectiveLanguage: 'zh-Hans' })), '自動：简体中文');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ effectiveLanguage: 'da' })), '自動：da');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ effectiveLanguage: 'da-DK' })), '自動：da-DK');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ quality: { isCC: true, degraded: true } })), '自動：日本語（CC、降級）');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ reason: 'same-primary-track' })), '自動：日本語（與主要字幕同軌，已省略）');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ isManualFallback: true, reason: 'same-primary-track' })),
    '自動：目前無法讀取原始語言；使用上次手動語言：日本語（與主要字幕同軌，已省略）');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ status: 'unavailable', reason: 'switch-track-timeout' })), '自動：無法取得日本語字幕');
  assert.equal(formatSecondaryRuntimeStatus('auto', snapshot({ effectiveLanguage: 'auto' })), '自動（跟隨影片原始語言）');
});
