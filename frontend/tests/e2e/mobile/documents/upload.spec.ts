// Upload modal on mobile (UP-M-1..2) — parity with
// desktop/documents/documents.spec.ts, reached via the Projects tab grid.
import { expect, test } from '../../helpers/setup';
import { gotoProjectPage } from '../../helpers/nav';

test('upload mobile: Add opens the modal; a queued URL stays in the queue', async ({ page }) => {
  await gotoProjectPage(page, 'ClaudePit');
  await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
  await expect(page.locator('.modal-head h3', { hasText: /Add to/ })).toBeVisible();

  await page.locator('.modal input[placeholder*="https"]').fill('https://example.com/mobile-article');
  await page.locator('.modal .btn', { hasText: 'Queue' }).click();
  await expect(page.locator('.modal').getByText('https://example.com/mobile-article')).toBeVisible();
});

test('upload mobile: default-tags editor autocompletes existing project tags', async ({ page }) => {
  await gotoProjectPage(page, 'ClaudePit');
  await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
  const modal = page.locator('.modal');
  await expect(modal.locator('.modal-head h3', { hasText: /Add to/ })).toBeVisible();

  await modal.locator('button.btn-ghost.btn-sm', { hasText: 'Add' }).click();
  await modal.locator('.input-tag').fill('au');
  const suggestion = modal.locator('.typeahead-popover .typeahead-row', { hasText: 'auth' });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(modal.locator('.tag', { hasText: 'auth' }).first()).toBeVisible();
});
