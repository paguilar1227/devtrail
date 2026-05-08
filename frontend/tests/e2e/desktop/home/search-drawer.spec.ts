// Search drawer end-to-end. Pinned behaviors:
//   1. Typing in the Home search row + Enter opens the drawer with the
//      query already submitted, results render.
//   2. The Sidebar Search row opens the drawer empty, ready for input.
//   3. Closing the drawer dismisses it cleanly.
// The drawer reuses the shared Drawer primitive — its expand toggle and
// mobile fullscreen are already covered by drawer-expand.spec.ts and
// mobile/home/drawer-fullscreen.spec.ts; this spec is about the search-
// specific wiring.

import { expect, test } from '@playwright/test';
import { navTo } from '../../helpers/setup';

test('search drawer: Home search row submits into the drawer with results', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  // 'retrieval' is a tag and a substring across multiple seeded items —
  // hits should be > 0.
  await page.locator('.home-search-box input').fill('retrieval');
  await page.locator('.home-search-box input').press('Enter');

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await expect(drawer).toContainText('Search');
  await expect(drawer.locator('.search-drawer-input input')).toHaveValue('retrieval');

  // Wait for the search query to resolve, then assert at least one hit.
  await expect(drawer.locator('.search-hit').first()).toBeVisible({ timeout: 15000 });
  await expect(drawer.locator('.results-count')).toContainText(/\d+ results/);

  // Close dismisses the drawer.
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toHaveCount(0);
});

test('search drawer: Sidebar Search row opens an empty drawer', async ({ page }) => {
  await navTo(page, 'Search');
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  // Empty default state — input is focused with no value.
  await expect(drawer.locator('.search-drawer-input input')).toHaveValue('');
  await expect(drawer).toContainText('Type a query and press Enter');
});
