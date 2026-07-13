import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadHandler(file, exportName) {
  const subscriptions = new Map();
  const configSubscriptions = new Set();
  const listeners = new Map();
  const playerListeners = new Map();
  const timers = new Map();
  const timerCallbacks = new Map();
  const animationFrames = new Map();
  let nextTimerId = 1;
  let nextAnimationFrameId = 1;
  const lifecycle = { disposerCalls: 0 };

  const addListener = (target, type, callback) => {
    let callbacks = target.get(type);
    if (!callbacks) {
      callbacks = new Set();
      target.set(type, callbacks);
    }
    callbacks.add(callback);
  };

  const removeListener = (target, type, callback) => {
    target.get(type)?.delete(callback);
  };

  const player = {
    addEventListener(type, callback) {
      addListener(playerListeners, type, callback);
    },
    removeEventListener(type, callback) {
      removeListener(playerListeners, type, callback);
    },
    closest(selector) {
      return selector === '.watch-video' ? player : null;
    },
    contains() {
      return true;
    }
  };
  const controlBar = {
    isConnected: true,
    closest(selector) {
      return selector === '.watch-video' ? player : null;
    }
  };

  const document = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    mozFullScreenElement: null,
    msFullscreenElement: null,
    addEventListener(type, callback) {
      addListener(listeners, type, callback);
    },
    removeEventListener(type, callback) {
      removeListener(listeners, type, callback);
    },
    dispatchEvent(type) {
      for (const callback of listeners.get(type) ?? []) callback();
    },
    querySelector(selector) {
      if (selector === '.watch-video') return player;
      if (selector === '.watch-video--bottom-controls-container') return controlBar;
      return null;
    },
    getElementById() {
      return null;
    }
  };

  const setTimer = (callback) => {
    const id = nextTimerId++;
    timers.set(id, callback);
    timerCallbacks.set(id, callback);
    return id;
  };
  const clearTimer = (id) => {
    timers.delete(id);
  };
  const setAnimationFrame = (callback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  const clearAnimationFrame = (id) => {
    animationFrames.delete(id);
  };

  const context = vm.createContext({
    console,
    clearTimeout: clearTimer,
    document,
    setTimeout: setTimer,
    cancelAnimationFrame: clearAnimationFrame,
    requestAnimationFrame: setAnimationFrame,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '0'
    }),
    lifecycle,
    subscriptions,
    configSubscriptions
  });
  const source = await readFile(new URL(`../content/ui/${file}`, import.meta.url), 'utf8');
  const config = new vm.SourceTextModule(`
    export const configBridge = {
      get: () => false,
      subscribe: (key, callback) => {
        globalThis.configSubscriptions.add(callback);
        globalThis.lifecycle.configSubscribeCalls = (globalThis.lifecycle.configSubscribeCalls ?? 0) + 1;
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          globalThis.lifecycle.configDisposerCalls = (globalThis.lifecycle.configDisposerCalls ?? 0) + 1;
          globalThis.configSubscriptions.delete(callback);
        };
      }
    };
  `, { context, identifier: 'content/system/config/config-bridge.js' });
  await config.link(() => {
    throw new Error('config bridge has no imports');
  });
  await config.evaluate();

  const module = new vm.SourceTextModule(source, {
    context,
    identifier: `content/ui/${file}`,
    importModuleDynamically: async (specifier) => {
      assert.equal(specifier, '../system/config/config-bridge.js');
      return config;
    }
  });
  const messaging = new vm.SourceTextModule(`
    export const sendMessage = async () => ({});
    export const registerInternalEventHandler = (type, handler) => {
      let handlers = globalThis.subscriptions.get(type);
      if (!handlers) {
        handlers = new Set();
        globalThis.subscriptions.set(type, handlers);
      }
      handlers.add(handler);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        globalThis.lifecycle.disposerCalls += 1;
        handlers.delete(handler);
        if (handlers.size === 0) globalThis.subscriptions.delete(type);
      };
    };
  `, { context });

  await module.link((specifier) => {
    assert.equal(specifier, '../system/messaging.js');
    return messaging;
  });
  await module.evaluate();

  return {
    Handler: module.namespace[exportName],
    liveCount(type) {
      return subscriptions.get(type)?.size ?? 0;
    },
    configLiveCount() {
      return configSubscriptions.size;
    },
    documentListenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    playerListenerCount(type) {
      return playerListeners.get(type)?.size ?? 0;
    },
    pendingTimeoutCount() {
      return timers.size;
    },
    pendingTimeoutIds() {
      return [...timers.keys()];
    },
    runTimeout(id) {
      timerCallbacks.get(id)?.();
    },
    pendingAnimationFrameCount() {
      return animationFrames.size;
    },
    dispatchInternal(type, event) {
      for (const callback of subscriptions.get(type) ?? []) callback(event);
    },
    dispatchPlayerEvent(type, event) {
      for (const callback of playerListeners.get(type) ?? []) callback(event);
    },
    document,
    lifecycle
  };
}

test('Given repeated UI avoidance cleanup When the handler is reinitialized Then exactly one DOM/config/internal set remains live', async () => {
  const fixture = await loadHandler('ui-avoidance-handler.js', 'UIAvoidanceHandler');
  const handler = new fixture.Handler();

  await handler.initialize();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 1);
  assert.equal(fixture.configLiveCount(), 1);
  assert.equal(fixture.playerListenerCount('mousemove'), 1);
  assert.equal(fixture.playerListenerCount('mouseleave'), 1);

  handler.handleMouseMove();
  handler.handleMouseLeave();
  fixture.dispatchPlayerEvent('mousemove', { clientY: 10 });
  fixture.dispatchInternal('SUBPAL_CONTAINER_CREATED', { containerId: 'container-1' });
  assert.ok(fixture.pendingTimeoutCount() > 0);
  assert.equal(fixture.pendingAnimationFrameCount(), 1);

  handler.cleanup();
  handler.cleanup();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 0, 'cleanup must unregister the old UI avoidance handler');
  assert.equal(fixture.configLiveCount(), 0, 'cleanup must unsubscribe the old config callback');
  assert.equal(fixture.playerListenerCount('mousemove'), 0, 'cleanup must remove the exact mousemove callback');
  assert.equal(fixture.playerListenerCount('mouseleave'), 0, 'cleanup must remove the exact mouseleave callback');
  assert.equal(fixture.pendingTimeoutCount(), 0, 'cleanup must cancel every queued timeout');
  assert.equal(fixture.pendingAnimationFrameCount(), 0, 'cleanup must cancel every queued animation frame');
  assert.equal(handler.controlBarSelector, null, 'cleanup must not retain the old control bar selector');
  assert.equal(fixture.lifecycle.disposerCalls, 1, 'repeated cleanup must not call the disposer twice');
  assert.equal(fixture.lifecycle.configDisposerCalls, 1, 'repeated cleanup must not call the config disposer twice');

  await handler.initialize();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 1, 'reinitialization must create one UI avoidance subscription');
  assert.equal(fixture.configLiveCount(), 1, 'reinitialization must create one config subscription');
  assert.equal(fixture.playerListenerCount('mousemove'), 1, 'reinitialization must create one mousemove callback');
  assert.equal(fixture.playerListenerCount('mouseleave'), 1, 'reinitialization must create one mouseleave callback');
  handler.cleanup();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 0);
  assert.equal(fixture.configLiveCount(), 0);
  assert.equal(fixture.playerListenerCount('mousemove'), 0);
  assert.equal(fixture.playerListenerCount('mouseleave'), 0);
  assert.equal(fixture.lifecycle.disposerCalls, 2);
  assert.equal(fixture.lifecycle.configDisposerCalls, 2);
});

test('Given repeated fullscreen cleanup When the handler is reinitialized Then exactly one DOM/config/internal set remains live', async () => {
  const fixture = await loadHandler('fullscreen-handler.js', 'FullscreenHandler');
  const handler = new fixture.Handler();

  await handler.initialize();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 1);
  assert.equal(fixture.configLiveCount(), 1);
  assert.equal(fixture.documentListenerCount('fullscreenchange'), 1);
  assert.equal(fixture.documentListenerCount('webkitfullscreenchange'), 1);
  assert.equal(fixture.documentListenerCount('mozfullscreenchange'), 1);
  assert.equal(fixture.documentListenerCount('MSFullscreenChange'), 1);

  fixture.document.fullscreenElement = {};
  fixture.document.dispatchEvent('fullscreenchange');
  fixture.dispatchInternal('SUBPAL_CONTAINER_CREATED', { containerId: 'container-1' });
  assert.ok(fixture.pendingTimeoutCount() > 0);

  handler.cleanup();
  handler.cleanup();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 0, 'cleanup must unregister the old fullscreen handler');
  assert.equal(fixture.configLiveCount(), 0, 'cleanup must unsubscribe the old config callback');
  assert.equal(fixture.documentListenerCount('fullscreenchange'), 0, 'cleanup must remove the exact fullscreenchange callback');
  assert.equal(fixture.documentListenerCount('webkitfullscreenchange'), 0, 'cleanup must remove the exact webkit callback');
  assert.equal(fixture.documentListenerCount('mozfullscreenchange'), 0, 'cleanup must remove the exact moz callback');
  assert.equal(fixture.documentListenerCount('MSFullscreenChange'), 0, 'cleanup must remove the exact MS callback');
  assert.equal(fixture.pendingTimeoutCount(), 0, 'cleanup must cancel every queued timeout');
  assert.equal(fixture.lifecycle.disposerCalls, 1, 'repeated cleanup must not call the disposer twice');
  assert.equal(fixture.lifecycle.configDisposerCalls, 1, 'repeated cleanup must not call the config disposer twice');

  await handler.initialize();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 1, 'reinitialization must create one fullscreen subscription');
  assert.equal(fixture.configLiveCount(), 1, 'reinitialization must create one config subscription');
  assert.equal(fixture.documentListenerCount('fullscreenchange'), 1, 'reinitialization must create one fullscreenchange callback');
  assert.equal(fixture.documentListenerCount('webkitfullscreenchange'), 1, 'reinitialization must create one webkit callback');
  assert.equal(fixture.documentListenerCount('mozfullscreenchange'), 1, 'reinitialization must create one moz callback');
  assert.equal(fixture.documentListenerCount('MSFullscreenChange'), 1, 'reinitialization must create one MS callback');
  handler.cleanup();
  assert.equal(fixture.liveCount('SUBPAL_CONTAINER_CREATED'), 0);
  assert.equal(fixture.configLiveCount(), 0);
  assert.equal(fixture.documentListenerCount('fullscreenchange'), 0);
  assert.equal(fixture.documentListenerCount('webkitfullscreenchange'), 0);
  assert.equal(fixture.documentListenerCount('mozfullscreenchange'), 0);
  assert.equal(fixture.documentListenerCount('MSFullscreenChange'), 0);
  assert.equal(fixture.lifecycle.disposerCalls, 2);
  assert.equal(fixture.lifecycle.configDisposerCalls, 2);
});

test('Given repeated fullscreen container events When an old callback runs Then it cannot clear the replacement timer', async () => {
  const fixture = await loadHandler('fullscreen-handler.js', 'FullscreenHandler');
  const handler = new fixture.Handler();
  await handler.initialize();
  fixture.document.fullscreenElement = {};
  fixture.document.dispatchEvent('fullscreenchange');

  const beforeFirstContainerEvent = new Set(fixture.pendingTimeoutIds());
  fixture.dispatchInternal('SUBPAL_CONTAINER_CREATED', { containerId: 'container-1' });
  const firstTimerId = fixture.pendingTimeoutIds().find((id) => !beforeFirstContainerEvent.has(id));
  const beforeSecondContainerEvent = new Set(fixture.pendingTimeoutIds());
  fixture.dispatchInternal('SUBPAL_CONTAINER_CREATED', { containerId: 'container-2' });
  const secondTimerId = fixture.pendingTimeoutIds().find((id) => !beforeSecondContainerEvent.has(id));

  assert.notEqual(firstTimerId, undefined);
  assert.notEqual(secondTimerId, undefined);
  assert.equal(fixture.pendingTimeoutIds().includes(firstTimerId), false);
  fixture.runTimeout(firstTimerId);
  assert.equal(handler.containerCreatedCheckTimer, secondTimerId);
  fixture.runTimeout(secondTimerId);
  assert.equal(handler.containerCreatedCheckTimer, null);
  handler.cleanup();
});

test('Given repeated avoidance container events When an old callback runs Then it cannot clear the replacement timer', async () => {
  const fixture = await loadHandler('ui-avoidance-handler.js', 'UIAvoidanceHandler');
  const handler = new fixture.Handler();
  await handler.initialize();
  handler.handleControlBarChange = () => {};

  const beforeFirstContainerEvent = new Set(fixture.pendingTimeoutIds());
  fixture.dispatchInternal('SUBPAL_CONTAINER_CREATED', { containerId: 'container-1' });
  const firstTimerId = fixture.pendingTimeoutIds().find((id) => !beforeFirstContainerEvent.has(id));
  const beforeSecondContainerEvent = new Set(fixture.pendingTimeoutIds());
  fixture.dispatchInternal('SUBPAL_CONTAINER_CREATED', { containerId: 'container-2' });
  const secondTimerId = fixture.pendingTimeoutIds().find((id) => !beforeSecondContainerEvent.has(id));

  assert.notEqual(firstTimerId, undefined);
  assert.notEqual(secondTimerId, undefined);
  assert.equal(fixture.pendingTimeoutIds().includes(firstTimerId), false);
  fixture.runTimeout(firstTimerId);
  assert.equal(handler.containerCreatedCheckTimer, secondTimerId);
  fixture.runTimeout(secondTimerId);
  assert.equal(handler.containerCreatedCheckTimer, null);
  handler.cleanup();
});
