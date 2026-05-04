import { expect, test, type Page } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

async function gotoTags(page: Page) {
  await page.goto('/');
  await waitForAppReady(page);
  if ((page.viewportSize()?.width ?? 0) < 820) {
    await page.locator('.mtab', { hasText: 'More' }).click();
    await page.locator('.m-sheet-row', { hasText: 'Tags' }).click();
  } else {
    await page.locator('.sb-item:has(.label:text-is("Tags"))').click();
  }
  await expect(page.locator('h1', { hasText: 'Tags' })).toBeVisible();
}

test.describe('Tags page', () => {
  test('@smoke heading visible', async ({ page }) => {
    await gotoTags(page);
    await expect(page.locator('h1', { hasText: 'Tags' })).toBeVisible();
  });

  test('renders 10 tag rows from mock', async ({ page }) => {
    await gotoTags(page);
    await expect(page.locator('.tag-row')).toHaveCount(10);
  });

  test('filter narrows by name (case-insensitive)', async ({ page }) => {
    await gotoTags(page);
    await page.locator('.todo-input-row .field input').fill('AUTH');
    // "auth" matches; "tailscale", "research", etc. do not
    await expect(page.locator('.tag-row .tag-name', { hasText: 'auth' })).toBeVisible();
    await expect(page.locator('.tag-row')).toHaveCount(1);
  });

  test('empty filter shows all tags', async ({ page }) => {
    await gotoTags(page);
    await page.locator('.todo-input-row .field input').fill('auth');
    await page.locator('.todo-input-row .field input').fill('');
    await expect(page.locator('.tag-row')).toHaveCount(10);
  });

  test('Rename opens confirm-rename modal', async ({ page }) => {
    await gotoTags(page);
    await page.locator('.tag-row .btn', { hasText: 'Rename' }).first().click();
    await expect(page.locator('.modal-head h3', { hasText: 'Rename tag' })).toBeVisible();
  });
});
