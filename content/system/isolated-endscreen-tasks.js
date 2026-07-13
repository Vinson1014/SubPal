import { EndscreenSignalAdapter } from '../core/endscreen-signal-adapter.js';
import { EndscreenTaskController } from '../core/endscreen-task-controller.js';
import { EndscreenTaskPanel } from '../ui/endscreen-task-panel.js';
import { toAPILanguageCode } from '../utils/language-code.js';
import { requestCrowdsourcingTasks } from './crowdsourcing-task-client.js';

class IsolatedEndscreenTasks {
  constructor({
    document, Observer, location, configManager, schedule, cancel, clock, sendMessage, routeTarget,
    Adapter = EndscreenSignalAdapter, Controller = EndscreenTaskController, Panel = EndscreenTaskPanel
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
    this.routeGeneration = 0;
    this.routeVideoId = null;
    this.started = false;
    this.startPromise = null;
    this.lifecycleGeneration = 0;
    this.routeListeners = [];
    this.cleanedPanels = new WeakSet();
    this.stoppedAdapters = new WeakSet();
  }

  start() {
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    const lifecycle = ++this.lifecycleGeneration;
    const startPromise = this.startInternal(lifecycle);
    const trackedPromise = startPromise.finally(() => {
      if (this.startPromise === trackedPromise) this.startPromise = null;
    });
    this.startPromise = trackedPromise;
    return trackedPromise;
  }

  async startInternal(lifecycle) {
    let panel = null;
    let adapter = null;

    try {
      const languageCode = toAPILanguageCode(this.configManager.get('subtitle.primaryLanguage'));
      if (!languageCode || !this.isCurrentLifecycle(lifecycle)) return;

      panel = new this.Panel({ document: this.document, schedule: this.schedule, cancel: this.cancel });
      this.panel = panel;
      await panel.initialize();
      if (!this.isCurrentLifecycle(lifecycle)) {
        this.cleanupPanel(panel);
        return;
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

  cleanup() {
    this.lifecycleGeneration += 1;
    this.routeGeneration += 1;
    this.started = false;
    this.teardownRouteListeners();

    const adapter = this.adapter;
    const panel = this.panel;
    this.adapter = null;
    this.controller = null;
    this.panel = null;
    this.stopAdapter(adapter);
    this.cleanupPanel(panel);
    this.startPromise = null;
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
    this.panel?.hide();
  }

  async requestCurrentTasks(languageCode, lifecycle = this.lifecycleGeneration) {
    this.refreshRoute();
    const videoID = this.routeVideoId;
    const generation = this.routeGeneration;
    if (!videoID || !this.isCurrentLifecycle(lifecycle)) return { tasks: [] };
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
