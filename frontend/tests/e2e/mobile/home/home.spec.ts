// Home dashboard on mobile (HOME-M-1..3) — parity with desktop
// desktop/home/home.spec.ts. Same selectors (the dashboard reflows below
// 820px but keeps its structure); the sidebar assertions are replaced by
// the tabbar, which waitForAppReady already gates on.
import { expect, test } from '../../helpers/setup';

test('home mobile: structure renders — hero, search, columns, activity, pinned strip', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  await expect(page.locator('.home-search-box input')).toBeVisible();
  await expect(page.locator('.home-scope-toggle button', { hasText: 'Personal' })).toHaveClass(/active/);

  const todosCol = page.locator('.home-personal-grid .pcol').filter({ has: page.locator('h3:text-is("Todos")') });
  const notesCol = page.locator('.home-personal-grid .pcol').filter({ has: page.locator('h3:text-is("Notes")') });
  await expect(todosCol).toBeVisible();
  await expect(notesCol).toBeVisible();
  await expect(todosCol.locator('.pcol-add input')).toBeVisible();
  await expect(notesCol.locator('.pcol-add input')).toBeVisible();

  const docsCol = page.locator('.home-top-row .pcol').filter({ has: page.locator('h3:text-is("Documents")') });
  await expect(docsCol).toBeVisible();
  await expect(page.locator('.home-top-row .stat-activity')).toBeVisible();

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
