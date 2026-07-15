import { EndscreenSignalAdapter } from '../core/endscreen-signal-adapter.js';
import { EndscreenTaskController } from '../core/endscreen-task-controller.js';
import { EndscreenTaskPanel } from '../ui/endscreen-task-panel.js';
import { SubmissionDialog } from '../ui/submission-dialog.js';
import { translationBridge } from '../core/translation-bridge.js';
import { voteBridge } from '../core/vote-bridge.js';
import { configBridge } from './config/config-bridge.js';
import { toAPILanguageCode } from '../utils/language-code.js';
import { requestCrowdsourcingTasks } from './crowdsourcing-task-client.js';
import { EndscreenActionCoordinator } from './endscreen-action-coordinator.js';

class IsolatedEndscreenTasks {
  constructor({
    document, Observer, location, configManager, schedule, cancel, clock, sendMessage, routeTarget,
    Adapter = EndscreenSignalAdapter, Controller = EndscreenTaskController, Panel = EndscreenTaskPanel,
    Dialog = SubmissionDialog, translation = translationBridge, vote = voteBridge, config = configBridge
  }) {
    this.document = document;
    this.Observer = Observer;
    this.location = location;
    this.configManager = configManager;
    this.schedule = schedule;
    this.cancel = cancel;
    this.clock = clock;
    this.sendMessage = sendMessage;
    this.routeTarget = routeTarget ?? document?.defaultView ?? null;
    this.Adapter = Adapter;
    this.Controller = Controller;
    this.Panel = Panel;
    this.Dialog = Dialog;
    this.routeGeneration = 0;
    this.routeVideoId = null;
    this.started = false;
    this.startPromise = null;
    this.lifecycleGeneration = 0;
    this.routeListeners = [];
    this.cleanedPanels = new WeakSet();
    this.stoppedAdapters = new WeakSet();
    this.configSubscriptionDisposer = typeof this.configManager.subscribe === 'function' ? this.configManager.subscribe('crowdsourcing.endscreenTasksEnabled', (_key, value) => this.handlePreferenceChange(value)) : null;
    this.pendingOptOut = null; this.pendingReenable = null; this.disposed = false;
    this.actionCoordinator = new EndscreenActionCoordinator({
      Dialog,
      translationBridge: translation,
      voteBridge: vote,
      actionConfig: config,
      configManager,
      getPanel: () => this.panel,
      getRouteGeneration: () => this.routeGeneration,
      isCurrentLifecycle: (lifecycle) => this.isCurrentLifecycle(lifecycle)
    });
  }

  get submissionDialog() {
    return this.actionCoordinator.submissionDialog;
  }

  get pendingSubmission() {
    return this.actionCoordinator.pendingSubmission;
  }

  get actionConfig() {
    return this.actionCoordinator.actionConfig;
  }

  set actionConfig(config) {
    this.actionCoordinator.actionConfig = config;
  }

  start() {
    if (this.disposed || this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    const lifecycle = ++this.lifecycleGeneration;
    const startPromise = this.startInternal(lifecycle);
    const trackedPromise = startPromise.finally(() => { if (this.startPromise === trackedPromise) { this.startPromise = null; this.flushPendingReenable(lifecycle); } });
    this.startPromise = trackedPromise;
    return trackedPromise;
  }

  async startInternal(lifecycle) {
    let panel = null;
    let adapter = null;

    try {
      const endscreenTasksEnabled = this.configManager.get('crowdsourcing.endscreenTasksEnabled');
      if (endscreenTasksEnabled === false || !this.isCurrentLifecycle(lifecycle)) return;

      const languageCode = toAPILanguageCode(this.configManager.get('subtitle.primaryLanguage'));
      if (!languageCode || !this.isCurrentLifecycle(lifecycle)) return;

      panel = new this.Panel({ document: this.document, schedule: this.schedule, cancel: this.cancel, configSource: this.configManager });
      this.panel = panel;
      await panel.initialize();
      if (!this.isCurrentLifecycle(lifecycle)) {
        this.cleanupPanel(panel);
        return;
      }

      panel.onOptOut((payload) => this.handleOptOut(panel, lifecycle, payload));
      panel.onDismiss?.(() => this.handlePanelDismiss(panel, lifecycle));
      if (typeof panel.onAction === 'function') {
        panel.onAction((payload) => this.handlePanelAction(panel, lifecycle, payload));
      }

      this.refreshRoute();
      const controller = new this.Controller({
        clock: this.clock,
        schedule: this.schedule,
        debounceMs: 500,
        languageCode,
        sendMessage: () => this.requestCurrentTasks(languageCode, lifecycle),
        onTasks: (tasks, context) => {
          if (!this.isCurrentLifecycle(lifecycle) || this.panel !== panel) return;
          tasks.length > 0 ? panel.show(tasks, context) : panel.hide();
        }
      });
      this.controller = controller;
      adapter = new this.Adapter({
        document: this.document,
        Observer: this.Observer,
        schedule: this.schedule,
        cancel: this.cancel,
        getContext: () => this.getContext(),
        controller,
        onInactive: () => {
          if (!this.isCurrentLifecycle(lifecycle) || this.panel !== panel || this.controller !== controller) return;
          this.closePendingSubmission('片尾任務已結束，請再試一次。');
          panel.hide();
          controller.handleInternalEvent({ type: 'ENDSCREEN_INACTIVE' });
        }
      });
      this.adapter = adapter;
      adapter.start();
      if (!this.isCurrentLifecycle(lifecycle)) {
        this.stopAdapter(adapter);
        this.cleanupPanel(panel);
        return;
      }
      this.bindRouteListeners(lifecycle);
      this.started = true;
    } catch (error) {
      if (this.isCurrentLifecycle(lifecycle)) {
        this.cleanup();
      } else {
        this.stopAdapter(adapter);
        this.cleanupPanel(panel);
      }
      throw error;
    }
  }

  handlePreferenceChange(value) {
    if (value === false) { this.pendingReenable = null; if (this.pendingOptOut) return; if (this.started || this.startPromise || this.panel || this.adapter || this.controller) this.cleanup(); return; }
    if (value !== true || this.disposed || this.started) return;
    if (this.startPromise) { this.pendingReenable = { lifecycle: this.lifecycleGeneration }; return; }

    void this.start().catch((error) => {
      console.error('片尾字幕任務重新啟動失敗:', error);
    });
  }

  flushPendingReenable(lifecycle) {
    const pendingReenable = this.pendingReenable; this.pendingReenable = null;
    if (!pendingReenable || pendingReenable.lifecycle < lifecycle || this.disposed || this.started || this.startPromise || this.configManager.get('crowdsourcing.endscreenTasksEnabled') !== true) return;

    void this.start().catch((error) => {
      console.error('片尾字幕任務重新啟動失敗:', error);
    });
  }

  handleOptOut(panel, lifecycle, payload) {
    if (!this.isCurrentLifecycle(lifecycle) || this.panel !== panel) return Promise.resolve();

    const pendingOptOut = { lifecycle, panel, promise: null }; this.pendingOptOut = pendingOptOut;
    try {
      pendingOptOut.promise = Promise.resolve(
        this.configManager.set('crowdsourcing.endscreenTasksEnabled', false)
      );
    } catch (error) {
      pendingOptOut.promise = Promise.reject(error);
    }

    const result = pendingOptOut.promise.then(
      () => {
        if (this.pendingOptOut !== pendingOptOut) return;
        this.pendingOptOut = null;
        if (this.isCurrentLifecycle(lifecycle) && this.panel === panel) this.cleanup();
      },
      (error) => {
        if (this.pendingOptOut === pendingOptOut) this.pendingOptOut = null;
        console.error('片尾字幕任務偏好設定保存失敗:', error);
        if (this.isCurrentLifecycle(lifecycle) && this.panel === panel) {
          this.markOptOutFailure(panel, payload);
        }
        throw error;
      }
    );
    result.catch((error) => ({ status: 'rejected', error }));
    return result;
  }

  async handlePanelAction(panel, lifecycle, payload) {
    return this.actionCoordinator.handlePanelAction(panel, lifecycle, payload);
  }

  handlePanelDismiss(panel, lifecycle) {
    if (!this.isCurrentLifecycle(lifecycle) || this.panel !== panel) return;
    this.routeGeneration += 1;
    this.actionCoordinator.cancelPending('任務已關閉，請再試一次。');
  }

  closePendingSubmission(error) {
    this.actionCoordinator.cancelPending(error);
  }

  markOptOutFailure(panel, payload) {
    if (typeof payload?.setFailure === 'function') return payload.setFailure();
    panel.setActionState('error');
  }

  cleanup() {
    const wasStarted = this.started;
    this.lifecycleGeneration += 1;
    this.routeGeneration += 1;
    this.started = false;
    this.teardownRouteListeners();
    this.closePendingSubmission('任務已失效，請稍後再試。');

    const adapter = this.adapter;
    const panel = this.panel;
    this.adapter = null;
    this.controller = null;
    this.panel = null;
    this.stopAdapter(adapter);
    this.cleanupPanel(panel);
    if (wasStarted || !this.startPromise) this.startPromise = null;
    this.actionCoordinator.cleanup('任務已失效，請稍後再試。');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingReenable = null;
    this.cleanup();
    const unsubscribe = this.configSubscriptionDisposer;
    this.configSubscriptionDisposer = null; unsubscribe?.();
  }

  stopAdapter(adapter) {
    if (!adapter || this.stoppedAdapters.has(adapter)) return;
    this.stoppedAdapters.add(adapter);
    adapter.stop();
  }

  cleanupPanel(panel) {
    if (!panel || this.cleanedPanels.has(panel)) return;
    this.cleanedPanels.add(panel);
    panel.cleanup();
  }

  bindRouteListeners(lifecycle) {
    if (!this.routeTarget?.addEventListener) return;
    const refresh = () => {
      if (this.isCurrentLifecycle(lifecycle)) this.refreshRoute();
    };
    for (const type of ['popstate', 'hashchange']) {
      this.routeTarget.addEventListener(type, refresh);
      this.routeListeners.push({ type, refresh });
    }
  }

  teardownRouteListeners() {
    if (this.routeTarget?.removeEventListener) {
      for (const { type, refresh } of this.routeListeners) {
        this.routeTarget.removeEventListener(type, refresh);
      }
    }
    this.routeListeners = [];
  }

  isCurrentLifecycle(lifecycle) {
    return this.lifecycleGeneration === lifecycle;
  }

  getVideoId() {
    const match = /^\/watch\/(\d+)(?:\/|$)/.exec(this.location.pathname);
    return match ? match[1] : null;
  }

  getContext() {
    this.refreshRoute();
    if (!this.routeVideoId) return null;
    return { videoId: this.routeVideoId, sessionId: `watch-${this.routeVideoId}`, epoch: this.routeGeneration, state: 'ready' };
  }

  refreshRoute() {
    const videoId = this.getVideoId();
    if (videoId === this.routeVideoId) return;
    this.routeVideoId = videoId;
    this.routeGeneration += 1;
    this.controller?.handleInternalEvent({ type: 'VIDEO_ID_CHANGED', newVideoId: videoId });
    this.closePendingSubmission('影片已切換，請再試一次。');
    this.panel?.hide();
  }

  async requestCurrentTasks(languageCode, lifecycle = this.lifecycleGeneration) {
    this.refreshRoute();
    const videoID = this.routeVideoId;
    const generation = this.routeGeneration;
    if (!videoID || !this.isCurrentLifecycle(lifecycle)) return { tasks: [] };
    if (this.configManager.get('crowdsourcing.endscreenTasksEnabled') !== true) return { tasks: [] };
    const response = await this.sendMessage({ type: 'GET_CROWDSOURCING_TASKS', videoID, languageCode, limit: 5 });
    if (!this.isCurrentLifecycle(lifecycle) || generation !== this.routeGeneration || videoID !== this.getVideoId()) {
      return { tasks: [] };
    }
    return response;
  }
}

async function startIsolatedEndscreenTasks(configManager) {
  const system = new IsolatedEndscreenTasks({
    document,
    Observer: MutationObserver,
    location: window.location,
    routeTarget: window,
    configManager,
    schedule: (...args) => window.setTimeout(...args),
    cancel: (timerId) => window.clearTimeout(timerId),
    clock: Date.now,
    sendMessage: requestCrowdsourcingTasks
  });
  await system.start();
  return system;
}

export { IsolatedEndscreenTasks, startIsolatedEndscreenTasks };
