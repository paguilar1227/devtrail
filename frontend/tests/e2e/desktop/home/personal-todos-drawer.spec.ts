// Home personal-todos column behaviors:
//   - Shows top 6 sorted (pinned > active > done; subtasks under parent).
//   - When count > 6, a "View N more" footer row links to the drawer.
//   - The drawer reuses the shared <Drawer/> primitive (role=dialog,
//     Close button, expand-to-center toggle).
//   - Done todos render with strikethrough on the title.
//   - Subtasks render at depth=1 (indented).
//   - Comment counts surface as a tiny badge on the row.
//
// The seed deliberately exercises every case so these assertions can
// run against the same fixture used by humans clicking around.

import { expect, test } from '@playwright/test';
import '../../helpers/setup';

const todosCol = (page: import('@playwright/test').Page) =>
  page.locator('.home-personal-grid .pcol').filter({ has: page.locator('h3:text-is("Todos")') });

test('home personal todos: "View N more" footer opens the drawer with the full list', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  const more = todosCol(page).locator('.pcol-more');
  await expect(more).toBeVisible();
  await expect(more).toContainText(/View \d+ more/);
  await more.click();

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await expect(drawer).toContainText(/Personal todos · \d+/);

  // Drawer holds more rows than the column does (column is sliced).
  const colRows = await todosCol(page).locator('.prow-todo').count();
  const drawerRows = await drawer.locator('.prow-todo').count();
  expect(drawerRows).toBeGreaterThan(colRows);

  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toHaveCount(0);
});

test('home personal todos: pinned parent + subtasks render at depth=1, done is struck through', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  const rows = todosCol(page).locator('.prow-todo');
  await expect(rows.first()).toBeVisible();

  // Seed: 'Plan home office overhaul' is pinned and has 3 subtasks
  // (Pick a standing desk, Order monitor arm, Cable management).
  // Pinned parent must come first; at least one subtask must render
  // immediately after with depth=1.
  await expect(rows.nth(0)).toContainText('Plan home office overhaul');
  await expect(rows.nth(0)).toHaveAttribute('data-depth', '0');
  await expect(rows.nth(1)).toHaveAttribute('data-depth', '1');

  // Order monitor arm is a done subtask — should be in the column with
  // strikethrough (textDecorationLine: line-through).
  const doneSubtask = rows.filter({ hasText: 'Order monitor arm' });
  await expect(doneSubtask).toHaveClass(/prow-done/);
  const td = await doneSubtask.locator('.ti').evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(td).toBe('line-through');
});

test('home personal todos: comment count badge renders when comments exist', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  // 'Plan home office overhaul' has 2 seeded comments — its row should
  // carry a .prow-comments badge with the count "2".
  const planRow = todosCol(page).locator('.prow-todo').filter({ hasText: 'Plan home office overhaul' });
  await expect(planRow.locator('.prow-comments')).toContainText('2');

  // 'Renew domain' has no comments — no badge.
  const renew = todosCol(page).locator('.prow-todo').filter({ hasText: 'Renew domain' });
  await expect(renew.locator('.prow-comments')).toHaveCount(0);
});
