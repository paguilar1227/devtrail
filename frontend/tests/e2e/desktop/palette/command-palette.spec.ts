// Command palette (CMDK-1..4) — desktop only: the palette's sole entry
// point is Cmd/Ctrl+K, which has no mobile affordance (documented exclusion
// in the coverage plan).
import type { Page } from '@playwright/test';
import { createTodo } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';

const open = async (page: Page) => {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('.cmdk')).toBeVisible();
};

test('palette: Cmd/Ctrl+K opens; Esc and overlay click both close', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmdk')).toHaveCount(0);

  await open(page);
  // Click the overlay well away from the centered panel.
  await page.locator('.cmdk-overlay').click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.cmdk')).toHaveCount(0);
});

test('palette: typing a project name filters; clicking routes to the project', async ({ page }) => {
  await open(page);
  await page.locator('.cmdk-input input').fill('ClaudePit');
  const row = page.locator('.cmdk-row', { hasText: 'ClaudePit' }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('.proj-hero h1')).toHaveText('ClaudePit');
});

test('palette: actions — toggle theme flips data-theme, Create new project opens the modal', async ({ page }) => {
  const initial = await page.evaluate(() => document.documentElement.dataset.theme);
  await open(page);
  await page.locator('.cmdk-input input').fill('theme');
  await page.locator('.cmdk-row', { hasText: /Switch to (light|dark) theme/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(initial);
  // Restore for later specs.
  await page.evaluate((t) => localStorage.setItem('ob.theme', t as string), initial ?? 'dark');

  await open(page);
  await page.locator('.cmdk-input input').fill('Create new');
  await page.locator('.cmdk-row', { hasText: 'Create new project' }).click();
  await expect(page.locator('.modal-head h3', { hasText: 'New project' })).toBeVisible();
});

test('palette: entity search surfaces a todo hit that opens the detail drawer', async ({ page }) => {
  const title = `${stamp()} palette quarry`;
  await createTodo(title, null);

  await open(page);
  await page.locator('.cmdk-input input').fill('palette quarry');
  const hit = page.locator('.cmdk-row', { hasText: title }).first();
  await expect(hit).toBeVisible();
  await hit.click();

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await expect(drawer).toContainText(title);
});

test('palette: Search… action lands on home with the search bar focused (intent fix)', async ({ page }) => {
  await open(page);
  await page.locator('.cmdk-input input').fill('Search');
  await page.locator('.cmdk-row', { hasText: 'Search…' }).click();

  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  await expect(page.locator('.home-search-box input')).toBeFocused();
});

test('palette: advertised G-then-<key> sequences navigate (intent fix)', async ({ page }) => {
  // The sequences the palette advertises in its action subtitles.
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page.locator('h1', { hasText: 'Tags' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  // Typing in a field must NOT trigger the sequence.
  const input = page.locator('.home-search-box input');
  await input.click();
  await input.pressSequentially('gt');
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  await expect(input).toHaveValue(/gt/);
});
