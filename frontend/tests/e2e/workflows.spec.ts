// frontend/tests/e2e/workflows.spec.ts
//
// User-flow e2e suite. Each test is a happy-path round-trip through the live
// stack: Vite → Hono → Postgres. Stub LLM provider keeps it fast and free.
//
// Conventions:
//   - One workflow per `test()`. Tests are NOT order-dependent.
//   - Anything created inside a test is named with `e2e:` prefix +
//     `Date.now()` so we can clean it up afterwards without touching seeds.
//   - Use REST helpers for arrange + cleanup; only the assertion path uses
//     the UI. Setting up state through the UI makes tests slow and fragile.
//   - Don't assert exact counts of seeded data — assert the delta.

import { expect, test, type Page } from '@playwright/test';
import {
  deleteContent,
  deleteProject,
  deleteTodo,
  findProjectByName,
  listContent,
  listProjects,
  listTodos,
} from './helpers/api';
import { waitForAppReady } from './helpers/utils';

const E2E_PREFIX = 'e2e:';
const stamp = () => `${E2E_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const SIDEBAR = 'aside.sidebar';
const navTo = (page: Page, label: string) =>
  page.locator(`${SIDEBAR} .sb-item:has(.label:text-is("${label}"))`).click();
const projectTo = (page: Page, name: string) =>
  page.locator(`${SIDEBAR} .sb-projects .sb-item:has(.label:text-is("${name}"))`).click();

async function createTodoApi(content: string, projectId?: string): Promise<void> {
  const res = await fetch('http://localhost:3001/api/v1/todos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer local-dev-key-not-secret',
    },
    body: JSON.stringify({ content, project_id: projectId }),
  });
  if (!res.ok) throw new Error(`createTodoApi failed: ${res.status}`);
}

test.beforeEach(async ({ page }) => {
  // Expand the sidebar so .label spans are visible/clickable. Default is
  // 'collapsed' which hides labels via CSS, breaking text-based selectors.
  await page.addInitScript(() => {
    window.localStorage.setItem('ob.sidebarMode', 'expanded');
  });
  await page.goto('/');
  await waitForAppReady(page);
});

test.afterEach(async () => {
  // Best-effort sweep of anything our prefix touched. Hard-deletes ensure
  // the next test starts clean.
  for (const p of await listProjects()) {
    if (p.name.startsWith(E2E_PREFIX)) {
      try { await deleteProject(p.id); } catch { /* ignore */ }
    }
  }
  for (const t of await listTodos()) {
    if (t.content.startsWith(E2E_PREFIX)) {
      try { await deleteTodo(t.id); } catch { /* ignore */ }
    }
  }
  for (const c of await listContent()) {
    if (c.title.startsWith(E2E_PREFIX)) {
      try { await deleteContent(c.id); } catch { /* ignore */ }
    }
  }
});

test('home: seed data drives hero and stat cards', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  const cards = page.locator('.stat-card');
  await expect(cards).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(cards.nth(i).locator('.vl, .v').first()).toBeVisible();
  }
});

test('sidebar: clicking a pinned project navigates to its detail page', async ({ page }) => {
  await projectTo(page, 'ClaudePit');
  await expect(page.locator('.proj-hero h1', { hasText: 'ClaudePit' })).toBeVisible();
  await expect(page.locator('[role="tab"]', { hasText: 'Todos' })).toBeVisible();
});

test('project flow: create new project from modal, see it in sidebar', async ({ page }) => {
  const name = stamp() + ' Project';
  await page.locator('.proj-hero .btn-primary', { hasText: 'New project' }).click();
  await expect(page.locator('.modal-head h3')).toHaveText('New project');

  await page.locator('.modal input.input').first().fill(name);
  await page.locator('.modal-foot .btn-primary', { hasText: 'Create' }).click();

  await expect(page.locator(`${SIDEBAR} .sb-projects .sb-item .label`, { hasText: name })).toBeVisible();
  expect(await findProjectByName(name)).toBeDefined();
});

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
  await createTodoApi(content);
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
  await createTodoApi(a);
  await createTodoApi(b);
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

test('note flow: create a new note in a project via the editor modal', async ({ page }) => {
  const project = await findProjectByName('ClaudePit');
  expect(project).toBeDefined();

  await projectTo(page, 'ClaudePit');
  await page.locator('[role="tab"]', { hasText: 'Notes' }).click();

  const title = stamp() + ' Note';
  await page.locator('button', { hasText: 'New note' }).first().click();
  await expect(page.locator('.modal-head h3', { hasText: 'New note' })).toBeVisible();

  await page.locator('.modal input.input').first().fill(title);
  await page.locator('.modal textarea').fill('# E2E body\n\nHello from a workflow test.');
  await page.locator('.modal-foot .btn-primary', { hasText: 'Save' }).click();

  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.note-card', { hasText: title })).toBeVisible();

  const items = await listContent({ project_id: project!.id, type: 'note' });
  expect(items.some((i) => i.title === title)).toBe(true);
});

test('document flow: open Add modal, queue a URL, see it stay in the queue', async ({ page }) => {
  await projectTo(page, 'ClaudePit');
  await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
  await expect(page.locator('.modal-head h3', { hasText: /Add to/ })).toBeVisible();

  await page.locator('.modal input[placeholder*="https"]').fill('https://example.com/article');
  await page.locator('.modal .btn', { hasText: 'Queue' }).click();
  await expect(page.locator('.modal').getByText('https://example.com/article')).toBeVisible();
});

test('search: known seed term returns at least one hit', async ({ page }) => {
  // Search isn't a sidebar nav item — reach it via Cmd-K → Go to Search.
  await page.keyboard.press('Meta+k');
  await page.locator('.cmdk').getByText('Go to Search').click();
  await expect(page.locator('h1', { hasText: 'Search' })).toBeVisible();

  // SearchPage uses .todo-input-row .field input (NOT the readonly topbar one).
  const input = page.locator('.todo-input-row .field input').first();
  await input.fill('Tailscale');
  await input.press('Enter');
  // Results render inside .page-narrow as .doc-row entries.
  await expect(page.locator('.page-narrow .doc-row').first()).toBeVisible({ timeout: 15_000 });
});

test('activity: feed renders entries from the seed', async ({ page }) => {
  await navTo(page, 'Activity');
  await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
  await expect(page.locator('.activity-row').first()).toBeVisible();
});

test('tags: list page shows tags with non-zero totals', async ({ page }) => {
  await navTo(page, 'Tags');
  await expect(page.locator('h1', { hasText: 'Tags' })).toBeVisible();
  await expect(page.locator('.tag-row, .tag-card').first()).toBeVisible();
});

test('pin: toggling pin on a project header round-trips through the backend', async ({ page }) => {
  // Use Homelab — seeded as active but NOT pinned.
  await projectTo(page, 'Homelab');
  await expect(page.locator('.proj-hero h1', { hasText: 'Homelab' })).toBeVisible();

  const before = await findProjectByName('Homelab');
  expect(before?.pinned_at).toBeFalsy();

  // The button renders <Icons.Pin /> Pin so its accessible name is "Pin"
  // (whitespace-tolerant) — getByRole avoids regex anchor pitfalls.
  await page.locator('.proj-hero').getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(page.locator('.proj-hero').getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
  const after = await findProjectByName('Homelab');
  expect(after?.pinned_at).toBeTruthy();

  // Restore.
  await page.locator('.proj-hero').getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(page.locator('.proj-hero').getByRole('button', { name: 'Pin', exact: true })).toBeVisible();
});
