// On mobile the right-rail drawer leaves a sliver of background on the
// right edge — half-completed-modal feel. This pins the fullscreen
// behavior: the drawer covers the entire viewport, and the desktop-only
// expand toggle is hidden so the header isn't cluttered.
import { expect, test } from '@playwright/test';
import '../../helpers/setup';

test('drawer: covers the full viewport on mobile and hides the expand toggle', async ({ page }) => {
  await expect(page.locator('.stat-activity .arows')).toBeVisible();
  await page.locator('.stat-activity .arow').first().click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();

  // Drawer should fill the viewport — no offset on any side.
  const dims = await drawer.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      left: r.left,
      rightGap: window.innerWidth - r.right,
      bottomGap: window.innerHeight - r.bottom,
      width: Math.round(r.width),
      vw: window.innerWidth,
    };
  });
  expect(dims.top).toBe(0);
  expect(dims.left).toBe(0);
  expect(dims.rightGap).toBe(0);
  expect(dims.bottomGap).toBe(0);
  expect(dims.width).toBe(dims.vw);

  // The expand toggle is desktop-only — show it on mobile and the
  // drawer-head gets too cluttered for the available space.
  await expect(page.locator('.drawer-expand')).toBeHidden();
});
