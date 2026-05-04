import { expect, test, type Page } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

async function gotoActivity(page: Page) {
  await page.goto('/');
  await waitForAppReady(page);
  if ((page.viewportSize()?.width ?? 0) < 820) {
    await page.locator('.mtab', { hasText: 'More' }).click();
    await page.locator('.m-sheet-row', { hasText: 'Activity' }).click();
  } else {
    await page.locator('.sb-item:has(.label:text-is("Activity"))').click();
  }
  await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
}

test.describe('Activity page', () => {
  test('@smoke heading visible', async ({ page }) => {
    await gotoActivity(page);
    await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
  });

  test('All chip is active by default', async ({ page }) => {
    await gotoActivity(page);
    await expect(page.locator('.filter-chip.active', { hasText: 'All' })).toBeVisible();
  });

  test('renders 10 events from mock', async ({ page }) => {
    await gotoActivity(page);
    await expect(page.locator('.activity-row')).toHaveCount(10);
  });

  test('Ingests filter narrows to ingest events', async ({ page }) => {
    await gotoActivity(page);
    await page.locator('.filter-chip', { hasText: 'Ingests' }).click();
    const rows = page.locator('.activity-row');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('Ingested');
    }
  });

  test('Edits filter narrows to edit events', async ({ page }) => {
    await gotoActivity(page);
    await page.locator('.filter-chip', { hasText: 'Edits' }).click();
    const rows = page.locator('.activity-row');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('Edited');
    }
  });

  test('Comments filter narrows to comment events', async ({ page }) => {
    await gotoActivity(page);
    await page.locator('.filter-chip', { hasText: 'Comments' }).click();
    const rows = page.locator('.activity-row');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('Commented on');
    }
  });

  test('day groups present (Today / Yesterday / This week / Earlier)', async ({ page }) => {
    await gotoActivity(page);
    const groups = await page.locator('.activity-day').allTextContents();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(['Today', 'Yesterday', 'This week', 'Earlier']).toContain(g);
    }
  });
});
