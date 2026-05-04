import { expect, test, type Page } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

async function gotoTrash(page: Page) {
  await page.goto('/');
  await waitForAppReady(page);
  if ((page.viewportSize()?.width ?? 0) < 820) {
    await page.locator('.mtab', { hasText: 'More' }).click();
    await page.locator('.m-sheet-row', { hasText: 'Archived' }).click();
  } else {
    await page.locator('.sb-item:has(.label:text-is("Archived"))').click();
  }
  await expect(page.locator('h1', { hasText: 'Archived' })).toBeVisible();
}

test.describe('Trash page', () => {
  test('@smoke heading visible', async ({ page }) => {
    await gotoTrash(page);
    await expect(page.locator('h1', { hasText: 'Archived' })).toBeVisible();
  });

  test('Empty archive button visible', async ({ page }) => {
    await gotoTrash(page);
    await expect(page.locator('.btn.btn-danger', { hasText: 'Empty archive' })).toBeVisible();
  });

  test('All filter chip active by default', async ({ page }) => {
    await gotoTrash(page);
    await expect(page.locator('.filter-chip.active', { hasText: 'All' })).toBeVisible();
  });

  test('renders 4 items', async ({ page }) => {
    await gotoTrash(page);
    await expect(page.locator('.row-list .row')).toHaveCount(4);
  });

  test('each row has Restore + Delete forever buttons', async ({ page }) => {
    await gotoTrash(page);
    const rows = page.locator('.row-list .row');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i).locator('.btn', { hasText: 'Restore' })).toBeVisible();
      await expect(rows.nth(i).locator('.btn-danger', { hasText: 'Delete forever' })).toBeVisible();
    }
  });
});
