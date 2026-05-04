import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

test.describe('Mobile tabbar', () => {
  test.skip(({ viewport }) => !viewport || viewport.width >= 820, 'mobile-only');

  test('app marks itself as mobile', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.app')).toHaveAttribute('data-mobile', 'true');
  });

  test('sidebar is not rendered', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('aside.sidebar')).toHaveCount(0);
  });

  test('mobile tabbar is visible with 4 items', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('nav.mobile-tabbar.show')).toBeVisible();
    await expect(page.locator('.mtab')).toHaveCount(4);
    await expect(page.locator('.mtab').nth(0)).toContainText('Home');
    await expect(page.locator('.mtab').nth(1)).toContainText('Projects');
    await expect(page.locator('.mtab').nth(2)).toContainText('Inbox');
    await expect(page.locator('.mtab').nth(3)).toContainText('More');
  });

  test('@smoke clicking each tab navigates', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'Projects' }).click();
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();
    await page.locator('.mtab', { hasText: 'Inbox' }).click();
    await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();
    await page.locator('.mtab', { hasText: 'Home' }).click();
    await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  });

  test('More tab opens m-sheet', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    await expect(page.locator('.m-sheet')).toBeVisible();
    await expect(page.locator('.m-sheet-overlay')).toBeVisible();
  });

  test('m-sheet has Activity / Tags / Mentions / Archived rows', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    await expect(page.locator('.m-sheet-row', { hasText: 'Activity' })).toBeVisible();
    await expect(page.locator('.m-sheet-row', { hasText: 'Tags' })).toBeVisible();
    await expect(page.locator('.m-sheet-row', { hasText: 'Mentions' })).toBeVisible();
    await expect(page.locator('.m-sheet-row', { hasText: 'Archived' })).toBeVisible();
  });

  test('clicking m-sheet row navigates and closes sheet', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    await page.locator('.m-sheet-row', { hasText: 'Activity' }).click();
    await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
    await expect(page.locator('.m-sheet')).toHaveCount(0);
  });

  test('clicking overlay closes sheet', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    await expect(page.locator('.m-sheet')).toBeVisible();
    const overlay = page.locator('.m-sheet-overlay');
    const box = await overlay.boundingBox();
    if (!box) throw new Error('overlay box not found');
    // Click near the top of the overlay where the sheet (bottom-anchored) doesn't reach
    await overlay.click({ position: { x: Math.floor(box.width / 2), y: 8 } });
    await expect(page.locator('.m-sheet')).toHaveCount(0);
  });

  test('clicking X button in sheet header closes', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    await expect(page.locator('.m-sheet')).toBeVisible();
    await page.locator('.m-sheet-h .btn-icon').click();
    await expect(page.locator('.m-sheet')).toHaveCount(0);
  });

  test('m-sheet shows pinned project rows', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    // Pinned section header
    await expect(page.locator('.m-sheet-section', { hasText: 'Pinned' })).toBeVisible();
    // ClaudePit and Copilot CLI App from mock
    await expect(page.locator('.m-sheet-row', { hasText: 'ClaudePit' })).toBeVisible();
    await expect(page.locator('.m-sheet-row', { hasText: 'Copilot CLI App' })).toBeVisible();
  });

  test('appearance row toggles theme', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const before = await page.locator('html').getAttribute('data-theme');
    await page.locator('.mtab', { hasText: 'More' }).click();
    await page.locator('.m-sheet-row', { hasText: 'Appearance' }).click();
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);
  });

  test('user row shows identity', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    await expect(page.locator('.m-sheet-user .nm')).toHaveText('Alex');
    await expect(page.locator('.m-sheet-user .em')).toHaveText('you@example.com');
  });
});
