// Page-level tag chips on Home — SEARCH MODE ONLY since the funnel-order
// fix: in browse mode each panel owns its type-scoped tag row, and the
// workspace-wide chip row appears once the page is in search mode (synced
// with the query's #tag predicates). These tests cover: the browse-mode
// absence regression, revealing the row by typing a #tag, chip-driven
// scoping + AND/OR + URL persistence, reload hydration, and keyboard nav.
//
// Selector note: `.page > [data-tag-filter]` is the page-level bar; the
// Todos panel's own bar lives under `.todos-panel`.

import {
  createDoc,
  createNote,
  createTodo,
  deleteContent,
  deleteTodo,
  listContent,
  listTodos,
} from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';

// Per-run tag namespace so parallel/sequential specs can't bleed into
// each other's chip rows. Build at module load — same value across all
// tests in this file's worker.
const TAG_A = `e2etag-a-${Math.random().toString(36).slice(2, 7)}`;
const TAG_B = `e2etag-b-${Math.random().toString(36).slice(2, 7)}`;

// Per-test stamp, set in beforeEach and read by the test bodies so they can
// match the exact seeded items (e.g. `${s} todo-AB`) in the search results.
let s = '';

const pageBar = '.page > [data-tag-filter]';

test.describe('Home tag filtering', () => {
  // Seed AFTER helpers/setup's page fixture has done its goto('/'), so
  // reload forces the tag inventory to include this run's tags.
  test.beforeEach(async ({ page }) => {
    s = stamp();
    await createTodo(`${s} todo-A`, null, { tags: [TAG_A] });
    await createTodo(`${s} todo-AB`, null, { tags: [TAG_A, TAG_B] });
    await createTodo(`${s} todo-B`, null, { tags: [TAG_B] });
    await createNote(`${s} note-A`, 'note body A', { tags: [TAG_A] });
    await createNote(`${s} note-B`, 'note body B', { tags: [TAG_B] });
    await createDoc(`${s} doc-A`, 'doc body A', { tags: [TAG_A] });
    await createDoc(`${s} doc-B`, 'doc body B', { tags: [TAG_B] });
    await page.reload();
    await page.locator('.home-tabs-row').waitFor({ state: 'visible' });
  });

  test('browse mode has NO page-level chip row; the panel owns tags (funnel-order regression)', async ({ page }) => {
    await expect(page.locator(pageBar)).toHaveCount(0);
    await expect(page.locator('.todos-panel [data-tag-filter]')).toBeVisible();
  });

  test('typing a #tag reveals the page-level row; results scope; Clear restores the dashboard', async ({ page }) => {
    await page.locator('.home-search-box input').fill(`#${TAG_A}`);

    // Search mode: the page-level bar appears with the typed tag active.
    const filterBar = page.locator(pageBar);
    await expect(filterBar).toBeVisible();
    const chipA = filterBar.getByRole('button', { name: `#${TAG_A}` });
    await expect(chipA).toHaveAttribute('aria-pressed', 'true');

    // Results are scoped to TAG_A. Assert via todos — they're searchable
    // the instant they're created; notes/docs race the ingest pipeline.
    const results = page.locator('.home-search-results .search-hit');
    await expect(results.filter({ hasText: `${s} todo-AB` })).toHaveCount(1);
    await expect(results.filter({ hasText: `${s} todo-B` })).toHaveCount(0);

    // Clear drops the tag from the query → back to the tabbed dashboard,
    // where the page-level bar is gone again.
    await filterBar.getByRole('button', { name: /clear tag filter/i }).click();
    await expect(page.locator('.home-tabs-row')).toBeVisible();
    await expect(page.locator('.todos-panel')).toBeVisible();
    await expect(page.locator(pageBar)).toHaveCount(0);
  });

  test('AND toggle: OR yields the union, AND the intersection', async ({ page }) => {
    // Enter search mode with tag A, then add tag B via its chip.
    await page.locator('.home-search-box input').fill(`#${TAG_A}`);
    const filterBar = page.locator(pageBar);
    await expect(filterBar).toBeVisible();
    // Mode toggle hidden at 1 selected.
    await expect(filterBar.locator('.home-tag-filter-mode-btn')).toHaveCount(0);

    await filterBar.getByRole('button', { name: `#${TAG_B}` }).click();
    // Mode toggle visible at 2.
    await expect(filterBar.locator('.home-tag-filter-mode-btn')).toHaveCount(2);

    // Regression guard for the OR=AND bug: before the `tag_match` fix the
    // backend always intersected (@>), so OR wrongly dropped todo-B.
    const results = page.locator('.home-search-results .search-hit');

    // Default OR: union of A|B — the B-only todo AND the both-tagged todo show.
    await expect(results.filter({ hasText: `${s} todo-B` })).toHaveCount(1);
    await expect(results.filter({ hasText: `${s} todo-AB` })).toHaveCount(1);

    // Switch to AND (radio): intersection — only the both-tagged todo survives.
    await filterBar.getByRole('radio', { name: 'AND' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('and');
    await expect(results.filter({ hasText: `${s} todo-AB` })).toHaveCount(1);
    await expect(results.filter({ hasText: `${s} todo-B` })).toHaveCount(0);
  });

  test('URL hydration on reload (no flash of unfiltered content)', async ({ page }) => {
    await page.goto(`/?tag=${TAG_A}`, { waitUntil: 'domcontentloaded' });
    // The ?tag= seed puts the page straight into search mode, where the
    // chip row renders. The first observable state of the chip MUST be
    // pressed=true, never pressed=false then pressed=true.
    const chipA = page.locator(`${pageBar} button:has-text("#${TAG_A}")`);
    await chipA.waitFor({ state: 'attached' });
    await expect(chipA).toHaveAttribute('aria-pressed', 'true');
    const results = page.locator('.home-search-results .search-hit');
    await expect(results.filter({ hasText: `${s} todo-AB` })).toHaveCount(1);
    await expect(results.filter({ hasText: `${s} todo-B` })).toHaveCount(0);
  });

  test('keyboard nav: ArrowRight moves focus, Space toggles', async ({ page }) => {
    // Enter search mode via a tag deep-link so the chip row is mounted.
    await page.goto(`/?tag=${TAG_A}`, { waitUntil: 'domcontentloaded' });
    const chipA = page.locator(`${pageBar} button:has-text("#${TAG_A}")`);
    await chipA.waitFor({ state: 'attached' });
    await expect(chipA).toHaveAttribute('aria-pressed', 'true');

    // ArrowRight from chip A MUST move focus to another chip.
    await chipA.focus();
    await page.keyboard.press('ArrowRight');
    const focusedIsChipA = await chipA.evaluate((el) => el === document.activeElement);
    expect(focusedIsChipA).toBe(false);

    // Space toggles the newly-focused chip on. Retrying `:focus` locator,
    // not a one-shot activeElement read — selecting a 2nd tag re-renders
    // the results and a one-shot read races that.
    const focusedChip = page.locator(`${pageBar} button[aria-pressed]:focus`);
    await expect(focusedChip).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Space');
    await expect(focusedChip).toHaveAttribute('aria-pressed', 'true');
  });

  test.afterEach(async () => {
    // Sweep ALL three entity types tagged with this run's namespace.
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
