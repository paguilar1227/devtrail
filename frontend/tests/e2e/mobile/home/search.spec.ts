// Home inline search on mobile (HOME-M-9) — condensed parity with
// desktop/home/search.spec.ts: free text returns hits; a #tag predicate
// renders a chip whose removal restores the dashboard.
import { createTodo } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';

const TAG = `e2etag-ms-${Math.random().toString(36).slice(2, 7)}`;

test('home mobile search: free text returns hits; removing the #tag chip restores the dashboard', async ({ page }) => {
  const s = stamp();
  await createTodo(`${s} axolotl errand`, null, { tags: [TAG] });
  await page.reload();
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  const input = page.locator('.home-search-box input');

  // Free text → unified results list with our todo.
  await input.fill('axolotl');
  const results = page.locator('.home-search-results .search-hit');
  await expect(results.filter({ hasText: `${s} axolotl errand` })).toHaveCount(1);

  // #tag predicate → chip renders; clicking it removes the predicate and,
  // with no signals left, Home falls back to the dashboard.
  await input.fill(`#${TAG}`);
  const chip = page.locator('.home-search-predicates .search-predicate-chip', { hasText: `#${TAG}` });
  await expect(chip).toBeVisible();
  await expect(results.filter({ hasText: `${s} axolotl errand` })).toHaveCount(1);

  await chip.click();
  await expect(page.locator('.home-personal-grid')).toBeVisible();
});
