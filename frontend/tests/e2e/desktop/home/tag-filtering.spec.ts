// Tag filtering at the top of Home, applied to all 3 personal widgets
// (todos / notes / documents). Verifies the chip-row UX, the AND/OR
// toggle, URL persistence + reload hydration, and the negative guard
// that the Overview block stays unfiltered by design.

import { expect, test } from '@playwright/test';
import {
  createDoc,
  createNote,
  createTodo,
  deleteContent,
  deleteTodo,
  listContent,
  listTodos,
} from '../../helpers/api';
import { stamp } from '../../helpers/setup';
import { waitForAppReady } from '../../helpers/utils';

// Per-run tag namespace so parallel/sequential specs can't bleed into
// each other's chip rows. Build at module load — same value across all
// tests in this file's worker.
const TAG_A = `e2etag-a-${Math.random().toString(36).slice(2, 7)}`;
const TAG_B = `e2etag-b-${Math.random().toString(36).slice(2, 7)}`;

test.describe('Home tag filtering', () => {
  // Seeded items: todos + notes + documents. AC-3 requires all three
  // content widgets to filter by tags; we now seed an inline doc fixture
  // (type=text, no multipart/OCR needed) so the docs path is asserted
  // with real outcomes, not just structural assumption.
  //
  // We seed AFTER the helpers/setup.ts beforeEach has already done its
  // page.goto('/'), so the initial app render saw an empty (or pre-seed)
  // tag list. page.reload() forces re-fetch so the chip row sees our
  // seeded tags.
  test.beforeEach(async ({ page }) => {
    const s = stamp();
    await createTodo(`${s} todo-A`, null, { tags: [TAG_A] });
    await createTodo(`${s} todo-AB`, null, { tags: [TAG_A, TAG_B] });
    await createTodo(`${s} todo-B`, null, { tags: [TAG_B] });
    await createNote(`${s} note-A`, 'note body A', { tags: [TAG_A] });
    await createNote(`${s} note-B`, 'note body B', { tags: [TAG_B] });
    await createDoc(`${s} doc-A`, 'doc body A', { tags: [TAG_A] });
    await createDoc(`${s} doc-B`, 'doc body B', { tags: [TAG_B] });
    await page.reload();
    await page.locator('[data-tag-filter]').waitFor({ state: 'visible' });
  });

  test('chip row renders + Clear hidden until a chip is active', async ({ page }) => {
    const filterBar = page.locator('[data-tag-filter]');
    await expect(filterBar).toBeVisible();
    // Our seeded tags appear as chips somewhere in the row.
    await expect(filterBar.getByRole('button', { name: `#${TAG_A}` })).toBeVisible();
    await expect(filterBar.getByRole('button', { name: `#${TAG_B}` })).toBeVisible();
    // No Clear until a tag is selected.
    await expect(filterBar.getByRole('button', { name: /clear tag filter/i })).toHaveCount(0);
  });

  test('OR filter scopes all widgets + URL updates + Clear restores', async ({ page }) => {
    const filterBar = page.locator('[data-tag-filter]');
    const chipA = filterBar.getByRole('button', { name: `#${TAG_A}` });
    await chipA.click();
    await expect(chipA).toHaveAttribute('aria-pressed', 'true');
    // URL gets ?tag=TAG_A, no mode (OR is default-omitted).
    await expect.poll(() => new URL(page.url()).searchParams.get('tag')).toBe(TAG_A);
    await expect.poll(() => new URL(page.url()).searchParams.has('mode')).toBe(false);

    // todos widget: 2 visible rows (todo-A + todo-AB), todo-B excluded.
    const todosCol = page.locator('[data-pcol="todos"]');
    await expect(todosCol.locator('.prow-todo')).toHaveCount(2);
    // notes widget: 1 visible row (note-A only).
    const notesCol = page.locator('[data-pcol="notes"]');
    await expect(notesCol.locator('.prow-note')).toHaveCount(1);
    // documents widget: 1 visible row (doc-A only) — AC-3 docs coverage.
    const docsCol = page.locator('[data-pcol="documents"]');
    await expect(docsCol.locator('.prow-doc')).toHaveCount(1);

    // Clear restores all.
    await filterBar.getByRole('button', { name: /clear tag filter/i }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has('tag')).toBe(false);
    await expect(chipA).toHaveAttribute('aria-pressed', 'false');
  });

  test('AND toggle appears at 2 tags + intersection only', async ({ page }) => {
    const filterBar = page.locator('[data-tag-filter]');
    await filterBar.getByRole('button', { name: `#${TAG_A}` }).click();
    // Mode toggle hidden at 1 selected.
    await expect(filterBar.locator('.home-tag-filter-mode-btn')).toHaveCount(0);

    await filterBar.getByRole('button', { name: `#${TAG_B}` }).click();
    // Mode toggle visible at 2.
    await expect(filterBar.locator('.home-tag-filter-mode-btn')).toHaveCount(2);
    // Default OR: union (3 todos with either tag).
    await expect(page.locator('[data-pcol="todos"] .prow-todo')).toHaveCount(3);

    // Switch to AND: intersection (only todo-AB). Mode buttons are radios.
    await filterBar.getByRole('radio', { name: 'AND' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('and');
    await expect(page.locator('[data-pcol="todos"] .prow-todo')).toHaveCount(1);
    await expect(page.locator('[data-pcol="todos"] .prow-todo')).toContainText('todo-AB');

    // Notes: AND across TAG_A + TAG_B yields zero — empty state shows.
    await expect(page.locator('[data-pcol="notes"] .pcol-empty')).toContainText(
      `No notes with tags #${TAG_A} AND #${TAG_B}`,
    );
  });

  test('URL hydration on reload (no flash of unfiltered content)', async ({ page }) => {
    await page.goto(`/?tag=${TAG_A}`, { waitUntil: 'domcontentloaded' });
    // Wait specifically for the chip row to mount (NOT for networkidle —
    // that misses the flash window). The first observable state of the
    // chip MUST be pressed=true, never pressed=false then pressed=true.
    const chipA = page.locator(`[data-tag-filter] button:has-text("#${TAG_A}")`);
    await chipA.waitFor({ state: 'attached' });
    await expect(chipA).toHaveAttribute('aria-pressed', 'true');
    // Todos column reflects filtered count (2 items) from first render.
    const todosCol = page.locator('[data-pcol="todos"]');
    await expect(todosCol.locator('.prow-todo')).toHaveCount(2);
  });

  test('overview counts stay UNFILTERED under active filter (D4 negative guard)', async ({ page }) => {
    // Capture overview "open" count before any filter.
    const openBtn = page.locator('.stat-overview-count').first();
    await expect(openBtn).toBeVisible();
    const openBefore = (await openBtn.locator('strong').innerText()).trim();

    // Apply a filter; overview MUST not budge.
    await page.locator(`[data-tag-filter] button:has-text("#${TAG_A}")`).click();
    // Sanity: chip is pressed.
    await expect(page.locator(`[data-tag-filter] button:has-text("#${TAG_A}")`).first()).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const openAfter = (await openBtn.locator('strong').innerText()).trim();
    expect(openAfter).toBe(openBefore);
  });

  test('keyboard nav: ArrowRight moves focus, Space toggles', async ({ page }) => {
    const chipA = page.locator(`[data-tag-filter] button:has-text("#${TAG_A}")`);
    await chipA.focus();
    await page.keyboard.press('Space');
    await expect(chipA).toHaveAttribute('aria-pressed', 'true');

    // ArrowRight MUST move focus — assert that the focused element is no
    // longer chipA. A broken Arrow handler that swallowed the keypress
    // would leave focus on chipA and fail this assertion.
    await page.keyboard.press('ArrowRight');
    const focusedIsChipA = await chipA.evaluate((el) => el === document.activeElement);
    expect(focusedIsChipA).toBe(false);

    // The newly-focused chip is some tag chip (button[aria-pressed]) — Space toggles it.
    const newlyFocusedPressedBefore = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-pressed'),
    );
    await page.keyboard.press('Space');
    const newlyFocusedPressedAfter = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-pressed'),
    );
    expect(newlyFocusedPressedAfter).not.toBe(newlyFocusedPressedBefore);
  });

  test.afterEach(async () => {
    // Sweep ALL three entity types tagged with this run's namespace so
    // we don't leak fixtures across runs into the local-dev / CI ephemeral
    // DB. Previously only todos were swept — notes leaked, and the doc
    // fixture added in this PR would leak too. listContent returns both
    // documents and notes; one pass covers both.
    const touched = (t: { tags?: string[] }) =>
      t.tags?.includes(TAG_A) || t.tags?.includes(TAG_B);

    const todos = await listTodos().catch(() => []);
    for (const t of todos) {
      if (touched(t)) {
        try { await deleteTodo(t.id); } catch { /* ignore */ }
      }
    }
    const content = await listContent().catch(() => []);
    for (const c of content) {
      if (touched(c)) {
        try { await deleteContent(c.id); } catch { /* ignore */ }
      }
    }
  });
});

// global beforeEach (sidebar expanded + nav to /) lives in helpers/setup.ts;
// importing stamp() from there pulls those hooks in via side-effect.
void waitForAppReady;
