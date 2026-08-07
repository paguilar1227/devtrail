// Home Activity tab filter — changing the kind filter refetches the list
// and updates it in place. The old full-page-reload regression premise is
// obsolete (the page no longer gates rendering on the activity query — the
// tab body owns its own query with keepPreviousData), so this simply pins
// the in-place behavior: the tab strip stays mounted and the filtered
// request round-trips while the select changes.
import { expect, test } from '../../helpers/setup';

test('home: changing the activity filter updates in place, tab strip stays mounted', async ({ page }) => {
  // Open the Activity tab and let its list load.
  await page.locator('.home-tabs-row .tab', { hasText: 'Activity' }).click();
  await expect(page.locator('.stat-activity .activity-list-compact')).toBeVisible();
  const tabsRow = page.locator('.home-tabs-row');
  await expect(tabsRow).toBeVisible();

  // Change the kind filter and wait for its refetch to land.
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/v1/activity') && r.url().includes('kinds=ingest'),
    ),
    page.locator('.stat-activity select').selectOption('ingest'),
  ]);
  await expect(page.locator('.stat-activity select')).toHaveValue('ingest');

  // The tab strip and the activity card stayed mounted (the card renders
  // either the filtered list or an empty state — both keep .stat-activity
  // present), and the Activity tab is still the active one.
  await expect(tabsRow).toBeVisible();
  await expect(page.locator('.home-tabs-row .tab', { hasText: 'Activity' })).toHaveClass(/active/);
  await expect(page.locator('.stat-activity')).toBeVisible();

  // Ingest events exist in the seed, so the filtered list renders rows.
  await expect(page.locator('.stat-activity .activity-row').first()).toBeVisible();
});
