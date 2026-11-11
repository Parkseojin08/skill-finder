// E2E tests of the screens (`npm run build && npm run e2e`): the built app in a real browser, against a server with
// a fixed index and no network (e2e/server/launch.ts). They guard what unit tests cannot see: that the page is styled
// (the CSS layer order broke every screen on 2026-11-05 while all tests passed), that the main flows work, and that
// the screens stay accessible.
import { defineConfig } from '@playwright/test';
import { BASE_URL, BLACKHOLE } from './e2e/support/env.ts';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',
  // one server for all tests, with one index, search log and offline state: one test at a time, in file order
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // generous: the PC may be busy with other work; waits end as soon as their condition holds
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    // the browser installed on the PC (nothing is downloaded): Edge on Windows, Chrome elsewhere; PW_CHANNEL picks another
    channel: process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome'),
    locale: 'ko-KR',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The browser has no way out either: everything but this PC's own addresses (which Chromium never sends to a
    // proxy) goes to a closed port. The page's own requests stay on 127.0.0.1 anyway (the app's CSP); this covers
    // what the browser itself might fetch, such as a translation model.
    launchOptions: { args: [`--proxy-server=${BLACKHOLE}`] },
  },
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning e2e/server/launch.ts',
    url: BASE_URL,
    // never a server someone left running: its index and offline state would not be the fixed ones
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
