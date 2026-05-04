import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

test.describe('Mock data integrity', () => {
  test.skip(({ viewport }) => !!viewport && viewport.width < 820, 'desktop sidebar checks');

  test('sidebar Projects badge = 5', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.sb-item:has(.label:text-is("Projects")) .count')).toHaveText('5');
  });

  test('Home stats Projects = 5', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.stats .stat-card').first().locator('.vl')).toHaveText('5');
  });

  test('Pinned projects count = 2', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const section = page.locator('.section').filter({ has: page.locator('h2', { hasText: 'Pinned projects' }) });
    await expect(section.locator('.proj-card')).toHaveCount(2);
  });

  test('Inbox count badge = 4 in sidebar matches count on inbox page', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.sb-item:has(.label:text-is("Inbox")) .count')).toHaveText('4');
    await page.locator('.sb-item:has(.label:text-is("Inbox"))').click();
    await expect(page.locator('.todo')).toHaveCount(4);
  });

  test('document project_ids resolve to project names in DocReader', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item:has(.label:text-is("ClaudePit"))').click();
    await page.locator('.tabs .tab', { hasText: 'Documents' }).click();
    // d-cp-3 belongs to claudepit + homelab
    await page.locator('.doc-row', { hasText: 'Tailscale' }).locator('.nm').click();
    await expect(page.locator('.drawer')).toBeVisible();
    await expect(page.locator('.drawer-body .tag', { hasText: 'ClaudePit' })).toBeVisible();
    await expect(page.locator('.drawer-body .tag', { hasText: 'Homelab' })).toBeVisible();
  });

  test('todo comments count matches drawer comments rendered', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item:has(.label:text-is("ClaudePit"))').click();
    await page.locator('.tabs .tab', { hasText: 'Todos' }).click();
    await page.locator('.todo .nm', { hasText: 'Wire up streaming' }).first().click();
    // t1 has 3 comments in COMMENTS fixture
    await expect(page.locator('.drawer .comment')).toHaveCount(3);
  });
});
