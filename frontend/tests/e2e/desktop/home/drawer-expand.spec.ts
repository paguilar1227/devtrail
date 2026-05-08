// Drawer expand/collapse — the right-rail drawer (todo detail, doc reader)
// has an expand toggle in its header that pulls it into the center of the
// viewport for more breathing room. Walks: open a todo from the activity
// widget → drawer is right-rail → click Expand → drawer is centered &
// wider → click Collapse → drawer is back to right-rail.
import { expect, test } from '@playwright/test';
import '../../helpers/setup';

test('drawer: expand toggle moves the right-rail drawer to centered/wider and back', async ({ page }) => {
  await expect(page.locator('.stat-activity .arows')).toBeVisible();
  // Open whatever the first activity row points at — any of the modals
  // share the same Drawer primitive, so the toggle behavior is identical.
  await page.locator('.stat-activity .arow').first().click();
  const drawer = page.locator('.drawer');
  // Click triggers an async fetch for the full entity — give CI's
  // slower runner room to finish before asserting.
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await expect(drawer).not.toHaveClass(/drawer-expanded/);

  // Default: ~480px wide, anchored 12px from the right edge.
  const before = await drawer.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), rightGap: Math.round(window.innerWidth - r.right) };
  });
  expect(before.width).toBeLessThan(560);
  expect(before.rightGap).toBeLessThan(20);

  await page.locator('.drawer-expand').click();
  await expect(drawer).toHaveClass(/drawer-expanded/);

  // Expanded: visibly wider, and the left/right gaps are roughly equal
  // (centered). We allow a small tolerance for transform rounding.
  const after = await drawer.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      width: Math.round(r.width),
      leftGap: Math.round(r.left),
      rightGap: Math.round(window.innerWidth - r.right),
    };
  });
  expect(after.width).toBeGreaterThan(before.width);
  expect(Math.abs(after.leftGap - after.rightGap)).toBeLessThanOrEqual(2);

  // Collapse goes back to the original right-rail layout.
  await page.locator('.drawer-expand').click();
  await expect(drawer).not.toHaveClass(/drawer-expanded/);
  const restored = await drawer.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), rightGap: Math.round(window.innerWidth - r.right) };
  });
  expect(restored.width).toBe(before.width);
  expect(restored.rightGap).toBe(before.rightGap);
});
