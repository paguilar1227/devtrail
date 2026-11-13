// Theme persistence (SET-1) — the settings-modal toggle is covered per-device
// by the existing settings specs; this adds the reload-persistence contract.

import { expect, test } from '../helpers/setup';
import { openSettings } from '../helpers/nav';
import { waitForAppReady } from '../helpers/utils';

export function defineThemeTests() {
  test('theme: choice made in Settings survives a reload', async ({ page }) => {
    await openSettings(page);

    const initial = await page.evaluate(() => document.documentElement.dataset.theme);
    const target = initial === 'dark' ? 'light' : 'dark';
    await page
      .locator(`.modal .thm-toggle button[aria-label="${target === 'dark' ? 'Dark' : 'Light'} theme"]`)
      .click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(target);

    await page.reload();
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(target);

    // Restore so theme state never leaks into other specs.
    await page.evaluate((t) => localStorage.setItem('devtrail.theme', t as string), initial ?? 'dark');
  });
}
