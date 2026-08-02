const RESOLUTION_CONTEXT_KEYS = ['action', 'slotKey', 'targetType', 'taskID', 'timestamp'];
const JUMP_EXPECTED_KEYS = ['epoch', 'sessionId', 'targetTimestamp', 'videoId'];

class EndscreenActionCoordinator {
  constructor({ Dialog, translationBridge, voteBridge, actionConfig, configManager, getPanel, getContext, getRouteGeneration, isCurrentLifecycle, playback }) {
    this.Dialog = Dialog;
    this.translationBridge = translationBridge;
    this.voteBridge = voteBridge;
    this.actionConfig = actionConfig;
    this.configManager = configManager;
    this.getPanel = getPanel;
    this.getContext = getContext;
    this.getRouteGeneration = getRouteGeneration;
    this.isCurrentLifecycle = isCurrentLifecycle;
    this.playback = playback;
    this.submissionDialog = null;
    this.pendingSubmission = null;
    this.pendingJump = null;
  }

  async handlePanelAction(panel, lifecycle, payload) {
    if (!this.isCurrentLifecycle(lifecycle) || this.getPanel() !== panel) {
      return { status: 'error', error: '任務已失效，請稍後再試。' };
    }
    if (payload?.intent === 'jump-to-timecode') {
      return this.jumpToTimecode(panel, lifecycle, payload);
    }
    const actionData = this.getActionData(payload);
    if (!actionData) return { status: 'error', error: '任務資料無效，請稍後再試。' };
    if (!this.isActionAllowed(actionData.task, payload.intent)) {
      return { status: 'error', error: '任務行動與目標不相容，請稍後再試。' };
    }
    if (payload.intent === 'vote-like' || payload.intent === 'vote-dislike') {
      return this.enqueueVote(payload, actionData, { panel, lifecycle, routeGeneration: this.getRouteGeneration() });
    }
    if (payload.intent === 'submit-improvement' || payload.intent === 'submit-better-candidate') {
      return this.openSubmission(panel, lifecycle, payload, actionData);
    }
    return { status: 'error', error: '不支援的任務操作。' };
  }

  async jumpToTimecode(panel, lifecycle, payload) {
    const expected = payload?.expected;
    const request = {
      controlId: payload?.controlId,
      requestId: payload?.requestId,
      issuedAt: payload?.issuedAt
    };
    if (!expected || typeof expected !== 'object' || Object.keys(expected).sort().join('|') !== JUMP_EXPECTED_KEYS.join('|')) {
      return { status: 'error', error: '跳轉資料無效，請再試一次。', reason: 'invalid-expected-context' };
    }
    if (!Number.isInteger(expected.epoch) || expected.epoch < 0 ||
        typeof expected.videoId !== 'string' || !expected.videoId ||
        typeof expected.sessionId !== 'string' || !expected.sessionId.startsWith('watch-')) {
      return { status: 'error', error: '跳轉資料無效，請再試一次。', reason: 'invalid-expected-context' };
    }
    if (!Number.isFinite(expected.targetTimestamp) || expected.targetTimestamp < 0) {
      return { status: 'error', error: '時間點資料無效，請再試一次。', reason: 'invalid-target-timestamp' };
    }
    if (typeof request.controlId !== 'string' || !request.controlId || typeof request.requestId !== 'string' || !request.requestId || !Number.isFinite(request.issuedAt)) {
      return { status: 'error', error: '請由字幕時間點按鈕重新操作。', reason: 'trusted-click-required' };
    }

    const currentContext = this.getContext?.();
    if (!currentContext || currentContext.state !== 'ready') {
      return { status: 'error', error: '目前影片狀態已失效，請再試一次。', reason: 'stale-context' };
    }
    if (expected.videoId !== currentContext.videoId || expected.sessionId !== currentContext.sessionId || expected.epoch !== currentContext.epoch) {
      return { status: 'error', error: '影片已切換，請再試一次。', reason: 'content-context-mismatch' };
    }

    const lifecycleState = { panel, lifecycle, routeGeneration: this.getRouteGeneration() };
    if (!this.isActionCurrent(lifecycleState)) {
      return { status: 'error', error: '任務已失效，請稍後再試。', reason: 'stale-lifecycle' };
    }
    const dispatchContext = this.getContext?.();
    if (!dispatchContext || dispatchContext.state !== 'ready' || dispatchContext.videoId !== expected.videoId ||
        dispatchContext.sessionId !== expected.sessionId || dispatchContext.epoch !== expected.epoch) {
      return { status: 'error', error: '影片狀態已變更，請再試一次。', reason: 'stale-context' };
    }

    const intent = {
      variant: 'jump-to-timecode',
      payload: {
        targetTimestamp: expected.targetTimestamp,
        ...request
      },
      expected: {
        videoId: expected.videoId,
        sessionId: expected.sessionId,
        epoch: expected.epoch
      }
    };
    const pending = { controller: new AbortController() };
    this.pendingJump = pending;
    try {
      const result = await this.playback.perform(intent, { signal: pending.controller.signal });
      if (!this.isActionCurrent(lifecycleState)) {
        return { status: 'error', error: '任務已失效，請稍後再試。', reason: 'stale-lifecycle' };
      }
      const postContext = this.getContext?.();
      if (!postContext || postContext.state !== 'ready' || postContext.videoId !== expected.videoId ||
          postContext.sessionId !== expected.sessionId || postContext.epoch !== expected.epoch) {
        return { status: 'error', error: '影片狀態已變更，請再試一次。', reason: 'post-context-mismatch' };
      }
      if (result?.ok === true && result.value?.variant === 'jump-to-timecode') {
        if (result.value.status === 'success') return { status: 'success' };
        if (result.value.status === 'partial') {
          return {
            status: 'partial',
            error: '已跳轉至字幕時間點，但無法安全還原播放器介面，請使用 Netflix 原生控制。',
            reason: 'player-ui-restore-failed'
          };
        }
      }
      return this.playbackFailure(result?.error);
    } catch {
      return this.playbackFailure();
    } finally {
      if (this.pendingJump === pending) this.pendingJump = null;
    }
  }

  playbackFailure(error) {
    switch (error?.kind) {
      case 'timeout':
        return { status: 'error', error: '目前無法跳轉至字幕時間點，請繼續觀看。', reason: 'playback-timeout' };
      case 'cancelled':
        return { status: 'error', error: '跳轉操作已取消，請再試一次。', reason: 'playback-cancelled' };
      case 'disconnected':
        return { status: 'error', error: '目前無法跳轉至字幕時間點，請繼續觀看。', reason: 'page-adapter-disconnected' };
      case 'forbidden':
        return { status: 'error', error: '請由字幕時間點按鈕重新操作。', reason: 'trusted-click-required' };
      case 'stale-context':
        return { status: 'error', error: '影片狀態已變更，請再試一次。', reason: 'playback-stale-context' };
      default:
        return { status: 'error', error: '無法跳轉至字幕時間點，請稍後再試。', reason: 'page-command-failed' };
    }
  }

  getActionData(payload) {
    const task = payload?.task;
    const resolutionContext = payload?.resolutionContext;
    if (!task || typeof task !== 'object' || !resolutionContext || typeof resolutionContext !== 'object') return null;
    if (Object.keys(resolutionContext).sort().join('|') !== RESOLUTION_CONTEXT_KEYS.join('|')) return null;
    const videoId = task.videoID || payload.context?.videoId;
    if (!videoId || typeof videoId !== 'string' || !Number.isFinite(task.timestamp) || task.slotKey === undefined || !task.taskID || !task.targetType || !task.action) return null;
    if (resolutionContext.taskID !== task.taskID || resolutionContext.targetType !== task.targetType || resolutionContext.action !== task.action || resolutionContext.slotKey !== task.slotKey || resolutionContext.timestamp !== task.timestamp) return null;
    if (!((task.targetType === 'official-subtitle' && task.action === 'submit-improvement') || (task.targetType === 'candidate-translation' && ['review-candidate', 'submit-better-candidate'].includes(task.action)))) return null;
    return { videoId, task, resolutionContext };
  }

  isActionAllowed(task, intent) {
    if (task.targetType === 'official-subtitle' && task.action === 'submit-improvement') return intent === 'submit-improvement';
    if (task.targetType === 'candidate-translation' && task.action === 'review-candidate') return ['vote-like', 'vote-dislike', 'submit-better-candidate'].includes(intent);
    return task.targetType === 'candidate-translation' && task.action === 'submit-better-candidate' && intent === 'submit-better-candidate';
  }

  async enqueueVote(payload, actionData, lifecycleState) {
    if (!payload.translationID || typeof payload.translationID !== 'string' || payload.translationID !== actionData.task.translationID) {
      return { status: 'error', error: '候選翻譯資料無效，請再試一次。' };
    }
    try {
      await this.initializeActionConfig();
      if (!this.voteBridge.isInitialized) await this.voteBridge.initialize();
      if (!this.isActionCurrent(lifecycleState)) return { status: 'error', error: '任務已失效，請稍後再試。' };
      const voteState = payload.intent === 'vote-like' ? 'like' : 'dislike';
      const result = await this.voteBridge.enqueue({
        videoId: actionData.videoId,
        timestamp: actionData.task.timestamp,
        voteType: voteState === 'like' ? 'upvote' : 'downvote',
        translationID: payload.translationID,
        originalSubtitle: actionData.task.originalSubtitle,
        slotKey: actionData.task.slotKey,
        voteState,
        resolutionContext: actionData.resolutionContext
      });
      return result?.ok === true && result.value?.status === 'queued-locally' && result.value.operationId
        ? { status: 'queued-locally', operationId: result.value.operationId }
        : { status: 'error', error: '投票未加入隊列，請再試一次。' };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : '投票失敗，請再試一次。' };
    }
  }

  async openSubmission(panel, lifecycle, payload, actionData) {
    if (!actionData.task.originalSubtitle || typeof actionData.task.originalSubtitle !== 'string') return { status: 'error', error: '原字幕資料無效，請稍後再試。' };
    if (payload.intent === 'submit-better-candidate' && (!payload.sourceTranslationID || typeof payload.sourceTranslationID !== 'string' || payload.sourceTranslationID !== actionData.task.translationID)) return { status: 'error', error: '候選翻譯資料無效，請再試一次。' };
    if (this.pendingSubmission) return { status: 'error', error: '翻譯提交仍在處理中。' };

    const routeGeneration = this.getRouteGeneration();
    let dialog = this.submissionDialog;
    try {
      await this.initializeActionConfig();
      if (!dialog) {
        dialog = new this.Dialog();
        this.submissionDialog = dialog;
        await dialog.initialize();
      }
      if (!this.translationBridge.isInitialized) await this.translationBridge.initialize();
    } catch (error) {
      this.releaseDialog(dialog);
      return { status: 'error', error: error instanceof Error ? error.message : '無法開啟翻譯提交表單，請再試一次。' };
    }
    if (!this.isActionCurrent({ panel, lifecycle, routeGeneration }) || this.submissionDialog !== dialog) {
      this.releaseDialog(dialog);
      return { status: 'error', error: '任務已失效，請稍後再試。' };
    }

    return new Promise((resolve) => {
      const pending = { panel, lifecycle, routeGeneration, isSubmitting: false, settled: false, resolve, payload, actionData };
      this.pendingSubmission = pending;
      dialog.onSubmit((submission) => this.enqueueSubmission(pending, submission));
      dialog.onCancel(() => this.finishSubmission(pending, { status: 'error', error: '已取消翻譯提交。' }));
      dialog.onClose(() => {
        if (!pending.isSubmitting) this.finishSubmission(pending, { status: 'error', error: '已取消翻譯提交。' });
      });
      Promise.resolve(dialog.open({
        videoId: actionData.videoId,
        timestamp: actionData.task.timestamp,
        original: actionData.task.originalSubtitle,
        text: actionData.task.suggestedSubtitle || actionData.task.originalSubtitle,
        slotKey: actionData.task.slotKey,
        resolutionContext: actionData.resolutionContext,
        translationID: null,
        sourceTranslationID: payload.sourceTranslationID
      })).then(() => {
        if (this.pendingSubmission !== pending || !this.isSubmissionCurrent(pending) || !dialog.isOpen) {
          dialog.close();
          this.finishSubmission(pending, { status: 'error', error: '無法開啟翻譯提交表單，請再試一次。' });
        }
      }, (error) => {
        dialog.close();
        this.finishSubmission(pending, { status: 'error', error: error instanceof Error ? error.message : '無法開啟翻譯提交表單，請再試一次。' });
      });
    });
  }

  async initializeActionConfig() {
    if (!this.actionConfig.isInitialized) await this.actionConfig.initialize();
  }

  async enqueueSubmission(pending, submission) {
    if (!this.isSubmissionCurrent(pending)) {
      const completion = { status: 'error', error: '任務已失效，請稍後再試。' };
      this.finishSubmission(pending, completion);
      return completion;
    }
    pending.isSubmitting = true;
    const { payload, actionData } = pending;
    if (!submission?.translation || !submission.submissionReason || !submission.languageCode) {
      pending.isSubmitting = false;
      return { status: 'error', error: '翻譯提交資料無效，請再試一次。' };
    }
    try {
      if (!this.isSubmissionCurrent(pending)) {
        const completion = { status: 'error', error: '任務已失效，請稍後再試。' };
        this.finishSubmission(pending, completion);
        return completion;
      }
      const result = await this.translationBridge.enqueue({
        ...submission,
        videoId: actionData.videoId,
        timestamp: actionData.task.timestamp,
        original: actionData.task.originalSubtitle,
        slotKey: actionData.task.slotKey,
        resolutionContext: actionData.resolutionContext,
        translationID: null,
        sourceTranslationID: payload.sourceTranslationID
      });
      const completion = result?.ok === true && result.value?.status === 'queued-locally' && result.value.operationId
        ? { status: 'queued-locally', operationId: result.value.operationId }
        : { status: 'error', error: '翻譯未加入隊列，請再試一次。' };
      if (completion.status === 'queued-locally') this.finishSubmission(pending, completion);
      else pending.isSubmitting = false;
      return completion;
    } catch (error) {
      pending.isSubmitting = false;
      return { status: 'error', error: error instanceof Error ? error.message : '翻譯提交失敗，請再試一次。' };
    }
  }

  finishSubmission(pending, result) {
    if (pending.settled) return;
    pending.settled = true;
    if (this.pendingSubmission === pending) this.pendingSubmission = null;
    pending.resolve(this.isSubmissionCurrent(pending) ? result : { status: 'error', error: '任務已失效，請稍後再試。' });
  }

  isSubmissionCurrent(pending) {
    return this.isCurrentLifecycle(pending.lifecycle) && this.getRouteGeneration() === pending.routeGeneration && this.getPanel() === pending.panel && pending.panel?.isVisible !== false && this.configManager.get('crowdsourcing.endscreenTasksEnabled') !== false;
  }

  isActionCurrent({ panel, lifecycle, routeGeneration }) {
    return this.isCurrentLifecycle(lifecycle) && this.getPanel() === panel && this.getRouteGeneration() === routeGeneration && panel?.isVisible !== false && this.configManager.get('crowdsourcing.endscreenTasksEnabled') !== false;
  }

  cancelPending(error) {
    this.pendingJump?.controller.abort();
    const pending = this.pendingSubmission;
    if (pending) this.finishSubmission(pending, { status: 'error', error });
    this.submissionDialog?.close();
  }

  cleanup(error) {
    this.cancelPending(error);
    const dialog = this.submissionDialog;
    this.submissionDialog = null;
    dialog?.cleanup?.();
  }

  releaseDialog(dialog) {
    if (!dialog || this.submissionDialog !== dialog) return;
    this.submissionDialog = null;
    dialog.cleanup?.();
  }
}

export { EndscreenActionCoordinator };
