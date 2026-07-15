import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveChromiumExecutable } from './chromium-executable.mjs';

test('Given an explicit Chromium environment override When it exists Then the resolver uses it before project tooling', () => {
  let projectCalls = 0;
  const executable = resolveChromiumExecutable({
    env: { SUBPAL_CHROMIUM_PATH: '/portable/chromium' },
    projectExecutablePath: () => {
      projectCalls += 1;
      return '/project/chromium';
    },
    pathExists: (candidate) => candidate === '/portable/chromium'
  });

  assert.equal(executable, '/portable/chromium');
  assert.equal(projectCalls, 0);
});

test('Given no environment override When project Playwright provides Chromium Then the resolver uses the current-host executable', () => {
  const executable = resolveChromiumExecutable({
    env: {},
    projectExecutablePath: () => '/project/chromium',
    pathExists: (candidate) => candidate === '/project/chromium'
  });

  assert.equal(executable, '/project/chromium');
});

test('Given no available Chromium When resolution runs Then it fails with a controlled setup error', () => {
  assert.throws(
    () => resolveChromiumExecutable({
      env: {},
      projectExecutablePath: () => '/missing/chromium',
      pathExists: () => false
    }),
    /No Chromium executable found\. Set SUBPAL_CHROMIUM_PATH/
  );
});
