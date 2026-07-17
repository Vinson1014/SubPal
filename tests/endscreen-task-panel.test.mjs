/**
 * 片尾任務面板測試
 *
 * 測試策略：
 * 1. 面板行為測試 — 驗證 show/hide/render/skip/close/idempotent/safe text
 * 2. 所有權測試 — 驗證 MAIN 初始化不持有片尾任務 transport 或 panel bridge
 *
 * 執行方式：node --experimental-vm-modules --test tests/endscreen-task-panel.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  loadPanel,
  FakeDocument,
  FakeElement,
  createScheduler,
  createOfficialTask,
  createCandidateTask,
  createContext,
  createHarness,
  createTrackedConfigBridge
} from './endscreen-task-panel-fixtures.mjs';

const CJK_UI_FONT_STACK = '"Netflix Sans", system-ui, "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", Arial, sans-serif';

test('Given two-world ownership When sources are inspected Then only the isolated bootstrap imports the panel', async () => {
  const isolated = await readFile(new URL('../content/system/isolated-endscreen-tasks.js', import.meta.url), 'utf8');
  const mainUI = await readFile(new URL('../content/ui/ui-manager-new.js', import.meta.url), 'utf8');
  assert.ok(isolated.includes("import { EndscreenTaskPanel } from '../ui/endscreen-task-panel.js'"));
  assert.ok(!mainUI.includes('EndscreenTaskPanel'));
  assert.ok(!mainUI.includes('ENDSCREEN_TASKS_RECEIVED'));
});

// ─── 面板行為測試（失敗優先） ───

test('Given a panel instance When show is called with empty tasks Then it does not render', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([], createContext());

  assert.equal(document.getElementById('subpal-endscreen-panel'), null,
    '空任務不應渲染面板');
});

test('Given a panel instance When show is called with a non-empty official task Then it renders timecode, original subtitle, and task type', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl, '面板應存在於 DOM');
  assert.equal(panelEl.style.fontFamily, CJK_UI_FONT_STACK, '面板應使用跨平台 CJK UI 字型堆疊');

  // 面板應顯示 timecode
  const timecodeEl = panelEl.querySelector('.subpal-endscreen-timecode');
  assert.ok(timecodeEl, '應有 timecode 元素');
  assert.equal(timecodeEl.textContent, '跳至 02:04', 'timecode 應顯示明確跳轉文案');

  // 面板應顯示原始字幕（使用 textContent，非 innerHTML）
  const originalEl = panelEl.querySelector('.subpal-endscreen-original');
  assert.ok(originalEl, '應有原始字幕元素');
  assert.equal(originalEl.textContent, '我會在十分鐘後回來。', '原始字幕應正確渲染');
  assert.equal(originalEl.innerHTML, originalEl.textContent, '原始字幕應使用 textContent 而非 innerHTML');

  // 面板應標示為 official-subtitle 類型
  const typeEl = panelEl.querySelector('.subpal-endscreen-task-type');
  assert.ok(typeEl, '應有任務類型元素');
  assert.ok(typeEl.textContent.includes('官方字幕'), '應標示為官方字幕任務');
});

test('Given a panel instance When show is called with a candidate task Then it renders the suggested subtitle', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createCandidateTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl, '面板應存在於 DOM');

  // 候選翻譯應顯示 suggestedSubtitle
  const suggestedEl = panelEl.querySelector('.subpal-endscreen-suggested');
  assert.ok(suggestedEl, '應有候選翻譯元素');
  assert.equal(suggestedEl.textContent, '我完全沒料到會這樣。', '候選翻譯應正確渲染');

  // 面板應標示為 candidate-translation 類型
  const typeEl = panelEl.querySelector('.subpal-endscreen-task-type');
  assert.ok(typeEl, '應有任務類型元素');
  assert.ok(typeEl.textContent.includes('候選翻譯'), '應標示為候選翻譯任務');
});

test('Given a panel instance When show is called with an official task Then no suggested subtitle section is rendered', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const suggestedEl = panelEl.querySelector('.subpal-endscreen-suggested');
  assert.equal(suggestedEl, null, '官方字幕任務不應有候選翻譯區塊');
});

test('Given a panel instance When show is called Then it renders skip, not-now, and close buttons', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');

  const skipBtn = panelEl.querySelector('.subpal-endscreen-skip-btn');
  assert.ok(skipBtn, '應有 skip 按鈕');
  assert.equal(skipBtn.style.color, 'rgba(255, 255, 255, 0.6)', '略過按鈕應使用安靜文字色');
  assert.equal(skipBtn.style.fontFamily, 'inherit', '略過按鈕應繼承面板字型');

  const notNowBtn = panelEl.querySelector('.subpal-endscreen-not-now-btn');
  assert.ok(notNowBtn, '應有 not-now 按鈕');
  assert.equal(notNowBtn.style.fontFamily, 'inherit', '次要按鈕應繼承面板字型');

  const closeBtn = panelEl.querySelector('.subpal-endscreen-close-btn');
  assert.ok(closeBtn, '應有 close 按鈕');
});

test('Given a visible panel When hide is called Then it is removed from the DOM', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();

  panel.show([task], createContext());
  assert.ok(document.getElementById('subpal-endscreen-panel'), '面板應先顯示');

  panel.hide();
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, '隱藏後面板應從 DOM 移除');
});

test('Given a visible panel When show then hide then cleanup are called Then attach animation callbacks are fully cancelled', async () => {
  const Panel = await loadPanel();
  const { panel, scheduler, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  assert.equal(scheduler.pending, 1, 'show 後應有一個待執行的 attach 動畫排程');

  panel.hide();
  assert.equal(scheduler.pending, 0, 'hide 後應取消所有 attach 動畫排程');
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'hide 後面板應從 DOM 移除');

  scheduler.advance(0);
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, '已取消的 attach 動畫不應在 hide 後重新影響 DOM');

  panel.show([createOfficialTask()], createContext());
  assert.equal(scheduler.pending, 1, '再次 show 應只保留一個新的 attach 動畫排程');

  panel.cleanup();
  assert.equal(scheduler.pending, 0, 'cleanup 後應取消 attach 動畫排程');

  scheduler.advance(0);
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'cleanup 後已取消的 attach 動畫不應重建 DOM');
});

test('Given a visible panel When hide is called twice Then it is idempotent', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  panel.hide();
  panel.hide(); // 不應拋出例外

  assert.equal(document.getElementById('subpal-endscreen-panel'), null, '重複隱藏應冪等');
});

test('Given no prior show When hide is called Then it is idempotent', async () => {
  const Panel = await loadPanel();
  const { panel } = await createHarness(Panel);

  panel.hide(); // 不應拋出例外
  assert.equal(panel.isVisible, false, '未顯示前隱藏應冪等');
});

test('Given a visible panel When show is called again with different tasks Then it updates content idempotently', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  const panelEl1 = document.getElementById('subpal-endscreen-panel');
  const timecode1 = panelEl1.querySelector('.subpal-endscreen-timecode').textContent;

  panel.show([createCandidateTask()], createContext());
  const panelEl2 = document.getElementById('subpal-endscreen-panel');
  const timecode2 = panelEl2.querySelector('.subpal-endscreen-timecode').textContent;

  assert.notEqual(timecode1, timecode2, '更新後 timecode 應改變');
  assert.equal(timecode2, '跳至 05:21', '更新後 timecode 應顯示候選任務的跳轉文案');
});

test('Given a panel with task text containing HTML When it is rendered Then the text is safely escaped via textContent', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const malicious = '<img src=x onerror=alert(1)>惡意字幕';
  const task = createOfficialTask({ originalSubtitle: malicious });

  panel.show([task], createContext());

  const originalEl = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-original');
  assert.equal(originalEl.textContent, malicious, 'textContent 應包含完整原始字串');
  assert.equal(originalEl.innerHTML, '&lt;img src=x onerror=alert(1)&gt;惡意字幕',
    'innerHTML 序列化應將不可信標籤轉義為文字');
  assert.equal(originalEl.children.length, 0, '不可信字幕不得建立子元素');
});

test('Given a fake element When untrusted text is assigned Then it serializes escaped text without parsing children', () => {
  const element = new FakeElement();
  element.textContent = '<img onerror=alert(1)>';

  assert.equal(element.innerHTML, '&lt;img onerror=alert(1)&gt;');
  assert.equal(element.children.length, 0);
});

test('Given a panel with rank reasons When debug mode is disabled Then diagnostic rank reasons are absent and remain safe when enabled', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const reason = '<img src=x onerror=alert(1)>debug-only';
  const task = createOfficialTask({ rankReasons: [reason] });

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.equal(panelEl.querySelector('.subpal-endscreen-rank-context'), null,
    '非 debug 模式不應顯示排名診斷內容');

  panel.debug = true;
  panel.renderContent();

  const contextEl = panelEl.querySelector('.subpal-endscreen-rank-context');
  assert.ok(contextEl, 'debug 模式應顯示排名診斷內容');
  assert.equal(contextEl.textContent, `排序原因：${reason}`, '排名原因應以文字安全渲染');
  assert.equal(contextEl.innerHTML, '排序原因：&lt;img src=x onerror=alert(1)&gt;debug-only',
    '排名原因序列化不應保留可解析的 HTML');
  assert.equal(contextEl.children.length, 0, '排名原因不得建立子元素');
});

test('Given each task action When rendered Then it exposes the Phase 4.5 primary and secondary action hierarchy', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  let panelEl = document.getElementById('subpal-endscreen-panel');
  let ctaBtn = panelEl.querySelector('.subpal-endscreen-cta-btn');
  assert.equal(ctaBtn.textContent, '提交翻譯', '官方改善任務應只有提交翻譯主行動');

  panel.show([createCandidateTask({ action: 'submit-better-candidate' })], createContext());
  panelEl = document.getElementById('subpal-endscreen-panel');
  ctaBtn = panelEl.querySelector('.subpal-endscreen-cta-btn');
  assert.equal(ctaBtn.textContent, '提交翻譯', '候選改善任務應只有提交翻譯主行動');

  panel.show([createCandidateTask({ action: 'review-candidate' })], createContext());
  panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl.querySelector('.subpal-endscreen-like-btn'), '審查任務應提供喜歡主行動');
  assert.ok(panelEl.querySelector('.subpal-endscreen-dislike-btn'), '審查任務應提供不喜歡主行動');
  const submitBetterBtn = panelEl.querySelector('.subpal-endscreen-submit-better-btn');
  assert.equal(submitBetterBtn.textContent, '提交更好翻譯', '審查任務應提供次要的提交更好翻譯');
  assert.equal(panelEl.querySelector('.subpal-endscreen-cta-btn'), null, '審查任務不應有通用提交主 CTA');
});

test('Given an active candidate vote When review controls render Then they use accessible SVG icons and active vote colors', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  document.createElementNS = (_namespace, tagName) => document.createElement(tagName);
  const task = createCandidateTask({ userState: { voteState: 'like' } });

  panel.show([task], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const likeBtn = panelEl.querySelector('.subpal-endscreen-like-btn');
  const dislikeBtn = panelEl.querySelector('.subpal-endscreen-dislike-btn');
  assert.equal(likeBtn.getAttribute('aria-label'), '喜歡這個翻譯', '喜歡按鈕應有中文 aria-label');
  assert.equal(dislikeBtn.getAttribute('aria-label'), '不喜歡這個翻譯', '不喜歡按鈕應有中文 aria-label');
  assert.equal(likeBtn.children[0].tagName, 'svg', '喜歡按鈕應使用 SVG 圖示');
  assert.equal(dislikeBtn.children[0].tagName, 'svg', '不喜歡按鈕應使用 SVG 圖示');
  assert.equal(likeBtn.children[0].getAttribute('width'), '18', '喜歡 SVG 應為 18px');
  assert.equal(dislikeBtn.children[0].getAttribute('height'), '18', '不喜歡 SVG 應為 18px');
  assert.equal(likeBtn.children[0].getAttribute('aria-hidden'), 'true', '圖示應對輔助科技隱藏');
  assert.equal(likeBtn.children[0].children[0].getAttribute('fill'), 'currentColor',
    'SVG 路徑應繼承控制項的 active 色彩');
  assert.equal(likeBtn.textContent, '', '喜歡按鈕不應呈現可見文字');
  assert.equal(dislikeBtn.textContent, '', '不喜歡按鈕不應呈現可見文字');
  assert.equal(likeBtn.style.color, 'var(--affirmative-hover-fg, #34d399)', '喜歡的 active 狀態應使用肯定色');

  const iconOnlyControl = panel.createControl({
    className: 'subpal-test-vote-btn',
    text: '喜歡',
    ariaLabel: '喜歡這個翻譯',
    variant: 'vote',
    icon: 'like',
    onClick: () => {}
  });
  assert.equal(iconOnlyControl.textContent, '', '帶有人類可讀描述的 SVG 控制仍不應呈現文字節點');

  panel.show([createCandidateTask({ userState: { voteState: 'dislike' } })], createContext());
  assert.equal(document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-dislike-btn').style.color, 'var(--vote-dislike-fg, #f87171)',
  '不喜歡的 active 狀態應使用否定色');
});

test('Given a candidate like succeeds When the panel rerenders Then like stays selected, dislike stays unselected, and aria-pressed reflects the outcome', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let resolveAction;
  panel.onAction(() => new Promise((resolve) => { resolveAction = resolve; }));
  panel.show([createCandidateTask({ userState: { voteState: 'none' } })], createContext());

  const like = document.getElementById('subpal-endscreen-panel').querySelector('.subpal-endscreen-like-btn');
  like.dispatchEvent({ type: 'click', target: like, preventDefault: () => {}, stopPropagation: () => {} });
  resolveAction({ status: 'success' });
  await Promise.resolve();
  await Promise.resolve();

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const selectedLike = panelEl.querySelector('.subpal-endscreen-like-btn');
  const unselectedDislike = panelEl.querySelector('.subpal-endscreen-dislike-btn');
  assert.equal(selectedLike.getAttribute('aria-pressed'), 'true');
  assert.equal(unselectedDislike.getAttribute('aria-pressed'), 'false');
  assert.equal(selectedLike.style.backgroundColor, 'var(--color-accent-subtle, rgba(16, 185, 129, 0.1))');
  assert.equal(selectedLike.style.border, '1px solid var(--color-accent, #10b981)');
  assert.ok(panelEl.querySelector('.subpal-endscreen-action-status').textContent.includes('喜歡'));
});

test('Given a candidate dislike succeeds When the panel rerenders Then dislike stays selected, like stays unselected, and aria-pressed reflects the outcome', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let resolveAction;
  panel.onAction(() => new Promise((resolve) => { resolveAction = resolve; }));
  panel.show([createCandidateTask({ userState: { voteState: 'none' } })], createContext());

  const dislike = document.getElementById('subpal-endscreen-panel').querySelector('.subpal-endscreen-dislike-btn');
  dislike.dispatchEvent({ type: 'click', target: dislike, preventDefault: () => {}, stopPropagation: () => {} });
  resolveAction({ status: 'success' });
  await Promise.resolve();
  await Promise.resolve();

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const unselectedLike = panelEl.querySelector('.subpal-endscreen-like-btn');
  const selectedDislike = panelEl.querySelector('.subpal-endscreen-dislike-btn');
  assert.equal(unselectedLike.getAttribute('aria-pressed'), 'false');
  assert.equal(selectedDislike.getAttribute('aria-pressed'), 'true');
  assert.equal(selectedDislike.style.backgroundColor, 'var(--color-danger-bg, rgba(239, 68, 68, 0.1))');
  assert.equal(selectedDislike.style.border, '1px solid var(--vote-dislike-fg, #f87171)');
  assert.ok(panelEl.querySelector('.subpal-endscreen-action-status').textContent.includes('不喜歡'));
});

test('Given a visible panel When its CTA is clicked Then onAction receives the displayed task and context without closing', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();
  const context = createContext();
  let received = null;
  panel.onAction((payload) => { received = payload; });

  panel.show([task], context);
  const ctaBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-cta-btn');
  ctaBtn.dispatchEvent({ type: 'click', target: ctaBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.equal(received.intent, 'submit-improvement', 'CTA 應傳遞明確行動意圖');
  assert.equal(received.task, task, 'CTA 應傳遞目前任務');
  assert.equal(received.context, context, 'CTA 應傳遞播放上下文');
  assert.equal(panel.isVisible, true, '展示性 CTA 不應關閉面板');
});

test('Given a visible panel When its current status is queried Then it reports initialized visibility and task count', async () => {
  const Panel = await loadPanel();
  const { panel } = await createHarness(Panel);

  panel.show([createOfficialTask(), createCandidateTask()], createContext());

  const status = panel.getStatus();
  assert.equal(status.isInitialized, true, '狀態應顯示已初始化');
  assert.equal(status.isVisible, true, '狀態應顯示可見');
  assert.equal(status.hasContainer, true, '狀態應顯示有容器');
  assert.equal(status.taskCount, 2, '狀態應顯示任務數');
});

test('Given a visible panel When skip button is clicked Then the panel hides and onSkip callback fires', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let skipCalled = false;
  panel.onSkip(() => { skipCalled = true; });

  panel.show([createOfficialTask()], createContext());
  const skipBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-skip-btn');

  skipBtn.dispatchEvent({ type: 'click', target: skipBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.ok(skipCalled, 'skip 回調應被觸發');
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'skip 後面板應隱藏');
});

test('Given multiple visible tasks When skip is clicked Then it advances exactly one task and only the final skip closes', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const skipped = [];
  let dismissed = 0;
  panel.onSkip((payload) => { skipped.push(payload); });
  panel.onDismiss(() => { dismissed += 1; });
  const firstTask = createOfficialTask();
  const secondTask = createCandidateTask();

  panel.show([firstTask, secondTask], createContext());
  let skipBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-skip-btn');
  skipBtn.dispatchEvent({ type: 'click', target: skipBtn, preventDefault: () => {}, stopPropagation: () => {} });

  let panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl, '非最後一項略過後應保留面板');
  assert.equal(panelEl.querySelector('.subpal-endscreen-timecode').textContent, secondTask.timecode,
    '略過後應重繪下一項任務');
  assert.equal(skipped.length, 1, '每次略過應只發出一個意圖');
  assert.equal(skipped[0].task, firstTask, '略過意圖應指出被略過的任務');

  skipBtn = panelEl.querySelector('.subpal-endscreen-skip-btn');
  skipBtn.dispatchEvent({ type: 'click', target: skipBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.equal(document.getElementById('subpal-endscreen-panel'), null, '最後一項略過後應關閉面板');
  assert.equal(skipped.length, 2, '最後一項略過仍應只額外發出一個意圖');
  assert.equal(skipped[1].task, secondTask, '最後略過意圖應指出最後任務');
  assert.equal(dismissed, 2, '略過與任務前進都應通知擁有者取消進行中的動作');
});

test('Given an opt-out request When the confirmation opens Then it is a blocking dialog with initial cancel focus and safe Escape/outside behavior', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let callbackCount = 0;
  panel.onOptOut(() => { callbackCount += 1; });
  panel.show([createOfficialTask()], createContext());
  const panelEl = document.getElementById('subpal-endscreen-panel');
  const optOutBtn = panelEl.querySelector('.subpal-endscreen-opt-out-btn');
  optOutBtn.dispatchEvent({ type: 'click', target: optOutBtn, preventDefault: () => {}, stopPropagation: () => {} });

  const overlay = document.body.querySelector('.subpal-endscreen-opt-out-overlay');
  const dialog = document.body.querySelector('.subpal-endscreen-opt-out-dialog');
  assert.ok(overlay, '應有阻擋式 overlay');
  assert.ok(dialog, '應有獨立確認 dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog', '確認應使用 dialog 語意');
  assert.equal(dialog.getAttribute('aria-modal'), 'true', '確認應標示為 modal');
  assert.equal(dialog.style.zIndex, '999999', 'dialog 應高於 overlay');
  assert.equal(overlay.style.zIndex, '999998', 'overlay 應位於 dialog 下方');
  assert.equal(dialog.style.fontFamily, CJK_UI_FONT_STACK, 'dialog 應共用面板 CJK UI 字型堆疊');
  assert.equal(dialog.style.boxSizing, 'border-box', 'dialog 寬度應包含內距與邊框');
  assert.equal(dialog.style.width, 'min(450px, calc(100vw - 32px))', 'dialog 應受視窗寬度限制');
  const cancelBtn = dialog.querySelector('.subpal-endscreen-opt-out-cancel-btn');
  const confirmBtn = dialog.querySelector('.subpal-endscreen-opt-out-confirm-btn');
  assert.equal(cancelBtn._focused, true, '初始焦點應在取消按鈕');
  assert.equal(confirmBtn.style.backgroundColor, 'var(--color-accent, #10b981)', '確認按鈕應使用肯定色主樣式');
  assert.equal(confirmBtn.style.color, '#fff', '確認按鈕應使用白色文字');
  assert.equal(confirmBtn.style.fontFamily, 'inherit', '確認按鈕應繼承 dialog 字型');
  assert.equal(cancelBtn.style.color, 'rgba(255, 255, 255, 0.6)', '安靜取消按鈕應使用 muted 文字色');
  assert.equal(cancelBtn.style.fontFamily, 'inherit', '取消按鈕應繼承 dialog 字型');

  let dialogClickStopped = false;
  dialog.dispatchEvent({ type: 'click', target: dialog, preventDefault: () => {}, stopPropagation: () => { dialogClickStopped = true; } });
  assert.equal(dialogClickStopped, true, 'dialog 點擊不得冒泡至播放器');

  let tabPrevented = false;
  document.dispatchEvent({ type: 'keydown', key: 'Tab', preventDefault: () => { tabPrevented = true; }, stopPropagation: () => {} });
  assert.equal(tabPrevented, true, 'Tab 應被 dialog 攔截');
  assert.equal(confirmBtn._focused, true, 'Tab 應將焦點循環至確認按鈕');

  let shiftTabPrevented = false;
  document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true, preventDefault: () => { shiftTabPrevented = true; }, stopPropagation: () => {} });
  assert.equal(shiftTabPrevented, true, 'Shift+Tab 應被 dialog 攔截');
  assert.equal(cancelBtn._focused, true, 'Shift+Tab 應將焦點循環回取消按鈕');

  overlay.dispatchEvent({ type: 'click', target: overlay, preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(callbackCount, 0, '點擊外部不得持久化偏好');
  assert.ok(document.body.querySelector('.subpal-endscreen-opt-out-dialog'), '外部點擊不得默默關閉確認');

  document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(callbackCount, 0, 'Escape 取消不得發出 opt-out 回調');
  assert.equal(document.body.querySelector('.subpal-endscreen-opt-out-overlay'), null, 'Escape 應清理 overlay');
  assert.equal(optOutBtn._focused, true, 'Escape 關閉後應將焦點還給啟動控制項');
});

test('Given an opt-out confirmation When confirmation events are synthetic or trusted Then only a trusted event emits once and exposes pending/failure state', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();
  const context = createContext();
  const payloads = [];
  panel.onOptOut((payload) => { payloads.push(payload); });
  panel.show([task], context);
  const optOutBtn = document.getElementById('subpal-endscreen-panel').querySelector('.subpal-endscreen-opt-out-btn');
  optOutBtn.dispatchEvent({ type: 'click', target: optOutBtn, preventDefault: () => {}, stopPropagation: () => {} });

  const syntheticConfirmBtn = document.body.querySelector('.subpal-endscreen-opt-out-confirm-btn');
  syntheticConfirmBtn.dispatchEvent({ type: 'click', target: syntheticConfirmBtn, preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(payloads.length, 0, '合成 click 不得確認永久偏好');

  panel.handleOptOutConfirm({ isTrusted: true });
  panel.handleOptOutConfirm({ isTrusted: true });
  assert.equal(payloads.length, 1, '受信任確認只能發出一次意圖');
  assert.equal(payloads[0].intent, 'opt-out-endscreen-tasks', '確認應發出 opt-out 意圖');
  assert.equal(payloads[0].task, task, '意圖應保留目前任務');
  assert.equal(payloads[0].context, context, '意圖應保留播放上下文');
  assert.equal(panel.getStatus().optOutState, 'pending', '受信任確認後應暴露 pending 狀態');
  payloads[0].setFailure();
  assert.equal(panel.getStatus().optOutState, 'error', 'isolated owner 應可回報失敗狀態');
  const errorEl = document.body.querySelector('.subpal-endscreen-opt-out-error');
  assert.ok(errorEl, '失敗時應顯示錯誤回饋');
  assert.equal(errorEl.getAttribute('role'), 'alert', '錯誤應立即通知螢幕閱讀器');
  assert.ok(errorEl.textContent.includes('無法儲存設定'), '錯誤文案應以繁體中文說明可重試');
  assert.equal(document.body.querySelector('.subpal-endscreen-opt-out-confirm-btn').disabled, false,
    '失敗後確認按鈕應恢復以允許重試');
});

test('Given an open opt-out confirmation When cleanup runs Then its overlay and document listeners are removed', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  panel.show([createOfficialTask()], createContext());
  const optOutBtn = document.getElementById('subpal-endscreen-panel').querySelector('.subpal-endscreen-opt-out-btn');
  optOutBtn.dispatchEvent({ type: 'click', target: optOutBtn, preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(document.body.listeners.get('keydown').length, 1, '確認應註冊一個 Escape listener');

  panel.cleanup();

  assert.equal(document.body.querySelector('.subpal-endscreen-opt-out-overlay'), null, 'cleanup 應移除 overlay');
  assert.equal(document.body.listeners.get('keydown').length, 0, 'cleanup 應移除 Escape listener');
  assert.equal(panel.confirmationOverlay, null, 'cleanup 應清除 overlay 參考');
  assert.equal(panel.confirmationDialog, null, 'cleanup 應清除 dialog 參考');
  assert.equal(panel.confirmationKeydownHandler, null, 'cleanup 應清除鍵盤處理器參考');
});

test('Given a visible panel When it rerenders Then its container has exactly one propagation listener', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  panel.show([createOfficialTask()], createContext());
  panel.setActionState('loading');
  panel.setActionState('idle');

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.equal(panelEl.listeners.get('click').length, 1, 'rerender 不得累積容器 click listener');
});

test('Given a visible panel When opt-out is cancelled Then it preserves the current task without invoking the callback', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const task = createOfficialTask();
  let callbackCount = 0;
  panel.onOptOut(() => { callbackCount += 1; });
  panel.show([task], createContext());
  const optOutBtn = document.getElementById('subpal-endscreen-panel').querySelector('.subpal-endscreen-opt-out-btn');
  optOutBtn.dispatchEvent({ type: 'click', target: optOutBtn, preventDefault: () => {}, stopPropagation: () => {} });
  const cancelBtn = document.body.querySelector('.subpal-endscreen-opt-out-cancel-btn');
  cancelBtn.dispatchEvent({ type: 'click', target: cancelBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.equal(callbackCount, 0, '取消不得發出 opt-out 意圖');
  assert.equal(document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-timecode').textContent, `跳至 ${task.timecode}`, '取消不得變更目前任務');
  assert.equal(optOutBtn._focused, true, '取消後應將焦點還給啟動控制項');
});

test('Given a visible panel When deterministic action states are set Then primary controls expose idle, loading, disabled, success, and error seams', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  assert.equal(panel.getActionState(), 'idle', '預設行動狀態應為 idle');

  for (const state of ['loading', 'disabled', 'success', 'error', 'idle']) {
    panel.setActionState(state);
    assert.equal(panel.getActionState(), state, `應可決定性地設定 ${state} 狀態`);
  }

  panel.setActionState('loading');
  const ctaBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-cta-btn');
  assert.equal(ctaBtn.disabled, true, 'loading 時主行動應停用以避免重複意圖');
  const loadingStatus = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-action-status');
  assert.equal(loadingStatus.getAttribute('role'), 'status', 'loading 應通知輔助科技');
  assert.ok(loadingStatus.textContent.includes('處理'), 'loading 應提供可見處理中提示');
  assert.equal(panel.getStatus().actionState, 'loading', '狀態 API 應提供目前行動狀態');
});

test('Given an injected initialized debug config source When its value changes Then visible rank reasons rerender and the subscription disposes', async () => {
  const Panel = await loadPanel();
  const callbacks = new Set();
  let debugMode = true;
  let unsubscribeCalls = 0;
  const configSource = {
    get: () => debugMode,
    subscribe: (_key, callback) => {
      callbacks.add(callback);
      return () => {
        unsubscribeCalls += 1;
        callbacks.delete(callback);
      };
    }
  };
  const { panel, document } = await createHarness(Panel, { configSource });
  const task = createOfficialTask({ rankReasons: ['debug-reason'] });

  panel.show([task], createContext());
  assert.ok(document.getElementById('subpal-endscreen-panel').querySelector('.subpal-endscreen-rank-context'),
    '注入來源的初始 debug 值應顯示排序原因');

  debugMode = false;
  for (const callback of callbacks) callback(false);
  assert.equal(document.getElementById('subpal-endscreen-panel').querySelector('.subpal-endscreen-rank-context'), null,
    'debug 設定變更後可見面板應立即重繪');

  panel.cleanup();
  assert.equal(unsubscribeCalls, 1, 'cleanup 應釋放注入來源訂閱');
});

test('Given a visible panel When close button is clicked Then the panel hides and onClose callback fires', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let closeCalled = false;
  let dismissCalled = false;
  panel.onClose(() => { closeCalled = true; });
  panel.onDismiss(() => { dismissCalled = true; });

  panel.show([createOfficialTask()], createContext());
  const closeBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-close-btn');

  closeBtn.dispatchEvent({ type: 'click', target: closeBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.ok(closeCalled, 'close 回調應被觸發');
  assert.ok(dismissCalled, 'close 回調應通知擁有者取消進行中的動作');
  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'close 後面板應隱藏');
});

test('Given a visible panel When not-now button is clicked Then the panel hides', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  let dismissCalled = false;
  panel.onDismiss(() => { dismissCalled = true; });

  panel.show([createOfficialTask()], createContext());
  const notNowBtn = document.getElementById('subpal-endscreen-panel')
    .querySelector('.subpal-endscreen-not-now-btn');

  notNowBtn.dispatchEvent({ type: 'click', target: notNowBtn, preventDefault: () => {}, stopPropagation: () => {} });

  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'not-now 後面板應隱藏');
  assert.ok(dismissCalled, 'not-now 回調應通知擁有者取消進行中的動作');
});

test('Given a panel instance When show is called Then the panel has accessible aria labels', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl.getAttribute('role') === 'dialog' || panelEl.getAttribute('role') === 'region',
    '面板應有 role 屬性');
  assert.ok(panelEl.getAttribute('aria-label'),
    '面板應有 aria-label');

  const closeBtn = panelEl.querySelector('.subpal-endscreen-close-btn');
  assert.ok(closeBtn.getAttribute('aria-label'),
    'close 按鈕應有 aria-label');
  assert.equal(closeBtn.style.fontFamily, 'inherit', 'close 按鈕應繼承面板 CJK 字型');
});

test('Given a panel instance When show is called with multiple tasks Then it renders the first task and shows count context', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const tasks = [createOfficialTask(), createCandidateTask()];

  panel.show(tasks, createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  const countEl = panelEl.querySelector('.subpal-endscreen-task-count');
  assert.ok(countEl, '應有任務計數元素');
  assert.ok(countEl.textContent.includes('2'), '應顯示任務總數 2');
});

test('Given a panel instance When cleanup is called Then all state is cleared and DOM is removed', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);

  panel.show([createOfficialTask()], createContext());
  panel.cleanup();

  assert.equal(document.getElementById('subpal-endscreen-panel'), null, 'cleanup 後面板應從 DOM 移除');
  assert.equal(panel.isVisible, false, 'cleanup 後 isVisible 應為 false');
});

test('Given an initialized panel When cleanup and restart occur Then the old ConfigBridge subscription is released once', async () => {
  const configBridge = createTrackedConfigBridge();
  const Panel = await loadPanel({ configBridge });
  const document = new FakeDocument();
  document.defaultView = {};
  const panel = new Panel({ document });

  await panel.initialize();
  assert.equal(configBridge.activeSubscriptionCount, 1, '初始化後應有一個配置訂閱');

  panel.cleanup();
  panel.cleanup();
  assert.equal(configBridge.activeSubscriptionCount, 0, 'cleanup 後舊配置訂閱應被釋放');
  assert.equal(configBridge.unsubscribeCalls, 1, '重複 cleanup 不應重複取消同一訂閱');

  await panel.initialize();
  assert.equal(configBridge.subscribeCalls, 2, 'restart 應建立新的配置訂閱');
  assert.equal(configBridge.activeSubscriptionCount, 1, 'restart 後只應保留新的配置訂閱');

  configBridge.emit(true);
  assert.equal(panel.debug, true, '新的配置訂閱應更新面板 debug 狀態');

  panel.cleanup();
  panel.cleanup();
  assert.equal(configBridge.activeSubscriptionCount, 0, '最終 cleanup 應釋放新的配置訂閱');
  assert.equal(configBridge.unsubscribeCalls, 2, '每個生命週期的訂閱只應取消一次');
});

test('Given a panel with malformed task fields When show is called Then it does not crash and renders safely', async () => {
  const Panel = await loadPanel();
  const { panel, document } = await createHarness(Panel);
  const malformed = {
    taskID: null,
    targetType: 'unknown',
    action: null,
    timestamp: null,
    timecode: undefined,
    originalSubtitle: null,
    suggestedSubtitle: undefined,
    rankReasons: null,
    userState: null
  };

  panel.show([malformed], createContext());

  const panelEl = document.getElementById('subpal-endscreen-panel');
  assert.ok(panelEl, '即使任務欄位不完整，面板仍應安全渲染');
  const originalEl = panelEl.querySelector('.subpal-endscreen-original');
  assert.ok(originalEl, '應有原始字幕元素');
  assert.equal(originalEl.textContent, '', 'null 字幕應渲染為空字串');
});

// ─── 端到端傳遞鏈源碼驗證 ───

test('Given MAIN initialization When inspected Then it owns no task transport or panel event bridge', async () => {
  const source = await readFile(new URL('../content/system/initialization-manager.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('EndscreenTaskBridge'));
  assert.ok(!source.includes('dispatchInternalEvent'));
  assert.ok(!source.includes('requestCrowdsourcingTasks'));
});

test('Given the controller When inspected Then it checks contextGeneration before delivering tasks (stale context guard)', async () => {
  const source = await readFile(new URL('../content/core/endscreen-task-controller.js', import.meta.url), 'utf8');
  assert.ok(source.includes('generation !== this.contextGeneration'),
    '控制器應在呼叫 onTasks 前檢查 contextGeneration，防止過時 context 的任務被送達');
});
