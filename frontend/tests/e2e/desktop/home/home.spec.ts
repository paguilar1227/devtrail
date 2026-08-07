// Home — the tabbed landing page. Asserts the structure renders: hero
// greeting, search row + scope toggle, the Todos|Notes|Documents|Activity
// tab strip (Todos active by default, its panel mounted), and the Pinned
// chip strip. Behavior tests for personal todo flows live in
// personal-todos.spec.ts; tab-panel behavior lives with each panel's suite.
import { expect, test } from '../../helpers/setup';

test('home: structure renders — hero, search, scope toggle, tab strip, todos panel, pinned strip', async ({ page }) => {
  await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();

  // Search row + scope toggle (default Personal).
  await expect(page.locator('.home-search-box input')).toBeVisible();
  const personalTab = page.locator('.home-scope-toggle button', { hasText: 'Personal' });
  const allTab = page.locator('.home-scope-toggle button', { hasText: 'All projects' });
  await expect(personalTab).toHaveClass(/active/);
  await expect(allTab).not.toHaveClass(/active/);

  // Personal heading + the tab strip: 4 tabs, Todos active by default.
  await expect(page.locator('.home-personal-h h2', { hasText: 'Personal' })).toBeVisible();
  const tabs = page.locator('.home-tabs-row .tab');
  await expect(tabs).toHaveCount(4);
  for (const label of ['Todos', 'Notes', 'Documents', 'Activity']) {
    await expect(tabs.filter({ hasText: label })).toBeVisible();
  }
  await expect(tabs.filter({ hasText: 'Todos' })).toHaveClass(/active/);

  // Default tab body is the shared todos panel with its quick-add row.
  await expect(page.locator('.todos-panel')).toBeVisible();
  await expect(page.locator('.todos-panel .todo-input-row .field input')).toBeVisible();

  // Seed has 2 pinned projects → strip exists with at least one chip.
  await expect(page.locator('.home-pinned-strip .pin-chip').first()).toBeVisible();
});

test('home: tab strip swaps panels — Notes, Documents, Activity, back to Todos', async ({ page }) => {
  const tab = (label: string) => page.locator('.home-tabs-row .tab', { hasText: label });

  await tab('Notes').click();
  await expect(tab('Notes')).toHaveClass(/active/);
  await expect(page.locator('.notes-panel')).toBeVisible();
  await expect(page.locator('.todos-panel')).toHaveCount(0);

  await tab('Documents').click();
  await expect(page.locator('.documents-panel')).toBeVisible();

  await tab('Activity').click();
  await expect(page.locator('.stat-activity.home-activity-tab')).toBeVisible();

  await tab('Todos').click();
  await expect(page.locator('.todos-panel')).toBeVisible();
});

test('home: scope toggle flips active state', async ({ page }) => {
  const personalTab = page.locator('.home-scope-toggle button', { hasText: 'Personal' });
  const allTab = page.locator('.home-scope-toggle button', { hasText: 'All projects' });

  await allTab.click();
  await expect(allTab).toHaveClass(/active/);
  await expect(personalTab).not.toHaveClass(/active/);

  await personalTab.click();
  await expect(personalTab).toHaveClass(/active/);
  await expect(allTab).not.toHaveClass(/active/);
});

test('home: pinned chip routes to the project page', async ({ page }) => {
  // Click the first pinned chip and confirm the project hero renders.
  const firstChip = page.locator('.home-pinned-strip .pin-chip').first();
  const name = (await firstChip.innerText()).trim();
  await firstChip.click();
  await expect(page.locator('.proj-hero h1', { hasText: name })).toBeVisible();
});
