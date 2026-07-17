/**
 * 片尾任務面板測試 fixtures
 * 提供假 DOM 環境與任務樣本資料，供 endscreen-task-panel.test.mjs 使用
 */

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function escapeTextForHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function setConnection(element, isConnected) {
  element._isConnected = isConnected;
  for (const child of element.children) setConnection(child, isConnected);
}

// ─── 模組載入 ───

/**
 * 載入 EndscreenTaskPanel 類別（不依賴外部 import）
 */
export async function loadPanel({ configBridge } = {}) {
  const source = await readFile(new URL('../content/ui/endscreen-task-panel.js', import.meta.url), 'utf8');
  const actionSource = await readFile(new URL('../content/ui/endscreen-task-action-controller.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console });
  const actionModule = new vm.SourceTextModule(actionSource, {
    context,
    identifier: 'content/ui/endscreen-task-action-controller.js'
  });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: 'content/ui/endscreen-task-panel.js',
    importModuleDynamically: async (specifier) => {
      if (!configBridge || !specifier.endsWith('../system/config/config-bridge.js')) {
        throw new Error(`Unexpected dynamic import: ${specifier}`);
      }

      const bridgeModule = new vm.SyntheticModule(['configBridge'], function () {
        this.setExport('configBridge', configBridge);
      }, { context, identifier: specifier });
      await bridgeModule.link(() => { throw new Error('Unexpected bridge dependency'); });
      await bridgeModule.evaluate();
      return bridgeModule;
    }
  });
  await module.link((specifier) => {
    if (specifier === './endscreen-task-action-controller.js') return actionModule;
    throw new Error(`Unexpected panel dependency: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.EndscreenTaskPanel;
}

// ─── 假 DOM ───

/**
 * 假 DOM 元素，支援面板所需操作：
 * createElement, appendChild, remove, textContent, style, addEventListener,
 * setAttribute, querySelector, contains, focus
 */
export class FakeElement {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this._textContent = '';
    this._innerHTML = '';
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this._isConnected = true;
    this._hidden = false;
    this._rect = { left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200 };
  }

  // id getter/setter — 對應 attributes.id
  get id() { return this.attributes.id ?? ''; }
  set id(value) { this.attributes.id = String(value); }

  // className getter/setter — 對應 attributes.class
  get className() { return this.attributes.class ?? ''; }
  set className(value) { this.attributes.class = String(value); }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); }

  // textContent setter — 同時更新 innerHTML 並清除子節點（模擬真實 DOM 行為）
  get textContent() { return this._textContent ?? ''; }
  set textContent(value) {
    // 真實 DOM：設定 textContent 會移除所有子節點
    for (const child of this.children) {
      child.parentNode = null;
      setConnection(child, false);
    }
    this.children = [];
    this._textContent = String(value);
    this._innerHTML = escapeTextForHtml(value);
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    if (!child.ownerDocument) child.ownerDocument = this.ownerDocument;
    setConnection(child, this._isConnected);
    return child;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
    }
    this.parentNode = null;
    setConnection(this, false);
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
      setConnection(child, false);
    }
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const arr = this.listeners.get(type);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx !== -1) arr.splice(idx, 1);
    }
  }

  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type) ?? [];
    for (const h of handlers) h(event);
    return true;
  }

  querySelector(selector) {
    // 簡易選擇器：支援 '#id' 和 '.class'
    for (const child of this.children) {
      if (selector.startsWith('#') && child.attributes.id === selector.slice(1)) return child;
      if (selector.startsWith('.') && (child.attributes.class ?? '').split(' ').includes(selector.slice(1))) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const child of this.children) {
      if (selector.startsWith('#') && child.attributes.id === selector.slice(1)) results.push(child);
      if (selector.startsWith('.') && (child.attributes.class ?? '').split(' ').includes(selector.slice(1))) results.push(child);
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }

  contains(node) {
    for (let cur = node; cur; cur = cur.parentNode) {
      if (cur === this) return true;
    }
    return false;
  }

  focus() {
    const activeElement = this.ownerDocument?.activeElement;
    if (activeElement && activeElement !== this) activeElement.blur();
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this._focused = true;
  }

  blur() {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
    this._focused = false;
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  get isConnected() {
    return this._isConnected;
  }

  get hidden() {
    return this._hidden;
  }
}

/**
 * 假 document，支援面板所需操作
 */
export class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.body = new FakeElement('body', this);
    this.documentElement = new FakeElement('html', this);
    this._elementIdCounter = 0;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
  }

  getElementById(id) {
    const search = (node) => {
      if (node.attributes.id === id) return node;
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this.body) || search(this.documentElement);
  }

  addEventListener(type, handler) {
    this.body.addEventListener(type, handler);
  }

  removeEventListener(type, handler) {
    this.body.removeEventListener(type, handler);
  }

  dispatchEvent(event) {
    return this.body.dispatchEvent(event);
  }
}

// ─── 假計時器 ───

export function createScheduler() {
  const jobs = new Map();
  let nextId = 1;
  let now = 0;

  return {
    clock: () => now,
    schedule(callback, delay) {
      const id = nextId++;
      jobs.set(id, { callback, runAt: now + delay });
      return id;
    },
    cancel(id) {
      jobs.delete(id);
    },
    advance(ms) {
      now += ms;
      const due = [];
      for (const [id, job] of jobs) {
        if (job.runAt <= now) due.push(id);
      }
      for (const id of due) {
        const job = jobs.get(id);
        jobs.delete(id);
        if (job) job.callback();
      }
    },
    get pending() {
      return jobs.size;
    }
  };
}

// ─── 任務樣本 ───

export function createOfficialTask(overrides = {}) {
  return {
    taskID: 'official:netflix-81234567:zh-TW:slot-000124',
    targetType: 'official-subtitle',
    action: 'submit-improvement',
    videoID: 'netflix-81234567',
    translationID: null,
    timestamp: 124.5,
    timecode: '02:04',
    slotKey: 'slot-000124',
    languageCode: 'zh-TW',
    originalSubtitle: '我會在十分鐘後回來。',
    suggestedSubtitle: null,
    score: 72,
    rankReasons: ['no-approved-candidate', 'has-slot-key'],
    resolution: {
      kind: 'official-slot',
      requiresTranslationID: false,
      voteTargetType: 'official-subtitle'
    },
    userState: {
      hasVoted: false,
      voteState: 'none',
      isOwnContribution: false,
      excludedReason: null
    },
    ...overrides
  };
}

export function createCandidateTask(overrides = {}) {
  return {
    taskID: 'candidate:550e8400-e29b-41d4-a716-446655440000',
    targetType: 'candidate-translation',
    action: 'review-candidate',
    videoID: 'netflix-81234567',
    translationID: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: 321.2,
    timecode: '05:21',
    slotKey: 'slot-000321',
    languageCode: 'zh-TW',
    originalSubtitle: 'I did not see that coming.',
    suggestedSubtitle: '我完全沒料到會這樣。',
    score: 88,
    rankReasons: ['needs-review', 'near-threshold', 'older-pending'],
    resolution: {
      kind: 'candidate-translation',
      requiresTranslationID: true,
      voteTargetType: 'candidate-translation',
      status: 'pending'
    },
    userState: {
      hasVoted: false,
      voteState: 'none',
      isOwnContribution: false,
      excludedReason: null
    },
    ...overrides
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

export function createTrackedConfigBridge() {
  const callbacks = new Set();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;

  return {
    get: () => false,
    subscribe: (_key, callback) => {
      subscribeCalls++;
      callbacks.add(callback);
      let isUnsubscribed = false;
      return () => {
        if (isUnsubscribed) return;
        isUnsubscribed = true;
        unsubscribeCalls++;
        callbacks.delete(callback);
      };
    },
    emit(value) {
      for (const callback of callbacks) callback(value);
    },
    get activeSubscriptionCount() {
      return callbacks.size;
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    }
  };
}

/**
 * 建立面板測試 harness
 * 面板需先 initialize() 才能使用 show/hide
 */
export async function createHarness(Panel, overrides = {}) {
  const document = new FakeDocument();
  const scheduler = overrides.scheduler ?? createScheduler();

  const panel = new Panel({
    document,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    ...overrides
  });

  // FakeDocument 沒有 defaultView，所以 initialize() 會跳過 ConfigBridge 匯入
  await panel.initialize();

  return { panel, document, scheduler };
}
