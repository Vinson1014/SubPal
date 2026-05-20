// 僅供 extension 頁面使用：options 與 tutorial 共用的字幕預覽 renderer。
// 這裡刻意不 import SubtitleDisplay，避免影響 Netflix 實際播放渲染鏈路。

const PREVIEW_TEXT_BY_LANGUAGE = {
  'zh-Hant': '這是一段字幕預覽',
  'zh-Hans': '这是一段字幕预览',
  en: 'This is a subtitle preview',
  ja: 'これは字幕プレビューです',
  ko: '자막 미리보기입니다',
  es: 'Esta es una vista previa de subtítulos',
  fr: 'Aperçu des sous-titres',
  de: 'Dies ist eine Untertitelvorschau',
  it: 'Anteprima dei sottotitoli',
  pt: 'Esta é uma prévia da legenda',
  ru: 'Это предварительный просмотр субтитров',
  ar: 'هذه معاينة للترجمة',
  th: 'นี่คือตัวอย่างคำบรรยาย',
  vi: 'Đây là bản xem trước phụ đề',
  id: 'Ini adalah pratinjau subtitle',
  ms: 'Ini ialah pratonton sari kata',
  hi: 'यह उपशीर्षक पूर्वावलोकन है',
  tr: 'Bu bir altyazı önizlemesidir',
  nl: 'Dit is een ondertitelvoorbeeld',
  pl: 'To jest podgląd napisów',
  sv: 'Det här är en förhandsvisning av undertexter'
};

export function getPreviewText(languageCode, type, languages = []) {
  if (PREVIEW_TEXT_BY_LANGUAGE[languageCode]) {
    return PREVIEW_TEXT_BY_LANGUAGE[languageCode];
  }

  const languageName = languages.find(language => language.code === languageCode)?.name || languageCode;
  return type === 'secondary'
    ? `${languageName} subtitle preview`
    : `${languageName} 字幕預覽`;
}

export function createSubtitlePreviewConfig(flatConfig) {
  return {
    isDualMode: !!flatConfig['subtitle.dualModeEnabled'],
    styleMode: flatConfig['subtitle.style.mode'],
    fontFamily: flatConfig['subtitle.style.fontFamily'],
    primaryLanguage: flatConfig['subtitle.primaryLanguage'],
    secondaryLanguage: flatConfig['subtitle.secondaryLanguage'],
    primary: {
      fontSize: Number(flatConfig['subtitle.style.primary.fontSize']),
      fontWeight: flatConfig['subtitle.style.primary.fontWeight'],
      textColor: flatConfig['subtitle.style.primary.textColor'],
      backgroundColor: flatConfig['subtitle.style.primary.backgroundColor']
    },
    secondary: {
      fontSize: Number(flatConfig['subtitle.style.secondary.fontSize']),
      fontWeight: flatConfig['subtitle.style.secondary.fontWeight'],
      textColor: flatConfig['subtitle.style.secondary.textColor'],
      backgroundColor: flatConfig['subtitle.style.secondary.backgroundColor']
    },
    netflixPreset: {
      fontFamily: flatConfig['subtitle.style.netflixPreset.fontFamily'],
      fontWeight: flatConfig['subtitle.style.netflixPreset.fontWeight'],
      textColor: flatConfig['subtitle.style.netflixPreset.textColor'],
      backgroundColor: flatConfig['subtitle.style.netflixPreset.backgroundColor'],
      textShadow: flatConfig['subtitle.style.netflixPreset.textShadow']
    }
  };
}

export function getEffectivePreviewStyle(previewConfig, type) {
  const styleConfig = previewConfig[type];

  if (previewConfig.styleMode === 'netflixPreset' || previewConfig.styleMode === 'nativeInherit') {
    return {
      fontSize: styleConfig.fontSize,
      fontFamily: previewConfig.netflixPreset.fontFamily,
      fontWeight: previewConfig.netflixPreset.fontWeight,
      textColor: styleConfig.textColor,
      backgroundColor: styleConfig.backgroundColor,
      textShadow: previewConfig.netflixPreset.textShadow
    };
  }

  return {
    fontSize: styleConfig.fontSize,
    fontFamily: previewConfig.fontFamily,
    fontWeight: styleConfig.fontWeight,
    textColor: styleConfig.textColor,
    backgroundColor: styleConfig.backgroundColor,
    textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)'
  };
}

export function applySubtitlePreviewStyle(element, previewConfig, type, options = {}) {
  if (!element || !previewConfig) return;

  const effectiveStyle = getEffectivePreviewStyle(previewConfig, type);
  const scale = options.scale || 1;
  const fontSize = Math.max(10, Math.round(effectiveStyle.fontSize * scale));
  const shouldNoWrap = !!options.noWrap;

  Object.assign(element.style, {
    display: 'inline-block',
    maxWidth: '100%',
    padding: '5px 10px',
    borderRadius: '4px',
    fontSize: `${fontSize}px`,
    fontFamily: effectiveStyle.fontFamily,
    fontWeight: effectiveStyle.fontWeight,
    fontStyle: 'normal',
    lineHeight: '1.2',
    color: effectiveStyle.textColor,
    backgroundColor: effectiveStyle.backgroundColor,
    textAlign: 'center',
    textShadow: effectiveStyle.textShadow,
    whiteSpace: shouldNoWrap ? 'normal' : 'pre-wrap',
    wordBreak: shouldNoWrap ? 'keep-all' : 'break-word',
    overflowWrap: shouldNoWrap ? 'normal' : 'anywhere',
    border: 'none',
    opacity: '1',
    boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.75)',
    transition: 'color 0.15s ease, background-color 0.15s ease, font-size 0.15s ease'
  });
}

export function renderSubtitlePreview({
  primaryElement,
  secondaryElement,
  config,
  languages = [],
  primaryText,
  secondaryText,
  scale = 1,
  noWrap = false
}) {
  const previewConfig = createSubtitlePreviewConfig(config);

  if (primaryElement) {
    primaryElement.textContent = primaryText || getPreviewText(previewConfig.primaryLanguage, 'primary', languages);
    applySubtitlePreviewStyle(primaryElement, previewConfig, 'primary', { scale, noWrap });
  }

  if (secondaryElement) {
    secondaryElement.textContent = secondaryText || getPreviewText(previewConfig.secondaryLanguage, 'secondary', languages);
    secondaryElement.style.display = previewConfig.isDualMode ? 'inline-block' : 'none';

    if (previewConfig.isDualMode) {
      applySubtitlePreviewStyle(secondaryElement, previewConfig, 'secondary', { scale, noWrap });
    }
  }
}
