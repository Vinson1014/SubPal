import { EndscreenSignalAdapter } from './endscreen-signal-adapter.js';
import { EndscreenTaskController } from './endscreen-task-controller.js';

class EndscreenTaskBridge {
  constructor({
    document,
    Observer,
    schedule,
    cancel,
    clock,
    debounceMs,
    sendMessage,
    languageCode,
    getContext,
    registerInternalEventHandler,
    Adapter = EndscreenSignalAdapter,
    Controller = EndscreenTaskController
  }) {
    if (typeof getContext !== 'function' || typeof registerInternalEventHandler !== 'function') {
      throw new TypeError('EndscreenTaskBridge requires context and event dependencies');
    }

    this.dependencies = {
      document,
      Observer,
      schedule,
      cancel,
      clock,
      debounceMs,
      sendMessage,
      languageCode,
      getContext,
      registerInternalEventHandler,
      Adapter,
      Controller
    };
    this.adapter = null;
    this.controller = null;
    this.eventDisposers = [];
    this.started = false;
  }

  start() {
    if (this.started) return;

    const { Adapter, Controller, registerInternalEventHandler, ...options } = this.dependencies;
    this.controller = new Controller({
      clock: options.clock,
      schedule: options.schedule,
      sendMessage: options.sendMessage,
      onTasks: () => {},
      languageCode: options.languageCode,
      debounceMs: options.debounceMs
    });
    this.adapter = new Adapter({
      document: options.document,
      Observer: options.Observer,
      schedule: options.schedule,
      cancel: options.cancel,
      getContext: options.getContext,
      controller: this.controller
    });
    let adapterStartAttempted = false;

    try {
      this.eventDisposers.push(registerInternalEventHandler('VIDEO_ID_CHANGED', (event) => this.controller.handleInternalEvent(event)));
      this.eventDisposers.push(registerInternalEventHandler('PLAYBACK_CONTEXT_CHANGED', (event) => {
        this.controller.handleInternalEvent({ ...event, type: 'VIDEO_ID_CHANGED' });
      }));
      adapterStartAttempted = true;
      this.adapter.start();
      this.started = true;
    } catch (error) {
      this.release(adapterStartAttempted);
      throw error;
    }
  }

  cleanup() {
    if (!this.started) return;

    this.release(true);
  }

  release(stopAdapter) {
    if (stopAdapter) this.adapter.stop();
    for (const dispose of this.eventDisposers) dispose();
    this.eventDisposers = [];
    this.adapter = null;
    this.controller = null;
    this.started = false;
  }
}

export { EndscreenTaskBridge };
