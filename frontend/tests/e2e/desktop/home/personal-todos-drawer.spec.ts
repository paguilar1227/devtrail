// The Home personal-todos column shows the top 6; clicking the
// expand button opens a drawer with the full list. Pinned: the button
// only appears when there are >6 todos, the drawer reuses the shared
// Drawer primitive (so role="dialog" + Close + the 'Expand drawer'
// affordance show up for free), and clicking a row inside hands off
// to the existing TodoDetailDrawer.
import { expect, test } from '@playwright/test';
import '../../helpers/setup';

test('home personal todos: expand button opens a drawer with the full list', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  // Seed has 10 personal todos; column shows 6, expand button is visible.
  const expand = page.locator('.home-personal-grid .pcol').filter({ has: page.locator('h3:text-is("Todos")') })
    .locator('.pcol-expand');
  await expect(expand).toBeVisible();
  await expand.click();

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });

  // Title carries the count, and the row count beats what the column shows.
  await expect(drawer).toContainText(/Personal todos · \d+/);
  const colRows = await page.locator('.home-personal-grid .pcol').filter({ has: page.locator('h3:text-is("Todos")') })
    .locator('.prow-todo').count();
  const drawerRows = await drawer.locator('.prow-todo').count();
  expect(drawerRows).toBeGreaterThan(colRows);

  // Close dismisses cleanly.
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toHaveCount(0);
});
