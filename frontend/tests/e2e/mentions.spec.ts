import { expect, test, type Page } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

async function gotoMentions(page: Page) {
  await page.goto('/');
  await waitForAppReady(page);
  if ((page.viewportSize()?.width ?? 0) < 820) {
    await page.locator('.mtab', { hasText: 'More' }).click();
    await page.locator('.m-sheet-row', { hasText: 'Mentions' }).click();
  } else {
    await page.locator('.sb-item:has(.label:text-is("Mentions"))').click();
  }
  await expect(page.locator('h1', { hasText: 'Find Mentions' })).toBeVisible();
}

test.describe('Mentions page', () => {
  test('@smoke heading visible', async ({ page }) => {
    await gotoMentions(page);
    await expect(page.locator('h1', { hasText: 'Find Mentions' })).toBeVisible();
  });

  test('search input pre-filled', async ({ page }) => {
    await gotoMentions(page);
    await expect(page.locator('.todo-input-row .field input')).toHaveValue('subscription cookies');
  });

  test('All mentions chip active by default', async ({ page }) => {
    await gotoMentions(page);
    await expect(page.locator('.filter-chip.active', { hasText: 'All mentions' })).toBeVisible();
  });

  test('renders 4 hits', async ({ page }) => {
    await gotoMentions(page);
    await expect(page.locator('.doc-row')).toHaveCount(4);
  });

  test('hits show retrieval-path tags and score', async ({ page }) => {
    await gotoMentions(page);
    const first = page.locator('.doc-row').first();
    await expect(first.locator('.tag').first()).toBeVisible();
    await expect(first).toContainText('score');
  });

  test('hits show entity-kind tag', async ({ page }) => {
    await gotoMentions(page);
    const first = page.locator('.doc-row').first();
    await expect(first.locator('.tag.kind-note, .tag.kind-doc, .tag.kind-todo').first()).toBeVisible();
  });
});
