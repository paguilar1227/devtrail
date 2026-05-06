// Personal todos column on Home. These tests used to target the Inbox
// route; the route is gone now, so the same flows run against the
// Home Personal column. Capture creates a todo via the quick-add input,
// toggle flips status via the row checkbox.
import { expect, test } from '@playwright/test';
import { createTodo, listTodos } from '../../helpers/api';
import { stamp } from '../../helpers/setup';
import { waitForAppReady } from '../../helpers/utils';

const TODOS_COL = '.home-personal-grid .pcol:has(h3:text-is("Todos"))';

test('home personal todos: capture via Enter creates a project-less todo and shows it in the column', async ({ page }) => {
  const content = stamp() + ' Inbox capture';
  const before = (await listTodos({ project_id: 'null' })).length;

  await page.locator(`${TODOS_COL} .pcol-add input`).fill(content);
  await page.locator(`${TODOS_COL} .pcol-add input`).press('Enter');

  await expect(page.locator(`${TODOS_COL} .prow .ti`, { hasText: content })).toBeVisible();
  const after = await listTodos({ project_id: 'null' });
  expect(after.length).toBe(before + 1);
});

test('home personal todos: toggling the row checkbox marks the todo done in the backend', async ({ page }) => {
  const content = stamp() + ' Toggle';
  await createTodo(content, null);
  // React Query staleTime keeps the cached list — reload to surface the
  // row we just created via REST.
  await page.reload();
  await waitForAppReady(page);

  const row = page.locator(`${TODOS_COL} .prow`, { hasText: content });
  await expect(row).toBeVisible();
  await row.locator('.checkbox').click();

  // The Home column doesn't render a status pill, so confirm via REST.
  await expect.poll(async () => {
    const todos = await listTodos({ project_id: 'null' });
    return todos.find((t) => t.content === content)?.status;
  }).toBe('done');
});
