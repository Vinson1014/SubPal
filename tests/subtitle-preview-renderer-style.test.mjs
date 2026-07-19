import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadRenderer() {
  const context = vm.createContext({});
  const source = await readFile(new URL('../shared/subtitle-preview-renderer.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'shared/subtitle-preview-renderer.js' });
  await module.link(() => { throw new Error('Unexpected dependency'); });
  await module.evaluate();
  return module.namespace;
}

function createFlatConfig(overrides = {}) {
  return {
    'subtitle.dualModeEnabled': true,
    'subtitle.style.mode': 'custom',
    'subtitle.style.fontFamily': 'Arial, sans-serif',
    'subtitle.primaryLanguage': 'zh-Hant',
    'subtitle.secondaryLanguage': 'en',
    'subtitle.style.primary.fontSize': 55,
    'subtitle.style.primary.fontWeight': '700',
    'subtitle.style.primary.textColor': '#ffffff',
    'subtitle.style.primary.backgroundColor': 'rgba(0, 0, 0, 0.6)',
    'subtitle.style.secondary.fontSize': 24,
    'subtitle.style.secondary.fontWeight': '400',
    'subtitle.style.secondary.textColor': '#ffff00',
    'subtitle.style.secondary.backgroundColor': 'rgba(0, 0, 0, 0.6)',
    'subtitle.style.netflixPreset.fontFamily': 'Arial, Helvetica, sans-serif',
    'subtitle.style.netflixPreset.fontWeight': '700',
    'subtitle.style.netflixPreset.textColor': '#ffffff',
    'subtitle.style.netflixPreset.backgroundColor': 'rgba(0, 0, 0, 0.6)',
    'subtitle.style.netflixPreset.textShadow': '0 0 2px rgba(0, 0, 0, 0.9)',
    ...overrides
  };
}

test('Given outline and letter spacing flat config When custom preview style is applied Then glyph outline layers over the custom base shadow without box-shadow', async () => {
  const renderer = await loadRenderer();
  const element = { style: {} };
  const config = renderer.createSubtitlePreviewConfig(createFlatConfig({
    'subtitle.style.primary.outlineEnabled': true,
    'subtitle.style.primary.outlineWidth': 2,
    'subtitle.style.primary.outlineColor': '#112233',
    'subtitle.style.primary.letterSpacing': 1.5
  }));

  renderer.applySubtitlePreviewStyle(element, config, 'primary');

  assert.equal(element.style.letterSpacing, '1.5px');
  assert.equal(element.style.boxShadow, 'none');
  assert.equal(element.style.textShadow, '-2px 0 0 #112233, 2px 0 0 #112233, 0 -2px 0 #112233, 0 2px 0 #112233, -2px -2px 0 #112233, 2px -2px 0 #112233, -2px 2px 0 #112233, 2px 2px 0 #112233, 1px 1px 1px rgba(0, 0, 0, 0.5)');
});

test('Given netflix preset mode and secondary outline config When effective style is computed Then outline layers over preset text shadow', async () => {
  const renderer = await loadRenderer();
  const config = renderer.createSubtitlePreviewConfig(createFlatConfig({
    'subtitle.style.mode': 'netflixPreset',
    'subtitle.style.secondary.outlineEnabled': true,
    'subtitle.style.secondary.outlineWidth': 1,
    'subtitle.style.secondary.outlineColor': '#445566',
    'subtitle.style.secondary.letterSpacing': 0.75
  }));

  const style = renderer.getEffectivePreviewStyle(config, 'secondary');

  assert.equal(style.letterSpacing, 0.75);
  assert.equal(style.hasOutline, true);
  assert.equal(style.textShadow, '-1px 0 0 #445566, 1px 0 0 #445566, 0 -1px 0 #445566, 0 1px 0 #445566, -1px -1px 0 #445566, 1px -1px 0 #445566, -1px 1px 0 #445566, 1px 1px 0 #445566, 0 0 2px rgba(0, 0, 0, 0.9)');
});

test('Given disabled or zero-width outline config When text outline shadow is created Then only the base shadow is returned', async () => {
  const renderer = await loadRenderer();

  assert.equal(renderer.createTextOutlineShadow({
    enabled: false,
    width: 2,
    color: '#000000',
    baseShadow: '0 0 2px rgba(0, 0, 0, 0.9)'
  }), '0 0 2px rgba(0, 0, 0, 0.9)');
  assert.equal(renderer.createTextOutlineShadow({
    enabled: true,
    width: 0,
    color: '#000000',
    baseShadow: '0 0 2px rgba(0, 0, 0, 0.9)'
  }), '0 0 2px rgba(0, 0, 0, 0.9)');
});

test('Given old preview config without outline or letter-spacing keys When preview renders Then schema default outline and safe letter spacing apply', async () => {
  const renderer = await loadRenderer();
  const primaryElement = { style: {}, textContent: '' };
  const secondaryElement = { style: {}, textContent: '' };

  renderer.renderSubtitlePreview({
    primaryElement,
    secondaryElement,
    config: createFlatConfig(),
    primaryText: 'Primary',
    secondaryText: 'Secondary'
  });

  assert.equal(primaryElement.style.letterSpacing, '0px');
  assert.equal(secondaryElement.style.letterSpacing, '0px');
  assert.equal(primaryElement.style.boxShadow, '0 0 0 2px rgba(0, 0, 0, 0.75)');
  assert.equal(secondaryElement.style.boxShadow, '0 0 0 2px rgba(0, 0, 0, 0.75)');
  assert.equal(primaryElement.style.textShadow, '1px 1px 1px rgba(0, 0, 0, 0.5)');
  assert.equal(secondaryElement.style.textShadow, '1px 1px 1px rgba(0, 0, 0, 0.5)');
  assert.equal(`${primaryElement.style.fontSize} ${primaryElement.style.letterSpacing} ${secondaryElement.style.letterSpacing}`.includes('undefinedpx'), false);
  assert.equal(`${primaryElement.style.fontSize} ${primaryElement.style.letterSpacing} ${secondaryElement.style.letterSpacing}`.includes('NaNpx'), false);
});
