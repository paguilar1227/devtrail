// More sheet → Todos (MORE-M-1) — the workspace-nav spec covers Notes /
// Activity / Tags / Archived; Todos was the missing row.
import { test, expect, MORE_SHEET, openMoreSheet } from '../../helpers/setup';

test('mobile more: Todos row routes to the Todos view and the sheet closes', async ({ page }) => {
  await openMoreSheet(page);
  await page.locator(`${MORE_SHEET} .m-sheet-row`, { hasText: 'Todos' }).click();
  await expect(page.locator('.todos-view')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('h1', { hasText: 'Todos' })).toBeVisible();
  await expect(page.locator(MORE_SHEET)).toHaveCount(0);
});
