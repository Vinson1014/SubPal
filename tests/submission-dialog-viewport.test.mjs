import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve, sep } from 'node:path';

import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './chromium-executable.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const chromiumPath = resolveChromiumExecutable({ projectExecutablePath: () => chromium.executablePath() });

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const filePath = resolve(projectRoot, `.${pathname}`);
    if (!filePath.startsWith(`${projectRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': filePath.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test('Given a 390px viewport When the production submission dialog opens Then it keeps a 16px horizontal safe margin and usable controls', async () => {
  const { server, url } = await startStaticServer();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${url}/tests/fixtures/submission-dialog-viewport.html`);
    await page.waitForFunction(() => Boolean(window.__submissionDialogViewport?.isOpen));

    const bounds = await page.evaluate(() => {
      const rect = (selector) => {
        const { left, right } = document.querySelector(selector).getBoundingClientRect();
        return { left, right };
      };
      return {
        dialog: rect('#subpal-translation-floating-window'),
        translation: rect('#translation-input'),
        reason: rect('#reason-input'),
        cancel: rect('#cancel-translation'),
        submit: rect('#submit-translation'),
        width: window.innerWidth
      };
    });

    assert.ok(bounds.dialog.left >= 16, JSON.stringify(bounds));
    assert.ok(bounds.dialog.right <= bounds.width - 16, JSON.stringify(bounds));
    for (const control of [bounds.translation, bounds.reason, bounds.cancel, bounds.submit]) {
      assert.ok(control.left >= bounds.dialog.left, JSON.stringify(bounds));
      assert.ok(control.right <= bounds.dialog.right, JSON.stringify(bounds));
    }
    const semantics = await page.evaluate(() => {
      const dialog = document.querySelector('#subpal-translation-floating-window');
      const heading = document.querySelector('#submission-dialog-title');
      const languageLabel = document.querySelector('label[for="language-display"]');
      const languageDisplay = document.querySelector('#language-display');
      return {
        role: dialog.getAttribute('role'),
        modal: dialog.getAttribute('aria-modal'),
        labelledBy: dialog.getAttribute('aria-labelledby'),
        headingId: heading?.id ?? null,
        languageFor: languageLabel?.htmlFor ?? null,
        languageTag: languageDisplay?.tagName ?? null,
        languageLabels: languageDisplay?.labels ? [...languageDisplay.labels].map((label) => label.htmlFor) : []
      };
    });
    assert.equal(semantics.role, 'dialog');
    assert.equal(semantics.modal, 'true');
    assert.equal(semantics.labelledBy, semantics.headingId);
    assert.equal(semantics.languageFor, 'language-display');
    assert.equal(semantics.languageTag, 'OUTPUT');
    assert.deepEqual(semantics.languageLabels, ['language-display']);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('Given a 1440px viewport When the production submission dialog opens Then it retains its 450px desktop width', async () => {
  const { server, url } = await startStaticServer();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${url}/tests/fixtures/submission-dialog-viewport.html`);
    await page.waitForFunction(() => Boolean(window.__submissionDialogViewport?.isOpen));
    const width = await page.locator('#subpal-translation-floating-window').evaluate((element) => element.getBoundingClientRect().width);
    assert.equal(width, 450);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('Given hostile subtitle text and a failed queue When the production dialog submits Then text stays inert and the dialog is retryable', async () => {
  const { server, url } = await startStaticServer();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${url}/tests/fixtures/submission-dialog-viewport.html`);
    await page.waitForFunction(() => Boolean(window.__submissionDialogViewport?.isOpen));
    await page.evaluate(async () => {
      const dialog = window.__submissionDialogViewport;
      const payload = '</textarea><img src=x onerror="window.__xss = 1">';
      window.__xss = 0;
      dialog.close();
      await dialog.open({
        videoId: 'netflix-81234567',
        timestamp: 124.5,
        original: payload,
        text: payload,
        slotKey: null
      });
      document.querySelector('#reason-input').value = '測試失敗後可重試';
      dialog.onSubmit(() => Promise.resolve({ status: 'error', error: 'queue unavailable' }));
      document.querySelector('#submit-translation').click();
    });
    await page.waitForFunction(() => document.querySelector('#submission-error')?.textContent === 'queue unavailable');
    const state = await page.evaluate(() => {
      const dialog = window.__submissionDialogViewport;
      return {
        xss: window.__xss,
        images: document.querySelectorAll('#subpal-translation-floating-window img').length,
        original: document.querySelector('#original-text').value,
        translation: document.querySelector('#translation-input').value,
        open: dialog.isOpen,
        submitDisabled: document.querySelector('#submit-translation').disabled,
        cancelDisabled: document.querySelector('#cancel-translation').disabled,
        error: document.querySelector('#submission-error').textContent
      };
    });

    assert.deepEqual(state, {
      xss: 0,
      images: 0,
      original: '</textarea><img src=x onerror="window.__xss = 1">',
      translation: '</textarea><img src=x onerror="window.__xss = 1">',
      open: true,
      submitDisabled: false,
      cancelDisabled: false,
      error: 'queue unavailable'
    });
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('Given a dialog open that is interrupted by cleanup When it settles Then it does not throw or leave DOM behind', async () => {
  const { server, url } = await startStaticServer();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${url}/tests/fixtures/submission-dialog-viewport.html`);
    await page.waitForFunction(() => Boolean(window.__submissionDialogViewport?.isOpen));

    const state = await page.evaluate(async () => {
      window.__submissionDialogViewport.cleanup();
      const dialog = new window.__SubmissionDialog();
      dialog.isInitialized = true;
      dialog.configBridge = { get: () => 'zh-Hant' };
      const opening = dialog.open({
        videoId: 'netflix-81234567',
        timestamp: 124.5,
        original: 'Original',
        text: 'Translation',
        slotKey: null
      });
      dialog.cleanup();
      await opening;
      return {
        isOpen: dialog.isOpen,
        dialogNodes: document.querySelectorAll('#subpal-translation-floating-window').length,
        overlayNodes: document.querySelectorAll('#subpal-translation-overlay').length
      };
    });

    assert.deepEqual(state, { isOpen: false, dialogNodes: 0, overlayNodes: 0 });
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('Given a pending queue callback When the dialog submit settles Then it stays disabled until success and closes only after success', async () => {
  const { server, url } = await startStaticServer();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${url}/tests/fixtures/submission-dialog-viewport.html`);
    await page.waitForFunction(() => Boolean(window.__submissionDialogViewport?.isOpen));

    const state = await page.evaluate(async () => {
      const dialog = window.__submissionDialogViewport;
      document.querySelector('#translation-input').value = 'Retained translation';
      document.querySelector('#reason-input').value = '保留表單內容';
      let resolveQueue;
      dialog.onSubmit(() => new Promise((resolve) => { resolveQueue = resolve; }));
      const submit = dialog.handleSubmit();
      await Promise.resolve();
      const pending = {
        isOpen: dialog.isOpen,
        submitDisabled: document.querySelector('#submit-translation').disabled,
        cancelDisabled: document.querySelector('#cancel-translation').disabled,
        translation: document.querySelector('#translation-input').value,
        reason: document.querySelector('#reason-input').value
      };
      resolveQueue({ status: 'success' });
      await submit;
      return { pending, closedAfterSuccess: !dialog.isOpen };
    });

    assert.deepEqual(state, {
      pending: {
        isOpen: true,
        submitDisabled: true,
        cancelDisabled: true,
        translation: 'Retained translation',
        reason: '保留表單內容'
      },
      closedAfterSuccess: true
    });
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
