// Home tag filtering on mobile (HOME-M-6) — condensed parity with
// desktop/home/tag-filtering.spec.ts under the funnel-order model: browse
// mode has NO page-level chip row (the Todos panel owns its own), typing a
// #tag flips the page into search mode where the row appears, and Clear
// restores the tabbed dashboard.
import { createTodo } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';

const TAG = `e2etag-m-${Math.random().toString(36).slice(2, 7)}`;

test('home mobile: typing #tag reveals the chip row, scopes results; Clear restores', async ({ page }) => {
  const s = stamp();
  await createTodo(`${s} todo-tagged`, null, { tags: [TAG] });
  await createTodo(`${s} todo-plain`, null);
  await page.reload();
  await page.locator('.home-tabs-row').waitFor({ state: 'visible' });

  // Browse mode: no page-level bar; the panel's own bar is the tag surface.
  await expect(page.locator('.page > [data-tag-filter]')).toHaveCount(0);

  // Type the tag predicate → search mode → the page-level bar appears with
  // the tag active, and results are scoped to it.
  await page.locator('.home-search-box input').fill(`#${TAG}`);
  const filterBar = page.locator('.page > [data-tag-filter]');
  await expect(filterBar).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(`#${TAG}`);

  const results = page.locator('.home-search-results .search-hit');
  await expect(results.filter({ hasText: `${s} todo-tagged` })).toHaveCount(1);
  await expect(results.filter({ hasText: `${s} todo-plain` })).toHaveCount(0);

  // Clear returns to the tabbed dashboard; the page-level bar unmounts.
  await filterBar.locator('.home-tag-filter-clear').click();
  await expect(page.locator('.home-tabs-row')).toBeVisible();
  await expect(page.locator('.todos-panel')).toBeVisible();
  await expect(page.locator('.page > [data-tag-filter]')).toHaveCount(0);
});
