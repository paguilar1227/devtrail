import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

test.describe('Accessibility — roles & focus', () => {
  test('modal has role=dialog and aria-modal', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop new-project trigger');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item.dim:has(.label:text-is("New project"))').click();
    const dialog = page.locator('.modal');
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  test('tabs use role=tablist and tabs have role=tab', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop sidebar nav');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item:has(.label:text-is("ClaudePit"))').click();
    await expect(page.locator('.tabs')).toHaveAttribute('role', 'tablist');
    const tabs = page.locator('.tabs .tab');
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      await expect(tabs.nth(i)).toHaveAttribute('role', 'tab');
    }
  });

  test('mobile sheet has aria-label', async ({ page, viewport }) => {
    test.skip(!viewport || viewport.width >= 820, 'mobile only');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.mtab', { hasText: 'More' }).click();
    await expect(page.locator('.m-sheet')).toHaveAttribute('aria-label', 'More');
  });

  test('NewProject modal autofocuses Name input', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop trigger');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item.dim:has(.label:text-is("New project"))').click();
    await expect(page.locator('.modal input').first()).toBeFocused();
  });

  test('command palette autofocuses search input', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk-input input')).toBeFocused();
  });
});
