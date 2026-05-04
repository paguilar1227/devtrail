import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

test.describe('Home page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('@smoke heading visible', async ({ page }) => {
    await expect(page.locator('h1', { hasText: /Welcome back/ })).toBeVisible();
  });

  test('subtitle mentions processing/inbox/pinned', async ({ page }) => {
    const subtitle = page.locator('.proj-hero .page-subtle');
    await expect(subtitle).toContainText('document processing');
    await expect(subtitle).toContainText('todos in your inbox');
    await expect(subtitle).toContainText('active projects pinned');
  });

  test('New project button opens modal', async ({ page }) => {
    await page.locator('.proj-hero .btn-primary', { hasText: 'New project' }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.modal-head h3')).toHaveText('New project');
  });

  test('renders 4 stat cards', async ({ page }) => {
    await expect(page.locator('.stats .stat-card')).toHaveCount(4);
  });

  test('stat card values match mock', async ({ page }) => {
    const cards = page.locator('.stats .stat-card');
    await expect(cards.nth(0).locator('.lb')).toHaveText('Projects');
    await expect(cards.nth(0).locator('.vl')).toHaveText('5');
    await expect(cards.nth(1).locator('.lb')).toHaveText('Documents');
    await expect(cards.nth(1).locator('.vl')).toHaveText('50');
    await expect(cards.nth(2).locator('.lb')).toHaveText('Notes');
    await expect(cards.nth(2).locator('.vl')).toHaveText('46');
    await expect(cards.nth(3).locator('.lb')).toHaveText('Todos');
    await expect(cards.nth(3).locator('.vl')).toHaveText('23/48');
  });

  test('todos card shows percentage', async ({ page }) => {
    await expect(page.locator('.stats .stat-card').nth(3).locator('.ds')).toContainText('% complete');
  });

  test('each stat card has a sparkline', async ({ page }) => {
    await expect(page.locator('.stats .stat-card .spark svg')).toHaveCount(4);
  });

  test('pinned projects section renders 2 cards', async ({ page }) => {
    const section = page.locator('.section').filter({ has: page.locator('h2', { hasText: 'Pinned projects' }) });
    await expect(section.locator('.proj-card')).toHaveCount(2);
  });

  test('clicking a pinned card navigates to project detail', async ({ page }) => {
    await page.locator('.proj-card', { hasText: 'ClaudePit' }).first().click();
    await expect(page.locator('.proj-hero h1', { hasText: 'ClaudePit' })).toBeVisible();
  });

  test('All projects → button navigates to projects', async ({ page }) => {
    await page.locator('.section-head .btn', { hasText: 'All projects' }).click();
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();
  });

  test('inbox preview section visible with up to 4 todos', async ({ page }) => {
    const section = page.locator('.section').filter({ has: page.locator('h2', { hasText: 'Inbox' }) });
    const rows = section.locator('.row-list .row');
    await expect(rows).toHaveCount(4);
  });

  test('inbox preview rows show due-at chip when due_at is set', async ({ page }) => {
    // Mock data has all due_at as future (negative ago()), so no .due-overdue.
    // Just assert that a due chip renders for items with due_at.
    const section = page.locator('.section').filter({ has: page.locator('h2', { hasText: 'Inbox' }) });
    await expect(section.getByText(/^due /).first()).toBeVisible();
  });

  test('Open inbox → button navigates', async ({ page }) => {
    await page.locator('.section-head .btn', { hasText: 'Open inbox' }).click();
    await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();
  });

  test('Recent activity section renders 6 events', async ({ page }) => {
    const section = page.locator('.section').filter({ has: page.locator('h2', { hasText: 'Recent activity' }) });
    await expect(section.locator('.activity-row')).toHaveCount(6);
  });

  test('activity row icons match kind', async ({ page }) => {
    const section = page.locator('.section').filter({ has: page.locator('h2', { hasText: 'Recent activity' }) });
    // Each row has an .activity-icon with a kind class (ingest/edit/comment).
    const rows = section.locator('.activity-row');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const cls = await rows.nth(i).locator('.activity-icon').getAttribute('class');
      expect(cls).toMatch(/(ingest|edit|comment)/);
    }
  });

  test('Full feed → button navigates to activity', async ({ page }) => {
    await page.locator('.section-head .btn', { hasText: 'Full feed' }).click();
    await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
  });
});
