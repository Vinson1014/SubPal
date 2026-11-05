/** 只依 native 標記解析；不讀取目前配音、軌道名稱或帳戶語言。 */
export function resolveOriginalLanguage(audioTracks) {
  const nativeLanguages = [];
  for (const track of Array.isArray(audioTracks) ? audioTracks : []) {
    if (track?.isNative !== true || typeof track.bcp47 !== 'string' || !track.bcp47) continue;
    try {
      nativeLanguages.push(Intl.getCanonicalLocales(track.bcp47)[0]);
    } catch {
      // 無效語言碼不是原始語言證據，忽略而非猜測或採用名稱。
      continue;
    }
  }
  const languages = [...new Set(nativeLanguages)];
  if (languages.length === 0) return { status: 'unknown', reason: 'no-valid-native-audio-language' };
  const baseLanguages = new Set(languages.map(language => new Intl.Locale(language).language));
  if (baseLanguages.size > 1) return { status: 'ambiguous', reason: 'multiple-native-audio-languages' };
  return {
    status: 'resolved',
    reason: 'native-audio-language',
    baseLanguage: new Intl.Locale(languages[0]).language,
    languages
  };
}
