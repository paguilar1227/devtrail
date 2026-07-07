// Home tag filtering on mobile (HOME-M-6) — condensed parity with
// desktop/home/tag-filtering.spec.ts: one chip scopes the widgets into the
// unified results list, updates the URL, and Clear restores the dashboard.
import { createTodo } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';
import { selectTagChip } from '../../helpers/nav';

const TAG = `e2etag-m-${Math.random().toString(36).slice(2, 7)}`;

test('home mobile: tag chip scopes results + URL updates + Clear restores', async ({ page }) => {
  const s = stamp();
  await createTodo(`${s} todo-tagged`, null, { tags: [TAG] });
  await createTodo(`${s} todo-plain`, null);
  await page.reload();
  await page.locator('[data-tag-filter]').waitFor({ state: 'visible' });

  // On the 390px viewport a fresh low-usage tag overflows into the "+N more"
  // picker, so use the overflow-aware helper instead of clicking a chip that
  // may not be in the visible row.
  const filterBar = page.locator('[data-tag-filter]');
  await selectTagChip(page, filterBar, TAG);
  await expect.poll(() => new URL(page.url()).searchParams.get('tag')).toBe(TAG);

  const results = page.locator('.home-search-results .search-hit');
  await expect(results.filter({ hasText: `${s} todo-tagged` })).toHaveCount(1);
  await expect(results.filter({ hasText: `${s} todo-plain` })).toHaveCount(0);

  await filterBar.locator('.home-tag-filter-clear').click();
  await expect.poll(() => new URL(page.url()).searchParams.has('tag')).toBe(false);
  await expect(page.locator('[data-pcol="todos"]')).toBeVisible();
});
