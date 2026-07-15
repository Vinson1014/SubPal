import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

import { getDefaultValues, validateConfigValue } from '../content/system/config/config-schema.js';

const CONFIG_DEFAULTS = {
  debugMode: false,
  'api.baseUrl': 'https://api.example.test',
  'subtitle.dualModeEnabled': false,
  'crowdsourcing.endscreenTasksEnabled': true
};

test('Given the config schema When defaults and validation are queried Then endscreen tasks are enabled by default and accept booleans', () => {
  const defaults = getDefaultValues();

  assert.equal(defaults['crowdsourcing.endscreenTasksEnabled'], true);
  assert.deepEqual(validateConfigValue('crowdsourcing.endscreenTasksEnabled', true), { valid: true });
  assert.equal(validateConfigValue('crowdsourcing.endscreenTasksEnabled', 'false').valid, false);
});

test('Given the endscreen task setting markup When assistive technology reads it Then the control is named and described while its icon is hidden', async () => {
  const markup = await readFile(new URL('../options.html', import.meta.url), 'utf8');

  assert.match(markup, /<svg(?=[^>]*aria-hidden="true")[^>]*>\s*<rect x="3" y="5"/);
  assert.match(markup, /<input(?=[^>]*id="endscreenTasksEnabledCheckbox")(?=[^>]*aria-label="啟用結束畫面的字幕任務")(?=[^>]*aria-describedby="endscreenTasksEnabledDescription")[^>]*>/);
  assert.match(markup, /<p id="endscreenTasksEnabledDescription">開啟後會在影片結束時恢復顯示字幕任務提示<\/p>/);
});

test('Given a keyboard-focused toggle When the visual slider is rendered Then it receives a high-contrast dual-layer focus ring', async () => {
  const styles = await readFile(new URL('../options.css', import.meta.url), 'utf8');

  assert.match(styles, /\.toggle-switch input:focus-visible \+ \.toggle-slider\s*\{\s*box-shadow: 0 0 0 2px var\(--color-bg-deep\), 0 0 0 5px var\(--color-accent\);\s*\}/);
});

class FakeCheckbox {
  constructor() {
    this.checked = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async change() {
    await Promise.all((this.listeners.get('change') ?? []).map(listener => listener({ target: this })));
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadOptions({ config = {} } = {}) {
  const domListeners = new Map();
  const debugModeCheckbox = new FakeCheckbox();
  const endscreenTasksEnabledCheckbox = new FakeCheckbox();
  const storage = structuredClone(config);
  const writes = [];
  const document = {
    addEventListener(type, listener) {
      domListeners.set(type, listener);
    },
    getElementById(id) {
      if (id === 'debugModeCheckbox') return debugModeCheckbox;
      if (id === 'endscreenTasksEnabledCheckbox') return endscreenTasksEnabledCheckbox;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    document,
    structuredClone,
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries(keys.map(key => [key, storage[key]]));
          },
          async set(values) {
            writes.push(structuredClone(values));
            Object.assign(storage, values);
          }
        }
      }
    }
  });
  const source = await readFile(new URL('../options.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'options.js' });

  await module.link(specifier => {
    if (specifier === './content/system/config/config-schema.js') {
      return new vm.SyntheticModule(
        ['SUPPORTED_LANGUAGES', 'SUBTITLE_FONT_PRESETS', 'SUBTITLE_FONT_WEIGHT_OPTIONS', 'SUBTITLE_STYLE_MODES', 'getDefaultValues'],
        function initialize() {
          this.setExport('SUPPORTED_LANGUAGES', []);
          this.setExport('SUBTITLE_FONT_PRESETS', []);
          this.setExport('SUBTITLE_FONT_WEIGHT_OPTIONS', []);
          this.setExport('SUBTITLE_STYLE_MODES', []);
          this.setExport('getDefaultValues', () => CONFIG_DEFAULTS);
        },
        { context, identifier: 'config-schema.js' }
      );
    }
    if (specifier === './shared/subtitle-preview-renderer.js') {
      return new vm.SyntheticModule(['renderSubtitlePreview'], function initialize() {
        this.setExport('renderSubtitlePreview', () => {});
      }, { context, identifier: 'subtitle-preview-renderer.js' });
    }
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await domListeners.get('DOMContentLoaded')();

  return { debugModeCheckbox, endscreenTasksEnabledCheckbox, storage, writes };
}

test('Given stored debug settings When options initializes and changes the checkbox Then it restores and deep-merges the intended key', async () => {
  const options = await loadOptions({ config: { debugMode: true, crowdsourcing: { existing: 'preserved' } } });

  assert.equal(options.debugModeCheckbox.checked, true);

  options.debugModeCheckbox.checked = false;
  await options.debugModeCheckbox.change();

  assert.deepEqual(options.storage, {
    debugMode: false,
    crowdsourcing: { existing: 'preserved' }
  });
  assert.deepEqual(options.writes, [{ debugMode: false }]);
});

test('Given missing or malformed endscreen task storage When options initializes Then the checkbox follows the schema default', async () => {
  const missing = await loadOptions();
  const malformed = await loadOptions({ config: { crowdsourcing: { endscreenTasksEnabled: 'disabled' } } });

  assert.equal(missing.endscreenTasksEnabledCheckbox.checked, true);
  assert.equal(malformed.endscreenTasksEnabledCheckbox.checked, true);
});

test('Given endscreen subtitle tasks are disabled When the user re-enables them Then only that preference is persisted and restored after reload', async () => {
  const options = await loadOptions({
    config: { crowdsourcing: { endscreenTasksEnabled: false, existing: 'preserved' } }
  });

  assert.equal(options.endscreenTasksEnabledCheckbox.checked, false);

  options.endscreenTasksEnabledCheckbox.checked = true;
  await options.endscreenTasksEnabledCheckbox.change();

  assert.deepEqual(plain(options.storage), {
    crowdsourcing: { endscreenTasksEnabled: true, existing: 'preserved' }
  });
  assert.deepEqual(plain(options.writes), [{
    crowdsourcing: { endscreenTasksEnabled: true, existing: 'preserved' }
  }]);

  const reloaded = await loadOptions({ config: options.storage });
  assert.equal(reloaded.endscreenTasksEnabledCheckbox.checked, true);
});
