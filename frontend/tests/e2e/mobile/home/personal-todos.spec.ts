// Personal todos column on mobile Home (HOME-M-4..5) — parity with the
// capture / toggle / drawer-status flows in desktop/home/personal-todos.spec.ts.
import { createTodo, deleteTodo, listTodos } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';
import { waitForAppReady } from '../../helpers/utils';

const TODOS_COL = '.home-personal-grid .pcol:has(h3:text-is("Todos"))';

test('home mobile todos: capture via Enter creates a project-less todo; checkbox marks it done', async ({ page }) => {
  const content = stamp() + ' Mobile capture';
  await page.locator(`${TODOS_COL} .pcol-add input`).fill(content);
  await page.locator(`${TODOS_COL} .pcol-add input`).press('Enter');

  // Quick-add pops the detail drawer for the fresh todo (so the user can
  // attach priority/due/tags). It's fullscreen on mobile and would swallow
  // the checkbox click — dismiss it first, exactly like a real user.
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await drawer.locator('.drawer-head button[aria-label="Close"]').click();
  await expect(drawer).toHaveCount(0);

  const row = page.locator(`${TODOS_COL} .prow`, { hasText: content });
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

    const row = page.locator(`${TODOS_COL} .prow`, { hasText: content });
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
