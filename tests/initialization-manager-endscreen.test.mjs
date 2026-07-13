import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('Given MAIN initialization When its module graph loads Then subtitle startup remains and endscreen task ownership is absent', async () => {
  const source = await readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8');
  assert.match(source, /requestPageScriptInjection/);
  assert.match(source, /waitForPageScript\(5000\)/);
  assert.match(source, /window\.subpalPageScript/);
  assert.match(source, /initializeSubtitleCoordinatorSafely/);
  assert.doesNotMatch(source, /EndscreenTaskBridge|requestCrowdsourcingTasks|ENDSCREEN_TASKS_RECEIVED|endscreenTaskBridge/);
});

test('Given initialized components When final integration starts Then initialization notification uses imported sendMessage', async () => {
  const sent = [];
  const context = vm.createContext({ console, Date, setTimeout, clearTimeout });
  const source = await readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8');
  const messaging = new vm.SyntheticModule(['requestPageScriptInjection', 'waitForPageScript', 'sendMessage'], function () {
    this.setExport('requestPageScriptInjection', async () => {});
    this.setExport('waitForPageScript', async () => {});
    this.setExport('sendMessage', async (message) => { sent.push(message); return {}; });
  }, { context });
  const videoInfo = new vm.SyntheticModule(['getVideoId'], function () { this.setExport('getVideoId', () => 'netflix-81234567'); }, { context });
  const module = new vm.SourceTextModule(source, { context, identifier: 'content/system/initialization-manager.js' });
  await module.link((specifier) => specifier === './messaging.js' ? messaging : videoInfo);
  await module.evaluate();
  const manager = new module.namespace.InitializationManager();
  manager.setupEventFlow = () => {};

  assert.equal(await manager.integrateAndStart(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'CONTENT_SCRIPT_READY');
});
