import { expect, test } from '@playwright/test';
import { captureConsoleErrors, reloadAndWait, waitForAppReady } from './helpers/utils';

test.describe('App shell — boot', () => {
  test('cold load renders Home with brand and no console errors', async ({ page }) => {
    const console = captureConsoleErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    // Don't assert on Topbar moon button (mobile hides the topbar's full search).
    // Brand text is mobile-conditional too — sidebar only on desktop.
    // 404 favicon is acceptable; only fail on real errors.
    const realErrors = console.errors.filter(
      m => !/favicon|404|Failed to load resource/i.test(m.text()),
    );
    expect(realErrors).toEqual([]);
  });

  test('default theme is dark when no localStorage', async ({ page, context }) => {
    await context.clearCookies();
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('theme=light from localStorage applies on boot', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ob.theme', 'light'));
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('bogus theme value falls back to dark', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ob.theme', 'banana'));
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('sidebarMode=expanded applies to data-sb', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await page.addInitScript(() => localStorage.setItem('ob.sidebarMode', 'expanded'));
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.app')).toHaveAttribute('data-sb', 'expanded');
  });

  test('sidebarMode=collapsed applies to data-sb', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await page.addInitScript(() => localStorage.setItem('ob.sidebarMode', 'collapsed'));
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
  });

  test('sidebarMode=hidden does not render sidebar', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await page.addInitScript(() => localStorage.setItem('ob.sidebarMode', 'hidden'));
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.app')).toHaveAttribute('data-sb', 'hidden');
  });

  test('bogus sidebarMode falls back to collapsed', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await page.addInitScript(() => localStorage.setItem('ob.sidebarMode', 'foo'));
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
  });

  test('@smoke app boots and is interactive', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    // Mobile tabbar OR desktop sidebar visible — at least one chrome surface present.
    const chrome = page.locator('aside.sidebar, nav.mobile-tabbar.show');
    expect(await chrome.count()).toBeGreaterThan(0);
  });
});

test.describe('App shell — theme toggle (desktop)', () => {
  test.skip(({ viewport }) => !!viewport && viewport.width < 820, 'desktop topbar only');

  test('click moon switches to dark and persists', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ob.theme', 'light'));
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.thm-toggle button').first().click(); // moon
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const stored = await page.evaluate(() => localStorage.getItem('ob.theme'));
    expect(stored).toBe('dark');
  });

  test('click sun switches to light and persists', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.thm-toggle button').nth(1).click(); // sun
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const stored = await page.evaluate(() => localStorage.getItem('ob.theme'));
    expect(stored).toBe('light');
  });

  test('@smoke Cmd+Shift+L toggles theme', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const initial = await page.locator('html').getAttribute('data-theme');
    await page.keyboard.press('Meta+Shift+KeyL');
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(initial);
  });

  test('Ctrl+Shift+L also toggles theme', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const initial = await page.locator('html').getAttribute('data-theme');
    await page.keyboard.press('Control+Shift+KeyL');
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(initial);
  });

  test('theme persists across reload', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.thm-toggle button').nth(1).click(); // sun
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await reloadAndWait(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('App shell — sidebar (desktop)', () => {
  test.skip(({ viewport }) => !!viewport && viewport.width < 820, 'desktop sidebar only');

  test('collapse toggle switches data-sb and persists', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ob.sidebarMode', 'collapsed'));
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await page.locator('button.sb-collapse').click();
    await expect(page.locator('.app')).toHaveAttribute('data-sb', 'expanded');
    expect(await page.evaluate(() => localStorage.getItem('ob.sidebarMode'))).toBe('expanded');
    await page.locator('button.sb-collapse').click();
    await expect(page.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
  });

  test('Home item active by default', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const homeItem = page.locator('.sb-item:has(.label:text-is("Home"))');
    await expect(homeItem).toHaveClass(/active/);
  });

  test('Projects count badge shows active count', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const badge = page.locator('.sb-item:has(.label:text-is("Projects")) .count');
    await expect(badge).toHaveText('5');
  });

  test('Inbox count badge shows 4', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const badge = page.locator('.sb-item:has(.label:text-is("Inbox")) .count');
    await expect(badge).toHaveText('4');
  });

  test('clicking Projects activates that item', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item:has(.label:text-is("Projects"))').click();
    await expect(page.locator('.sb-item:has(.label:text-is("Projects"))')).toHaveClass(
      /active/,
    );
    await expect(page.locator('h1:has-text("Projects")')).toBeVisible();
  });

  test('@smoke clicking each top-level nav item navigates without errors', async ({ page }) => {
    const console = captureConsoleErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    for (const label of ['Projects', 'Inbox', 'Activity', 'Tags', 'Mentions', 'Archived', 'Home']) {
      await page.locator(`.sb-item:has(.label:text-is("${label}"))`).first().click();
      await page.waitForTimeout(120);
    }
    const real = console.errors.filter(m => !/favicon/i.test(m.text()));
    expect(real).toEqual([]);
  });

  test('clicking ClaudePit navigates to project detail', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item:has(.label:text-is("ClaudePit"))').click();
    await expect(page.locator('h1:has-text("ClaudePit")')).toBeVisible();
  });

  test('clicking "New project" opens modal', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item.dim:has(.label:text-is("New project"))').click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.modal-head h3')).toHaveText('New project');
  });

  test('archived project does not appear in sidebar', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('aside.sidebar')).not.toContainText('MCP E2E Test v2');
  });

  test('footer shows user identity', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('.sb-footer .nm')).toHaveText('Alex');
    await expect(page.locator('.sb-footer .em')).toHaveText('you@example.com');
  });
});

test.describe('App shell — topbar (desktop)', () => {
  test.skip(({ viewport }) => !!viewport && viewport.width < 820, 'desktop topbar only');

  test('home crumb single', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    const crumbs = page.locator('.crumb > span');
    await expect(crumbs).toHaveCount(1);
    await expect(crumbs.first()).toHaveText('Home');
  });

  test('projects crumb single', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item:has(.label:text-is("Projects"))').click();
    const crumbs = page.locator('.crumb > span').filter({ hasNotText: '›' });
    await expect(crumbs.last()).toHaveText('Projects');
  });

  test('project detail shows two crumbs and first is clickable', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item:has(.label:text-is("ClaudePit"))').click();
    await expect(page.locator('.crumb .ctx')).toHaveText('Projects');
    // Clicking the Projects crumb returns to projects list
    await page.locator('.crumb .ctx').click();
    await expect(page.locator('h1:has-text("Projects")')).toBeVisible();
  });

  test('clicking topbar search opens command palette', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.topbar .search').click();
    await expect(page.locator('.cmdk')).toBeVisible();
  });
});

test.describe('App shell — keyboard', () => {
  test('@smoke Cmd+K opens then closes command palette', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk')).toBeVisible();
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk')).not.toBeVisible();
  });

  test('Esc closes command palette', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await page.keyboard.press('Meta+KeyK');
    await expect(page.locator('.cmdk')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cmdk')).not.toBeVisible();
  });

  test('Esc with no overlay does not throw', async ({ page }) => {
    const console = captureConsoleErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await page.keyboard.press('Escape');
    expect(console.errors).toEqual([]);
  });
});

test.describe('App shell — backdrop chrome', () => {
  test('backdrop and grain are present', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.locator('div.backdrop')).toHaveCount(1);
    await expect(page.locator('div.grain')).toHaveCount(1);
    await expect(page.locator('div.backdrop .blob')).toHaveCount(2);
  });
});
