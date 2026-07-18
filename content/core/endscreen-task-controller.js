const TYPE_B_ENDSCREEN_TASKS_ENABLED = false;

class EndscreenTaskController {
  constructor({ clock, schedule, sendMessage, onTasks, languageCode, debounceMs = 500 }) {
    if (typeof clock !== 'function' || typeof schedule !== 'function' || typeof sendMessage !== 'function' || typeof onTasks !== 'function') {
      throw new TypeError('EndscreenTaskController requires injected dependencies');
    }
    if (typeof languageCode !== 'string' || languageCode.length === 0 || !Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new TypeError('EndscreenTaskController requires valid configuration');
    }

    this.clock = clock;
    this.schedule = schedule;
    this.sendMessage = sendMessage;
    this.onTasks = onTasks;
    this.languageCode = languageCode;
    this.debounceMs = debounceMs;
    this.pendingConfirmation = null;
    this.lastFinishedContexts = new Set();
    this.dismissedContexts = new Set();
    this.contextGeneration = 0;
    this.activeContextKey = null;
  }

  observe(observation) {
    const context = observation?.context;
    if (!this.isTrustedContext(context)) return;
    const contextKey = this.getContextKey(context);
    if (this.activeContextKey !== contextKey) {
      if (this.activeContextKey !== null) this.contextGeneration += 1;
      this.activeContextKey = contextKey;
      this.pendingConfirmation = null;
    }
    if (!this.isEligible(observation)) return;
    if (this.lastFinishedContexts.has(contextKey) || this.dismissedContexts.has(contextKey)) return;

    const now = this.clock();
    const pending = this.pendingConfirmation;
    if (pending && pending.contextKey === contextKey && now - pending.observedAt <= this.debounceMs) {
      pending.confirmed = true;
      return;
    }

    const confirmation = {
      contextKey,
      context: Object.assign(Object.create(Object.getPrototypeOf(context)), context),
      observedAt: now,
      confirmed: false
    };
    this.pendingConfirmation = confirmation;
    this.schedule(() => {
      if (this.pendingConfirmation !== confirmation || !confirmation.confirmed) return;
      this.pendingConfirmation = null;
      this.requestTasks(confirmation.context, confirmation.contextKey, this.contextGeneration);
    }, this.debounceMs);
  }

  dismiss(context) {
    const contextKey = this.getContextKey(context);
    this.dismissedContexts.add(contextKey);
    if (this.pendingConfirmation?.contextKey === contextKey) this.pendingConfirmation = null;
  }

  handleInternalEvent(event) {
    if (event?.type === 'ENDSCREEN_INACTIVE') {
      this.contextGeneration += 1;
      this.pendingConfirmation = null;
      return;
    }
    if (event?.type !== 'VIDEO_ID_CHANGED') return;
    this.contextGeneration += 1;
    this.pendingConfirmation = null;
    this.lastFinishedContexts.clear();
    this.dismissedContexts.clear();
    this.activeContextKey = null;
  }

  isEligible(observation) {
    const context = observation?.context;
    const snapshot = observation?.snapshot;
    const hasValidSnapshot = (
      Number.isFinite(snapshot?.currentTime) && snapshot.currentTime > 0 &&
      Number.isFinite(snapshot?.duration) && snapshot.duration > 0
    );
    if (!this.isTrustedContext(context) || !hasValidSnapshot) return false;

    if (observation.variant === 'type-b') {
      if (!TYPE_B_ENDSCREEN_TASKS_ENABLED) return false;
      return (
        (snapshot.state === 'playing' || snapshot.state === 'paused') &&
        observation.evidence?.promotedPreview === true
      );
    }
    if (observation.variant === 'type-a-next-episode') {
      return (
        snapshot.state === 'playing' &&
        observation.evidence?.watchCreditsCta === true &&
        observation.evidence?.nextEpisodeCta === true
      );
    }
    return false;
  }

  isTrustedContext(context) {
    return (
      context?.state === 'ready' &&
      typeof context.videoId === 'string' && context.videoId.length > 0 &&
      typeof context.sessionId === 'string' && context.sessionId.startsWith('watch-') &&
      Number.isInteger(context.epoch) && context.epoch >= 0
    );
  }

  getContextKey(context) {
    return `${context?.videoId ?? ''}|${context?.sessionId ?? ''}|${context?.epoch ?? ''}`;
  }

  requestTasks(context, contextKey, generation) {
    this.lastFinishedContexts.add(contextKey);
    const message = Object.assign(Object.create(Object.getPrototypeOf(context)), {
      type: 'GET_CROWDSOURCING_TASKS',
      videoID: context.videoId,
      languageCode: this.languageCode,
      limit: 5
    });
    return this.sendMessage(message)
      .then((response) => {
        if (generation !== this.contextGeneration || !Array.isArray(response?.tasks)) return;
        this.onTasks(response.tasks, context);
      })
      .catch(() => null);
  }
}

export { EndscreenTaskController };
