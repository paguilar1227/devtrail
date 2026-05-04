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
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
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
