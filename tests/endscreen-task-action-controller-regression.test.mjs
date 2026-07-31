import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EndscreenTaskActionController } from '../content/ui/endscreen-task-action-controller.js';

test('Given a durable queued contribution When applyResult receives it Then the controller enters success while playback success remains success', () => {
  const controller = new EndscreenTaskActionController(() => {});
  controller.applyResult('vote-like', { status: 'queued-locally', operationId: 'vote-1' });
  assert.equal(controller.state, 'success');
  assert.equal(controller.successfulVoteState, 'like');
  controller.reset();
  controller.applyResult('jump-to-timecode', { status: 'success' });
  assert.equal(controller.state, 'success');
  assert.equal(controller.successfulIntent, 'jump-to-timecode');
});
