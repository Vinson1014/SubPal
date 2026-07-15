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
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!button.disabled) onClick();
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
  resolveAction({ status: 'success' });
});

test('Given an action promise that resolves successfully When it settles Then success is observable without a misleading immediate success', async () => {
  const Panel = await loadActionPanel();
  const { panel, document } = await createHarness(Panel);
  panel.onAction(() => Promise.resolve({ status: 'success' }));

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
