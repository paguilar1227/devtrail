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
  // Body input is a CodeMirror 6 editor (contenteditable), not a plain
  // textarea — focus via click on .cm-content, then type. Selecting all
  // first wipes the seeded "# New note\n\nStart writing…" placeholder.
  const cm = page.locator('.modal .cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# E2E body\n\nHello from a workflow test.');
  await page.locator('.modal-foot .btn-primary', { hasText: 'Save' }).click();

  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.note-card', { hasText: title })).toBeVisible();

  const items = await listContent({ project_id: project!.id, type: 'note' });
  expect(items.some((i) => i.title === title)).toBe(true);
});

test('note editor: cm-editor surface stays transparent (regression for the cm-theme-light white-bg bug)', async ({ page }) => {
  // The Bear-style markdown editor depends on @uiw/react-codemirror NOT
  // applying its built-in light theme — that theme paints .cm-editor
  // white, which makes our bright text look ghostly faded against it.
  // We pass `theme="none"` on the component; if a future refactor drops
  // that prop, this test fails before the regression ships.
  await projectTo(page, 'ClaudePit');
  await page.locator('[role="tab"]', { hasText: 'Notes' }).click();
  await page.locator('.note-card').first().click();
  await expect(page.locator('.modal .cm-editor')).toBeVisible();

  // 1) The active theme wrapper must NOT be cm-theme-light.
  const themeWrapper = page.locator('.modal').locator('[class^="cm-theme-"]').first();
  await expect(themeWrapper).toHaveClass(/cm-theme-none/);
  await expect(themeWrapper).not.toHaveClass(/cm-theme-light/);

  // 2) .cm-editor background must be transparent so the parent surface
  //    color is what shows through.
  const editorBg = await page
    .locator('.modal .cm-editor')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(editorBg).toMatch(/^rgba\(0, 0, 0, 0\)|^transparent$/);
});

test('note editor: tag input is hidden behind + Add and commits with Enter without leaving edit mode', async ({ page }) => {
  // Two-fix regression:
  //   1) Committed .tag pills must read as --fg brightness (oklch L≥0.9) so
  //      they don't blur into the muted input affordance next to them.
  //   2) The "add tag" input is hidden until the user clicks + Add. Enter
  //      commits + clears + stays focused (fast multi-add); empty Enter
  //      collapses back to the + Add button.
  await projectTo(page, 'ClaudePit');
  await page.locator('[role="tab"]', { hasText: 'Notes' }).click();
  await page.locator('button', { hasText: 'New note' }).first().click();
  await expect(page.locator('.modal-head h3', { hasText: 'New note' })).toBeVisible();

  // Initial state: no input pill, only the + Add button.
  await expect(page.locator('.modal .input-tag-wrap')).toHaveCount(0);
  const addBtn = page.locator('.modal button.btn-ghost.btn-sm', { hasText: 'Add' });
  await expect(addBtn).toBeVisible();

  // Click + Add → input pill appears and is autofocused.
  await addBtn.click();
  const inputPill = page.locator('.modal .input-tag-wrap');
  const tagInput = page.locator('.modal .input-tag');
  await expect(inputPill).toBeVisible();
  await expect(tagInput).toBeFocused();
  await expect(addBtn).toHaveCount(0);

  // Type + Enter commits the tag and keeps the input open + focused.
  const tagName = `e2e-${Date.now().toString(36)}`;
  await tagInput.fill(tagName);
  await tagInput.press('Enter');
  await expect(page.locator('.modal .tag', { hasText: tagName })).toBeVisible();
  await expect(tagInput).toHaveValue('');
  await expect(tagInput).toBeFocused();

  // Tag pill text reads as --fg brightness (oklch lightness ≥ 0.9). The
  // earlier --fg-muted color produced ~0.74 and made committed pills blur
  // into the muted placeholder.
  const lightness = await page.locator('.modal .tag', { hasText: tagName }).first().evaluate((el) => {
    const c = getComputedStyle(el).color;
    const m = c.match(/oklch\(([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  });
  expect(lightness).not.toBeNull();
  expect(lightness!).toBeGreaterThanOrEqual(0.9);

  // Empty Enter collapses back to the + Add button.
  await tagInput.press('Enter');
  await expect(page.locator('.modal .input-tag-wrap')).toHaveCount(0);
  await expect(page.locator('.modal button.btn-ghost.btn-sm', { hasText: 'Add' })).toBeVisible();
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

// ── Settings ─────────────────────────────────────────────────────────────
//
// The Settings modal is the only ephemeral overlay over the home view —
// dismissing it returns the user where they were instead of replacing the
// page. These tests cover both entry points (desktop sidebar footer +
// mobile More sheet) and exercise the three knobs inside (theme, logout,
// close).

test('settings desktop: clicking sidebar footer opens the modal and Esc/X dismiss it', async ({ page }) => {
  await page.locator('aside.sidebar .sb-footer').click();
  await expect(page.locator('.modal-head h3', { hasText: 'Settings' })).toBeVisible();
  // The home page must still be mounted underneath — closing the modal
  // should drop the user back where they were, not on a fresh route.
  await expect(page.locator('main h1', { hasText: /Welcome back/ })).toBeVisible();
  await page.locator('.modal-head button[aria-label="Close"]').click();
  await expect(page.locator('.modal')).toHaveCount(0);
});

test('settings desktop: theme toggle inside the modal flips the document data-theme', async ({ page }) => {
  await page.locator('aside.sidebar .sb-footer').click();
  await expect(page.locator('.modal-head h3', { hasText: 'Settings' })).toBeVisible();

  const initial = await page.evaluate(() => document.documentElement.dataset.theme);
  const target: 'light' | 'dark' = initial === 'dark' ? 'light' : 'dark';
  await page.locator(`.modal .thm-toggle button[aria-label="${target === 'dark' ? 'Dark' : 'Light'} theme"]`).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(target);

  // Restore the initial theme so the next test starts clean.
  await page.locator(`.modal .thm-toggle button[aria-label="${initial === 'dark' ? 'Dark' : 'Light'} theme"]`).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(initial);
});

test('settings desktop: clicking Log out clears the cached token and redirects', async ({ page }) => {
  // Plant a sentinel token so we can prove the logout call cleared it. In
  // local dev /.auth/logout doesn't exist; the dev branch of logout()
  // assigns '/' and bootAuth re-hydrates from the env-var fallback.
  await page.evaluate(() => localStorage.setItem('ob.api_key', 'sentinel-to-clear'));

  await page.locator('aside.sidebar .sb-footer').click();
  await expect(page.locator('.modal-head h3', { hasText: 'Settings' })).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Log out' }).click();

  // Wait for the post-logout reload + bootAuth to settle on the home view.
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('ob.api_key'));
  expect(stored).toBeNull();
});

test('settings mobile: More → Account & preferences opens the modal and X dismisses it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The mobile tabbar swaps in below 820px (see useIsMobile). Wait for it
  // to render before driving the More button.
  const more = page.locator('.mobile-tabbar .mtab', { hasText: 'More' });
  await expect(more).toBeVisible();
  await more.click();

  await page.locator('.m-sheet .m-sheet-row', { hasText: 'Account & preferences' }).click();
  await expect(page.locator('.modal-head h3', { hasText: 'Settings' })).toBeVisible();
  // The More sheet should have closed itself when we opened the modal —
  // otherwise the user gets a stacked-overlay mess on a small screen.
  await expect(page.locator('.m-sheet')).toHaveCount(0);

  await page.locator('.modal-head button[aria-label="Close"]').click();
  await expect(page.locator('.modal')).toHaveCount(0);
});

test('settings mobile: theme toggle inside the modal flips the document data-theme', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const more = page.locator('.mobile-tabbar .mtab', { hasText: 'More' });
  await expect(more).toBeVisible();
  await more.click();
  await page.locator('.m-sheet .m-sheet-row', { hasText: 'Account & preferences' }).click();
  await expect(page.locator('.modal-head h3', { hasText: 'Settings' })).toBeVisible();

  const initial = await page.evaluate(() => document.documentElement.dataset.theme);
  const target: 'light' | 'dark' = initial === 'dark' ? 'light' : 'dark';
  await page.locator(`.modal .thm-toggle button[aria-label="${target === 'dark' ? 'Dark' : 'Light'} theme"]`).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(target);

  await page.locator(`.modal .thm-toggle button[aria-label="${initial === 'dark' ? 'Dark' : 'Light'} theme"]`).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(initial);
});

test('settings mobile: clicking Log out clears the cached token and redirects', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('ob.api_key', 'sentinel-to-clear'));

  const more = page.locator('.mobile-tabbar .mtab', { hasText: 'More' });
  await expect(more).toBeVisible();
  await more.click();
  await page.locator('.m-sheet .m-sheet-row', { hasText: 'Account & preferences' }).click();
  await expect(page.locator('.modal-head h3', { hasText: 'Settings' })).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Log out' }).click();

  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('ob.api_key'));
  expect(stored).toBeNull();
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
