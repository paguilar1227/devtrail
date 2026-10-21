// Guest-only fixture runner. Production-style API/auth + PGlite and Azurite.
import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...base,
  globalSetup: undefined,
  webServer: undefined,
  use: { ...base.use, baseURL: 'http://localhost:5173' },
  projects: [
    ...(base.projects ?? []),
    { name: 'webkit-session', testMatch: /mobile\/sessions\/.*\.spec\.ts$/, use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
