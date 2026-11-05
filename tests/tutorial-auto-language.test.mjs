import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('tutorial offers auto only for secondary, explains every auto preview and remembers manual transitions', async () => {
  const elements = new Map();
  for (const id of ['prevBtn', 'nextBtn', 'skipTutorialBtn', 'setupPrimaryLanguage', 'setupSecondaryLanguage', 'submitLanguageSelect', 'secondaryLanguageName',
    'miniSecondaryPreview', 'setupSecondaryPreview', 'styleSecondaryPreview', 'mockSecondaryPreview']) {
    const listeners = new Map();
    elements.set(id, { value: '', textContent: '', style: {}, options: [],
      add(option) { this.options.push(option); },
      addEventListener(type, listener) { listeners.set(type, listener); },
      async change(value) { this.value = value; await listeners.get('change')({ target: this }); }
    });
  }
  const stored = { subtitle: { secondaryLanguage: 'ja', dualModeEnabled: true } };
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll: () => [], getElementById: id => elements.get(id) || null },
    window: { addEventListener() {}, removeEventListener() {} },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    chrome: { storage: { local: {
      async get() { return structuredClone(stored); },
      async set(items) { Object.assign(stored, structuredClone(items)); }
    } } }
  });
  const modules = new Map();
  async function load(url) {
    if (modules.has(url.href)) return modules.get(url.href);
    let source = await readFile(url, 'utf8');
    if (url.pathname.endsWith('/tutorial.js')) source += '\nglobalThis.TutorialManager = TutorialManager;';
    const module = new vm.SourceTextModule(source, { context, identifier: url.href });
    modules.set(url.href, module);
    await module.link(specifier => load(new URL(specifier, url)));
    return module;
  }
  const module = await load(new URL('../tutorial.js', import.meta.url));
  await module.evaluate();
  const manager = new context.TutorialManager();
  await manager.init();
  const secondary = elements.get('setupSecondaryLanguage');
  assert.equal(secondary.options.some(option => option.value === 'auto'), true);
  assert.equal(elements.get('setupPrimaryLanguage').options.some(option => option.value === 'auto'), false);
  await secondary.change('auto');
  assert.equal(stored.subpalLastManualSecondaryLanguage, 'ja');
  assert.equal(elements.get('secondaryLanguageName').textContent, '自動（跟隨影片原始語言）');
  for (const id of ['miniSecondaryPreview', 'setupSecondaryPreview', 'styleSecondaryPreview', 'mockSecondaryPreview']) {
    assert.equal(elements.get(id).textContent, '播放時自動顯示影片原始語言字幕');
  }
  await secondary.change('manual');
  assert.equal(stored.subtitle.secondaryLanguage, 'ja');
  assert.equal(secondary.value, 'ja');
});
