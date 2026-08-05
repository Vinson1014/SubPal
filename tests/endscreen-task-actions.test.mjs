import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCandidateTask,
  createContext,
  createHarness,
  createOfficialTask,
  loadPanel
} from './endscreen-task-panel-fixtures.mjs';

async function loadActionPanel() {
  const Panel = await loadPanel();
  return class ActionTestPanel extends Panel {
    createControl({ className, text, ariaLabel, disabled = false, onClick }) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = text;
      button.disabled = disabled;
      button.setAttribute('aria-label', ariaLabel || text);
      if (className.includes('subpal-endscreen-timecode')) {
        button.setAttribute('data-control-id', `control-test-${className}`);
      }
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!button.disabled) onClick(event);
      });
      return button;
    }
  };
}

function expectedResolutionContext(task) {
  return {
    taskID: task.taskID,
    targetType: task.targetType,
    action: task.action,
    slotKey: task.slotKey,
    timestamp: task.timestamp
  };
}

function assertExactResolutionContext(actual, task) {
  assert.deepEqual(actual, expectedResolutionContext(task));
  assert.deepEqual(Object.keys(actual).sort(), [
    'action', 'slotKey', 'targetType', 'taskID', 'timestamp'
  ]);
}

function clickButton(panel, selector) {
  const button = panel.querySelector(selector);
  assert.ok(button, `expected task action button ${selector}`);
  button.dispatchEvent({ type: 'click', target: button, preventDefault: () => {}, stopPropagation: () => {} });
  return button;
}

test('Given an official task When its primary action is clicked Then it emits submit-improvement intent with exact resolutionContext without requiring translationID', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();
  const context = createContext();
  let received = null;
  panel.onAction((payload) => { received = payload; });

  panel.show([task], context);
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-cta-btn');

  assert.equal(received.intent, 'submit-improvement');
  assert.equal(received.task.translationID, null);
  assertExactResolutionContext(received.resolutionContext, task);
});

test('Given an official task When its existing submit action is used Then it retains its original payload without a jump contract', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  let received = null;
  panel.onAction((payload) => { received = payload; });

  panel.show([createOfficialTask()], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-cta-btn');

  assert.equal(received.intent, 'submit-improvement');
  assert.equal(Object.hasOwn(received, 'expected'), false);
});

test('Given a displayed task timecode When it renders or receives focus Then it does not dispatch until one explicit click sends the exact content-owned jump intent', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();
  const context = createContext();
  const received = [];
  panel.onAction((payload) => { received.push(payload); });

  panel.show([task], context);
  const panelElement = document.getElementById('subpal-endscreen-panel');
  const jumpButton = panelElement.querySelector('.subpal-endscreen-timecode-jump-btn');
  assert.ok(jumpButton, 'timecode should be a visible quick-jump button');
  assert.equal(jumpButton.type, 'button');
  assert.equal(jumpButton.getAttribute('aria-label'), '跳至 02:04 字幕時間點');
  assert.equal(jumpButton.textContent, '跳至 02:04');
  assert.equal(jumpButton.style.fontFamily, '"SF Mono", "Monaco", "Consolas", monospace');
  assert.equal(jumpButton.style.fontVariantNumeric, 'tabular-nums');

  jumpButton.focus();
  assert.deepEqual(received, [], 'rendering and focus must never seek or dispatch');

  clickButton(panelElement, '.subpal-endscreen-timecode-jump-btn');
  assert.equal(received.length, 1);
  assert.equal(received[0].intent, 'jump-to-timecode');
  assert.equal(received[0].task, task);
  assert.equal(received[0].context, context);
  assertExactResolutionContext(received[0].resolutionContext, task);
  assert.deepEqual(JSON.parse(JSON.stringify(received[0].expected)), {
    videoId: context.videoId,
    sessionId: context.sessionId,
    epoch: context.epoch,
    targetTimestamp: task.timestamp
  });
});

test('Given a pending quick jump When its timecode control is clicked repeatedly Then it dispatches exactly one action and blocks duplicates', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  let calls = 0;
  let resolveAction;
  panel.onAction(() => {
    calls += 1;
    return new Promise((resolve) => { resolveAction = resolve; });
  });

  panel.show([createOfficialTask()], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-timecode-jump-btn');
  const pendingJump = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-timecode-jump-btn');
  assert.equal(pendingJump.disabled, true);
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-timecode-jump-btn');

  assert.equal(calls, 1);
  resolveAction({ status: 'success' });
});

test('Given a missing, negative, or non-finite task timestamp When the panel renders Then quick jump is disabled and cannot dispatch', async () => {
  const Panel = await loadActionPanel();
  for (const timestamp of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { panel, document } = await createHarness(Panel);
    let calls = 0;
    panel.onAction(() => { calls += 1; });
    panel.show([createOfficialTask({ timestamp })], createContext());

    const jumpButton = document.getElementById('subpal-endscreen-panel')
      .querySelector('.subpal-endscreen-timecode-jump-btn');
    assert.equal(jumpButton.disabled, true, `timestamp ${timestamp} should disable quick jump`);
    clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-timecode-jump-btn');
    assert.equal(calls, 0);
  }
});

test('Given a failed quick jump When unavailable or stale feedback returns Then the panel stays open with an accessible Traditional Chinese retry message', async () => {
  const Panel = await loadActionPanel();
  for (const error of ['目前無法跳轉至字幕時間點，請繼續觀看。', '影片已切換，請再試一次。']) {
    const { panel, document } = await createHarness(Panel);
    panel.onAction(() => Promise.resolve({ status: 'error', error }));
    panel.show([createOfficialTask()], createContext());

    clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-timecode-jump-btn');
    await Promise.resolve();

    const panelElement = document.getElementById('subpal-endscreen-panel');
    const status = panelElement.querySelector('.subpal-endscreen-action-status');
    assert.equal(panel.isVisible, true);
    assert.equal(status.getAttribute('role'), 'alert');
    assert.equal(status.textContent, error);
    assert.equal(panelElement.querySelector('.subpal-endscreen-timecode-jump-btn').disabled, false);
  }
});

test('Given a partial quick jump with a specific restoration fallback When it settles Then the panel shows that fallback and keeps jump retryable', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const fallback = '已跳轉至字幕時間點，但無法安全還原播放器介面，請使用 Netflix 原生控制。';
  panel.onAction(() => Promise.resolve({
    status: 'partial',
    partial: true,
    reason: 'player-ui-restore-timeout',
    error: fallback
  }));
  panel.show([createOfficialTask()], createContext());

  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-timecode-jump-btn');
  await Promise.resolve();

  const panelElement = document.getElementById('subpal-endscreen-panel');
  assert.equal(panelElement.querySelector('.subpal-endscreen-action-status').textContent, fallback);
  assert.equal(panelElement.querySelector('.subpal-endscreen-timecode-jump-btn').disabled, false);
});

test('Given a quick jump success or a late result after a task update When it settles Then the current panel remains usable and stale completion cannot alter it', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  let resolveAction;
  panel.onAction(() => new Promise((resolve) => { resolveAction = resolve; }));
  const firstTask = createOfficialTask();
  const nextTask = createCandidateTask();

  panel.show([firstTask], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-timecode-jump-btn');
  resolveAction({ status: 'success' });
  await Promise.resolve();
  await Promise.resolve();

  let panelElement = document.getElementById('subpal-endscreen-panel');
  assert.equal(panel.isVisible, true);
  assert.equal(panelElement.querySelector('.subpal-endscreen-timecode-jump-btn').disabled, false);
  assert.equal(panelElement.querySelector('.subpal-endscreen-action-status').getAttribute('role'), 'status');
  assert.equal(panelElement.querySelector('.subpal-endscreen-action-status').textContent, '已跳轉至字幕時間點。');

  clickButton(panelElement, '.subpal-endscreen-timecode-jump-btn');
  panel.show([nextTask], createContext({ epoch: 4 }));
  resolveAction({ status: 'error', error: '影片已切換，請再試一次。' });
  await Promise.resolve();
  await Promise.resolve();

  panelElement = document.getElementById('subpal-endscreen-panel');
  assert.equal(panelElement.querySelector('.subpal-endscreen-timecode').textContent, `跳至 ${nextTask.timecode}`);
  assert.equal(panelElement.querySelector('.subpal-endscreen-action-status'), null);
  assert.equal(panelElement.querySelector('.subpal-endscreen-timecode-jump-btn').disabled, false);
});

test('Given a pending task action When next-task resets the task-local state Then its late completion cannot alter the newly selected task', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  let resolveAction;
  panel.onAction(() => new Promise((resolve) => { resolveAction = resolve; }));
  const firstTask = createOfficialTask();
  const secondTask = createCandidateTask();

  panel.show([firstTask, secondTask], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-cta-btn');
  assert.equal(panel.getActionState(), 'loading');

  panel.setActionState('idle');
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-next-task-btn');
  assert.equal(panel.getActionState(), 'idle', '下一題應重置前一題的 loading 狀態');
  assert.equal(document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-timecode').textContent, `跳至 ${secondTask.timecode}`);

  resolveAction({ status: 'queued-locally', operationId: 'operation-late-completion-1' });
  await Promise.resolve();
  await Promise.resolve();

  const panelElement = document.getElementById('subpal-endscreen-panel');
  assert.equal(panelElement.querySelector('.subpal-endscreen-action-status'), null,
    '前一題的 late completion 不得在新任務顯示成功狀態');
  assert.equal(panel.getActionState(), 'idle', '前一題的 late completion 不得改變新任務狀態');
  assert.equal(panelElement.querySelector('.subpal-endscreen-next-task-btn').disabled, false,
    '新任務的下一題控制應維持可用');
});

test('Given a review-candidate task When like and dislike are clicked Then both are primary intents and preserve candidate translationID', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createCandidateTask({ action: 'review-candidate' });
  const received = [];
  panel.onAction((payload) => { received.push(payload); });

  panel.show([task], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-like-btn');
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-dislike-btn');

  assert.deepEqual(received.map((payload) => payload.intent), ['vote-like', 'vote-dislike']);
  assert.deepEqual(received.map((payload) => payload.translationID), [task.translationID, task.translationID]);
  for (const payload of received) assertExactResolutionContext(payload.resolutionContext, task);
});

test('Given a review-candidate task When the secondary submit-better action is clicked Then it emits submit-better-candidate intent', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createCandidateTask({ action: 'review-candidate' });
  let received = null;
  panel.onAction((payload) => { received = payload; });

  panel.show([task], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-submit-better-btn');

  assert.equal(received.intent, 'submit-better-candidate');
  assert.equal(received.sourceTranslationID, task.translationID);
  assertExactResolutionContext(received.resolutionContext, task);
});

test('Given a submit-better-candidate task When its primary action is clicked Then it emits the primary submit-better-candidate intent with sourceTranslationID', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createCandidateTask({ action: 'submit-better-candidate' });
  let received = null;
  panel.onAction((payload) => { received = payload; });

  panel.show([task], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-cta-btn');

  assert.equal(received.intent, 'submit-better-candidate');
  assert.equal(received.sourceTranslationID, task.translationID);
  assertExactResolutionContext(received.resolutionContext, task);
});

test('Given an action request When the same action is clicked repeatedly Then one loading action remains observable', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();
  let calls = 0;
  let resolveAction;
  panel.onAction(() => {
    calls += 1;
    return new Promise((resolve) => { resolveAction = resolve; });
  });

  panel.show([task], createContext());
  const panelElement = document.getElementById('subpal-endscreen-panel');
  clickButton(panelElement, '.subpal-endscreen-cta-btn');
  clickButton(panelElement, '.subpal-endscreen-cta-btn');

  assert.equal(calls, 1);
  assert.equal(panel.getStatus().actionState, 'loading');
  resolveAction({ status: 'queued-locally', operationId: 'operation-duplicate-1' });
});

test('Given an action promise that resolves successfully When it settles Then success is observable without a misleading immediate success', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  panel.onAction(() => Promise.resolve({ status: 'queued-locally', operationId: 'operation-settled-1' }));

  panel.show([createOfficialTask()], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-cta-btn');
  assert.equal(panel.getStatus().actionState, 'loading');

  await Promise.resolve();
  assert.equal(panel.getStatus().actionState, 'success');
});

test('Given an action promise that resolves with an error When it settles Then error is observable and the action is not reported as success', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  panel.onAction(() => Promise.resolve({ status: 'error', error: 'backend unavailable' }));

  panel.show([createOfficialTask()], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-cta-btn');
  await Promise.resolve();

  assert.equal(panel.getStatus().actionState, 'error');
  assert.equal(panel.getStatus().actionError, 'backend unavailable');
});

test('Given an action promise that resolves without a completion status When it settles Then the existing fallback error remains observable', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  panel.onAction(() => Promise.resolve(undefined));

  panel.show([createOfficialTask()], createContext());
  clickButton(document.getElementById('subpal-endscreen-panel'), '.subpal-endscreen-cta-btn');
  await Promise.resolve();

  assert.equal(panel.getStatus().actionState, 'error');
  assert.equal(panel.getStatus().actionError, '無法完成此任務，請再試一次。');
});

test('Given a rendered task When its marked timecode control is clicked Then the jump intent carries the per-render control ID without changing layout', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();
  let received = null;
  panel.onAction((payload) => { received = payload; });

  panel.show([task], createContext());
  const control = panel.container.querySelector('.subpal-endscreen-timecode');
  assert.ok(control);
  assert.equal(control.className.includes('subpal-endscreen-timecode'), true);
  assert.equal(typeof control.getAttribute('data-control-id'), 'string');
  control.dispatchEvent({ type: 'click', target: control, currentTarget: control, preventDefault() {}, stopPropagation() {} });

  assert.equal(received.intent, 'jump-to-timecode');
  assert.equal(received.controlId, control.getAttribute('data-control-id'));
});
