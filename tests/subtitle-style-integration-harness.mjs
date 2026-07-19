import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  SUBTITLE_FONT_PRESETS,
  SUBTITLE_FONT_WEIGHT_OPTIONS,
  SUBTITLE_STYLE_MODES,
  SUPPORTED_LANGUAGES,
  getDefaultValues
} from '../content/system/config/config-schema.js';
import * as previewRenderer from '../shared/subtitle-preview-renderer.js';

export const MATRIX = {
  primary: { outlineEnabled: true, outlineWidth: 3, outlineColor: '#112233', letterSpacing: 1.5 },
  secondary: { outlineEnabled: true, outlineWidth: 1, outlineColor: '#445566', letterSpacing: 0.5 },
  disabled: { outlineEnabled: false, outlineWidth: 0, outlineColor: '#112233', letterSpacing: -1 }
};

export const CUSTOM_BASE_SHADOW = '1px 1px 1px rgba(0, 0, 0, 0.5)';
export const EXPECTED_PRIMARY_SHADOW = '-3px 0 0 #112233, 3px 0 0 #112233, 0 -3px 0 #112233, 0 3px 0 #112233, -3px -3px 0 #112233, 3px -3px 0 #112233, -3px 3px 0 #112233, 3px 3px 0 #112233, 1px 1px 1px rgba(0, 0, 0, 0.5)';
export const EXPECTED_SECONDARY_SHADOW = '-1px 0 0 #445566, 1px 0 0 #445566, 0 -1px 0 #445566, 0 1px 0 #445566, -1px -1px 0 #445566, 1px -1px 0 #445566, -1px 1px 0 #445566, 1px 1px 0 #445566, 1px 1px 1px rgba(0, 0, 0, 0.5)';

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

export function styleKey(type, setting) {
  return `subtitle.style.${type}.${setting}`;
}

export function flatToNested(flatItems) {
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

export function createFlatConfig(overrides = {}) {
  return {
    ...getDefaultValues(),
    'subtitle.dualModeEnabled': true,
    'subtitle.style.mode': 'custom',
    'subtitle.style.primary.outlineEnabled': MATRIX.primary.outlineEnabled,
    'subtitle.style.primary.outlineWidth': MATRIX.primary.outlineWidth,
    'subtitle.style.primary.outlineColor': MATRIX.primary.outlineColor,
    'subtitle.style.primary.letterSpacing': MATRIX.primary.letterSpacing,
    'subtitle.style.secondary.outlineEnabled': MATRIX.secondary.outlineEnabled,
    'subtitle.style.secondary.outlineWidth': MATRIX.secondary.outlineWidth,
    'subtitle.style.secondary.outlineColor': MATRIX.secondary.outlineColor,
    'subtitle.style.secondary.letterSpacing': MATRIX.secondary.letterSpacing,
    ...overrides
  };
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

export async function loadOptionsHarness(storage) {
  const elements = createElementMap();
  const previewCalls = [];
  const stored = structuredClone(storage);
  const source = (await readFile(new URL('../options.js', import.meta.url), 'utf8'))
    .replace(/import\s+\{[\s\S]*?getDefaultValues\s*\}\s+from\s+'\.\/content\/system\/config\/config-schema\.js';\n/, '')
    .replace(/import\s+\{[\s\S]*?renderSubtitlePreview\s*\}\s+from\s+'\.\/shared\/subtitle-preview-renderer\.js';\n/, '')
    .concat('\nglobalThis.__optionsApi = { restoreOptionsUI, getPreviewConfigFromControls, setupStyleControlListeners };\n');
  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    SUPPORTED_LANGUAGES,
    SUBTITLE_FONT_PRESETS,
    SUBTITLE_FONT_WEIGHT_OPTIONS,
    SUBTITLE_STYLE_MODES,
    getDefaultValues: () => ({ ...getDefaultValues() }),
    renderSubtitlePreview: (args) => {
      previewCalls.push(args);
      previewRenderer.renderSubtitlePreview(args);
    },
    document: {
      getElementById: id => elements[id] || null,
      querySelectorAll: selector => selector.split(',').map(item => elements[item.trim().slice(1)]).filter(Boolean),
      addEventListener() {}
    },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0' }), connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) },
      storage: { local: createStorageApi(stored) }
    }
  });

  vm.runInContext(source, context, { filename: 'options.js' });
  return { api: context.__optionsApi, elements, previewCalls, stored };
}

function createStorageApi(stored) {
  return {
    get: async (keys) => {
      if (!Array.isArray(keys)) return structuredClone(stored);
      return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
    },
    set: async (items) => {
      Object.assign(stored, structuredClone(items));
    }
  };
}

export async function loadSubtitleStyleManager(initialConfig) {
  const configEntries = new Map(Object.entries({ ...getDefaultValues(), ...initialConfig }));
  const subscriptions = new Map();
  const context = vm.createContext({ console, configEntries, subscriptions });
  const managerSource = await readFile(new URL('../content/ui/subtitle-style-manager.js', import.meta.url), 'utf8');
  const configModule = new vm.SourceTextModule('export const configBridge = { get: (key) => globalThis.configEntries.get(key), subscribe: (key, callback) => { globalThis.subscriptions.set(key, callback); return () => globalThis.subscriptions.delete(key); } };', { context });
  const messagingModule = new vm.SourceTextModule('export const registerInternalEventHandler = () => () => {};', { context });
  const managerModule = new vm.SourceTextModule(managerSource, {
    context,
    identifier: 'content/ui/subtitle-style-manager.js',
    importModuleDynamically: async () => configModule
  });

  await configModule.link(() => { throw new Error('config bridge has no imports'); });
  await configModule.evaluate();
  await managerModule.link((specifier) => {
    if (specifier === '../system/messaging.js') return messagingModule;
    throw new Error(`Unexpected dependency: ${specifier}`);
  });
  await managerModule.evaluate();
  return managerModule.namespace.SubtitleStyleManager;
}

export async function loadSubtitleDisplay() {
  const context = vm.createContext({ console, setTimeout, clearTimeout });
  const source = await readFile(new URL('../content/ui/subtitle-display.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/ui/subtitle-display.js' });
  const dependencies = new Map([
    ['../system/messaging.js', new vm.SourceTextModule('export const sendMessage = async () => ({}); export const registerInternalEventHandler = () => () => {}; export const dispatchInternalEvent = () => {};', { context })],
    ['./netflix-player-adapter.js', new vm.SourceTextModule('export const getPlayerAdapter = () => ({ getCurrentPlayerBounds: () => ({ width: 1920 }) });', { context })]
  ]);

  await module.link((specifier) => dependencies.get(specifier));
  await module.evaluate();
  return module.namespace.SubtitleDisplay;
}

export function createUiManager() {
  return {
    singleStyle: null,
    setSubtitleStyle(style) {
      this.singleStyle = style;
    },
    subtitleDisplay: {
      dualStyles: null,
      setDualModeStyles(styles) {
        this.dualStyles = styles;
      },
      setStyleMode() {}
    }
  };
}

export async function applyStyleControl(elements, type, matrix) {
  elements[`${type}OutlineEnabled`].checked = matrix.outlineEnabled;
  await elements[`${type}OutlineEnabled`].dispatch('change');
  elements[`${type}OutlineWidth`].value = String(matrix.outlineWidth);
  await elements[`${type}OutlineWidth`].dispatch('input');
  elements[`${type}OutlineColor`].value = matrix.outlineColor;
  await elements[`${type}OutlineColor`].dispatch('input');
  await elements[`${type}OutlineColor`].dispatch('change');
  elements[`${type}LetterSpacing`].value = String(matrix.letterSpacing);
  await elements[`${type}LetterSpacing`].dispatch('input');
}
