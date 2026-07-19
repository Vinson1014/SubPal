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

const CUSTOM_BASE_TEXT_SHADOW = '1px 1px 1px rgba(0, 0, 0, 0.5)';
const NETFLIX_BASE_TEXT_SHADOW = '0 0 2px rgba(0, 0, 0, 0.9)';
const PREVIEW_BOX_SHADOW = '0 0 0 2px rgba(0, 0, 0, 0.75)';

function toFiniteNumber(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toStringValue(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function createTextStyleConfig(flatConfig, namespace, defaults) {
  const outlineEnabled = flatConfig[`subtitle.style.${namespace}.outlineEnabled`];

  return {
    fontSize: toFiniteNumber(flatConfig[`subtitle.style.${namespace}.fontSize`], defaults.fontSize),
    fontWeight: toStringValue(flatConfig[`subtitle.style.${namespace}.fontWeight`], defaults.fontWeight),
    textColor: toStringValue(flatConfig[`subtitle.style.${namespace}.textColor`], defaults.textColor),
    backgroundColor: toStringValue(flatConfig[`subtitle.style.${namespace}.backgroundColor`], defaults.backgroundColor),
    outlineEnabled: outlineEnabled === undefined ? false : outlineEnabled === true,
    outlineWidth: toFiniteNumber(flatConfig[`subtitle.style.${namespace}.outlineWidth`], 2),
    outlineColor: toStringValue(flatConfig[`subtitle.style.${namespace}.outlineColor`], '#000000'),
    letterSpacing: toFiniteNumber(flatConfig[`subtitle.style.${namespace}.letterSpacing`], 0)
  };
}

export function createTextOutlineShadow({ enabled, width, color, baseShadow }) {
  const safeBaseShadow = toStringValue(baseShadow, 'none');
  const safeWidth = toFiniteNumber(width, 0);

  if (!enabled || safeWidth <= 0) {
    return safeBaseShadow;
  }

  const offset = `${safeWidth}px`;
  const safeColor = toStringValue(color, '#000000');
  const outlineShadow = [
    `-${offset} 0 0 ${safeColor}`,
    `${offset} 0 0 ${safeColor}`,
    `0 -${offset} 0 ${safeColor}`,
    `0 ${offset} 0 ${safeColor}`,
    `-${offset} -${offset} 0 ${safeColor}`,
    `${offset} -${offset} 0 ${safeColor}`,
    `-${offset} ${offset} 0 ${safeColor}`,
    `${offset} ${offset} 0 ${safeColor}`
  ].join(', ');

  return safeBaseShadow === 'none' ? outlineShadow : `${outlineShadow}, ${safeBaseShadow}`;
}

export function getPreviewText(languageCode, type, languages = []) {
  if (PREVIEW_TEXT_BY_LANGUAGE[languageCode]) {
    return PREVIEW_TEXT_BY_LANGUAGE[languageCode];
  }

  const languageName = languages.find(language => language.code === languageCode)?.name || languageCode;
  return type === 'secondary'
    ? `${languageName} subtitle preview`
    : `${languageName} 字幕預覽`;
}

export function createSubtitlePreviewConfig(flatConfig = {}) {
  return {
    isDualMode: !!flatConfig['subtitle.dualModeEnabled'],
    styleMode: toStringValue(flatConfig['subtitle.style.mode'], 'custom'),
    fontFamily: toStringValue(flatConfig['subtitle.style.fontFamily'], 'Arial, Helvetica, "Microsoft JhengHei", "PingFang TC", sans-serif'),
    primaryLanguage: toStringValue(flatConfig['subtitle.primaryLanguage'], 'zh-Hant'),
    secondaryLanguage: toStringValue(flatConfig['subtitle.secondaryLanguage'], 'en'),
    primary: createTextStyleConfig(flatConfig, 'primary', {
      fontSize: 55,
      fontWeight: '700',
      textColor: '#ffffff',
      backgroundColor: 'rgba(0, 0, 0, 0.6)'
    }),
    secondary: createTextStyleConfig(flatConfig, 'secondary', {
      fontSize: 24,
      fontWeight: '400',
      textColor: '#ffff00',
      backgroundColor: 'rgba(0, 0, 0, 0.6)'
    }),
    netflixPreset: {
      fontFamily: toStringValue(flatConfig['subtitle.style.netflixPreset.fontFamily'], 'Arial, Helvetica, sans-serif'),
      fontWeight: toStringValue(flatConfig['subtitle.style.netflixPreset.fontWeight'], '700'),
      textColor: toStringValue(flatConfig['subtitle.style.netflixPreset.textColor'], '#ffffff'),
      backgroundColor: toStringValue(flatConfig['subtitle.style.netflixPreset.backgroundColor'], 'rgba(0, 0, 0, 0.6)'),
      textShadow: toStringValue(flatConfig['subtitle.style.netflixPreset.textShadow'], NETFLIX_BASE_TEXT_SHADOW)
    }
  };
}

export function getEffectivePreviewStyle(previewConfig, type) {
  const styleConfig = previewConfig[type];
  const hasOutline = styleConfig.outlineEnabled && styleConfig.outlineWidth > 0;

  if (previewConfig.styleMode === 'netflixPreset' || previewConfig.styleMode === 'nativeInherit') {
    return {
      fontSize: styleConfig.fontSize,
      fontFamily: previewConfig.netflixPreset.fontFamily,
      fontWeight: previewConfig.netflixPreset.fontWeight,
      textColor: styleConfig.textColor,
      backgroundColor: styleConfig.backgroundColor,
      textShadow: createTextOutlineShadow({
        enabled: styleConfig.outlineEnabled,
        width: styleConfig.outlineWidth,
        color: styleConfig.outlineColor,
        baseShadow: previewConfig.netflixPreset.textShadow
      }),
      letterSpacing: styleConfig.letterSpacing,
      hasOutline
    };
  }

  return {
    fontSize: styleConfig.fontSize,
    fontFamily: previewConfig.fontFamily,
    fontWeight: styleConfig.fontWeight,
    textColor: styleConfig.textColor,
    backgroundColor: styleConfig.backgroundColor,
    textShadow: createTextOutlineShadow({
      enabled: styleConfig.outlineEnabled,
      width: styleConfig.outlineWidth,
      color: styleConfig.outlineColor,
      baseShadow: CUSTOM_BASE_TEXT_SHADOW
    }),
    letterSpacing: styleConfig.letterSpacing,
    hasOutline
  };
}

export function applySubtitlePreviewStyle(element, previewConfig, type, options = {}) {
  if (!element || !previewConfig) return;

  const effectiveStyle = getEffectivePreviewStyle(previewConfig, type);
  const scale = toFiniteNumber(options.scale, 1) || 1;
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
    letterSpacing: `${effectiveStyle.letterSpacing}px`,
    color: effectiveStyle.textColor,
    backgroundColor: effectiveStyle.backgroundColor,
    textAlign: 'center',
    textShadow: effectiveStyle.textShadow,
    whiteSpace: shouldNoWrap ? 'normal' : 'pre-wrap',
    wordBreak: shouldNoWrap ? 'keep-all' : 'break-word',
    overflowWrap: shouldNoWrap ? 'normal' : 'anywhere',
    border: 'none',
    opacity: '1',
    boxShadow: effectiveStyle.hasOutline ? 'none' : PREVIEW_BOX_SHADOW,
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
