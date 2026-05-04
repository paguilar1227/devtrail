import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

test.describe('Command palette', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('@smoke Cmd+K opens', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk')).toBeVisible();
  });

  test('Cmd+K toggles closed when already open', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk')).toBeVisible();
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk')).not.toBeVisible();
  });

  test('search input autofocused', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk-input input')).toBeFocused();
  });

  test('initial groups: Projects + Documents + Notes + Actions', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    const groups = page.locator('.cmdk-group-h');
    await expect(groups).toHaveCount(4);
    const titles = await groups.allTextContents();
    expect(titles).toEqual(['Projects', 'Documents', 'Notes', 'Actions']);
  });

  test('typing filters items', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-input input').fill('subscription');
    // Notes group should have the auth-strategy note
    await expect(page.locator('.cmdk-row', { hasText: 'subscription cookies' })).toBeVisible();
  });

  test('case-insensitive filter', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-input input').fill('CLAUDEPIT');
    await expect(page.locator('.cmdk-row', { hasText: 'ClaudePit' }).first()).toBeVisible();
  });

  test('gibberish removes all groups', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-input input').fill('zzzzqq');
    await expect(page.locator('.cmdk-group-h')).toHaveCount(0);
  });

  test('clearing filter restores groups', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-input input').fill('zzz');
    await expect(page.locator('.cmdk-group-h')).toHaveCount(0);
    await page.locator('.cmdk-input input').fill('');
    await expect(page.locator('.cmdk-group-h')).toHaveCount(4);
  });

  test('clicking project row navigates and closes', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-row', { hasText: 'ClaudePit' }).first().click();
    await expect(page.locator('.cmdk')).toHaveCount(0);
    await expect(page.locator('.proj-hero h1', { hasText: 'ClaudePit' })).toBeVisible();
  });

  test('Go to Inbox action navigates', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-row', { hasText: 'Go to Inbox' }).click();
    await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();
  });

  test('Go to Tags action navigates', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-row', { hasText: 'Go to Tags' }).click();
    await expect(page.locator('h1', { hasText: 'Tags' })).toBeVisible();
  });

  test('first row in first group has active class on initial render', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    const first = page.locator('.cmdk-row').first();
    await expect(first).toHaveClass(/active/);
  });

  test('Esc closes', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.keyboard.press('Escape');
    await expect(page.locator('.cmdk')).toHaveCount(0);
  });

  test('clicking overlay closes', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk')).toBeVisible();
    const overlay = page.locator('.cmdk-overlay');
    const box = await overlay.boundingBox();
    if (!box) throw new Error('overlay box not found');
    // Top edge of the overlay is empty space above the centered palette.
    await overlay.click({ position: { x: Math.floor(box.width / 2), y: 4 } });
    await expect(page.locator('.cmdk')).toHaveCount(0);
  });

  test('clicking inside palette stays open', async ({ page }) => {
    await page.keyboard.press('Meta+KeyK');
    await page.locator('.cmdk-input').click();
    await expect(page.locator('.cmdk')).toBeVisible();
  });
});
