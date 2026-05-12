// Search drawer end-to-end. Pinned behavior: typing in the Home search row
// + Enter opens the drawer with the query already submitted, results render,
// and Close dismisses it. The drawer reuses the shared Drawer primitive —
// expand toggle and mobile fullscreen are already covered by
// drawer-expand.spec.ts and mobile/home/drawer-fullscreen.spec.ts.

import { expect, test } from '@playwright/test';
// Side-effect import: attaches the standard beforeEach (navigate + wait for
// SPA ready) and afterEach (e2e:-prefixed cleanup). Required even if no
// helper symbols are pulled from this module.
import '../../helpers/setup';

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

