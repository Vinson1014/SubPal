import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const DEFAULT_CONFIG = {
  debugMode: false,
  'crowdsourcing.endscreenTasksEnabled': true,
  'api.baseUrl': 'https://api.subpal.test',
  'subtitle.dualModeEnabled': true,
  'subtitle.primaryLanguage': 'zh-Hant',
  'subtitle.secondaryLanguage': 'en',
  'subtitle.style.mode': 'custom',
  'subtitle.style.fontPreset': 'clearSans',
  'subtitle.style.fontFamily': 'Arial, Helvetica, "Microsoft JhengHei", "PingFang TC", sans-serif',
  'subtitle.style.primary.fontSize': 55,
  'subtitle.style.primary.fontWeight': '700',
  'subtitle.style.primary.textColor': '#ffffff',
  'subtitle.style.primary.backgroundColor': 'rgba(0, 0, 0, 0.6)',
  'subtitle.style.primary.outlineEnabled': false,
  'subtitle.style.primary.outlineWidth': 2,
  'subtitle.style.primary.outlineColor': '#000000',
  'subtitle.style.primary.letterSpacing': 0,
  'subtitle.style.secondary.fontSize': 24,
  'subtitle.style.secondary.fontWeight': '400',
  'subtitle.style.secondary.textColor': '#ffff00',
  'subtitle.style.secondary.backgroundColor': 'rgba(0, 0, 0, 0.6)',
  'subtitle.style.secondary.outlineEnabled': false,
  'subtitle.style.secondary.outlineWidth': 2,
  'subtitle.style.secondary.outlineColor': '#000000',
  'subtitle.style.secondary.letterSpacing': 0
};

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(value, force) {
    if (force) {
      this.values.add(value);
      return true;
    }
    this.values.delete(value);
    return false;
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this._value = '';
    this.checked = false;
    this._textContent = '';
    this.style = {};
    this.disabled = false;
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.wrapper = { classList: new FakeClassList() };
  }

  get value() {
    return this._value;
  }

  set value(nextValue) {
    this._value = String(nextValue);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(nextValue) {
    this._textContent = String(nextValue);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type) {
    const listeners = this.listeners.get(type) || [];
    await Promise.all(listeners.map(listener => listener({ target: this })));
  }

  closest() {
    return this.wrapper;
  }
}

function flatToNested(flatItems) {
  const nested = {};

  for (const [flatKey, value] of Object.entries(flatItems)) {
    const path = flatKey.split('.');
    const lastKey = path.pop();
    let cursor = nested;

    for (const segment of path) {
      cursor[segment] ||= {};
      cursor = cursor[segment];
    }

    cursor[lastKey] = value;
  }

  return nested;
}

function deepMerge(existing, updates) {
  const result = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function createElementMap() {
  const ids = [
    'debugModeCheckbox', 'endscreenTasksEnabledCheckbox', 'apiBaseUrlInput',
    'singleMode', 'dualMode', 'primaryLanguageSelect', 'secondaryLanguageSelect',
    'subtitleStyleMode', 'subtitleFontPreset', 'fontPresetControl',
    'primaryPreview', 'secondaryPreview', 'secondaryLanguageGroup', 'secondaryStyleSection'
  ];

  for (const type of ['primary', 'secondary']) {
    ids.push(
      `${type}FontSize`, `${type}FontSizeValue`, `${type}FontWeight`,
      `${type}TextColor`, `${type}TextColorHex`, `${type}BackgroundColor`,
      `${type}BackgroundColorHex`, `${type}BackgroundOpacity`, `${type}BackgroundOpacityValue`,
      `${type}OutlineEnabled`, `${type}OutlineWidth`, `${type}OutlineWidthValue`,
      `${type}OutlineColor`, `${type}OutlineColorHex`, `${type}LetterSpacing`, `${type}LetterSpacingValue`
    );
  }

  return Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
}

async function loadOptionsHarness({ storage = {} } = {}) {
  const elements = createElementMap();
  const previewCalls = [];
  const setCalls = [];
  const stored = structuredClone(storage);
  const source = (await readFile(new URL('../options.js', import.meta.url), 'utf8'))
    .replace(/import\s+\{[\s\S]*?getDefaultValues\s*\}\s+from\s+'\.\/content\/system\/config\/config-schema\.js';\n/, '')
    .replace(/import\s+\{[\s\S]*?renderSubtitlePreview\s*\}\s+from\s+'\.\/shared\/subtitle-preview-renderer\.js';\n/, '')
    .concat('\nglobalThis.__optionsApi = { restoreOptionsUI, updateStyleControls, getPreviewConfigFromControls, setupStyleControlListeners, resetStyles };\n');

  const context = vm.createContext({
    console: { log() {}, error() {} },
    confirm: () => true,
    SUPPORTED_LANGUAGES: [{ code: 'zh-Hant', name: '繁體中文' }, { code: 'en', name: 'English' }],
    SUBTITLE_FONT_PRESETS: [{ value: 'clearSans', label: 'Clear Sans', fontFamily: DEFAULT_CONFIG['subtitle.style.fontFamily'] }],
    SUBTITLE_FONT_WEIGHT_OPTIONS: [{ value: '400', label: '400' }, { value: '700', label: '700' }],
    SUBTITLE_STYLE_MODES: [{ value: 'custom', label: '自訂' }],
    getDefaultValues: () => ({ ...DEFAULT_CONFIG }),
    renderSubtitlePreview: (args) => previewCalls.push(args),
    document: {
      getElementById: id => elements[id] || null,
      querySelectorAll: selector => selector.split(',').map(item => elements[item.trim().slice(1)]).filter(Boolean),
      addEventListener() {}
    },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0' }), connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) },
      storage: {
        local: {
          get: async (keys) => {
            if (!Array.isArray(keys)) return structuredClone(stored);
            return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
          },
          set: async (items) => {
            setCalls.push(structuredClone(items));
            Object.assign(stored, structuredClone(items));
          }
        }
      }
    }
  });

  vm.runInContext(source, context, { filename: 'options.js' });

  return { api: context.__optionsApi, elements, previewCalls, setCalls, stored };
}

test('Given old options storage missing outline controls When restoreOptionsUI loads Then controls and preview config use schema defaults', async () => {
  const { api, elements, previewCalls } = await loadOptionsHarness({
    storage: {
      subtitle: {
        dualModeEnabled: true,
        primaryLanguage: 'en',
        secondaryLanguage: 'zh-Hant',
        style: {
          mode: 'custom',
          fontPreset: 'clearSans',
          fontFamily: DEFAULT_CONFIG['subtitle.style.fontFamily'],
          primary: { fontSize: 61, fontWeight: '700', textColor: '#eeeeee', backgroundColor: 'rgba(10, 20, 30, 0.4)' },
          secondary: { fontSize: 28, fontWeight: '400', textColor: '#dddd00', backgroundColor: 'rgba(40, 50, 60, 0.5)' }
        }
      }
    }
  });
  elements.primaryOutlineEnabled.checked = false;
  elements.primaryOutlineWidth.value = '7';
  elements.primaryOutlineWidthValue.textContent = '7';
  elements.primaryOutlineColor.value = '#abcdef';
  elements.primaryOutlineColorHex.textContent = '#abcdef';
  elements.secondaryLetterSpacing.value = '4';
  elements.secondaryLetterSpacingValue.textContent = '4';

  await api.restoreOptionsUI();

  assert.equal(elements.primaryOutlineEnabled.checked, false);
  assert.equal(elements.primaryOutlineWidth.value, '2');
  assert.equal(elements.primaryOutlineWidthValue.textContent, '2');
  assert.equal(elements.primaryOutlineColor.value, '#000000');
  assert.equal(elements.primaryOutlineColorHex.textContent, '#000000');
  assert.equal(elements.secondaryLetterSpacing.value, '0');
  assert.equal(elements.secondaryLetterSpacingValue.textContent, '0');
  assert.equal(previewCalls.at(-1).config['subtitle.style.primary.outlineWidth'], 2);
  assert.equal(previewCalls.at(-1).config['subtitle.style.primary.outlineColor'], '#000000');
  assert.equal(previewCalls.at(-1).config['subtitle.style.secondary.letterSpacing'], 0);
});

test('Given style listeners are installed When outline and spacing controls change Then existing saveConfig path persists nested keys and previews immediately', async () => {
  const { api, elements, previewCalls, stored } = await loadOptionsHarness();
  api.setupStyleControlListeners('primary', 'subtitle.style.primary');
  api.setupStyleControlListeners('secondary', 'subtitle.style.secondary');

  elements.primaryOutlineEnabled.checked = false;
  await elements.primaryOutlineEnabled.dispatch('change');
  elements.primaryOutlineWidth.value = '3.5';
  await elements.primaryOutlineWidth.dispatch('input');
  elements.primaryOutlineColor.value = '#123456';
  await elements.primaryOutlineColor.dispatch('input');
  await elements.primaryOutlineColor.dispatch('change');
  elements.secondaryLetterSpacing.value = '1.5';
  await elements.secondaryLetterSpacing.dispatch('input');

  assert.equal(elements.primaryOutlineWidthValue.textContent, '3.5');
  assert.equal(elements.primaryOutlineColorHex.textContent, '#123456');
  assert.equal(elements.secondaryLetterSpacingValue.textContent, '1.5');
  assert.equal(stored.subtitle.style.primary.outlineEnabled, false);
  assert.equal(stored.subtitle.style.primary.outlineWidth, 3.5);
  assert.equal(stored.subtitle.style.primary.outlineColor, '#123456');
  assert.equal(stored.subtitle.style.secondary.letterSpacing, 1.5);
  assert.equal(previewCalls.at(-1).config['subtitle.style.primary.outlineWidth'], 3.5);
  assert.equal(previewCalls.at(-1).config['subtitle.style.primary.outlineColor'], '#123456');
  assert.equal(previewCalls.at(-1).config['subtitle.style.secondary.letterSpacing'], 1.5);
});

test('Given non-default outline and spacing settings When resetStyles runs Then saveConfigMultiple restores all new flat defaults', async () => {
  const { api, stored, setCalls } = await loadOptionsHarness({
    storage: deepMerge(flatToNested(DEFAULT_CONFIG), {
      subtitle: {
        style: {
          primary: { outlineEnabled: false, outlineWidth: 7, outlineColor: '#654321', letterSpacing: 4 },
          secondary: { outlineEnabled: false, outlineWidth: 6, outlineColor: '#abcdef', letterSpacing: 3 }
        }
      }
    })
  });

  await api.resetStyles();

  assert.equal(stored.subtitle.style.primary.outlineEnabled, false);
  assert.equal(stored.subtitle.style.primary.outlineWidth, 2);
  assert.equal(stored.subtitle.style.primary.outlineColor, '#000000');
  assert.equal(stored.subtitle.style.primary.letterSpacing, 0);
  assert.equal(stored.subtitle.style.secondary.outlineEnabled, false);
  assert.equal(stored.subtitle.style.secondary.outlineWidth, 2);
  assert.equal(stored.subtitle.style.secondary.outlineColor, '#000000');
  assert.equal(stored.subtitle.style.secondary.letterSpacing, 0);
  assert.equal(setCalls.at(0).subtitle.style.primary.outlineWidth, 2);
  assert.equal(setCalls.at(0).subtitle.style.secondary.letterSpacing, 0);
});
