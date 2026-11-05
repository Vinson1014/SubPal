import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSecondaryTrack } from '../shared/secondary-track-selection.js';

const track = (code, trackId, extra = {}) => ({
  code, trackId, name: '關閉', trackType: 'PRIMARY', rawTrackType: 'SUBTITLES',
  isNoneTrack: false, isForcedNarrative: false, ...extra
});

test('secondary selection uses exact language and structured priority, never names, none or forced', () => {
  const tracks = [
    track('ja', 'none', { isNoneTrack: true }),
    track('ja', 'forced', { isForcedNarrative: true }),
    track('ja', 'cc', { rawTrackType: 'CLOSEDCAPTIONS', trackType: 'ASSISTIVE' }),
    track('ja-JP', 'regional'), track('ja', 'full'), track('JA', 'full-2')
  ];
  const result = selectSecondaryTrack(['ja'], tracks);
  assert.equal(result.status, 'selected');
  assert.equal(result.track.trackId, 'full');
  assert.deepEqual(result.candidates.map(candidate => candidate.trackId), ['full', 'full-2', 'cc']);
  assert.equal(result.track.isCC, false);
});

test('secondary language fallback requires one distinct code and never infers Chinese script', () => {
  assert.equal(selectSecondaryTrack(['pt-BR'], [track('pt', 'pt')]).track?.trackId, 'pt');
  assert.equal(selectSecondaryTrack(['en-AU'], [track('en-US', 'us'), track('en-GB', 'gb')]).status, 'ambiguous');
  assert.equal(selectSecondaryTrack(['es-MX'], [track('es', 'es'), track('es-ES', 'spain')]).status, 'ambiguous');
  for (const [target, available] of [['zh-Hant', 'zh-Hans'], ['zh', 'zh-Hant'], ['zh-Hant', 'zh']]) {
    assert.equal(selectSecondaryTrack([target], [track(available, 'zh')]).status, 'missing');
  }
  assert.equal(selectSecondaryTrack(['ja', 'ja-JP'], [track('ja-JP', 'jp')]).track?.trackId, 'jp');
  assert.equal(selectSecondaryTrack(['da-DK'], [track('da', 'danish')]).track?.trackId, 'danish');
  assert.equal(selectSecondaryTrack(['auto'], [track('en', 'en')]).status, 'missing');
});

test('CC precedes other eligible tracks and invalid, none-only or forced-only lists stay missing', () => {
  const other = track('en', 'other', { trackType: 'OTHER', rawTrackType: 'OTHER' });
  const cc = track('en', 'cc', { trackType: 'ASSISTIVE', rawTrackType: 'OTHER' });
  assert.equal(selectSecondaryTrack('en', [other, cc]).track.isCC, true);
  assert.equal(selectSecondaryTrack('en', [other]).track.trackId, 'other');
  assert.equal(selectSecondaryTrack('en', [track('en', 'forced', { isForcedNarrative: true }),
    track('en', 'none', { isNoneTrack: true }), track('en_US', 'invalid')]).status, 'missing');
  assert.equal(selectSecondaryTrack('en-US', [track('EN-us', 'exact'), track('en', 'generic')]).track.trackId, 'exact');
  assert.equal(selectSecondaryTrack('pt-BR', [track('pt', 'first'), track('PT', 'second')]).track.trackId, 'first');
});
