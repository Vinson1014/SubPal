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

// 任務類型標籤
const TASK_TYPE_LABELS = {
  'official-subtitle': '官方字幕改善',
  'candidate-translation': '候選翻譯審查'
};

// 動作標籤
const ACTION_LABELS = {
  'submit-improvement': '提交改善翻譯',
  'review-candidate': '評價此翻譯',
  'submit-better-candidate': '提交更好翻譯'
};

/**
 * 安全取得字串值，null/undefined 轉為空字串
 */
function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

class EndscreenTaskPanel {
  /**
   * @param {Object} options
   * @param {Document} [options.document] - DOM document（可注入用於測試）
   * @param {Function} [options.schedule] - 排程函式
   * @param {Function} [options.cancel] - 取消排程函式
   */
  constructor({ document, schedule, cancel } = {}) {
    this.document = document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    this.schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = cancel || (id => clearTimeout(id));

    this.isInitialized = false;
    this.isVisible = false;
    this.container = null;
    this.currentTasks = null;
    this.currentContext = null;
    this.currentTaskIndex = 0;
    this.attachAnimationTimer = null;
    this.configSubscriptionDisposer = null;

    // 事件回調（展示性，Phase 5 接管實際邏輯）
    this.eventCallbacks = {
      onSkip: null,
      onClose: null,
      onAction: null
    };

    this.debug = false;
  }

  /**
   * 初始化面板組件
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      // 嘗試從 ConfigBridge 讀取調試模式（容錯：測試環境可能無 ConfigBridge）
      if (this.document?.defaultView) {
        try {
          const { configBridge } = await import('../system/config/config-bridge.js');
          this.debug = configBridge.get('debugMode');
          this.configSubscriptionDisposer = configBridge.subscribe('debugMode', (v) => { this.debug = v; });
        } catch { /* 測試環境無 ConfigBridge，忽略 */ }
      }

      this.isInitialized = true;
      this.log('片尾任務面板初始化完成');
    } catch (error) {
      console.error('片尾任務面板初始化失敗:', error);
      throw error;
    }
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

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.currentTasks = null;
    this.currentContext = null;
    this.currentTaskIndex = 0;
    this.isVisible = false;
  }

  /**
   * 更新面板內容
   */
  updateContent(tasks, context) {
    this.currentTasks = tasks;
    this.currentContext = context || null;
    this.currentTaskIndex = 0;
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
      bottom: '80px',
      left: '24px',
      zIndex: '10002',
      maxWidth: '380px',
      minWidth: '280px',
      padding: '0',
      borderRadius: '8px',
      backgroundColor: 'rgba(20, 20, 24, 0.92)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(8px)',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
      color: 'rgba(255, 255, 255, 0.92)',
      fontFamily: '"Netflix Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
      fontSize: '14px',
      lineHeight: '1.5',
      overflow: 'hidden',
      transition: 'opacity 0.25s ease, transform 0.25s ease',
      opacity: '0',
      transform: 'translateY(8px)'
    });
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

    const timecode = doc.createElement('span');
    timecode.className = 'subpal-endscreen-timecode';
    timecode.textContent = safeText(task.timecode);
    Object.assign(timecode.style, {
      fontFamily: '"SF Mono", "Monaco", "Consolas", monospace',
      fontSize: '13px',
      fontWeight: '600',
      color: 'rgba(255, 255, 255, 0.8)',
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
    if (rankReasons.length > 0) {
      const contextSection = doc.createElement('div');
      contextSection.style.cssText = 'padding: 4px 16px 8px;';

      const contextLabel = doc.createElement('div');
      contextLabel.className = 'subpal-endscreen-rank-context';
      // 安全渲染：使用 textContent 組合，不使用 innerHTML
      contextLabel.textContent = `排序原因：${rankReasons.join(', ')}`;
      contextLabel.style.cssText = 'font-size: 11px; color: rgba(255, 255, 255, 0.4);';
      contextSection.appendChild(contextLabel);

      this.container.appendChild(contextSection);
    }

    // ── CTA 按鈕列 ──
    const actionBar = doc.createElement('div');
    Object.assign(actionBar.style, {
      display: 'flex',
      gap: '8px',
      padding: '8px 16px 12px',
      flexWrap: 'wrap'
    });

    // 主要 CTA 按鈕（展示性，Phase 5 接管實際邏輯）
    const ctaBtn = doc.createElement('button');
    ctaBtn.type = 'button';
    ctaBtn.className = 'subpal-endscreen-cta-btn';
    ctaBtn.textContent = safeText(ACTION_LABELS[task.action] || '查看任務');
    ctaBtn.setAttribute('aria-label', safeText(ACTION_LABELS[task.action] || '查看任務'));
    Object.assign(ctaBtn.style, {
      flex: '1 1 auto',
      minHeight: '34px',
      padding: '0 14px',
      borderRadius: '6px',
      border: 'none',
      backgroundColor: 'rgba(59, 130, 246, 0.85)',
      color: '#fff',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
      transition: 'background 0.2s ease'
    });
    ctaBtn.addEventListener('mouseenter', () => {
      ctaBtn.style.backgroundColor = 'rgba(59, 130, 246, 1)';
    });
    ctaBtn.addEventListener('mouseleave', () => {
      ctaBtn.style.backgroundColor = 'rgba(59, 130, 246, 0.85)';
    });
    ctaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleAction();
    });
    actionBar.appendChild(ctaBtn);

    // Not-now 按鈕
    const notNowBtn = doc.createElement('button');
    notNowBtn.type = 'button';
    notNowBtn.className = 'subpal-endscreen-not-now-btn';
    notNowBtn.textContent = '稍後再說';
    notNowBtn.setAttribute('aria-label', '稍後再說');
    Object.assign(notNowBtn.style, {
      minHeight: '34px',
      padding: '0 12px',
      borderRadius: '6px',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      backgroundColor: 'transparent',
      color: 'rgba(255, 255, 255, 0.7)',
      fontSize: '13px',
      cursor: 'pointer',
      transition: 'background 0.2s ease'
    });
    notNowBtn.addEventListener('mouseenter', () => {
      notNowBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
    });
    notNowBtn.addEventListener('mouseleave', () => {
      notNowBtn.style.backgroundColor = 'transparent';
    });
    notNowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleNotNow();
    });
    actionBar.appendChild(notNowBtn);

    // Skip 按鈕
    const skipBtn = doc.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'subpal-endscreen-skip-btn';
    skipBtn.textContent = '跳過';
    skipBtn.setAttribute('aria-label', '跳過此任務');
    Object.assign(skipBtn.style, {
      minHeight: '34px',
      padding: '0 12px',
      borderRadius: '6px',
      border: '1px solid rgba(255, 255, 255, 0.15)',
      backgroundColor: 'transparent',
      color: 'rgba(255, 255, 255, 0.5)',
      fontSize: '13px',
      cursor: 'pointer',
      transition: 'background 0.2s ease'
    });
    skipBtn.addEventListener('mouseenter', () => {
      skipBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
    });
    skipBtn.addEventListener('mouseleave', () => {
      skipBtn.style.backgroundColor = 'transparent';
    });
    skipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleSkip();
    });
    actionBar.appendChild(skipBtn);

    this.container.appendChild(actionBar);

    // ── 阻止點擊事件冒泡到 Netflix 播放器 ──
    this.container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
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

  // ── 事件處理 ──

  handleSkip() {
    this.log('skip 按鈕被點擊');
    this.triggerCallback('onSkip');
    this.hide();
  }

  handleNotNow() {
    this.log('not-now 按鈕被點擊');
    this.hide();
  }

  handleClose() {
    this.log('close 按鈕被點擊');
    this.triggerCallback('onClose');
    this.hide();
  }

  handleAction() {
    this.log('CTA 按鈕被點擊');
    // Phase 5 將接管實際提交/投票邏輯
    this.triggerCallback('onAction', {
      task: this.currentTasks?.[this.currentTaskIndex] || null,
      context: this.currentContext
    });
  }

  triggerCallback(name, data = null) {
    const cb = this.eventCallbacks[name];
    if (typeof cb === 'function') cb(data);
  }

  // ── 回調註冊 ──

  onSkip(callback) {
    this.eventCallbacks.onSkip = callback;
  }

  onClose(callback) {
    this.eventCallbacks.onClose = callback;
  }

  onAction(callback) {
    this.eventCallbacks.onAction = callback;
  }

  // ── 清理 ──

  cleanup() {
    this.log('清理片尾任務面板資源');

    if (this.configSubscriptionDisposer) {
      this.configSubscriptionDisposer();
      this.configSubscriptionDisposer = null;
    }

    this.clearAttachAnimationTimer();

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.currentTasks = null;
    this.currentContext = null;
    this.currentTaskIndex = 0;
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
      taskCount: this.currentTasks?.length ?? 0
    };
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[EndscreenTaskPanel] ${message}`, ...args);
    }
  }
}

export { EndscreenTaskPanel };
