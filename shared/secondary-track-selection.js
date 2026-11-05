/** 次要字幕專用的純選軌規則；主要字幕保留既有 discovery／選軌行為。 */
export function normalizeSubtitleLanguage(value) {
  if (typeof value !== 'string' || value.toLowerCase() === 'auto') return null;
  try {
    return Intl.getCanonicalLocales(value)[0]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

function priority(track) {
  if (track.trackType === 'PRIMARY' && track.rawTrackType === 'SUBTITLES') return 0;
  if (track.rawTrackType === 'CLOSEDCAPTIONS' || track.trackType === 'ASSISTIVE') return 1;
  return 2;
}

/** 已知 identity 優先；任一 identity 缺少時才比較完整 canonical 語言，不做 base 回退。 */
export function isSameSubtitleSource(primary, secondary) {
  if (!primary || !secondary) return false;
  if (primary.trackId !== null && primary.trackId !== undefined &&
    secondary.trackId !== null && secondary.trackId !== undefined) {
    return primary.trackId === secondary.trackId;
  }
  const language = normalizeSubtitleLanguage(primary.code);
  return !!language && language === normalizeSubtitleLanguage(secondary.code);
}

export function selectSecondaryTrack(languageCodes, tracks) {
  const targets = (Array.isArray(languageCodes) ? languageCodes : [languageCodes])
    .map(normalizeSubtitleLanguage).filter(Boolean);
  const eligible = (tracks || []).filter(track => track && !track.isNoneTrack && !track.isForcedNarrative &&
    normalizeSubtitleLanguage(track.code));
  let matches = eligible.filter(track => targets.includes(normalizeSubtitleLanguage(track.code)));
  if (!matches.length && targets.length) {
    const bases = new Set(targets.map(code => code.split('-')[0]));
    const baseMatches = eligible.filter(track => bases.has(normalizeSubtitleLanguage(track.code).split('-')[0]));
    const codes = new Set(baseMatches.map(track => normalizeSubtitleLanguage(track.code)));
    if (codes.size > 1) return { status: 'ambiguous', track: null, candidates: [], reason: 'ambiguous-secondary-language' };
    matches = baseMatches.filter(track => {
      const code = normalizeSubtitleLanguage(track.code);
      if (!code.startsWith('zh')) return true;
      // 不以地區或 generic zh 猜測繁簡；只有明確相同 script 才能回退。
      const script = new Intl.Locale(code).script;
      return script && targets.some(target => new Intl.Locale(target).script === script);
    });
  }
  const candidates = matches.sort((left, right) => priority(left) - priority(right))
    .map(track => ({ ...track, isCC: priority(track) === 1, degraded: false }));
  return candidates.length ? { status: 'selected', track: candidates[0], candidates, reason: null } :
    { status: 'missing', track: null, candidates: [], reason: 'no-eligible-secondary-track' };
}
