/**
 * 片尾任務面板測試
 *
 * 測試策略：
 * 1. 面板行為測試 — 驗證 show/hide/render/skip/close/idempotent/safe text
 * 2. 所有權測試 — 驗證 MAIN 初始化不持有片尾任務 transport 或 panel bridge
 *
 * 執行方式：node --experimental-vm-modules --test tests/endscreen-task-panel.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  loadPanel,
  FakeDocument,
  FakeElement,
  createScheduler,
  createOfficialTask,
  createCandidateTask,
  createContext,
  createHarness,
  createTrackedConfigBridge
} from './endscreen-task-panel-fixtures.mjs';

test('Given two-world ownership When sources are inspected Then only the isolated bootstrap imports the panel', async () => {
  const isolated = await readFile(new URL('../content/system/isolated-endscreen-tasks.js', import.meta.url), 'utf8');
  const mainUI = await readFile(new URL('../content/ui/ui-manager-new.js', import.meta.url), 'utf8');
  assert.ok(isolated.includes("import { EndscreenTaskPanel } from '../ui/endscreen-task-panel.js'"));
  assert.ok(!mainUI.includes('EndscreenTaskPanel'));
  assert.ok(!mainUI.includes('ENDSCREEN_TASKS_RECEIVED'));
});

// ─── 面板行為測試（失敗優先） ───

test('Given a panel instance When show is called with empty tasks Then it does not render', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([], createContext());

  assert.equal(document.getElementById('subpal-endscreen-panel'), null,
    '空任務不應渲染面板');
});

test('Given a panel instance When show is called with a non-empty official task Then it renders timecode, original subtitle, and task type', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl, '面板應存在於 DOM');

  // 面板應顯示 timecode
  const timecodeEl = panelEl.querySelector('.subpal-endscreen-timecode');
  assert.ok(timecodeEl, '應有 timecode 元素');
  assert.equal(timecodeEl.textContent, '02:04', 'timecode 應為 02:04');

  // 面板應顯示原始字幕（使用 textContent，非 innerHTML）
  const originalEl = panelEl.querySelector('.subpal-endscreen-original');
  assert.ok(originalEl, '應有原始字幕元素');
  assert.equal(originalEl.textContent, '我會在十分鐘後回來。', '原始字幕應正確渲染');
  assert.equal(originalEl.innerHTML, originalEl.textContent, '原始字幕應使用 textContent 而非 innerHTML');

  // 面板應標示為 official-subtitle 類型
  const typeEl = panelEl.querySelector('.subpal-endscreen-task-type');
  assert.ok(typeEl, '應有任務類型元素');
  assert.ok(typeEl.textContent.includes('官方字幕'), '應標示為官方字幕任務');
});

test('Given a panel instance When show is called with a candidate task Then it renders the suggested subtitle', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createCandidateTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl, '面板應存在於 DOM');

  // 候選翻譯應顯示 suggestedSubtitle
  const suggestedEl = panelEl.querySelector('.subpal-endscreen-suggested');
  assert.ok(suggestedEl, '應有候選翻譯元素');
  assert.equal(suggestedEl.textContent, '我完全沒料到會這樣。', '候選翻譯應正確渲染');

  // 面板應標示為 candidate-translation 類型
  const typeEl = panelEl.querySelector('.subpal-endscreen-task-type');
  assert.ok(typeEl, '應有任務類型元素');
  assert.ok(typeEl.textContent.includes('候選翻譯'), '應標示為候選翻譯任務');
});

test('Given a panel instance When show is called with an official task Then no suggested subtitle section is rendered', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const suggestedEl = panelEl.querySelector('.subpal-endscreen-suggested');
  assert.equal(suggestedEl, null, '官方字幕任務不應有候選翻譯區塊');
});

test('Given a panel instance When show is called Then it renders skip, not-now, and close buttons', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');

  const skipBtn = panelEl.querySelector('.subpal-endscreen-skip-btn');
  assert.ok(skipBtn, '應有 skip 按鈕');

  const notNowBtn = panelEl.querySelector('.subpal-endscreen-not-now-btn');
  assert.ok(notNowBtn, '應有 not-now 按鈕');

  const closeBtn = panelEl.querySelector('.subpal-endscreen-close-btn');
  assert.ok(closeBtn, '應有 close 按鈕');
});

test('Given a visible panel When hide is called Then it is removed from the DOM', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());
  assert.ok(document.getElementById('subpal-endscreen-panel'), '面板應先顯示');

  panel.hide();
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, '隱藏後面板應從 DOM 移除');
});

test('Given a visible panel When show then hide then cleanup are called Then attach animation callbacks are fully cancelled', async () => {
  const Panel = await loadPanel();
  const { panel, scheduler, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  assert.equal(scheduler.pending, 1, 'show 後應有一個待執行的 attach 動畫排程');

  panel.hide();
  assert.equal(scheduler.pending, 0, 'hide 後應取消所有 attach 動畫排程');
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'hide 後面板應從 DOM 移除');

  scheduler.advance(0);
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, '已取消的 attach 動畫不應在 hide 後重新影響 DOM');

  panel.show([createOfficialTask()], createContext());
  assert.equal(scheduler.pending, 1, '再次 show 應只保留一個新的 attach 動畫排程');

  panel.cleanup();
  assert.equal(scheduler.pending, 0, 'cleanup 後應取消 attach 動畫排程');

  scheduler.advance(0);
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'cleanup 後已取消的 attach 動畫不應重建 DOM');
});

test('Given a visible panel When hide is called twice Then it is idempotent', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  panel.hide();
  panel.hide(); // 不應拋出例外

  assert.equal(document.getElementById('subpal-endscreen-panel'), null, '重複隱藏應冪等');
});

test('Given no prior show When hide is called Then it is idempotent', async () => {
  const Panel = await loadPanel();
  const { panel } = await createHarness(Panel);

  panel.hide(); // 不應拋出例外
  assert.equal(panel.isVisible, false, '未顯示前隱藏應冪等');
});

test('Given a visible panel When show is called again with different tasks Then it updates content idempotently', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  const panelEl1 = document.getElementById('subpal-endscreen-panel');
  const timecode1 = panelEl1.querySelector('.subpal-endscreen-timecode').textContent;

  panel.show([createCandidateTask()], createContext());
  const panelEl2 = document.getElementById('subpal-endscreen-panel');
  const timecode2 = panelEl2.querySelector('.subpal-endscreen-timecode').textContent;

  assert.notEqual(timecode1, timecode2, '更新後 timecode 應改變');
  assert.equal(timecode2, '05:21', '更新後 timecode 應為候選任務的 05:21');
});

test('Given a panel with task text containing HTML When it is rendered Then the text is safely escaped via textContent', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const malicious = '<img src=x onerror=alert(1)>惡意字幕';
  const task = createOfficialTask({ originalSubtitle: malicious });

  panel.show([task], createContext());

  const originalEl = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-original');
  assert.equal(originalEl.textContent, malicious, 'textContent 應包含完整原始字串');
  assert.equal(originalEl.innerHTML, malicious, 'innerHTML 不應被解析為 HTML');
});

test('Given a panel instance When show is called Then it renders rank/count context', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask({ rankReasons: ['no-approved-candidate', 'has-slot-key'] });

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const contextEl = panelEl.querySelector('.subpal-endscreen-rank-context');
  assert.ok(contextEl, '應有排名上下文元素');
  assert.ok(contextEl.textContent.length > 0, '排名上下文應有內容');
});

test('Given a panel instance When show is called Then it renders CTA buttons appropriate to the task action', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  // official-subtitle → submit-improvement CTA
  panel.show([createOfficialTask()], createContext());
  let panelEl = document.getElementById('subpal-endscreen-panel');
  let ctaBtn = panelEl.querySelector('.subpal-endscreen-cta-btn');
  assert.ok(ctaBtn, '應有 CTA 按鈕');
  assert.ok(ctaBtn.textContent.includes('提交'), '官方任務 CTA 應為提交改善');

  // candidate-translation → review-candidate CTA
  panel.show([createCandidateTask({ action: 'review-candidate' })], createContext());
  panelEl = document.getElementById('subpal-endscreen-panel');
  ctaBtn = panelEl.querySelector('.subpal-endscreen-cta-btn');
  assert.ok(ctaBtn, '應有 CTA 按鈕');
});

test('Given a visible panel When skip button is clicked Then the panel hides and onSkip callback fires', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let skipCalled = false;
  panel.onSkip(() => { skipCalled = true; });

  panel.show([createOfficialTask()], createContext());
  const skipBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-skip-btn');

  skipBtn.dispatchEvent({ type: 'click', target: skipBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.ok(skipCalled, 'skip 回調應被觸發');
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'skip 後面板應隱藏');
});

test('Given a visible panel When close button is clicked Then the panel hides and onClose callback fires', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let closeCalled = false;
  panel.onClose(() => { closeCalled = true; });

  panel.show([createOfficialTask()], createContext());
  const closeBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-close-btn');

  closeBtn.dispatchEvent({ type: 'click', target: closeBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.ok(closeCalled, 'close 回調應被觸發');
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'close 後面板應隱藏');
});

test('Given a visible panel When not-now button is clicked Then the panel hides', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  const notNowBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-not-now-btn');

  notNowBtn.dispatchEvent({ type: 'click', target: notNowBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'not-now 後面板應隱藏');
});

test('Given a panel instance When show is called Then the panel has accessible aria labels', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl.getAttribute('role') === 'dialog' || panelEl.getAttribute('role') === 'region',
    '面板應有 role 屬性');
  assert.ok(panelEl.getAttribute('aria-label'),
    '面板應有 aria-label');

  const closeBtn = panelEl.querySelector('.subpal-endscreen-close-btn');
  assert.ok(closeBtn.getAttribute('aria-label'),
    'close 按鈕應有 aria-label');
});

test('Given a panel instance When show is called with multiple tasks Then it renders the first task and shows count context', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const tasks = [createOfficialTask(), createCandidateTask()];

  panel.show(tasks, createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const countEl = panelEl.querySelector('.subpal-endscreen-task-count');
  assert.ok(countEl, '應有任務計數元素');
  assert.ok(countEl.textContent.includes('2'), '應顯示任務總數 2');
});

test('Given a panel instance When cleanup is called Then all state is cleared and DOM is removed', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  panel.cleanup();

  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'cleanup 後面板應從 DOM 移除');
  assert.equal(panel.isVisible, false, 'cleanup 後 isVisible 應為 false');
});

test('Given an initialized panel When cleanup and restart occur Then the old ConfigBridge subscription is released once', async () => {
  const configBridge = createTrackedConfigBridge();
  const Panel = await loadPanel({ configBridge });
  const document = new FakeDocument();
  document.defaultView = {};
  const panel = new Panel({ document });

  await panel.initialize();
  assert.equal(configBridge.activeSubscriptionCount, 1, '初始化後應有一個配置訂閱');

  panel.cleanup();
  panel.cleanup();
  assert.equal(configBridge.activeSubscriptionCount, 0, 'cleanup 後舊配置訂閱應被釋放');
  assert.equal(configBridge.unsubscribeCalls, 1, '重複 cleanup 不應重複取消同一訂閱');

  await panel.initialize();
  assert.equal(configBridge.subscribeCalls, 2, 'restart 應建立新的配置訂閱');
  assert.equal(configBridge.activeSubscriptionCount, 1, 'restart 後只應保留新的配置訂閱');

  configBridge.emit(true);
  assert.equal(panel.debug, true, '新的配置訂閱應更新面板 debug 狀態');

  panel.cleanup();
  panel.cleanup();
  assert.equal(configBridge.activeSubscriptionCount, 0, '最終 cleanup 應釋放新的配置訂閱');
  assert.equal(configBridge.unsubscribeCalls, 2, '每個生命週期的訂閱只應取消一次');
});

test('Given a panel with malformed task fields When show is called Then it does not crash and renders safely', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const malformed = {
    taskID: null,
    targetType: 'unknown',
    action: null,
    timestamp: null,
    timecode: undefined,
    originalSubtitle: null,
    suggestedSubtitle: undefined,
    rankReasons: null,
    userState: null
  };

  panel.show([malformed], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl, '即使任務欄位不完整，面板仍應安全渲染');
  const originalEl = panelEl.querySelector('.subpal-endscreen-original');
  assert.ok(originalEl, '應有原始字幕元素');
  assert.equal(originalEl.textContent, '', 'null 字幕應渲染為空字串');
});

// ─── 端到端傳遞鏈源碼驗證 ───

test('Given MAIN initialization When inspected Then it owns no task transport or panel event bridge', async () => {
  const source = await readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('EndscreenTaskBridge'));
  assert.ok(!source.includes('dispatchInternalEvent'));
  assert.ok(!source.includes('requestCrowdsourcingTasks'));
});

test('Given the controller When inspected Then it checks contextGeneration before delivering tasks (stale context guard)', async () => {
  const source = await readFile(new URL('../content/core/endscreen-task-controller.js', import.meta.url), 'utf8');
  assert.ok(source.includes('generation !== this.contextGeneration'),
    '控制器應在呼叫 onTasks 前檢查 contextGeneration，防止過時 context 的任務被送達');
});
