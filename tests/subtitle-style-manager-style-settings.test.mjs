import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const BASE_CONFIG = {
  'subtitle.style.mode': 'custom',
  'subtitle.style.fontPreset': 'clearSans',
  'subtitle.style.fontFamily': 'Arial, sans-serif',
  'subtitle.style.primary.fontSize': 55,
  'subtitle.style.primary.fontWeight': '700',
  'subtitle.style.primary.textColor': '#ffffff',
  'subtitle.style.primary.backgroundColor': 'rgba(0, 0, 0, 0.75)',
  'subtitle.style.secondary.fontSize': 24,
  'subtitle.style.secondary.fontWeight': '500',
  'subtitle.style.secondary.textColor': '#ffff00',
  'subtitle.style.secondary.backgroundColor': 'rgba(0, 0, 0, 0.75)',
  'subtitle.style.netflixPreset.fontFamily': 'Arial, Helvetica, sans-serif',
  'subtitle.style.netflixPreset.fontWeight': '700',
  'subtitle.style.netflixPreset.textColor': '#ffffff',
  'subtitle.style.netflixPreset.backgroundColor': 'rgba(0, 0, 0, 0.75)',
  'subtitle.style.netflixPreset.textShadow': '0 0 2px rgba(0, 0, 0, 0.9)',
  'subtitle.dualModeEnabled': false,
  debugMode: false
};

async function loadSubtitleStyleManager(initialConfig = {}) {
  const configEntries = new Map(Object.entries({ ...BASE_CONFIG, ...initialConfig }));
  const subscriptions = new Map();
  const context = vm.createContext({ console, configEntries, subscriptions });
  const managerSource = await readFile(new URL('../content/ui/subtitle-style-manager.js', import.meta.url), 'utf8');
  const configModule = new vm.SourceTextModule(`
    export const configBridge = {
      get: (key) => globalThis.configEntries.get(key),
      subscribe: (key, callback) => {
        globalThis.subscriptions.set(key, callback);
        return () => globalThis.subscriptions.delete(key);
      }
    };
  `, { context, identifier: 'content/system/config/config-bridge.js' });
  const messagingModule = new vm.SourceTextModule('export const registerInternalEventHandler = () => () => {};', { context });
  const managerModule = new vm.SourceTextModule(managerSource, {
    context,
    identifier: 'content/ui/subtitle-style-manager.js',
    importModuleDynamically: async (specifier) => {
      assert.equal(specifier, '../system/config/config-bridge.js');
      return configModule;
    }
  });

  await configModule.link(() => { throw new Error('config bridge has no imports'); });
  await configModule.evaluate();
  await managerModule.link((specifier) => {
    if (specifier === '../system/messaging.js') return messagingModule;
    throw new Error(`Unexpected dependency: ${specifier}`);
  });
  await managerModule.evaluate();

  return {
    SubtitleStyleManager: managerModule.namespace.SubtitleStyleManager,
    emitConfigChange(key, value) {
      configEntries.set(key, value);
      subscriptions.get(key)(value);
    },
    subscriptions
  };
}

function createUiManager() {
  return {
    singleStyle: null,
    setSubtitleStyle(style) {
      this.singleStyle = style;
    },
    subtitleDisplay: {
      dualStyles: null,
      styleMode: null,
      setDualModeStyles(styles) {
        this.dualStyles = styles;
      },
      setStyleMode(mode) {
        this.styleMode = mode;
      }
    }
  };
}

function assertCssIsSafe(style) {
  assert.equal(Object.values(style).some(value => String(value).includes('NaN')), false);
  assert.equal(Object.values(style).some(value => String(value).includes('undefined')), false);
}

test('Given primary outline and letter spacing config When manager initializes single mode Then legacy style carries deterministic CSS', async () => {
  const { SubtitleStyleManager, subscriptions } = await loadSubtitleStyleManager({
    'subtitle.style.primary.outlineEnabled': true,
    'subtitle.style.primary.outlineWidth': 2,
    'subtitle.style.primary.outlineColor': '#112233',
    'subtitle.style.primary.letterSpacing': 1.5
  });
  const manager = new SubtitleStyleManager();
  const uiManager = createUiManager();

  await manager.initialize(uiManager);

  assert.equal(uiManager.singleStyle.letterSpacing, '1.5px');
  assert.equal(uiManager.singleStyle.textShadow, '-2px 0 0 #112233, 2px 0 0 #112233, 0 -2px 0 #112233, 0 2px 0 #112233, -2px -2px 0 #112233, 2px -2px 0 #112233, -2px 2px 0 #112233, 2px 2px 0 #112233, 1px 1px 1px rgba(0, 0, 0, 0.5)');
  assert.equal(subscriptions.has('subtitle.style.primary.outlineEnabled'), true);
  assert.equal(subscriptions.has('subtitle.style.primary.outlineWidth'), true);
  assert.equal(subscriptions.has('subtitle.style.primary.outlineColor'), true);
  assert.equal(subscriptions.has('subtitle.style.primary.letterSpacing'), true);
  assertCssIsSafe(uiManager.singleStyle);
});

test('Given dual mode secondary style changes When config subscriptions fire Then dual legacy styles update symmetrically', async () => {
  const { SubtitleStyleManager, emitConfigChange, subscriptions } = await loadSubtitleStyleManager({
    'subtitle.dualModeEnabled': true,
    'subtitle.style.primary.outlineEnabled': false,
    'subtitle.style.primary.outlineWidth': 3,
    'subtitle.style.primary.outlineColor': '#111111',
    'subtitle.style.primary.letterSpacing': 0.25,
    'subtitle.style.secondary.outlineEnabled': true,
    'subtitle.style.secondary.outlineWidth': 1,
    'subtitle.style.secondary.outlineColor': '#445566',
    'subtitle.style.secondary.letterSpacing': 0.75
  });
  const manager = new SubtitleStyleManager();
  const uiManager = createUiManager();

  await manager.initialize(uiManager);
  emitConfigChange('subtitle.style.secondary.letterSpacing', 3);
  emitConfigChange('subtitle.style.secondary.outlineWidth', 4);

  assert.equal(uiManager.subtitleDisplay.dualStyles.primary.letterSpacing, '0.25px');
  assert.equal(uiManager.subtitleDisplay.dualStyles.primary.textShadow, '1px 1px 1px rgba(0, 0, 0, 0.5)');
  assert.equal(uiManager.subtitleDisplay.dualStyles.secondary.letterSpacing, '3px');
  assert.equal(uiManager.subtitleDisplay.dualStyles.secondary.textShadow, '-4px 0 0 #445566, 4px 0 0 #445566, 0 -4px 0 #445566, 0 4px 0 #445566, -4px -4px 0 #445566, 4px -4px 0 #445566, -4px 4px 0 #445566, 4px 4px 0 #445566, 1px 1px 1px rgba(0, 0, 0, 0.5)');
  assert.equal(subscriptions.has('subtitle.style.secondary.outlineEnabled'), true);
  assert.equal(subscriptions.has('subtitle.style.secondary.outlineWidth'), true);
  assert.equal(subscriptions.has('subtitle.style.secondary.outlineColor'), true);
  assert.equal(subscriptions.has('subtitle.style.secondary.letterSpacing'), true);
  assertCssIsSafe(uiManager.subtitleDisplay.dualStyles.secondary);
});

test('Given missing old style keys and zero outline width When legacy style is produced Then defaults are safe and zero disables outline', async () => {
  const { SubtitleStyleManager, emitConfigChange } = await loadSubtitleStyleManager({
    'subtitle.style.primary.outlineWidth': undefined,
    'subtitle.style.primary.outlineColor': undefined,
    'subtitle.style.primary.letterSpacing': undefined,
    'subtitle.style.primary.outlineEnabled': undefined
  });
  const manager = new SubtitleStyleManager();
  const uiManager = createUiManager();

  await manager.initialize(uiManager);
  assert.equal(uiManager.singleStyle.letterSpacing, '0px');
  assert.equal(uiManager.singleStyle.textShadow, '1px 1px 1px rgba(0, 0, 0, 0.5)');
  assertCssIsSafe(uiManager.singleStyle);

  emitConfigChange('subtitle.style.primary.outlineWidth', 0);

  assert.equal(uiManager.singleStyle.letterSpacing, '0px');
  assert.equal(uiManager.singleStyle.textShadow, '1px 1px 1px rgba(0, 0, 0, 0.5)');
  assertCssIsSafe(uiManager.singleStyle);
});
