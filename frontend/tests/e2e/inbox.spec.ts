import { expect, test, type Page } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

async function gotoInbox(page: Page) {
  await page.goto('/');
  await waitForAppReady(page);
  if ((page.viewportSize()?.width ?? 0) < 820) {
    await page.locator('.mtab', { hasText: 'Inbox' }).click();
  } else {
    await page.locator('.sb-item:has(.label:text-is("Inbox"))').click();
  }
  await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();
}

test.describe('Inbox page', () => {
  test('@smoke heading visible', async ({ page }) => {
    await gotoInbox(page);
    await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();
  });

  test('quick capture row visible', async ({ page }) => {
    await gotoInbox(page);
    await expect(page.locator('.todo-input-row .field input')).toBeVisible();
    await expect(page.locator('.btn', { hasText: 'Add details' })).toBeVisible();
  });

  test('filter chips render', async ({ page }) => {
    await gotoInbox(page);
    await expect(page.locator('.filter-chip', { hasText: 'All' })).toBeVisible();
    await expect(page.locator('.filter-chip', { hasText: 'Open' })).toBeVisible();
    await expect(page.locator('.filter-chip', { hasText: 'Overdue' })).toBeVisible();
    await expect(page.locator('.filter-chip', { hasText: 'Today' })).toBeVisible();
    await expect(page.locator('.filter-chip', { hasText: 'This week' })).toBeVisible();
  });

  test('renders 4 todos from mock', async ({ page }) => {
    await gotoInbox(page);
    await expect(page.locator('.todo')).toHaveCount(4);
  });

  test('todos with due_at render a due chip', async ({ page }) => {
    // Mock fixtures use future due_at (negative ago()), so no .due-overdue.
    // Verify the due chip text renders for at least one row.
    await gotoInbox(page);
    await expect(page.getByText(/^due /).first()).toBeVisible();
  });

  test('priority pills render', async ({ page }) => {
    await gotoInbox(page);
    await expect(page.locator('.priority').first()).toBeVisible();
  });

  test('selecting a todo reveals bulk bar', async ({ page }) => {
    await gotoInbox(page);
    await page.locator('.todo .bulk-checkbox').first().click();
    await expect(page.locator('.bulk-bar')).toBeVisible();
    await expect(page.locator('.bulk-bar')).toContainText('1 selected');
  });

  test('selecting another increments count', async ({ page }) => {
    await gotoInbox(page);
    await page.locator('.todo .bulk-checkbox').nth(0).click();
    await page.locator('.todo .bulk-checkbox').nth(1).click();
    await expect(page.locator('.bulk-bar')).toContainText('2 selected');
  });

  test('clicking selected again deselects', async ({ page }) => {
    await gotoInbox(page);
    await page.locator('.todo .bulk-checkbox').first().click();
    await page.locator('.todo .bulk-checkbox').first().click();
    await expect(page.locator('.bulk-bar')).toHaveCount(0);
  });

  test('Clear empties selection', async ({ page }) => {
    await gotoInbox(page);
    await page.locator('.todo .bulk-checkbox').first().click();
    await page.locator('.bulk-bar .btn', { hasText: 'Clear' }).click();
    await expect(page.locator('.bulk-bar')).toHaveCount(0);
  });

  test('More button on a todo opens detail drawer', async ({ page }) => {
    await gotoInbox(page);
    await page.locator('.todo .btn-icon').first().click();
    await expect(page.locator('.drawer')).toBeVisible();
  });
});
