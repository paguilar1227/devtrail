// Home on mobile (HOME-M-1..3) — parity with desktop desktop/home/home.spec.ts.
// Same selectors (the page reflows below 820px but keeps its structure); the
// sidebar assertions are replaced by the tabbar, which waitForAppReady
// already gates on.
import { expect, test } from '../../helpers/setup';

test('home mobile: structure renders — hero, search, tab strip, todos panel, pinned strip', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  await expect(page.locator('.home-search-box input')).toBeVisible();
  await expect(page.locator('.home-scope-toggle button', { hasText: 'Personal' })).toHaveClass(/active/);

  // Tab strip: 4 tabs, Todos active by default, its panel mounted.
  const tabs = page.locator('.home-tabs-row .tab');
  await expect(tabs).toHaveCount(4);
  await expect(tabs.filter({ hasText: 'Todos' })).toHaveClass(/active/);
  await expect(page.locator('.todos-panel')).toBeVisible();
  await expect(page.locator('.todos-panel .todo-input-row .field input')).toBeVisible();

  // Switching tabs swaps the panel.
  await tabs.filter({ hasText: 'Notes' }).click();
  await expect(page.locator('.notes-panel')).toBeVisible();
  await tabs.filter({ hasText: 'Todos' }).click();
  await expect(page.locator('.todos-panel')).toBeVisible();

  await expect(page.locator('.home-pinned-strip .pin-chip').first()).toBeVisible();
});

test('home mobile: scope toggle flips active state', async ({ page }) => {
  const personalTab = page.locator('.home-scope-toggle button', { hasText: 'Personal' });
  const allTab = page.locator('.home-scope-toggle button', { hasText: 'All projects' });

  await allTab.click();
  await expect(allTab).toHaveClass(/active/);
  await expect(personalTab).not.toHaveClass(/active/);

  await personalTab.click();
  await expect(personalTab).toHaveClass(/active/);
  await expect(allTab).not.toHaveClass(/active/);
});

test('home mobile: pinned chip routes to the project page', async ({ page }) => {
  const firstChip = page.locator('.home-pinned-strip .pin-chip').first();
  const name = (await firstChip.innerText()).trim();
  await firstChip.click();
  await expect(page.locator('.proj-hero h1', { hasText: name })).toBeVisible();
});
