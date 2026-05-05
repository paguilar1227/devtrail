// Inbox is the project_id=null bucket — fastest capture surface and the
// default for "personal" todos. These tests exercise creation through
// the UI capture row, single-row mutation, and multi-row bulk actions.
import { expect, test } from '@playwright/test';
import { createTodo, listTodos } from '../../helpers/api';
import { navTo, stamp } from '../../helpers/setup';
import { waitForAppReady } from '../../helpers/utils';

test('todo flow: capture in inbox via Enter, see it appear in the list', async ({ page }) => {
  const content = stamp() + ' Inbox capture';
  await navTo(page, 'Inbox');
  await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();

  const before = (await listTodos({ project_id: 'null' })).length;
  await page.locator('.todo-input-row input').first().fill(content);
  await page.locator('.todo-input-row input').first().press('Enter');

  await expect(page.locator('.todo .nm', { hasText: content })).toBeVisible();
  const after = await listTodos({ project_id: 'null' });
  expect(after.length).toBe(before + 1);
});

test('todo flow: toggle row checkbox marks the todo done in the backend', async ({ page }) => {
  const content = stamp() + ' Toggle';
  await createTodo(content, null);
  // Bypass the React Query cache: home page has already fetched
  // ['todos', 'inbox'] with a 30s staleTime, so we must reload to see the
  // row we just created via REST.
  await page.reload();
  await waitForAppReady(page);

  await navTo(page, 'Inbox');
  const row = page.locator('.todo', { hasText: content });
  await expect(row).toBeVisible();
  await expect(row.locator('.todo-status-pill')).toHaveText(/not.started/);

  await row.locator('.checkbox').click();

  await expect(row.locator('.todo-status-pill')).toHaveText('done');
  const matches = (await listTodos({ project_id: 'null' })).filter((t) => t.content === content);
  expect(matches.length).toBe(1);
  expect(matches[0].status).toBe('done');
});

test('todo flow: bulk archive removes selected rows from the open list', async ({ page }) => {
  const a = stamp() + ' Bulk A';
  const b = stamp() + ' Bulk B';
  await createTodo(a, null);
  await createTodo(b, null);
  await page.reload();
  await waitForAppReady(page);

  await navTo(page, 'Inbox');
  const rowA = page.locator('.todo', { hasText: a });
  const rowB = page.locator('.todo', { hasText: b });
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  await rowA.locator('.bulk-checkbox').first().click();
  await rowB.locator('.bulk-checkbox').first().click();
  await expect(page.locator('.bulk-bar')).toBeVisible();

  await page.locator('.bulk-bar .btn-danger', { hasText: 'Archive' }).click();
  await expect(rowA).toHaveCount(0);
  await expect(rowB).toHaveCount(0);

  const remaining = (await listTodos({ project_id: 'null' })).filter(
    (t) => t.content === a || t.content === b,
  );
  for (const t of remaining) expect(t.archived).toBe(true);
});
