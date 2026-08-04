import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('Given a pending avoidance update When current subtitle clears before timeout Then callback does not dereference mutable null state', async () => {
  const jobs = [];
  const context = vm.createContext({ console, Date, document: { getElementById: () => null }, setInterval, clearInterval, clearTimeout, setTimeout: (job) => jobs.push(job) });
  const source = await readFile(new URL('../content/ui/ui-manager-new.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/ui/ui-manager-new.js' });
  const emptyClass = (name) => new vm.SourceTextModule(`export class ${name} {}`, { context });
  const dependencies = new Map([
    ['./subtitle-display.js', emptyClass('SubtitleDisplay')], ['./interaction-panel.js', emptyClass('InteractionPanel')],
    ['./submission-dialog.js', emptyClass('SubmissionDialog')], ['./fullscreen-handler.js', emptyClass('FullscreenHandler')],
    ['./ui-avoidance-handler.js', emptyClass('UIAvoidanceHandler')], ['./toast-manager.js', emptyClass('ToastManager')],
    ['./netflix-player-adapter.js', new vm.SourceTextModule('export const getPlayerAdapter = () => ({});', { context })],
    ['../system/messaging.js', new vm.SourceTextModule('export const registerInternalEventHandler = () => () => {}; export const dispatchInternalEvent = () => {};', { context })],
    ['../system/capabilities/contributions.js', new vm.SourceTextModule('export const createPageContributions = () => ({});', { context })],
    ['../core/subtitle-replacer.js', emptyClass('SubtitleReplacer')]
  ]);
  await module.link((specifier) => dependencies.get(specifier));
  await module.evaluate();
  const manager = new module.namespace.UIManager();
  const updates = [];
  manager.interactionPanel = { updatePosition(value) { updates.push(value); } };
  manager.currentSubtitle = { text: 'hello', position: { top: 100, left: 20 } };

  manager.handleUIAvoidanceChange(true, 25);
  manager.currentSubtitle = null;
  assert.doesNotThrow(() => jobs[0]());
  assert.equal(JSON.stringify(updates), JSON.stringify([{ text: 'hello', position: { top: 125, left: 20 } }]));
});
