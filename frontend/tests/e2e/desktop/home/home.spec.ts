import { expect, test } from '@playwright/test';
import '../../helpers/setup';

test('home: seed data drives hero and stat cards', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  const cards = page.locator('.stat-card');
  await expect(cards).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(cards.nth(i).locator('.vl, .v').first()).toBeVisible();
  }
});
