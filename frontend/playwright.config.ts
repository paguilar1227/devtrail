import { defineConfig, devices } from '@playwright/test';

const FRONTEND_PORT = 5173;
const BACKEND_PORT = 3001;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
const BACKEND_HEALTH = `http://localhost:${BACKEND_PORT}/health`;
const BASE_URL = process.env.BASE_URL || FRONTEND_URL;
const isLocal = BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1');

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: isLocal ? './tests/e2e/global-setup.ts' : undefined,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Local runs flake intermittently when the Vite dev server cold-starts a
  // new BrowserContext between specs (we've seen blank-white SPA loads that
  // recover on retry). One retry locally absorbs that without masking real
  // failures — a real bug fails twice and shows up as a hard failure.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  // 30s was too tight in practice — first goto in a fresh BrowserContext can
  // take 10–15s when Vite has to (re-)satisfy the dep graph for the test
  // page, leaving little headroom for the actual assertions. 60s gives the
  // SPA enough time to mount and the downstream interactions still race
  // each other normally.
  timeout: 60_000,
  // 5s missed intermittently on mutation → invalidate → refetch churn
  // (archive a doc, create a section: four query keys refetch behind one
  // spinner) when the host is under load. 10s absorbs that without masking
  // logic failures — a wrong assertion still fails, just a few seconds later.
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // Two profiles. Each project's testMatch restricts it to its own
  // top-level subdir under tests/e2e, so a single `npx playwright test`
  // run executes both profiles sequentially. Tests live with the device
  // class they're written for — viewport is set by the project, not by
  // the test, so individual specs stay device-agnostic.
  projects: [
    {
      name: 'chromium-desktop',
      testMatch: /[\\/]desktop[\\/].*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'chromium-mobile',
      testMatch: /[\\/]mobile[\\/].*\.spec\.ts$/,
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],

  // Two-server bring-up: backend (Hono on 3001) + Vite (5173). globalSetup
  // does docker compose + seed once, then these stay running across the
  // whole test suite. reuseExistingServer is on locally so an already-warm
  // `npm run dev:up` shell short-circuits this.
  webServer: isLocal
    ? [
        {
          command: 'npm run dev:backend',
          cwd: '..',
          url: BACKEND_HEALTH,
          reuseExistingServer: !process.env.CI,
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: 60_000,
        },
        {
          command: 'npm run dev',
          url: FRONTEND_URL,
          reuseExistingServer: !process.env.CI,
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: 60_000,
        },
      ]
    : undefined,
});
