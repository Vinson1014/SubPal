/**
 * 片尾字幕任務面板組件
 *
 * 設計理念：
 * 1. 專責化：只負責片尾眾包任務面板的顯示、隱藏和事件處理
 * 2. 安全渲染：所有任務文字使用 textContent，絕不使用 innerHTML 渲染不可信內容
 * 3. 冪等生命週期：show/update/hide 皆可重複呼叫而不產生副作用
 * 4. 可存取性：提供 aria 標籤與焦點管理
 * 5. 展示性動作：CTA 按鈕僅觸發回調，實際提交/投票由 Phase 5 接管
 *
 * 面板定位於播放器左下角，避開 Netflix 主要「下一集」CTA（通常位於中下或右側）。
 *
 * @module endscreen-task-panel
 */

import { EndscreenTaskActionController } from './endscreen-task-action-controller.js';

// 任務類型標籤
const TASK_TYPE_LABELS = {
  'official-subtitle': '官方字幕改善',
  'candidate-translation': '候選翻譯審查'
};

const OPT_OUT_STATES = new Set(['idle', 'pending', 'error']);
const OVERLAY_UI_FONT_STACK = '"Netflix Sans", system-ui, "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", Arial, sans-serif';
const VOTE_ICON_PATHS = {
  like: 'M2 9h4v12H2zM22 10c0-1.1-.9-2-2-2h-6.3l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z',
  dislike: 'M2 14h4V2H2zM22 13c0 1.1-.9 2-2 2h-6.3l.95 4.57.03.32c0 .41-.17.79-.44 1.06L13.17 23l-6.58-6.59C6.22 16.05 6 15.55 6 15V5c0-1.1.9-2 2-2h9c.83 0 1.54.5 1.84 1.22l3.02 7.05c.09.23.14.47.14.73v2z',
  'chevron-right': 'M9 18l6-6-6-6'
};

/**
 * 安全取得字串值，null/undefined 轉為空字串
 */
function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function createControlId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `control-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

class EndscreenTaskPanel {
  /**
   * @param {Object} options
   * @param {Document} [options.document] - DOM document（可注入用於測試）
   * @param {Function} [options.schedule] - 排程函式
   * @param {Function} [options.cancel] - 取消排程函式
   */
  constructor({ document, schedule, cancel, configSource } = {}) {
    this.document = document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    this.schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = cancel || (id => clearTimeout(id));
    this.configSource = configSource || null;

    this.isInitialized = false;
    this.isVisible = false;
    this.container = null;
    this.currentTasks = null;
    this.currentContext = null;
    this.currentTaskIndex = 0;
    this.attachAnimationTimer = null;
    this.viewportResizeHandler = null;
    this.configSubscriptionDisposer = null;
    this.confirmationOverlay = null;
    this.confirmationDialog = null;
    this.confirmationKeydownHandler = null;
    this.confirmationFocusTarget = null;

    // 事件回調（展示性，Phase 5 接管實際邏輯）
    this.eventCallbacks = {
      onClose: null,
      onDismiss: null,
      onAction: null,
      onOptOut: null
    };

    this.debug = false;
    this.actionController = new EndscreenTaskActionController(() => {
      if (this.isVisible) this.renderContent();
    });
    this.isOptOutConfirmationVisible = false;
    this.optOutState = 'idle';
  }

  /**
   * 初始化面板組件
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      if (this.configSource) {
        this.connectDebugConfig(this.configSource);
      } else if (this.document?.defaultView) {
        try {
          const { configBridge } = await import('../system/config/config-bridge.js');
          this.connectDebugConfig(configBridge);
        } catch { /* 測試環境無 ConfigBridge，忽略 */ }
      }

      this.isInitialized = true;
      this.log('片尾任務面板初始化完成');
    } catch (error) {
      console.error('片尾任務面板初始化失敗:', error);
      throw error;
    }
  }

  connectDebugConfig(source) {
    this.debug = source.get('debugMode') === true;
    if (typeof source.subscribe !== 'function') return;
    this.configSubscriptionDisposer = source.subscribe('debugMode', (...values) => {
      this.debug = (values.length > 1 ? values[1] : values[0]) === true;
      if (this.isVisible) this.renderContent();
    });
  }

  /**
   * 顯示面板（冪等：重複呼叫相同任務不會重建 DOM）
   * @param {Array} tasks - 非空任務陣列
   * @param {Object} context - 播放上下文
   */
  show(tasks, context) {
    if (!this.isInitialized) return;
    if (!Array.isArray(tasks) || tasks.length === 0) return;

    // 冪等更新：若已顯示，更新內容而非重建
    if (this.isVisible && this.container) {
      this.updateContent(tasks, context);
      return;
    }

    this.log('顯示片尾任務面板', { taskCount: tasks.length });

    this.currentTasks = tasks;
    this.currentContext = context || null;
    this.currentTaskIndex = 0;
    this.actionController.reset();
    this.clearOptOutConfirmation(false);
    this.optOutState = 'idle';

    this.createPanel();
    this.renderContent();
    this.attachToDOM();
    this.isVisible = true;
  }

  /**
   * 隱藏面板（冪等：重複呼叫不會出錯）
   */
  hide() {
    if (!this.isVisible) return;

    this.log('隱藏片尾任務面板');

    this.clearAttachAnimationTimer();
    this.clearViewportResizeHandler();
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.clearOptOutConfirmation();
    this.container = null;
    this.currentTasks = null;
    this.currentContext = null;
    this.currentTaskIndex = 0;
    this.actionController.reset();
    this.optOutState = 'idle';
    this.isVisible = false;
  }

  /**
   * 更新面板內容
   */
  updateContent(tasks, context) {
    this.currentTasks = tasks;
    this.currentContext = context || null;
    this.currentTaskIndex = 0;
    this.actionController.reset();
    this.clearOptOutConfirmation(false);
    this.optOutState = 'idle';
    this.renderContent();
  }

  /**
   * 建立面板容器
   */
  createPanel() {
    const doc = this.document;
    if (!doc) return;

    // 若已存在，先移除
    const existing = doc.getElementById('subpal-endscreen-panel');
    if (existing) existing.remove();

    this.container = doc.createElement('div');
    this.container.id = 'subpal-endscreen-panel';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'SubPal 字幕任務');
    this.container.className = 'subpal-endscreen-panel';

    // 面板樣式：定位於左下角，避開 Netflix 主要「下一集」CTA
    Object.assign(this.container.style, {
      position: 'fixed',
      left: '24px',
      zIndex: '10002',
      boxSizing: 'border-box',
      maxWidth: 'min(380px, calc(100vw - 48px))',
      minWidth: 'min(280px, calc(100vw - 48px))',
      padding: '0',
      borderRadius: '8px',
      backgroundColor: 'rgba(20, 20, 24, 0.92)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(8px)',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
      color: 'rgba(255, 255, 255, 0.92)',
      fontFamily: OVERLAY_UI_FONT_STACK,
      fontSize: '14px',
      lineHeight: '1.5',
      overflow: 'hidden',
      transition: 'opacity 0.25s ease, transform 0.25s ease',
      opacity: '0',
      transform: 'translateY(8px)'
    });
    this.updateViewportPosition();
    if (typeof doc.defaultView?.addEventListener === 'function') {
      this.viewportResizeHandler = () => this.updateViewportPosition();
      doc.defaultView.addEventListener('resize', this.viewportResizeHandler);
    }
    this.container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  updateViewportPosition() {
    if (!this.container) return;

    const isNarrowViewport = this.document?.defaultView?.innerWidth <= 640;
    this.container.style.bottom = isNarrowViewport ? '140px' : '80px';
  }

  /**
   * 渲染面板內容
   * 所有不可信文字使用 textContent，絕不使用 innerHTML
   */
  renderContent() {
    if (!this.container || !this.currentTasks) return;

    const task = this.currentTasks[this.currentTaskIndex] || {};
    const doc = this.document;

    // 清空現有內容
    this.container.textContent = '';
    this.container.setAttribute('data-action-state', this.actionController.state);

    // ── 標題列 ──
    const header = doc.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px 8px',
      borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
    });

    const title = doc.createElement('span');
    title.className = 'subpal-endscreen-title';
    title.textContent = 'SubPal 字幕任務';
    title.style.cssText = 'font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.96);';
    header.appendChild(title);

    // 關閉按鈕
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'subpal-endscreen-close-btn';
    closeBtn.setAttribute('aria-label', '關閉任務面板');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      background: 'none',
      border: 'none',
      color: 'rgba(255, 255, 255, 0.6)',
      fontFamily: 'inherit',
      fontSize: '20px',
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: '1'
    });
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleClose();
    });
    header.appendChild(closeBtn);

    this.container.appendChild(header);

    // ── 任務類型標籤 ──
    const typeBar = doc.createElement('div');
    typeBar.style.cssText = 'padding: 8px 16px 4px;';

    const typeLabel = doc.createElement('span');
    typeLabel.className = 'subpal-endscreen-task-type';
    typeLabel.textContent = safeText(TASK_TYPE_LABELS[task.targetType] || task.targetType);
    Object.assign(typeLabel.style, {
      display: 'inline-block',
      fontSize: '11px',
      fontWeight: '600',
      padding: '2px 8px',
      borderRadius: '4px',
      backgroundColor: task.targetType === 'official-subtitle'
        ? 'rgba(59, 130, 246, 0.2)'
        : 'rgba(168, 85, 247, 0.2)',
      color: task.targetType === 'official-subtitle'
        ? 'rgba(147, 197, 253, 1)'
        : 'rgba(216, 180, 254, 1)'
    });
    typeBar.appendChild(typeLabel);

    // 任務計數
    if (this.currentTasks.length > 1) {
      const countLabel = doc.createElement('span');
      countLabel.className = 'subpal-endscreen-task-count';
      countLabel.textContent = ` ${this.currentTaskIndex + 1}/${this.currentTasks.length}`;
      countLabel.style.cssText = 'font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-left: 6px;';
      typeBar.appendChild(countLabel);
    }

    this.container.appendChild(typeBar);

    // ── Timecode ──
    const timecodeBar = doc.createElement('div');
    timecodeBar.style.cssText = 'padding: 4px 16px;';

    const actionIsDisabled = this.actionController.isBlocked();
    const canJumpToTimecode = Number.isFinite(task.timestamp) && task.timestamp >= 0;
    const timecode = this.createControl({
      className: 'subpal-endscreen-timecode subpal-endscreen-timecode-jump-btn',
      text: `跳至 ${safeText(task.timecode)}`,
      ariaLabel: `跳至 ${safeText(task.timecode)} 字幕時間點`,
      variant: 'quiet',
      disabled: actionIsDisabled || !canJumpToTimecode,
      onClick: (event) => this.handleAction('jump-to-timecode', event)
    });
    timecode.setAttribute('data-control-id', createControlId());
    timecode.setAttribute('data-subpal-jump-video-id', String(this.currentContext?.videoId || ''));
    timecode.setAttribute('data-subpal-jump-session-id', String(this.currentContext?.sessionId || ''));
    timecode.setAttribute('data-subpal-jump-epoch', String(this.currentContext?.epoch ?? ''));
    timecode.setAttribute('data-subpal-jump-target-timestamp', String(task.timestamp));
    Object.assign(timecode.style, {
      width: '100%',
      boxSizing: 'border-box',
      fontFamily: '"SF Mono", "Monaco", "Consolas", monospace',
      fontVariantNumeric: 'tabular-nums'
    });
    timecodeBar.appendChild(timecode);

    this.container.appendChild(timecodeBar);

    // ── 原始字幕 ──
    const originalSection = doc.createElement('div');
    originalSection.style.cssText = 'padding: 4px 16px;';

    const originalLabel = doc.createElement('div');
    originalLabel.textContent = '原字幕';
    originalLabel.style.cssText = 'font-size: 11px; color: rgba(255, 255, 255, 0.4); margin-bottom: 2px;';
    originalSection.appendChild(originalLabel);

    const originalText = doc.createElement('div');
    originalText.className = 'subpal-endscreen-original';
    originalText.textContent = safeText(task.originalSubtitle); // 安全渲染：textContent
    Object.assign(originalText.style, {
      fontSize: '14px',
      color: 'rgba(255, 255, 255, 0.88)',
      wordBreak: 'break-word',
      whiteSpace: 'pre-wrap'
    });
    originalSection.appendChild(originalText);

    this.container.appendChild(originalSection);

    // ── 候選翻譯（僅 candidate-translation 任務） ──
    if (task.targetType === 'candidate-translation' && task.suggestedSubtitle != null) {
      const suggestedSection = doc.createElement('div');
      suggestedSection.style.cssText = 'padding: 4px 16px;';

      const suggestedLabel = doc.createElement('div');
      suggestedLabel.textContent = '候選翻譯';
      suggestedLabel.style.cssText = 'font-size: 11px; color: rgba(255, 255, 255, 0.4); margin-bottom: 2px;';
      suggestedSection.appendChild(suggestedLabel);

      const suggestedText = doc.createElement('div');
      suggestedText.className = 'subpal-endscreen-suggested';
      suggestedText.textContent = safeText(task.suggestedSubtitle); // 安全渲染：textContent
      Object.assign(suggestedText.style, {
        fontSize: '14px',
        color: 'rgba(255, 255, 255, 0.78)',
        fontStyle: 'italic',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap'
      });
      suggestedSection.appendChild(suggestedText);

      this.container.appendChild(suggestedSection);
    }

    // ── 排名上下文 ──
    const rankReasons = Array.isArray(task.rankReasons) ? task.rankReasons : [];
    if (this.debug && rankReasons.length > 0) {
      const contextSection = doc.createElement('div');
      contextSection.style.cssText = 'padding: 4px 16px 8px;';

      const contextLabel = doc.createElement('div');
      contextLabel.className = 'subpal-endscreen-rank-context';
      // 安全渲染：使用 textContent 組合，不使用 innerHTML
      contextLabel.textContent = `排序原因：${rankReasons.join(', ')}`;
      contextLabel.style.cssText = 'font-size: 11px; color: rgba(255, 255, 255, 0.4); overflow-wrap: anywhere;';
      contextSection.appendChild(contextLabel);

      this.container.appendChild(contextSection);
    }

    const actionBar = doc.createElement('div');
    Object.assign(actionBar.style, {
      display: 'flex',
      gap: '8px',
      padding: '8px 16px 12px',
      flexWrap: 'wrap'
    });

    const voteState = this.actionController.selectedVote(task);
    if (task.action === 'review-candidate') {
      actionBar.appendChild(this.createControl({
        className: 'subpal-endscreen-like-btn',
        text: '喜歡',
        ariaLabel: '喜歡這個翻譯',
        variant: 'vote',
        icon: 'like',
        active: voteState === 'like',
        disabled: actionIsDisabled,
        onClick: () => this.handleAction('vote-like')
      }));
      actionBar.appendChild(this.createControl({
        className: 'subpal-endscreen-dislike-btn',
        text: '不喜歡',
        ariaLabel: '不喜歡這個翻譯',
        variant: 'vote',
        icon: 'dislike',
        active: voteState === 'dislike',
        disabled: actionIsDisabled,
        onClick: () => this.handleAction('vote-dislike')
      }));
      actionBar.appendChild(this.createControl({
        className: 'subpal-endscreen-submit-better-btn',
        text: '提交更好翻譯',
        variant: 'secondary',
        disabled: actionIsDisabled,
        onClick: () => this.handleAction('submit-better-candidate')
      }));
    } else {
      actionBar.appendChild(this.createControl({
        className: 'subpal-endscreen-cta-btn',
        text: '提交翻譯',
        variant: 'primary',
        disabled: actionIsDisabled,
        onClick: () => this.handleAction(task.action)
      }));
    }

    this.container.appendChild(actionBar);

    if (this.currentTasks.length > 1) {
      const navigationBar = doc.createElement('div');
      Object.assign(navigationBar.style, {
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '0 16px 12px'
      });
      navigationBar.appendChild(this.createControl({
        className: 'subpal-endscreen-next-task-btn',
        text: '下一題',
        ariaLabel: '下一題',
        variant: 'quiet',
        icon: 'chevron-right',
        disabled: this.actionController.state === 'loading',
        onClick: () => this.handleNextTask()
      }));
      this.container.appendChild(navigationBar);
    }

    if (this.actionController.state === 'loading' || this.actionController.state === 'success' || this.actionController.state === 'error') {
      const actionStatus = doc.createElement('div');
      const isError = this.actionController.state === 'error';
      actionStatus.className = 'subpal-endscreen-action-status';
      actionStatus.setAttribute('role', isError ? 'alert' : 'status');
      actionStatus.textContent = this.actionController.state === 'loading'
        ? '正在處理，請稍候。'
        : isError
          ? this.actionController.error || '無法完成此任務，請再試一次。'
          : this.actionController.successfulIntent === 'jump-to-timecode'
            ? '已跳轉至字幕時間點。'
          : this.actionController.successfulVoteState === 'like'
            ? '已送出喜歡評價。'
            : this.actionController.successfulVoteState === 'dislike'
              ? '已送出不喜歡評價。'
              : '任務已完成。';
      actionStatus.style.cssText = `padding: 0 16px 8px; font-size: 11px; color: ${isError ? 'var(--vote-dislike-fg, #f87171)' : 'var(--affirmative-hover-fg, #34d399)'};`;
      this.container.appendChild(actionStatus);
    }

    const preferenceSection = doc.createElement('div');
    preferenceSection.style.cssText = 'border-top: 1px solid rgba(255, 255, 255, 0.06); margin-top: 16px; padding: 16px;';
    preferenceSection.appendChild(this.createControl({
      className: 'subpal-endscreen-opt-out-btn',
      text: '不再顯示字幕任務',
      variant: 'quiet',
      onClick: (event) => this.handleOptOutRequest(event)
    }));
    this.container.appendChild(preferenceSection);
  }

  createControl({ className, text, ariaLabel, variant, icon, active = false, disabled = false, onClick }) {
    const button = this.document.createElement('button');
    const isPrimary = variant === 'primary';
    const isQuiet = variant === 'quiet';
    const isVote = variant === 'vote';
    const selectedVoteBackground = icon === 'like'
      ? 'var(--color-accent-subtle, rgba(16, 185, 129, 0.1))'
      : 'var(--color-danger-bg, rgba(239, 68, 68, 0.1))';
    const defaultBackground = isPrimary
      ? 'var(--color-accent, #10b981)'
      : isVote && active
        ? selectedVoteBackground
        : 'transparent';
    const defaultBorder = isPrimary
      ? 'none'
      : isVote && active
        ? `1px solid ${icon === 'like' ? 'var(--color-accent, #10b981)' : 'var(--vote-dislike-fg, #f87171)'}`
        : `1px solid ${isQuiet ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.2)'}`;
    button.type = 'button';
    button.className = className;
    button.textContent = isVote ? '' : text;
    button.setAttribute('aria-label', ariaLabel || text);
    if (isVote) button.setAttribute('aria-pressed', String(active));
    button.disabled = disabled;
    Object.assign(button.style, {
      minHeight: '34px',
      padding: '0 12px',
      borderRadius: '6px',
      border: defaultBorder,
      backgroundColor: defaultBackground,
      color: active ? (icon === 'like' ? 'var(--affirmative-hover-fg, #34d399)' : 'var(--vote-dislike-fg, #f87171)') : isPrimary ? '#fff' : isQuiet ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.78)',
      fontFamily: 'inherit',
      fontSize: '13px',
      fontWeight: '600',
      cursor: disabled ? 'not-allowed' : 'pointer',
      whiteSpace: 'nowrap',
      opacity: disabled ? '0.5' : '1',
      pointerEvents: disabled ? 'none' : 'auto',
      transition: 'background 0.15s ease, box-shadow 0.15s ease'
    });
    if (icon) {
      const createSvgElement = this.document.createElementNS
        ? (tagName) => this.document.createElementNS('http://www.w3.org/2000/svg', tagName)
        : (tagName) => this.document.createElement(tagName);
      const svg = createSvgElement('svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.setAttribute('aria-hidden', 'true');
      const path = createSvgElement('path');
      path.setAttribute('d', VOTE_ICON_PATHS[icon]);
      if (icon === 'chevron-right') {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
      } else {
        path.setAttribute('fill', 'currentColor');
      }
      svg.appendChild(path);
      button.appendChild(svg);
    }
    if (isPrimary) button.style.flex = '1 1 auto';
    if (isVote) button.style.flex = '1 1 0';
    button.addEventListener('mouseenter', () => {
      if (disabled) return;
      button.style.backgroundColor = isVote && active ? defaultBackground : isPrimary ? 'var(--color-accent-hover, #059669)' : isQuiet ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.08)';
    });
    button.addEventListener('mouseleave', () => {
      if (!disabled) button.style.backgroundColor = defaultBackground;
    });
    button.addEventListener('focus', () => {
      button.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.15)';
    });
    button.addEventListener('blur', () => {
      button.style.boxShadow = 'none';
    });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!button.disabled) onClick(e);
    });
    return button;
  }

  clearOptOutConfirmation(restoreFocus = true) {
    const focusTarget = this.confirmationFocusTarget;
    if (this.confirmationKeydownHandler) {
      this.document?.removeEventListener('keydown', this.confirmationKeydownHandler);
      this.confirmationKeydownHandler = null;
    }
    this.confirmationOverlay?.remove();
    this.confirmationDialog?.remove();
    this.confirmationOverlay = null;
    this.confirmationDialog = null;
    this.isOptOutConfirmationVisible = false;
    this.confirmationFocusTarget = null;
    if (restoreFocus && focusTarget?.isConnected) focusTarget.focus();
  }

  handleOptOutRequest(event) {
    if (!this.document || this.confirmationOverlay) return;

    this.optOutState = 'idle';
    this.isOptOutConfirmationVisible = true;
    const focusTarget = event?.currentTarget || event?.target;
    this.confirmationFocusTarget = focusTarget?.isConnected ? focusTarget : null;
    const overlay = this.document.createElement('div');
    overlay.className = 'subpal-endscreen-opt-out-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '999998',
      backgroundColor: 'rgba(0, 0, 0, 0.5)'
    });
    overlay.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    const dialog = this.document.createElement('div');
    dialog.className = 'subpal-endscreen-opt-out-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '確認不再顯示字幕任務');
    dialog.textContent = '確定不再顯示字幕任務嗎？之後可在 SubPal 設定中重新啟用。';
    Object.assign(dialog.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      zIndex: '999999',
      boxSizing: 'border-box',
      width: 'min(450px, calc(100vw - 32px))',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: '80vh',
      overflowY: 'auto',
      padding: '24px',
      borderRadius: '8px',
      transform: 'translate(-50%, -50%)',
      backgroundColor: 'rgba(20, 20, 24, 0.92)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      boxShadow: '0 4px 8px rgba(0, 0, 0, 0.2)',
      color: 'rgba(255, 255, 255, 0.92)',
      fontFamily: OVERLAY_UI_FONT_STACK,
      fontSize: '14px',
      lineHeight: '1.5'
    });
    dialog.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    const error = this.document.createElement('div');
    error.className = 'subpal-endscreen-opt-out-error';
    error.setAttribute('role', 'alert');
    error.style.cssText = 'display: none; margin-top: 12px; color: #f87171;';
    dialog.appendChild(error);

    const actions = this.document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 8px; margin-top: 16px;';
    const cancelBtn = this.createControl({
      className: 'subpal-endscreen-opt-out-cancel-btn',
      text: '取消',
      variant: 'quiet',
      onClick: () => this.handleOptOutCancel()
    });
    actions.appendChild(cancelBtn);
    const confirmBtn = this.createControl({
      className: 'subpal-endscreen-opt-out-confirm-btn',
      text: '確認不再顯示',
      variant: 'primary',
      onClick: (event) => this.handleOptOutConfirm(event)
    });
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    this.document.body.appendChild(overlay);
    this.document.body.appendChild(dialog);
    this.confirmationOverlay = overlay;
    this.confirmationDialog = dialog;
    this.confirmationKeydownHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.handleOptOutCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [cancelBtn, confirmBtn].filter((control) => !control.disabled);
      if (controls.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const currentIndex = controls.indexOf(this.document.activeElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? controls.length - 1 : currentIndex - 1)
        : (currentIndex === controls.length - 1 ? 0 : currentIndex + 1);
      controls[nextIndex].focus();
    };
    this.document.addEventListener('keydown', this.confirmationKeydownHandler);
    cancelBtn.focus();
  }

  handleOptOutCancel() {
    this.clearOptOutConfirmation();
    this.optOutState = 'idle';
  }

  handleOptOutConfirm(event) {
    if (!event?.isTrusted || this.optOutState === 'pending' || !this.confirmationDialog) return false;

    this.setOptOutState('pending');
    this.triggerCallback('onOptOut', {
      intent: 'opt-out-endscreen-tasks',
      task: this.currentTasks?.[this.currentTaskIndex] || null,
      context: this.currentContext,
      setPending: () => this.setOptOutState('pending'),
      setFailure: () => this.setOptOutState('error')
    });
    return true;
  }

  setOptOutState(state) {
    if (!OPT_OUT_STATES.has(state)) return false;
    this.optOutState = state;
    this.confirmationDialog?.setAttribute('data-opt-out-state', state);
    const confirmBtn = this.confirmationDialog?.querySelector('.subpal-endscreen-opt-out-confirm-btn');
    const error = this.confirmationDialog?.querySelector('.subpal-endscreen-opt-out-error');
    if (confirmBtn) {
      const isPending = state === 'pending';
      confirmBtn.disabled = isPending;
      confirmBtn.style.opacity = isPending ? '0.5' : '1';
      confirmBtn.style.pointerEvents = isPending ? 'none' : 'auto';
    }
    if (error) {
      const hasError = state === 'error';
      error.textContent = hasError ? '無法儲存設定，請再試一次。' : '';
      error.style.display = hasError ? 'block' : 'none';
    }
    return true;
  }

  /**
   * 將面板附加到 DOM 並觸發顯示動畫
   */
  attachToDOM() {
    if (!this.container || !this.document) return;

    this.clearAttachAnimationTimer();
    this.document.body.appendChild(this.container);

    // 顯示動畫
    const timerId = this.schedule(() => {
      if (this.attachAnimationTimer !== timerId) return;
      this.attachAnimationTimer = null;

      if (this.container) {
        this.container.style.opacity = '1';
        this.container.style.transform = 'translateY(0)';
      }
    }, 0);

    this.attachAnimationTimer = timerId;
  }

  clearAttachAnimationTimer() {
    if (this.attachAnimationTimer == null) return;

    this.cancel(this.attachAnimationTimer);
    this.attachAnimationTimer = null;
  }

  clearViewportResizeHandler() {
    if (!this.viewportResizeHandler) return;

    this.document?.defaultView?.removeEventListener?.('resize', this.viewportResizeHandler);
    this.viewportResizeHandler = null;
  }

  // ── 事件處理 ──

  handleNextTask() {
    if (!this.currentTasks || this.currentTasks.length < 2 || this.actionController.state === 'loading') return;

    this.log('下一題按鈕被點擊');
    this.currentTaskIndex = (this.currentTaskIndex + 1) % this.currentTasks.length;
    this.actionController.reset();
    this.clearOptOutConfirmation();
    this.renderContent();
    this.container?.querySelector('.subpal-endscreen-next-task-btn')?.focus();
  }

  handleClose() {
    this.log('close 按鈕被點擊');
    this.triggerCallback('onClose');
    this.triggerCallback('onDismiss');
    this.hide();
  }

  handleAction(intent, event = null) {
    this.log('任務行動按鈕被點擊', { intent });
    const task = this.currentTasks?.[this.currentTaskIndex];
    const metadata = intent === 'jump-to-timecode' ? {
      controlId: event?.currentTarget?.getAttribute?.('data-control-id'),
      requestId: event?.currentTarget?.getAttribute?.('data-subpal-jump-request-id'),
      issuedAt: Number(event?.currentTarget?.getAttribute?.('data-subpal-jump-issued-at'))
    } : {};
    return this.actionController.handle(intent, task, this.currentContext, this.eventCallbacks.onAction, metadata);
  }

  triggerCallback(name, data = null) {
    const cb = this.eventCallbacks[name];
    if (typeof cb === 'function') cb(data);
  }

  // ── 回調註冊 ──

  onClose(callback) {
    this.eventCallbacks.onClose = callback;
  }

  onDismiss(callback) {
    this.eventCallbacks.onDismiss = callback;
  }

  onAction(callback) {
    this.eventCallbacks.onAction = callback;
  }

  onOptOut(callback) {
    this.eventCallbacks.onOptOut = callback;
  }

  setActionState(state) {
    return this.actionController.setState(state);
  }

  getActionState() {
    return this.actionController.state;
  }

  // ── 清理 ──

  cleanup() {
    this.log('清理片尾任務面板資源');

    if (this.configSubscriptionDisposer) {
      this.configSubscriptionDisposer();
      this.configSubscriptionDisposer = null;
    }

    this.clearAttachAnimationTimer();
    this.clearViewportResizeHandler();

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.clearOptOutConfirmation();

    this.container = null;
    this.currentTasks = null;
    this.currentContext = null;
    this.currentTaskIndex = 0;
    this.actionController.reset();
    this.optOutState = 'idle';
    this.isVisible = false;
    this.isInitialized = false;
    this.eventCallbacks = {};
  }

  // ── 狀態查詢 ──

  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isVisible: this.isVisible,
      hasContainer: !!this.container,
      taskCount: this.currentTasks?.length ?? 0,
      actionState: this.actionController.state,
      actionError: this.actionController.error,
      optOutState: this.optOutState
    };
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[EndscreenTaskPanel] ${message}`, ...args);
    }
  }
}

export { EndscreenTaskPanel };
