import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { getDefaultValues, validateConfigValue } from '../content/system/config/config-schema.js';

const STYLE_VARIANTS = ['primary', 'secondary'];
const OUTLINE_DEFAULTS = {
  outlineEnabled: false,
  outlineWidth: 2,
  outlineColor: '#000000',
  letterSpacing: 0
};
const FORBIDDEN_POSITION_SETTING_TERMS = ['position', 'height', 'vertical', 'offset', 'top', 'bottom', 'yOffset'];
const FORBIDDEN_POSITION_SETTING_PATTERN = new RegExp(FORBIDDEN_POSITION_SETTING_TERMS.join('|'), 'i');

function containsForbiddenPositionSettingTerm(value) {
  return FORBIDDEN_POSITION_SETTING_PATTERN.test(value);
}

function getForbiddenPositionSettingTerms(value) {
  const lowerValue = value.toLowerCase();
  return FORBIDDEN_POSITION_SETTING_TERMS.filter(term => lowerValue.includes(term.toLowerCase()));
}

function styleKey(variant, setting) {
  return `subtitle.style.${variant}.${setting}`;
}

function getOptionsSubtitleStyleCardLines() {
  const optionsHtml = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const lines = optionsHtml.split('\n');
  const startIndex = lines.findIndex(line => line.includes('<section class="settings-card subtitle-card">'));
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.includes('<!-- Backup & Restore Card -->'));

  assert.notEqual(startIndex, -1, 'Expected options.html to contain the subtitle style card scope marker');
  assert.notEqual(endIndex, -1, 'Expected options.html to contain the backup card marker after subtitle style controls');

  return lines.slice(startIndex, endIndex).map((line, index) => ({
    lineNumber: startIndex + index + 1,
    source: line
  }));
}

function collectForbiddenOptionControlOffenses() {
  const scopedLines = getOptionsSubtitleStyleCardLines();
  const attributePattern = /\b(id|for|name|aria-label|aria-describedby)="([^"]+)"/gi;
  const offenses = [];

  for (const { lineNumber, source } of scopedLines) {
    for (const match of source.matchAll(attributePattern)) {
      const value = match[2];
      if (containsForbiddenPositionSettingTerm(value)) {
        offenses.push({
          line: lineNumber,
          source: `${match[1]}="${value}"`,
          terms: getForbiddenPositionSettingTerms(value)
        });
      }
    }

    const visibleText = source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (visibleText && containsForbiddenPositionSettingTerm(visibleText)) {
      offenses.push({
        line: lineNumber,
        source: visibleText,
        terms: getForbiddenPositionSettingTerms(visibleText)
      });
    }
  }

  return offenses;
}

test('Given subtitle style schema defaults When flattened defaults are read Then primary and secondary outline settings are present', () => {
  const defaults = getDefaultValues();

  for (const variant of STYLE_VARIANTS) {
    for (const [setting, expected] of Object.entries(OUTLINE_DEFAULTS)) {
      assert.equal(defaults[styleKey(variant, setting)], expected);
    }
  }
});

test('Given subtitle style schema validators When outline and spacing boundary values are checked Then only valid persisted values are accepted', () => {
  for (const variant of STYLE_VARIANTS) {
    assert.deepEqual(validateConfigValue(styleKey(variant, 'outlineEnabled'), true), { valid: true });
    assert.equal(validateConfigValue(styleKey(variant, 'outlineEnabled'), 'true').valid, false);

    assert.deepEqual(validateConfigValue(styleKey(variant, 'outlineWidth'), 0), { valid: true });
    assert.deepEqual(validateConfigValue(styleKey(variant, 'outlineWidth'), 8), { valid: true });
    assert.equal(validateConfigValue(styleKey(variant, 'outlineWidth'), 9).valid, false);

    assert.deepEqual(validateConfigValue(styleKey(variant, 'outlineColor'), '#000000'), { valid: true });
    assert.deepEqual(validateConfigValue(styleKey(variant, 'outlineColor'), '#12ABef'), { valid: true });
    assert.equal(validateConfigValue(styleKey(variant, 'outlineColor'), 'black').valid, false);

    assert.deepEqual(validateConfigValue(styleKey(variant, 'letterSpacing'), -2), { valid: true });
    assert.deepEqual(validateConfigValue(styleKey(variant, 'letterSpacing'), 8), { valid: true });
    assert.equal(validateConfigValue(styleKey(variant, 'letterSpacing'), -3).valid, false);
  }
});

test('Given subtitle style schema defaults When schema keys are inspected Then position and container placement settings are absent', () => {
  const defaults = getDefaultValues();
  const forbiddenKeys = Object.keys(defaults).filter(containsForbiddenPositionSettingTerm);

  assert.deepEqual(
    forbiddenKeys,
    [],
    `Forbidden subtitle position-style schema keys found: ${forbiddenKeys.join(', ') || '(none)'}`
  );
});

test('Given Options subtitle style controls When control ids and visible labels are inspected Then position and container placement controls are absent', () => {
  const offenses = collectForbiddenOptionControlOffenses();

  assert.deepEqual(
    offenses,
    [],
    `Forbidden subtitle position-style Options controls found: ${JSON.stringify(offenses)}`
  );
});
