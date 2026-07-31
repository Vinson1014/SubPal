const ACTION_STATES = new Set(['idle', 'loading', 'disabled', 'success', 'error']);
const BLOCKING_STATES = new Set(['loading', 'disabled', 'success']);

function actionText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

class EndscreenTaskActionController {
  constructor(onChange) {
    this.onChange = onChange;
    this.state = 'idle';
    this.error = null;
    this.successfulVoteState = null;
    this.successfulIntent = null;
    this.generation = 0;
  }

  reset() {
    this.generation += 1;
    this.state = 'idle';
    this.error = null;
    this.successfulVoteState = null;
    this.successfulIntent = null;
  }

  setState(state) {
    if (!ACTION_STATES.has(state)) return false;
    this.state = state;
    if (state !== 'error') this.error = null;
    this.onChange();
    return true;
  }

  isBlocked() {
    return this.state === 'success'
      ? this.successfulIntent !== 'jump-to-timecode'
      : BLOCKING_STATES.has(this.state);
  }

  selectedVote(task) {
    return this.successfulVoteState ?? task?.userState?.voteState;
  }

  handle(intent, task, context, callback, metadata = {}) {
    if (this.isBlocked()) return undefined;
    if (!task || typeof task !== 'object') {
      this.fail('任務資料無效，請稍後再試。');
      return undefined;
    }
    if (typeof callback !== 'function') {
      this.fail('無法處理此任務，請再試一次。');
      return undefined;
    }
    if (intent === 'jump-to-timecode' && (!Number.isFinite(task.timestamp) || task.timestamp < 0)) {
      this.fail('時間點資料無效，請再試一次。');
      return undefined;
    }

    let result;
    try {
      result = callback(this.buildPayload(intent, task, context, metadata));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : actionText(error));
      return undefined;
    }

    if (!result || typeof result.then !== 'function') {
      this.applyResult(intent, result);
      return result;
    }

    const generation = this.generation;
    this.state = 'loading';
    this.error = null;
    this.onChange();
    return result.then(
      (settled) => {
        if (generation !== this.generation || this.state !== 'loading') return settled;
        this.applyResult(intent, settled, true);
        return settled;
      },
      (error) => {
        if (generation !== this.generation || this.state !== 'loading') return { status: 'stale' };
        this.fail(error instanceof Error ? error.message : actionText(error));
        return { status: 'error', error: this.error };
      }
    );
  }

  buildPayload(intent, task, context, metadata = {}) {
    const resolutionContext = typeof task.constructor === 'function' ? new task.constructor() : {};
    resolutionContext.taskID = task.taskID;
    resolutionContext.targetType = task.targetType;
    resolutionContext.action = task.action;
    resolutionContext.slotKey = task.slotKey;
    resolutionContext.timestamp = task.timestamp;

    const payload = { intent, task, context, resolutionContext };
    if (intent === 'jump-to-timecode') {
      payload.controlId = metadata.controlId;
      payload.requestId = metadata.requestId;
      payload.issuedAt = metadata.issuedAt;
    }
    if (intent === 'jump-to-timecode') {
      payload.expected = {
        videoId: context?.videoId,
        sessionId: context?.sessionId,
        epoch: context?.epoch,
        targetTimestamp: task.timestamp
      };
    } else if (intent === 'vote-like' || intent === 'vote-dislike') {
      payload.translationID = task.translationID;
    } else if (intent === 'submit-better-candidate') {
      payload.sourceTranslationID = task.translationID;
    }
    return payload;
  }

  applyResult(intent, result, notifyIdle = false) {
    if (result?.status === 'success' || result?.status === 'queued-locally') {
      this.state = 'success';
      this.error = null;
      this.successfulIntent = intent;
      if (intent === 'vote-like') this.successfulVoteState = 'like';
      if (intent === 'vote-dislike') this.successfulVoteState = 'dislike';
    } else if (result?.status === 'error' || notifyIdle) {
      this.state = 'error';
      this.error = actionText(result?.error) || '無法完成此任務，請再試一次。';
    }
    if (notifyIdle || this.state !== 'idle') this.onChange();
  }

  fail(message) {
    this.state = 'error';
    this.error = message;
    this.onChange();
  }
}

export { EndscreenTaskActionController };
