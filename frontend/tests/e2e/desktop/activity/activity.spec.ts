import { expect, test } from '@playwright/test';
import { navTo } from '../../helpers/setup';

test('activity: feed renders entries from the seed', async ({ page }) => {
  await navTo(page, 'Activity');
  await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
  await expect(page.locator('.activity-row').first()).toBeVisible();
});
