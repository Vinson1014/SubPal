import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveOriginalLanguage } from '../shared/original-language-resolver.js';

test('單一 native 音軌解析原始語言，不受目前配音、名稱或 ASSISTIVE 類型影響', () => {
  assert.deepEqual(resolveOriginalLanguage([
    { bcp47: 'en', isNative: false, selected: true, displayName: 'Original' },
    { bcp47: 'ja-JP', isNative: true, trackType: 'ASSISTIVE' }
  ]), {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja-JP']
  });
});

test('同 base 的 native 標籤正規化去重並保留全部標籤，支援清單以外語言', () => {
  assert.deepEqual(resolveOriginalLanguage([
    { bcp47: 'JA-jp', isNative: true },
    { bcp47: 'ja', isNative: true },
    { bcp47: 'ja-JP', isNative: true }
  ]), {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja-JP', 'ja']
  });
  assert.deepEqual(resolveOriginalLanguage([{ bcp47: 'da', isNative: true }]), {
    status: 'resolved', reason: 'native-audio-language', baseLanguage: 'da', languages: ['da']
  });
});

test('不同 base 的 native 音軌有歧義，不挑清單第一項', () => {
  assert.deepEqual(resolveOriginalLanguage([
    { bcp47: 'en', isNative: true },
    { bcp47: 'ja', isNative: true }
  ]), { status: 'ambiguous', reason: 'multiple-native-audio-languages' });
});

test('缺少 native 或有效 BCP47 時 unknown，不採用 code、名稱或 truthy native 值', () => {
  const unknown = { status: 'unknown', reason: 'no-valid-native-audio-language' };
  for (const tracks of [
    [], null, {},
    [{ bcp47: 'ja' }, { bcp47: 'en', isNative: 'true' }],
    [null, {}, { isNative: true }, { isNative: true, bcp47: 123 },
      { isNative: true, bcp47: '' }, { isNative: true, bcp47: 'ja_JP' },
      { isNative: true, bcp47: 'not a language' }, { isNative: true, code: 'ja', displayName: 'Japanese' }]
  ]) assert.deepEqual(resolveOriginalLanguage(tracks), unknown);
  assert.deepEqual(resolveOriginalLanguage([
    { isNative: true, bcp47: 'invalid_code' }, { isNative: true, bcp47: 'ja' }
  ]), { status: 'resolved', reason: 'native-audio-language', baseLanguage: 'ja', languages: ['ja'] });
});
