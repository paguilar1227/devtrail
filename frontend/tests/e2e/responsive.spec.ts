import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

const VIEWPORTS = [
  { name: '360', width: 360, height: 640 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
];

test.describe('Responsive — chrome surfaces', () => {
  for (const v of VIEWPORTS) {
    test(`shell at ${v.name} renders correct chrome`, async ({ page }) => {
      await page.setViewportSize({ width: v.width, height: v.height });
      await page.goto('/');
      await waitForAppReady(page);
      if (v.width < 820) {
        await expect(page.locator('aside.sidebar')).toHaveCount(0);
        await expect(page.locator('nav.mobile-tabbar.show')).toBeVisible();
      } else {
        await expect(page.locator('aside.sidebar')).toBeVisible();
        await expect(page.locator('nav.mobile-tabbar')).toHaveCount(0);
      }
    });
  }
});

test.describe('Responsive — page integrity', () => {
  for (const v of VIEWPORTS) {
    test(`Home renders without error at ${v.name}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.setViewportSize({ width: v.width, height: v.height });
      await page.goto('/');
      await waitForAppReady(page);
      await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  for (const v of VIEWPORTS) {
    test(`Project detail Chat renders at ${v.name}`, async ({ page }) => {
      await page.setViewportSize({ width: v.width, height: v.height });
      await page.goto('/');
      await waitForAppReady(page);
      if (v.width < 820) {
        await page.locator('.mtab', { hasText: 'Projects' }).click();
        await page.locator('.proj-card', { hasText: 'ClaudePit' }).first().click();
      } else {
        await page.locator('.sb-item:has(.label:text-is("ClaudePit"))').click();
      }
      await expect(page.locator('.composer textarea')).toBeVisible();
    });
  }
});
