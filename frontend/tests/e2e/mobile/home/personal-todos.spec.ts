// Personal todos on mobile Home (HOME-M-4..5) — parity with the
// capture / toggle / drawer-status flows in desktop/home/personal-todos.spec.ts.
// Home's Todos tab renders the shared TodosPanel (the default tab).
import { createTodo, deleteTodo, listTodos } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';
import { waitForAppReady } from '../../helpers/utils';

const PANEL = '.todos-panel';

test('home mobile todos: capture via Enter creates a project-less todo; checkbox marks it done', async ({ page }) => {
  const content = stamp() + ' Mobile capture';
  await page.locator(`${PANEL} .todo-input-row .field input`).fill(content);
  await page.locator(`${PANEL} .todo-input-row .field input`).press('Enter');

  // Quick-add Enter is the fast path — no drawer pops (that's what the
  // "Add details" button is for). The row lands straight in the panel body.
  const row = page.locator(`${PANEL} .todos-body .prow`, { hasText: content });
  await expect(row).toBeVisible();

  await row.locator('.checkbox').click();
  await expect.poll(async () => {
    const todos = await listTodos({ project_id: 'null' });
    return todos.find((t) => t.content === content)?.status;
  }).toBe('done');
});

test('home mobile todos: status is editable from the fullscreen detail drawer', async ({ page }) => {
  const content = stamp() + ' Mobile status edit';
  const created = await createTodo(content, null);
  try {
    await page.reload();
    await waitForAppReady(page);

    const row = page.locator(`${PANEL} .prow`, { hasText: content });
    await expect(row).toBeVisible();
    await row.click();

    const drawer = page.locator('.drawer');
    await expect(drawer).toBeVisible({ timeout: 15000 });

    const chip = (label: string) => drawer.locator('.filter-chip', { hasText: label });
    await expect(chip('Not started')).toHaveClass(/\bactive\b/);
    await chip('In progress').click();
    await expect(chip('In progress')).toHaveClass(/\bactive\b/);

    await expect.poll(async () => {
      const todos = await listTodos({ project_id: 'null' });
      return todos.find((t) => t.content === content)?.status;
    }).toBe('in_progress');
  } finally {
    await deleteTodo(created.id).catch(() => {});
  }
});
