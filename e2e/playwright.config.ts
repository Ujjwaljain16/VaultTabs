import { defineConfig } from '@playwright/test';

/**
 * End-to-end suite: real backend + Postgres, real PWA, and two Chromium profiles with the real
 * extension. Run from the repo root with `npm run test:e2e` (needs a local Postgres: E2E_PG_URL,
 * default postgres://postgres@127.0.0.1:55432/postgres). E2E_HEADED=1 shows the browsers.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // One backend, one database and fixed ports: spec files run one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
