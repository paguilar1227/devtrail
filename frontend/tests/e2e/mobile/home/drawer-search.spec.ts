// Column drawer search on mobile (HOME-M-10) — condensed parity with
// desktop/home/drawer-search.spec.ts: the notes drawer's `#` typeahead and
// free-text hybrid search both work from the fullscreen mobile drawer.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../../helpers/setup';

// Seed contract — same constants the desktop spec pins.
const NOTE_HIT = 'Travel — Lisbon trip ideas';

const col = (page: Page, title: string) =>
  page.locator('.pcol').filter({ has: page.locator(`h3:text-is("${title}")`) });

const searchInput = (scope: Locator) =>
  scope.locator('.todo-list-drawer-toolbar .search-input-wrapper input, .filter-bar .search-box .search-input-wrapper input');

async function openDrawer(page: Page, columnTitle: string): Promise<Locator> {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  const more = col(page, columnTitle).locator('.pcol-more');
  await more.scrollIntoViewIfNeeded();
  await more.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  return drawer;
}

test('notes drawer mobile: # opens the tag typeahead without a search crash', async ({ page }) => {
  const drawer = await openDrawer(page, 'Notes');
  const fetchPromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/search') && r.request().method() === 'POST',
    { timeout: 6000 },
  );
  await searchInput(drawer).fill('#');
  await expect(page.locator('.typeahead-popover')).toBeVisible({ timeout: 3000 });
  await fetchPromise;
  await expect(drawer.locator('.search-drawer-error')).toHaveCount(0);
});

test('notes drawer mobile: free-text hybrid search returns note rows; clearing restores browse', async ({ page }) => {
  const drawer = await openDrawer(page, 'Notes');
  const fetchPromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/search') && r.request().method() === 'POST',
    { timeout: 6000 },
  );
  await searchInput(drawer).fill('travel');
  await fetchPromise;
  await expect(drawer.locator('.prow', { hasText: NOTE_HIT })).toBeVisible();
  await expect(drawer.locator('.search-drawer-error')).toHaveCount(0);

  await searchInput(drawer).fill('');
  await expect(drawer.locator('.prow').first()).toBeVisible();
});
