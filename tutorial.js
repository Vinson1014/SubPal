// SubPal 初始設定教學
// 使用 config-schema.js 作為設定欄位的單一真相來源。

import {
  SUPPORTED_LANGUAGES,
  SUBTITLE_FONT_PRESETS,
  SUBTITLE_FONT_WEIGHT_OPTIONS,
  SUBTITLE_STYLE_MODES,
  getDefaultValues
} from './content/system/config/config-schema.js';
import {
  renderSubtitlePreview
} from './shared/subtitle-preview-renderer.js';

const DEFAULT_CONFIG = getDefaultValues();

function getNestedValue(obj, path) {
  const keys = path.split('.');
  let value = obj;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return undefined;
    }
  }

  return value;
}

function flatToNested(flatItems) {
  const nested = {};

  for (const [key, value] of Object.entries(flatItems)) {
    const keys = key.split('.');
    const lastKey = keys.pop();
    let current = nested;

    for (const item of keys) {
      if (!(item in current)) {
        current[item] = {};
      }
      current = current[item];
    }

    current[lastKey] = value;
  }

  return nested;
}

function deepMerge(existing, updates) {
  const result = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      key in result &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage?.local;
}

function readFallbackStorage() {
  try {
    return JSON.parse(localStorage.getItem('subpal-tutorial-config') || '{}');
  } catch {
    return {};
  }
}

function writeFallbackStorage(items) {
  const current = readFallbackStorage();
  localStorage.setItem('subpal-tutorial-config', JSON.stringify(deepMerge(current, items)));
}

async function loadConfig() {
  const flatKeys = Object.keys(DEFAULT_CONFIG);
  const rootKeys = [...new Set(flatKeys.map(key => key.split('.')[0]))];
  const result = hasChromeStorage()
    ? await chrome.storage.local.get(rootKeys)
    : readFallbackStorage();
  const config = {};

  for (const flatKey of flatKeys) {
    const value = getNestedValue(result, flatKey);
    config[flatKey] = value !== undefined ? value : DEFAULT_CONFIG[flatKey];
  }

  return config;
}

async function saveConfig(key, value) {
  await saveConfigMultiple({ [key]: value });
}

async function saveConfigMultiple(items) {
  const nested = flatToNested(items);
  const rootKeys = [...new Set(Object.keys(items).map(key => key.split('.')[0]))];

  if (!hasChromeStorage()) {
    writeFallbackStorage(nested);
    return;
  }

  const existing = await chrome.storage.local.get(rootKeys);
  const merged = deepMerge(existing, nested);
  await chrome.storage.local.set(merged);
}

function parseRgba(value) {
  const match = String(value).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!match) {
    return { hex: '#000000', opacity: 1 };
  }

  const r = Number(match[1]).toString(16).padStart(2, '0');
  const g = Number(match[2]).toString(16).padStart(2, '0');
  const b = Number(match[3]).toString(16).padStart(2, '0');
  const opacity = match[4] ? Number(match[4]) : 1;

  return { hex: `#${r}${g}${b}`, opacity };
}

function toRgba(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function getLanguageName(languageCode) {
  return SUPPORTED_LANGUAGES.find(language => language.code === languageCode)?.name || languageCode;
}

class TutorialManager {
  constructor() {
    this.currentStep = 1;
    this.totalSteps = 6;
    this.config = { ...DEFAULT_CONFIG };
    this.toastTimer = null;
    this.popupGuideCompleted = false;
    this.popupDetectionHandler = null;
  }

  async init() {
    this.populateStaticSelects();
    this.setupEventListeners();
    this.config = await loadConfig();
    this.restoreUIFromConfig();
    this.goToStep(1);
  }

  populateStaticSelects() {
    this.populateLanguageSelect('setupPrimaryLanguage');
    this.populateLanguageSelect('setupSecondaryLanguage');
    this.populateLanguageSelect('submitLanguageSelect');
    this.populateSelect('setupStyleMode', SUBTITLE_STYLE_MODES, 'value', 'label');
    this.populateSelect('setupFontPreset', SUBTITLE_FONT_PRESETS, 'value', 'label');
    this.populateSelect('primaryFontWeight', SUBTITLE_FONT_WEIGHT_OPTIONS, 'value', 'label');
    this.populateSelect('secondaryFontWeight', SUBTITLE_FONT_WEIGHT_OPTIONS, 'value', 'label');
  }

  populateLanguageSelect(id) {
    const select = document.getElementById(id);
    if (!select) return;

    select.innerHTML = '';
    for (const language of SUPPORTED_LANGUAGES) {
      select.add(new Option(language.name, language.code));
    }
  }

  populateSelect(id, items, valueKey, labelKey) {
    const select = document.getElementById(id);
    if (!select) return;

    select.innerHTML = '';
    for (const item of items) {
      select.add(new Option(item[labelKey], item[valueKey]));
    }
  }

  setupEventListeners() {
    document.querySelectorAll('[data-action="next"]').forEach(button => {
      button.addEventListener('click', () => this.nextStep());
    });

    document.querySelectorAll('.step-item[data-step]').forEach(item => {
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');

      const navigateToStep = () => {
        this.goToStep(Number(item.dataset.step));
      };

      item.addEventListener('click', navigateToStep);
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          navigateToStep();
        }
      });
    });

    document.getElementById('prevBtn')?.addEventListener('click', () => this.previousStep());
    document.getElementById('nextBtn')?.addEventListener('click', () => this.nextStep());
    document.getElementById('skipTutorialBtn')?.addEventListener('click', () => this.confirmSkip());
    document.getElementById('skip-intro-btn')?.addEventListener('click', () => this.confirmSkip());

    document.getElementById('openNetflixBtn')?.addEventListener('click', async () => {
      await this.finishTutorial(false);
      window.open('https://www.netflix.com', '_blank');
      window.close();
    });
    document.getElementById('openOptionsBtn')?.addEventListener('click', async () => {
      await this.finishTutorial(false);
      if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
    });
    document.getElementById('closeTutorialBtn')?.addEventListener('click', () => this.finishTutorial());

    document.getElementById('setupSingleMode')?.addEventListener('change', () => this.setDualMode(false));
    document.getElementById('setupDualMode')?.addEventListener('change', () => this.setDualMode(true));
    document.getElementById('setupPrimaryLanguage')?.addEventListener('change', event => this.updateLanguage('primary', event.target.value));
    document.getElementById('setupSecondaryLanguage')?.addEventListener('change', event => this.updateLanguage('secondary', event.target.value));

    document.getElementById('setupStyleMode')?.addEventListener('change', event => this.updateStyleMode(event.target.value));
    document.getElementById('setupFontPreset')?.addEventListener('change', event => this.updateFontPreset(event.target.value));

    this.bindStyleControls('primary', 'subtitle.style.primary');
    this.bindStyleControls('secondary', 'subtitle.style.secondary');

    document.getElementById('resetStylesBtn')?.addEventListener('click', () => this.resetSubtitleSettings());

    document.getElementById('mockSubtitleZone')?.addEventListener('mouseenter', () => {
      this.hideSubtitleHoverGuide();
      document.getElementById('mockToolbar')?.classList.add('active');
    });
    document.getElementById('mockSubtitleZone')?.addEventListener('focusin', () => this.hideSubtitleHoverGuide());
    document.getElementById('mockSubtitleZone')?.addEventListener('mouseleave', () => {
      document.getElementById('mockToolbar')?.classList.remove('active');
    });
    document.getElementById('openSubmitDemo')?.addEventListener('click', () => this.openSubmitDemo());
    document.getElementById('mockUpvote')?.addEventListener('click', () => this.showToast('已記錄這次模擬讚票'));
    document.getElementById('mockDownvote')?.addEventListener('click', () => this.showToast('已記錄這次模擬倒讚'));

    document.getElementById('closeSubmitDemo')?.addEventListener('click', () => this.closeSubmitDemo());
    document.getElementById('cancelSubmitDemo')?.addEventListener('click', () => this.closeSubmitDemo());
    document.getElementById('submitDemoBtn')?.addEventListener('click', () => this.submitDemo());
    document.getElementById('submitOverlay')?.addEventListener('click', event => {
      if (event.target.id === 'submitOverlay') {
        this.closeSubmitDemo();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight') this.nextStep();
      if (event.key === 'ArrowLeft') this.previousStep();
      if (event.key === 'Escape') this.closeSubmitDemo();
    });
  }

  bindStyleControls(type, keyPrefix) {
    const fontSize = document.getElementById(`${type}FontSize`);
    const fontWeight = document.getElementById(`${type}FontWeight`);
    const textColor = document.getElementById(`${type}TextColor`);
    const backgroundColor = document.getElementById(`${type}BackgroundColor`);
    const backgroundOpacity = document.getElementById(`${type}BackgroundOpacity`);

    fontSize?.addEventListener('input', event => {
      const size = Number(event.target.value);
      this.setConfigValue(`${keyPrefix}.fontSize`, size);
      this.updateStyleControlValues(type);
      this.updatePreviews();
      saveConfig(`${keyPrefix}.fontSize`, size);
    });

    fontWeight?.addEventListener('change', event => {
      this.setConfigValue(`${keyPrefix}.fontWeight`, event.target.value);
      this.updatePreviews();
      saveConfig(`${keyPrefix}.fontWeight`, event.target.value);
    });

    textColor?.addEventListener('input', event => {
      this.setConfigValue(`${keyPrefix}.textColor`, event.target.value);
      this.updateStyleControlValues(type);
      this.updatePreviews();
    });
    textColor?.addEventListener('change', event => saveConfig(`${keyPrefix}.textColor`, event.target.value));

    const updateBackground = shouldSave => {
      const hex = backgroundColor?.value || '#000000';
      const opacity = Number(backgroundOpacity?.value ?? 1);
      const rgba = toRgba(hex, opacity);
      this.setConfigValue(`${keyPrefix}.backgroundColor`, rgba);
      this.updateStyleControlValues(type);
      this.updatePreviews();
      if (shouldSave) {
        saveConfig(`${keyPrefix}.backgroundColor`, rgba);
      }
    };

    backgroundColor?.addEventListener('input', () => updateBackground(false));
    backgroundColor?.addEventListener('change', () => updateBackground(true));
    backgroundOpacity?.addEventListener('input', () => updateBackground(true));
  }

  setConfigValue(key, value) {
    this.config[key] = value;
  }

  restoreUIFromConfig() {
    const isDualMode = this.config['subtitle.dualModeEnabled'];
    const singleMode = document.getElementById('setupSingleMode');
    const dualMode = document.getElementById('setupDualMode');
    if (singleMode) singleMode.checked = !isDualMode;
    if (dualMode) dualMode.checked = isDualMode;

    this.setValue('setupPrimaryLanguage', this.config['subtitle.primaryLanguage']);
    this.setValue('setupSecondaryLanguage', this.config['subtitle.secondaryLanguage']);
    this.setValue('submitLanguageSelect', this.config['subtitle.primaryLanguage']);
    this.setValue('setupStyleMode', this.config['subtitle.style.mode']);
    this.setValue('setupFontPreset', this.config['subtitle.style.fontPreset']);

    this.updateStyleControls('primary', {
      fontSize: this.config['subtitle.style.primary.fontSize'],
      fontWeight: this.config['subtitle.style.primary.fontWeight'],
      textColor: this.config['subtitle.style.primary.textColor'],
      backgroundColor: this.config['subtitle.style.primary.backgroundColor']
    });

    this.updateStyleControls('secondary', {
      fontSize: this.config['subtitle.style.secondary.fontSize'],
      fontWeight: this.config['subtitle.style.secondary.fontWeight'],
      textColor: this.config['subtitle.style.secondary.textColor'],
      backgroundColor: this.config['subtitle.style.secondary.backgroundColor']
    });

    this.updateSubtitleModeUI();
    this.updateStyleModeUI();
    this.updatePreviews();
    this.updateSummary();
  }

  setValue(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.value = value;
    }
  }

  updateStyleControls(type, styleConfig) {
    this.setValue(`${type}FontSize`, styleConfig.fontSize);
    this.setValue(`${type}FontWeight`, styleConfig.fontWeight);
    this.setValue(`${type}TextColor`, styleConfig.textColor);

    const { hex, opacity } = parseRgba(styleConfig.backgroundColor);
    this.setValue(`${type}BackgroundColor`, hex);
    this.setValue(`${type}BackgroundOpacity`, opacity);
    this.updateStyleControlValues(type);
  }

  updateStyleControlValues(type) {
    const fontSize = document.getElementById(`${type}FontSize`)?.value;
    const textColor = document.getElementById(`${type}TextColor`)?.value;
    const backgroundColor = document.getElementById(`${type}BackgroundColor`)?.value;
    const backgroundOpacity = Number(document.getElementById(`${type}BackgroundOpacity`)?.value ?? 1);

    this.setText(`${type}FontSizeValue`, fontSize);
    this.setText(`${type}TextColorHex`, textColor);
    this.setText(`${type}BackgroundColorHex`, backgroundColor);
    this.setText(`${type}BackgroundOpacityValue`, backgroundOpacity.toFixed(2));
  }

  setText(id, text) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = text;
    }
  }

  async setDualMode(isDualMode) {
    this.config['subtitle.dualModeEnabled'] = isDualMode;
    this.updateSubtitleModeUI();
    this.updateStyleModeUI();
    this.updatePreviews();
    this.updateSummary();
    await saveConfig('subtitle.dualModeEnabled', isDualMode);
  }

  async updateLanguage(type, value) {
    const key = type === 'primary' ? 'subtitle.primaryLanguage' : 'subtitle.secondaryLanguage';
    this.config[key] = value;
    if (type === 'primary') {
      this.setValue('submitLanguageSelect', value);
    }
    this.updateLanguageLabels();
    this.updatePreviews();
    this.updateSummary();
    await saveConfig(key, value);
  }

  async updateStyleMode(value) {
    this.config['subtitle.style.mode'] = value;
    this.updateStyleModeUI();
    this.updatePreviews();
    this.updateSummary();
    await saveConfig('subtitle.style.mode', value);
  }

  async updateFontPreset(value) {
    const preset = SUBTITLE_FONT_PRESETS.find(item => item.value === value);
    if (!preset) return;

    this.config['subtitle.style.fontPreset'] = preset.value;
    this.config['subtitle.style.fontFamily'] = preset.fontFamily;
    this.updatePreviews();
    await saveConfigMultiple({
      'subtitle.style.fontPreset': preset.value,
      'subtitle.style.fontFamily': preset.fontFamily
    });
  }

  updateSubtitleModeUI() {
    const isDualMode = this.config['subtitle.dualModeEnabled'];
    const secondaryGroup = document.getElementById('setupSecondaryLanguageGroup');
    const secondaryPanel = document.getElementById('secondaryStylePanel');
    const secondarySelect = document.getElementById('setupSecondaryLanguage');

    if (secondaryGroup) {
      secondaryGroup.style.display = isDualMode ? 'flex' : 'none';
    }
    if (secondaryPanel) {
      secondaryPanel.classList.toggle('disabled', !isDualMode);
      secondaryPanel.querySelectorAll('input, select').forEach(input => {
        input.disabled = !isDualMode;
      });
    }
    if (secondarySelect) {
      secondarySelect.disabled = !isDualMode;
    }

    this.updateLanguageLabels();
  }

  updateStyleModeUI() {
    const isCustom = this.config['subtitle.style.mode'] === 'custom';
    const fontPresetControl = document.getElementById('setupFontPresetControl');

    if (fontPresetControl) {
      fontPresetControl.style.display = isCustom ? 'block' : 'none';
    }

    ['primaryFontWeight', 'secondaryFontWeight'].forEach(id => {
      const control = document.getElementById(id);
      if (control) {
        control.disabled = !isCustom || (id.startsWith('secondary') && !this.config['subtitle.dualModeEnabled']);
      }
    });
  }

  updateLanguageLabels() {
    this.setText('primaryLanguageName', getLanguageName(this.config['subtitle.primaryLanguage']));
    this.setText('secondaryLanguageName', getLanguageName(this.config['subtitle.secondaryLanguage']));
  }

  updatePreviews() {
    [
      {
        primaryElement: document.getElementById('miniPrimaryPreview'),
        secondaryElement: document.getElementById('miniSecondaryPreview'),
        primaryText: '這是一段更準確的字幕',
        secondaryText: 'This is a clearer subtitle',
        scale: 0.56,
        noWrap: true
      },
      {
        primaryElement: document.getElementById('setupPrimaryPreview'),
        secondaryElement: document.getElementById('setupSecondaryPreview'),
        scale: 0.68,
        noWrap: true
      },
      {
        primaryElement: document.getElementById('stylePrimaryPreview'),
        secondaryElement: document.getElementById('styleSecondaryPreview'),
        scale: 0.62,
        noWrap: true
      },
      {
        primaryElement: document.getElementById('mockPrimaryPreview'),
        secondaryElement: document.getElementById('mockSecondaryPreview'),
        primaryText: '這是可以被社群改善的字幕翻譯',
        secondaryText: 'This translation can be improved by the community',
        scale: 0.62,
        noWrap: true
      }
    ].forEach(preview => {
      renderSubtitlePreview({
        ...preview,
        config: this.config,
        languages: SUPPORTED_LANGUAGES
      });
    });
  }

  updateSummary() {
    const styleMode = SUBTITLE_STYLE_MODES.find(item => item.value === this.config['subtitle.style.mode']);
    this.setText('summaryMode', this.config['subtitle.dualModeEnabled'] ? '雙語字幕' : '單語字幕');
    this.setText(
      'summaryLanguages',
      this.config['subtitle.dualModeEnabled']
        ? `${getLanguageName(this.config['subtitle.primaryLanguage'])} / ${getLanguageName(this.config['subtitle.secondaryLanguage'])}`
        : getLanguageName(this.config['subtitle.primaryLanguage'])
    );
    this.setText('summaryStyle', styleMode?.label || this.config['subtitle.style.mode']);
  }

  showSubtitleHoverGuide() {
    document.getElementById('mockSubtitleZone')?.classList.remove('hover-guide-dismissed');
  }

  hideSubtitleHoverGuide() {
    document.getElementById('mockSubtitleZone')?.classList.add('hover-guide-dismissed');
  }

  startPopupGuideDetection() {
    this.renderPopupGuideState();
    this.stopPopupGuideDetection();

    if (this.popupGuideCompleted) {
      return;
    }

    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
      return;
    }

    this.popupDetectionHandler = message => {
      if (message?.type === 'POPUP_ACTIVE_PROFILE_STATS') {
        this.completePopupGuide();
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(this.popupDetectionHandler);
  }

  stopPopupGuideDetection() {
    if (
      this.popupDetectionHandler &&
      typeof chrome !== 'undefined' &&
      chrome.runtime?.onMessage?.removeListener
    ) {
      chrome.runtime.onMessage.removeListener(this.popupDetectionHandler);
    }

    this.popupDetectionHandler = null;
  }

  completePopupGuide() {
    if (this.currentStep !== 5 || this.popupGuideCompleted) {
      return;
    }

    this.popupGuideCompleted = true;
    this.stopPopupGuideDetection();
    this.renderPopupGuideState();
    this.showToast('已偵測到 SubPal popup 開啟');
  }

  renderPopupGuideState() {
    document
      .getElementById('popupChromeDemo')
      ?.classList.toggle('popup-opened', this.popupGuideCompleted);
  }

  async resetSubtitleSettings() {
    if (!confirm('確定要將字幕設定重置為預設值嗎？')) {
      return;
    }

    const defaults = {
      'subtitle.dualModeEnabled': DEFAULT_CONFIG['subtitle.dualModeEnabled'],
      'subtitle.primaryLanguage': DEFAULT_CONFIG['subtitle.primaryLanguage'],
      'subtitle.secondaryLanguage': DEFAULT_CONFIG['subtitle.secondaryLanguage'],
      'subtitle.style.mode': DEFAULT_CONFIG['subtitle.style.mode'],
      'subtitle.style.fontPreset': DEFAULT_CONFIG['subtitle.style.fontPreset'],
      'subtitle.style.fontFamily': DEFAULT_CONFIG['subtitle.style.fontFamily'],
      'subtitle.style.primary.fontSize': DEFAULT_CONFIG['subtitle.style.primary.fontSize'],
      'subtitle.style.primary.fontWeight': DEFAULT_CONFIG['subtitle.style.primary.fontWeight'],
      'subtitle.style.primary.textColor': DEFAULT_CONFIG['subtitle.style.primary.textColor'],
      'subtitle.style.primary.backgroundColor': DEFAULT_CONFIG['subtitle.style.primary.backgroundColor'],
      'subtitle.style.secondary.fontSize': DEFAULT_CONFIG['subtitle.style.secondary.fontSize'],
      'subtitle.style.secondary.fontWeight': DEFAULT_CONFIG['subtitle.style.secondary.fontWeight'],
      'subtitle.style.secondary.textColor': DEFAULT_CONFIG['subtitle.style.secondary.textColor'],
      'subtitle.style.secondary.backgroundColor': DEFAULT_CONFIG['subtitle.style.secondary.backgroundColor']
    };

    Object.assign(this.config, defaults);
    await saveConfigMultiple(defaults);
    this.restoreUIFromConfig();
    this.showToast('字幕設定已重置');
  }

  goToStep(step) {
    if (step < 1 || step > this.totalSteps) return;

    const previousStep = this.currentStep;
    if (previousStep === 5 && step !== 5) {
      this.stopPopupGuideDetection();
    }

    this.currentStep = step;
    document.querySelectorAll('.tutorial-step').forEach(section => {
      section.classList.toggle('active', Number(section.dataset.step) === step);
    });
    document.querySelectorAll('.step-item').forEach(item => {
      const itemStep = Number(item.dataset.step);
      item.classList.toggle('active', itemStep === step);
      item.classList.toggle('completed', itemStep < step);
      if (itemStep === step) {
        item.setAttribute('aria-current', 'step');
      } else {
        item.removeAttribute('aria-current');
      }
    });

    document.getElementById('prevBtn').disabled = step === 1;
    document.getElementById('nextBtn').style.display = step === this.totalSteps ? 'none' : 'inline-flex';
    document.getElementById('skipTutorialBtn').style.visibility = step === this.totalSteps ? 'hidden' : 'visible';

    if (step === this.totalSteps) {
      this.updateSummary();
    }

    if (step === 4) {
      this.showSubtitleHoverGuide();
    }

    if (step === 5) {
      this.startPopupGuideDetection();
    }
  }

  nextStep() {
    if (this.currentStep < this.totalSteps) {
      this.goToStep(this.currentStep + 1);
    }
  }

  previousStep() {
    if (this.currentStep > 1) {
      this.goToStep(this.currentStep - 1);
    }
  }

  confirmSkip() {
    if (confirm('確定要跳過初始設定嗎？你之後仍可從設定頁調整字幕。')) {
      this.finishTutorial();
    }
  }

  async finishTutorial(shouldClose = true) {
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ tutorialCompleted: true });
    }
    localStorage.setItem('subpal-tutorial-completed', 'true');

    if (shouldClose) {
      window.close();
    }
  }

  openSubmitDemo() {
    const overlay = document.getElementById('submitOverlay');
    if (!overlay) return;

    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    document.getElementById('submitLanguageSelect').value = this.config['subtitle.primaryLanguage'];
    setTimeout(() => document.getElementById('submitTranslationInput')?.focus(), 50);
  }

  closeSubmitDemo() {
    const overlay = document.getElementById('submitOverlay');
    if (!overlay) return;

    document.getElementById('openSubmitDemo')?.focus();
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }

  submitDemo() {
    const translation = document.getElementById('submitTranslationInput')?.value.trim();
    const reason = document.getElementById('submitReasonInput')?.value.trim();

    if (!translation) {
      this.showToast('請輸入修正翻譯', true);
      return;
    }
    if (!reason) {
      this.showToast('請填寫調整原因', true);
      return;
    }

    this.closeSubmitDemo();
    this.showToast('模擬提交成功，感謝你的貢獻');
  }

  showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    clearTimeout(this.toastTimer);
    toast.textContent = message;
    toast.style.background = isError ? 'var(--color-danger)' : 'var(--color-accent)';
    toast.classList.add('show');

    this.toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2200);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const manager = new TutorialManager();
  manager.init().catch(error => {
    console.error('[Tutorial] 初始化失敗:', error);
  });
});
