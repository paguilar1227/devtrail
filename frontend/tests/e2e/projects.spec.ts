import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

async function gotoProjects(page: import('@playwright/test').Page) {
  await page.goto('/');
  await waitForAppReady(page);
  // Navigate via sidebar (desktop) or mobile tabbar
  if ((page.viewportSize()?.width ?? 0) < 820) {
    await page.locator('.mtab', { hasText: 'Projects' }).click();
  } else {
    await page.locator('.sb-item:has(.label:text-is("Projects"))').click();
  }
  await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();
}

test.describe('Projects page', () => {
  test('@smoke heading visible', async ({ page }) => {
    await gotoProjects(page);
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();
  });

  test('New project button opens modal', async ({ page }) => {
    await gotoProjects(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'New project' }).click();
    await expect(page.locator('.modal')).toBeVisible();
  });

  test('filter chips render Active / Archived / All', async ({ page }) => {
    await gotoProjects(page);
    await expect(page.locator('.filter-chip', { hasText: 'Active' })).toBeVisible();
    await expect(page.locator('.filter-chip', { hasText: 'Archived' })).toBeVisible();
    await expect(page.locator('.filter-chip', { hasText: 'All' })).toBeVisible();
  });

  test('default filter is Active and shows 5 projects', async ({ page }) => {
    await gotoProjects(page);
    await expect(page.locator('.filter-chip.active', { hasText: 'Active' })).toBeVisible();
    await expect(page.locator('.proj-grid .proj-card')).toHaveCount(5);
  });

  test('Archived filter shows only archived projects', async ({ page }) => {
    await gotoProjects(page);
    await page.locator('.filter-chip', { hasText: 'Archived' }).click();
    await expect(page.locator('.proj-grid .proj-card')).toHaveCount(1);
    await expect(page.locator('.proj-grid .proj-card', { hasText: 'MCP E2E Test v2' })).toBeVisible();
  });

  test('All filter shows 6 projects', async ({ page }) => {
    await gotoProjects(page);
    await page.locator('.filter-chip', { hasText: 'All' }).click();
    await expect(page.locator('.proj-grid .proj-card')).toHaveCount(6);
  });

  test('grid is default view; List toggle switches to list view', async ({ page }) => {
    await gotoProjects(page);
    await expect(page.locator('.proj-grid')).toBeVisible();
    await page.locator('.seg-toggle button', { hasText: 'List' }).click();
    await expect(page.locator('.proj-grid')).toHaveCount(0);
    await expect(page.locator('.row-list')).toBeVisible();
  });

  test('Grid toggle returns to grid', async ({ page }) => {
    await gotoProjects(page);
    await page.locator('.seg-toggle button', { hasText: 'List' }).click();
    await page.locator('.seg-toggle button', { hasText: 'Grid' }).click();
    await expect(page.locator('.proj-grid')).toBeVisible();
  });

  test('first two cards have size-lg', async ({ page }) => {
    await gotoProjects(page);
    const cards = page.locator('.proj-grid .proj-card');
    await expect(cards.nth(0)).toHaveClass(/size-lg/);
    await expect(cards.nth(1)).toHaveClass(/size-lg/);
    await expect(cards.nth(2)).toHaveClass(/size-md/);
  });

  test('clicking a card navigates to project detail', async ({ page }) => {
    await gotoProjects(page);
    await page.locator('.proj-card', { hasText: 'ClaudePit' }).first().click();
    await expect(page.locator('.proj-hero h1', { hasText: 'ClaudePit' })).toBeVisible();
  });

  test('list view click navigates; more icon does not', async ({ page }) => {
    await gotoProjects(page);
    await page.locator('.seg-toggle button', { hasText: 'List' }).click();
    // Click more on first row — should NOT navigate
    await page.locator('.row-list .row').first().locator('.btn-icon').click();
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();
    // Now click row body
    await page.locator('.row-list .row').first().locator('.strong').click();
    await expect(page.locator('.proj-hero h1')).not.toHaveText('Projects');
  });

  test('pinned card shows pin icon', async ({ page }) => {
    await gotoProjects(page);
    const card = page.locator('.proj-card', { hasText: 'ClaudePit' }).first();
    await expect(card.locator('.ph svg').last()).toBeVisible();
  });
});
