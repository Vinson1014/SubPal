import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadController() {
  const source = await readFile(new URL('../content/core/endscreen-task-controller.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context: vm.createContext({ console }), identifier: 'content/core/endscreen-task-controller.js' });
  await module.link(() => { throw new Error('endscreen-task-controller.js should not import dependencies'); });
  await module.evaluate();
  return module.namespace.EndscreenTaskController;
}

export function createScheduler() {
  let now = 0;
  const scheduled = [];

  return {
    clock: () => now,
    schedule(callback, delay) {
      scheduled.push({ callback, runAt: now + delay });
    },
    advance(milliseconds) {
      now += milliseconds;
      const due = scheduled.filter((job) => job.runAt <= now);
      const pending = scheduled.filter((job) => job.runAt > now);
      scheduled.splice(0, scheduled.length, ...pending);
      for (const job of due) job.callback();
    }
  };
}

export function createContext(overrides = {}) {
  return {
    videoId: 'netflix-81234567',
    sessionId: 'watch-session-1',
    epoch: 3,
    state: 'ready',
    ...overrides
  };
}

export function unsupportedTerminalNextEpisodeObservation(context = createContext(), overrides = {}) {
  return {
    context,
    snapshot: { currentTime: 1740, duration: 1800, state: 'ended' },
    variant: 'next-episode',
    evidence: { nextEpisodeCta: true },
    ...overrides
  };
}

export function typeBObservation(context = createContext(), overrides = {}) {
  return {
    context,
    snapshot: { currentTime: 1740, duration: 1800, state: 'playing' },
    variant: 'type-b',
    evidence: { promotedPreview: true },
    ...overrides
  };
}

export function typeANextEpisodeObservation(context = createContext(), overrides = {}) {
  return {
    context,
    snapshot: { currentTime: 1378.496948, duration: 1536.159625, state: 'playing' },
    variant: 'type-a-next-episode',
    evidence: { watchCreditsCta: true, nextEpisodeCta: true },
    ...overrides
  };
}

export function createController(EndscreenTaskController, overrides = {}) {
  const scheduler = overrides.scheduler ?? createScheduler();
  const sentMessages = [];
  const taskBatches = [];
  const controller = new EndscreenTaskController({
    clock: scheduler.clock,
    schedule: scheduler.schedule,
    debounceMs: 500,
    languageCode: 'zh-TW',
    sendMessage: async (message) => {
      sentMessages.push(message);
      return { tasks: [{ taskID: 'task-1' }] };
    },
    onTasks: (tasks, context) => taskBatches.push({ tasks, context }),
    ...overrides
  });
  return { controller, scheduler, sentMessages, taskBatches };
}
