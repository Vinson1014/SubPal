import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfigValue } from '../content/system/config/config-schema.js';
import * as previewRenderer from '../shared/subtitle-preview-renderer.js';
import {
  CUSTOM_BASE_SHADOW,
  EXPECTED_PRIMARY_SHADOW,
  EXPECTED_SECONDARY_SHADOW,
  MATRIX,
  applyStyleControl,
  createFlatConfig,
  createUiManager,
  flatToNested,
  loadOptionsHarness,
  loadSubtitleDisplay,
  loadSubtitleStyleManager,
  styleKey
} from './subtitle-style-integration-harness.mjs';

test('Given subtitle style schema When the outline matrix is validated Then accepted values and invalid values are explicit', () => {
  for (const type of ['primary', 'secondary']) {
    const matrix = MATRIX[type];

    assert.deepEqual(validateConfigValue(styleKey(type, 'outlineEnabled'), matrix.outlineEnabled), { valid: true });
    assert.deepEqual(validateConfigValue(styleKey(type, 'outlineWidth'), matrix.outlineWidth), { valid: true });
    assert.deepEqual(validateConfigValue(styleKey(type, 'outlineColor'), matrix.outlineColor), { valid: true });
    assert.deepEqual(validateConfigValue(styleKey(type, 'letterSpacing'), matrix.letterSpacing), { valid: true });
  }

  assert.deepEqual(validateConfigValue(styleKey('primary', 'outlineEnabled'), MATRIX.disabled.outlineEnabled), { valid: true });
  assert.deepEqual(validateConfigValue(styleKey('primary', 'outlineWidth'), MATRIX.disabled.outlineWidth), { valid: true });
  assert.deepEqual(validateConfigValue(styleKey('primary', 'letterSpacing'), MATRIX.disabled.letterSpacing), { valid: true });
  assert.equal(validateConfigValue(styleKey('secondary', 'outlineWidth'), 9).valid, false);
  assert.equal(validateConfigValue(styleKey('secondary', 'outlineColor'), 'black').valid, false);
  assert.equal(validateConfigValue(styleKey('secondary', 'letterSpacing'), -3).valid, false);
});

test('Given Options controls When the matrix is serialized Then storage, preview config, and preview DOM carry exact nested values', async () => {
  const storedDefaults = flatToNested(createFlatConfig({
    'subtitle.style.primary.fontSize': 61,
    'subtitle.style.secondary.fontWeight': '400'
  }));
  const { api, elements, previewCalls, stored } = await loadOptionsHarness(storedDefaults);

  await api.restoreOptionsUI();
  api.setupStyleControlListeners('primary', 'subtitle.style.primary');
  api.setupStyleControlListeners('secondary', 'subtitle.style.secondary');
  await applyStyleControl(elements, 'primary', MATRIX.primary);
  await applyStyleControl(elements, 'secondary', MATRIX.secondary);

  const previewConfig = api.getPreviewConfigFromControls();
  assert.equal(stored.subtitle.style.primary.outlineEnabled, MATRIX.primary.outlineEnabled);
  assert.equal(stored.subtitle.style.primary.outlineWidth, MATRIX.primary.outlineWidth);
  assert.equal(stored.subtitle.style.primary.outlineColor, MATRIX.primary.outlineColor);
  assert.equal(stored.subtitle.style.primary.letterSpacing, MATRIX.primary.letterSpacing);
  assert.equal(stored.subtitle.style.primary.fontSize, 61);
  assert.equal(stored.subtitle.style.secondary.outlineEnabled, MATRIX.secondary.outlineEnabled);
  assert.equal(stored.subtitle.style.secondary.outlineWidth, MATRIX.secondary.outlineWidth);
  assert.equal(stored.subtitle.style.secondary.outlineColor, MATRIX.secondary.outlineColor);
  assert.equal(stored.subtitle.style.secondary.letterSpacing, MATRIX.secondary.letterSpacing);
  assert.equal(stored.subtitle.style.secondary.fontWeight, '400');
  assert.equal(previewConfig['subtitle.style.primary.outlineWidth'], MATRIX.primary.outlineWidth);
  assert.equal(previewConfig['subtitle.style.primary.outlineColor'], MATRIX.primary.outlineColor);
  assert.equal(previewConfig['subtitle.style.primary.letterSpacing'], MATRIX.primary.letterSpacing);
  assert.equal(previewConfig['subtitle.style.secondary.outlineWidth'], MATRIX.secondary.outlineWidth);
  assert.equal(previewConfig['subtitle.style.secondary.outlineColor'], MATRIX.secondary.outlineColor);
  assert.equal(previewConfig['subtitle.style.secondary.letterSpacing'], MATRIX.secondary.letterSpacing);
  assert.equal(previewCalls.at(-1).config['subtitle.style.secondary.letterSpacing'], MATRIX.secondary.letterSpacing);
  assert.equal(elements.primaryPreview.style.letterSpacing, '1.5px');
  assert.equal(elements.primaryPreview.style.textShadow, EXPECTED_PRIMARY_SHADOW);
  assert.equal(elements.secondaryPreview.style.letterSpacing, '0.5px');
  assert.equal(elements.secondaryPreview.style.textShadow, EXPECTED_SECONDARY_SHADOW);
});

test('Given preview, runtime manager, and display DOM When the matrix flows through them Then CSS shadows and spacing match exactly', async () => {
  const flatConfig = createFlatConfig();
  const previewConfig = previewRenderer.createSubtitlePreviewConfig(flatConfig);
  const previewPrimary = previewRenderer.getEffectivePreviewStyle(previewConfig, 'primary');
  const previewSecondary = previewRenderer.getEffectivePreviewStyle(previewConfig, 'secondary');
  const SubtitleStyleManager = await loadSubtitleStyleManager(flatConfig);
  const manager = new SubtitleStyleManager();
  const uiManager = createUiManager();

  await manager.initialize(uiManager);

  assert.equal(previewPrimary.textShadow, EXPECTED_PRIMARY_SHADOW);
  assert.equal(previewSecondary.textShadow, EXPECTED_SECONDARY_SHADOW);
  assert.equal(uiManager.subtitleDisplay.dualStyles.primary.textShadow, previewPrimary.textShadow);
  assert.equal(uiManager.subtitleDisplay.dualStyles.primary.letterSpacing, '1.5px');
  assert.equal(uiManager.subtitleDisplay.dualStyles.secondary.textShadow, previewSecondary.textShadow);
  assert.equal(uiManager.subtitleDisplay.dualStyles.secondary.letterSpacing, '0.5px');

  const SubtitleDisplay = await loadSubtitleDisplay();
  const display = new SubtitleDisplay();
  display.isDualMode = true;
  display.primaryContainer = { style: {} };
  display.secondaryContainer = { style: {} };
  display.setDualModeStyles(uiManager.subtitleDisplay.dualStyles);

  assert.equal(display.primaryContainer.style.letterSpacing, '1.5px');
  assert.equal(display.primaryContainer.style.textShadow, EXPECTED_PRIMARY_SHADOW);
  assert.equal(display.secondaryContainer.style.letterSpacing, '0.5px');
  assert.equal(display.secondaryContainer.style.textShadow, EXPECTED_SECONDARY_SHADOW);
});

test('Given disabled outline matrix When preview and runtime styles are emitted Then only base shadow and negative spacing remain safe', async () => {
  const disabledConfig = createFlatConfig({
    'subtitle.dualModeEnabled': false,
    'subtitle.style.primary.outlineEnabled': MATRIX.disabled.outlineEnabled,
    'subtitle.style.primary.outlineWidth': MATRIX.disabled.outlineWidth,
    'subtitle.style.primary.outlineColor': MATRIX.disabled.outlineColor,
    'subtitle.style.primary.letterSpacing': MATRIX.disabled.letterSpacing
  });
  const previewConfig = previewRenderer.createSubtitlePreviewConfig(disabledConfig);
  const previewPrimary = previewRenderer.getEffectivePreviewStyle(previewConfig, 'primary');
  const SubtitleStyleManager = await loadSubtitleStyleManager(disabledConfig);
  const manager = new SubtitleStyleManager();
  const uiManager = createUiManager();

  await manager.initialize(uiManager);

  assert.equal(previewPrimary.textShadow, CUSTOM_BASE_SHADOW);
  assert.equal(previewPrimary.letterSpacing, -1);
  assert.equal(uiManager.singleStyle.textShadow, CUSTOM_BASE_SHADOW);
  assert.equal(uiManager.singleStyle.letterSpacing, '-1px');
  assert.equal(Object.values(uiManager.singleStyle).some(value => String(value).includes(['undefined', 'px'].join(''))), false);
  assert.equal(Object.values(uiManager.singleStyle).some(value => String(value).includes(['NaN', 'px'].join(''))), false);
});
