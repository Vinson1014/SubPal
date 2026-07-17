import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadAdapter() {
  const source = await readFile(new URL('../content/core/endscreen-signal-adapter.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context: vm.createContext({ console }), identifier: 'content/core/endscreen-signal-adapter.js' });
  await module.link(() => { throw new Error('endscreen-signal-adapter.js should not import dependencies'); });
  await module.evaluate();
  return module.namespace.EndscreenSignalAdapter;
}

export class FakeNode {
  constructor({ uia, visible = true, connected = true, hidden = false, rendered = true, style = {}, media } = {}) {
    this.dataset = uia ? { uia } : {};
    this.visible = visible;
    this.isConnected = connected;
    this.hidden = hidden;
    this.rendered = rendered;
    this.style = style;
    this.parentNode = null;
    this.children = [];
    this.listeners = new Map();
    Object.assign(this, media);
  }

  append(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
    this.isConnected = false;
  }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  getClientRects() { return this.rendered ? [{}] : []; }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener)); }
  dispatch(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this, ...event }); }
}

class FakeDocument extends FakeNode {
  constructor() {
    super();
    this.isConnected = true;
    this.defaultView = { getComputedStyle: (node) => node.style };
  }

  querySelectorAll(selector) {
    const uia = /^\[data-uia="([^"]+)"\]$/.exec(selector)?.[1];
    const matches = [];
    const visit = (node) => {
      if (selector === 'video' && Number.isFinite(node.readyState)) matches.push(node);
      if (uia && node.dataset.uia === uia) matches.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }
}

export class FakeObserver {
  static instances = [];
  constructor(callback) { this.callback = callback; this.disconnected = false; FakeObserver.instances.push(this); }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
  trigger() { this.callback([]); }
}

function createScheduler() {
  const jobs = [];
  let now = 0;
  const runDue = () => {
    const due = jobs.filter((job) => !job.cancelled && job.runAt <= now);
    for (const job of due) jobs.splice(jobs.indexOf(job), 1);
    for (const job of due) job.callback();
  };
  return {
    schedule(callback, delay = 0) { const job = { callback, cancelled: false, runAt: now + delay }; jobs.push(job); return job; },
    cancel(job) { job.cancelled = true; },
    flush() { runDue(); },
    advance(milliseconds) { now += milliseconds; runDue(); },
    get pending() { return jobs.filter((job) => !job.cancelled).length; }
  };
}

export function createContext(overrides = {}) {
  return { state: 'ready', videoId: '81234567', sessionId: 'watch-session-1', epoch: 2, ...overrides };
}

export function createHarness({ context = createContext(), media = {}, markers = [], rootCount = 1 } = {}) {
  FakeObserver.instances = [];
  const document = new FakeDocument();
  const roots = Array.from({ length: rootCount }, () => document.append(new FakeNode()));
  const video = roots[0].append(new FakeNode({ media: { currentTime: 1800, duration: 1800, readyState: 4, ended: true, paused: false, ...media } }));
  const markerNodes = markers.map(({ root = 0, ...marker }) => roots[root].append(new FakeNode(marker)));
  const scheduler = createScheduler();
  const observations = [];
  const dismissals = [];
  return { document, roots, video, markerNodes, scheduler, observations, dismissals, context: () => context, controller: { observe: (observation) => observations.push(observation), dismiss: (value) => dismissals.push(value) } };
}

export function start(Adapter, harness) {
  const adapter = new Adapter({ document: harness.document, Observer: FakeObserver, schedule: harness.scheduler.schedule, cancel: harness.scheduler.cancel, getContext: harness.context, controller: harness.controller });
  adapter.start();
  return adapter;
}
