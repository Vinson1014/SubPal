import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadSubtitleDisplay() {
  const context = vm.createContext({ console, setTimeout, clearTimeout });
  const source = await readFile(new URL('../content/ui/subtitle-display.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/ui/subtitle-display.js' });
  const dependencies = new Map([
    ['../system/messaging.js', new vm.SourceTextModule('export const dispatchInternalEvent = () => {};', { context })],
    ['./netflix-player-adapter.js', new vm.SourceTextModule('export const getPlayerAdapter = () => ({ getCurrentPlayerBounds: () => ({ width: 1920 }) });', { context })]
  ]);
  await module.link((specifier) => dependencies.get(specifier));
  await module.evaluate();
  return module.namespace.SubtitleDisplay;
}

test('Given a single subtitle style When applied Then letter spacing and incoming outline shadow reach the text element', async () => {
  const SubtitleDisplay = await loadSubtitleDisplay();
  const display = new SubtitleDisplay();
  display.element = { style: {} };
  display.setStyle({
    letterSpacing: '2.5px',
    textShadow: '0 0 2px #111, 0 0 4px #111'
  });

  display.applySubtitleStyle();

  assert.equal(display.element.style.letterSpacing, '2.5px');
  assert.equal(display.element.style.textShadow, '0 0 2px #111, 0 0 4px #111');
  assert.notEqual(display.element.style.boxShadow, '0 0 0 2px rgba(0, 0, 0, 0.75)');
});

test('Given dual subtitle styles When applied Then primary and secondary containers receive spacing and outline shadow', async () => {
  const SubtitleDisplay = await loadSubtitleDisplay();
  const display = new SubtitleDisplay();
  display.isDualMode = true;
  display.primaryContainer = { style: {} };
  display.secondaryContainer = { style: {} };

  display.setDualModeStyles({
    primary: {
      fontSize: '40px',
      fontFamily: 'Arial, sans-serif',
      color: '#ffffff',
      backgroundColor: 'transparent',
      letterSpacing: '1px',
      textShadow: '1px 0 0 #000'
    },
    secondary: {
      fontSize: '24px',
      fontFamily: 'Arial, sans-serif',
      color: '#ffff00',
      backgroundColor: 'transparent',
      letterSpacing: '3px',
      textShadow: '2px 0 0 #222'
    }
  });

  assert.equal(display.primaryContainer.style.letterSpacing, '1px');
  assert.equal(display.primaryContainer.style.textShadow, '1px 0 0 #000');
  assert.equal(display.secondaryContainer.style.letterSpacing, '3px');
  assert.equal(display.secondaryContainer.style.textShadow, '2px 0 0 #222');
});

test('Given style data without letter spacing When applied Then subtitle elements fall back to zero spacing', async () => {
  const SubtitleDisplay = await loadSubtitleDisplay();
  const display = new SubtitleDisplay();
  display.element = { style: {} };
  display.primaryContainer = { style: {} };

  display.applySubtitleStyle();
  display.applyStylesToContainer(display.primaryContainer, {
    fontSize: '32px',
    fontFamily: 'Arial, sans-serif',
    color: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.75)'
  });

  assert.equal(display.element.style.letterSpacing, '0px');
  assert.equal(display.primaryContainer.style.letterSpacing, '0px');
});

test('Given intercept subtitle data with dual mode disabled When shown Then primary text uses the single subtitle style path', async () => {
  const SubtitleDisplay = await loadSubtitleDisplay();
  const display = new SubtitleDisplay();
  display.isInitialized = true;
  display.container = { style: {} };
  display.element = { style: {}, textContent: '' };
  display.setStyle({
    letterSpacing: '1.5px',
    textShadow: '-3px 0 0 #112233'
  });

  display.show({
    text: '主要字幕',
    isDualSubtitle: true,
    dualSubtitleData: {
      isDualModeEnabled: false,
      primaryText: '主要字幕',
      secondaryText: ''
    }
  });

  assert.equal(display.isDualMode, false);
  assert.equal(display.container.style.display, 'block');
  assert.equal(display.element.textContent, '主要字幕');
  assert.equal(display.element.style.letterSpacing, '1.5px');
  assert.equal(display.element.style.textShadow, '-3px 0 0 #112233');
});
