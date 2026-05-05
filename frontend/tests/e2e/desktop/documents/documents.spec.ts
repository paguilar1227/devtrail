import { expect, test } from '@playwright/test';
import { projectTo } from '../../helpers/setup';

test('document flow: open Add modal, queue a URL, see it stay in the queue', async ({ page }) => {
  await projectTo(page, 'ClaudePit');
  await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
  await expect(page.locator('.modal-head h3', { hasText: /Add to/ })).toBeVisible();

  await page.locator('.modal input[placeholder*="https"]').fill('https://example.com/article');
  await page.locator('.modal .btn', { hasText: 'Queue' }).click();
  await expect(page.locator('.modal').getByText('https://example.com/article')).toBeVisible();
});
