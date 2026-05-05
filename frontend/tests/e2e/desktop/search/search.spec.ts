import { expect, test } from '@playwright/test';
import '../../helpers/setup';

test('search: known seed term returns at least one hit', async ({ page }) => {
  // Search isn't a sidebar nav item — reach it via Cmd-K → Go to Search.
  await page.keyboard.press('Meta+k');
  await page.locator('.cmdk').getByText('Go to Search').click();
  await expect(page.locator('h1', { hasText: 'Search' })).toBeVisible();

  // SearchPage uses .todo-input-row .field input (NOT the readonly topbar one).
  const input = page.locator('.todo-input-row .field input').first();
  await input.fill('Tailscale');
  await input.press('Enter');
  // Results render inside .page-narrow as .doc-row entries.
  await expect(page.locator('.page-narrow .doc-row').first()).toBeVisible({ timeout: 15_000 });
});
