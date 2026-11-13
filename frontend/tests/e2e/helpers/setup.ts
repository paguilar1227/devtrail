// Shared per-test setup/teardown for every spec file.
//
// ⚠️ Import `test` (and `expect`) FROM THIS MODULE, never from
// '@playwright/test' directly. The old pattern — a side-effect
// `test.beforeEach(...)` registered when this module loads — silently broke
// at every spec-FILE transition: Playwright caches helper modules per
// worker, so the side effect only ran for the first file a worker loaded.
// Every subsequent file got NO hooks — its first test started on
// about:blank, stared at a blank page for the full timeout, "flaked", and
// only passed on retry because the failure forced a fresh worker (which
// re-evaluated this module). That was the long-parked "~26 flaky specs"
// mystery. Fixtures don't have that failure mode: they're bound to the
// `test` object itself, so they run for every test in every file
// regardless of module caching.
//
// The page fixture below:
//   1. Forces the sidebar to 'expanded' before the SPA mounts (default is
//      'collapsed', which hides .label spans and breaks text selectors).
//   2. Navigates to '/' and waits for the SPA to be interactive.
//   3. After the test: sweeps anything created with the `e2e:` prefix.
//      Hard-deletes (?hard=true) so the next test starts clean.

import { test as base, expect, type Page } from '@playwright/test';
import {
  deleteContent,
  deleteProject,
  deleteTodo,
  listContent,
  listProjects,
  listTodos,
} from './api';
import { waitForAppReady } from './utils';

export const E2E_PREFIX = 'e2e:';
export const stamp = (): string =>
  `${E2E_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export const SIDEBAR = 'aside.sidebar';
export const TABBAR = 'nav.mobile-tabbar';
export const MORE_SHEET = '.m-sheet';

export const navTo = (page: Page, label: string) =>
  page.locator(`${SIDEBAR} .sb-item:has(.label:text-is("${label}"))`).click();

export const projectTo = (page: Page, name: string) =>
  page.locator(`${SIDEBAR} .sb-projects .sb-item:has(.label:text-is("${name}"))`).click();

/** Mobile: open the More bottom-sheet from the tabbar. Specs that act on
 *  rows inside the sheet use this so the tap-More dance isn't repeated. */
export const openMoreSheet = async (page: Page) => {
  await page.locator(`${TABBAR} .mtab`, { hasText: 'More' }).click();
  await page.locator(MORE_SHEET).waitFor({ state: 'visible' });
};

async function sweepE2eFixtures(): Promise<void> {
  // Cleanup must never fail a test: the list calls themselves can throw on a
  // transient backend hiccup, so each sweep phase is guarded — a missed
  // sweep is recovered by the next test's teardown anyway.
  try {
    for (const p of await listProjects()) {
      if (p.name.startsWith(E2E_PREFIX)) {
        try { await deleteProject(p.id); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore — retried by the next teardown */ }
  try {
    for (const t of await listTodos()) {
      if (t.content.startsWith(E2E_PREFIX)) {
        try { await deleteTodo(t.id); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  try {
    for (const c of await listContent()) {
      if (c.title.startsWith(E2E_PREFIX)) {
        try { await deleteContent(c.id); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

export const test = base.extend({
  page: async ({ page }, use) => {
    // E2E_DEBUG=1: surface the page's own signals (errors, crashes, reloads,
    // console) on the runner's stdout — kept from the blank-page hunt.
    if (process.env.E2E_DEBUG) {
      page.on('pageerror', (err) => console.log(`[page:error] ${err.message}`));
      page.on('crash', () => console.log('[page:CRASH]'));
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) console.log(`[page:nav] ${f.url()}`);
      });
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.log(`[page:${m.type()}] ${m.text().slice(0, 200)}`);
      });
      page.on('requestfailed', (r) => console.log(`[page:reqfail] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
    }

    await page.addInitScript(() => {
      window.localStorage.setItem('devtrail.sidebarMode', 'expanded');
    });
    await page.goto('/');
    await waitForAppReady(page);

    await use(page);

    // Teardown always runs, pass or fail — the sweep can't be skipped by a
    // mid-test failure the way an afterEach in a hook-less file could be.
    await sweepE2eFixtures();
  },
});

export { expect };
