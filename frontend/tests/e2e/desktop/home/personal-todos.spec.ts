// Personal todos column on Home. These tests used to target the Inbox
// route; the route is gone now, so the same flows run against the
// Home Personal column. Capture creates a todo via the quick-add input,
// toggle flips status via the row checkbox.
import { expect, test } from '@playwright/test';
import { createTodo, listTodos, updateTodo } from '../../helpers/api';
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

test('home personal todos: completing a parent cascades to non-done descendants', async ({ page }) => {
  // Build a 3-level tree with a mix of statuses so we exercise both
  // the cascade (touches in_progress + not_started) and the skip
  // path (already-done child stays put — no redundant write).
  const parentContent = stamp() + ' Parent';
  const inProgressChild = stamp() + ' InProgress child';
  const doneChild = stamp() + ' Already-done child';
  const grandchild = stamp() + ' Grandchild';

  const parent = await createTodo(parentContent, null);
  const child1 = await createTodo(inProgressChild, null, { parent_id: parent.id });
  const child2 = await createTodo(doneChild, null, { parent_id: parent.id });
  const gc = await createTodo(grandchild, null, { parent_id: child1.id });

  // Set the in_progress + already-done states via REST so the seed is
  // deterministic regardless of default status.
  await updateTodo(child1.id, { status: 'in_progress' });
  await updateTodo(child2.id, { status: 'done' });

  await page.reload();
  await waitForAppReady(page);

  // Expand the parent so its checkbox is reachable in the column.
  const parentRow = page.locator(`${TODOS_COL} .prow`, { hasText: parentContent });
  await expect(parentRow).toBeVisible();
  await parentRow.locator('.prow-chev').click();

  // Tick the parent's checkbox.
  await parentRow.locator('.checkbox').first().click();

  // All non-done descendants should flip to done. Child2 was already
  // done — assert it stayed done (no spurious write would still be
  // 'done', but the bug we'd care about is regression to non-done).
  await expect.poll(async () => {
    const todos = await listTodos({ project_id: 'null' });
    const byId = new Map(todos.map((t) => [t.id, t]));
    return {
      parent: byId.get(parent.id)?.status,
      child1: byId.get(child1.id)?.status,
      child2: byId.get(child2.id)?.status,
      grandchild: byId.get(gc.id)?.status,
    };
  }, { timeout: 10000 }).toEqual({
    parent: 'done',
    child1: 'done',
    child2: 'done',
    grandchild: 'done',
  });
});
