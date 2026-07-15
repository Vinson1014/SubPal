import { existsSync } from 'node:fs';

const ENVIRONMENT_KEYS = ['SUBPAL_CHROMIUM_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', 'CHROME_PATH'];

function resolveChromiumExecutable({ env = process.env, projectExecutablePath, pathExists = existsSync } = {}) {
  for (const key of ENVIRONMENT_KEYS) {
    const candidate = env[key];
    if (!candidate) continue;
    if (pathExists(candidate)) return candidate;
    throw new Error(`Chromium executable from ${key} does not exist: ${candidate}`);
  }

  const projectCandidate = projectExecutablePath?.();
  if (projectCandidate && pathExists(projectCandidate)) return projectCandidate;

  throw new Error('No Chromium executable found. Set SUBPAL_CHROMIUM_PATH or provide Chromium through the project Playwright installation.');
}

export { resolveChromiumExecutable };
