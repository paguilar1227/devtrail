import type { Locator } from '@playwright/test';
import { test, expect, stamp } from '../helpers/setup';
import { gotoView, openSettings } from '../helpers/nav';

async function assertAccentContrast(control: Locator) {
  const contrast = await control.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = (value: string) => {
      const rgb = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const a = luminance(style.color);
    const b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5); // WCAG AA normal-text contrast.
}

export function defineLiteThemeTests() {
  test('Lite theme: light is the initial theme and bundled fonts load', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 247, 240)');
    await expect(page.locator('.main')).toHaveCSS('border-radius', '0px');
    await expect(page.locator('.main')).toHaveCSS('font-family', /Inter Variable/);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('14px "Inter Variable"'))).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('12px "Geist Mono Variable"'))).toBe(true);
    await expect(page.locator('.backdrop .blob').first()).toHaveCSS('display', 'none');
    const capture = await page.locator('.todo-input-row').evaluate(row => ({
      right: row.getBoundingClientRect().right,
      buttonRight: row.querySelector('button')!.getBoundingClientRect().right,
    }));
    expect(capture.buttonRight).toBeLessThanOrEqual(capture.right);
    await page.screenshot({ path: test.info().outputPath('lite-home-light.png'), fullPage: true });
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`Lite theme: ${theme} persists with readable session controls`, async ({ page }) => {
      await openSettings(page);
      await page.getByRole('button', { name: theme === 'dark' ? 'Dark theme' : 'Light theme', exact: true }).click();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', theme === 'dark' ? '#151715' : '#ffffff');
      await expect(page.locator('body')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(27, 30, 26)' : 'rgb(246, 247, 240)');
      const mobile = await page.locator('.app').getAttribute('data-mobile');
      if (mobile !== 'true') {
        const logoColor = await page.locator('.sb-brand .logo').evaluate(element => getComputedStyle(element).color);
        await expect(page.locator('.sb-brand .logo svg')).toHaveCSS('stroke', logoColor);
      }
      await gotoView(page, 'Sessions');
      const create = page.getByRole('button', { name: 'New session', exact: true });
      await expect(create).toHaveCSS('border-radius', '2px');
      await assertAccentContrast(create);
      await create.click();
      await expect(page.locator('.modal')).toHaveCSS('border-radius', mobile === 'true' ? '0px' : '2px');
      const name = stamp();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      await page.getByRole('button', { name: 'Create session', exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      const mode = page.getByRole('button', { name: 'OR', exact: true });
      await mode.click();
      await expect(mode).toHaveAttribute('aria-pressed', 'true');
      await assertAccentContrast(mode);
      await expect(page.getByRole('status')).not.toContainText('Loading');
      await page.screenshot({ path: test.info().outputPath(`lite-session-${theme}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole('button', { name: 'Manage session' }).click();
      await page.getByRole('button', { name: 'Delete session', exact: true }).click();
      await page.locator('.modal input').fill(name);
      await page.getByRole('button', { name: 'Delete session forever' }).click();
      await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
    });
  }
}
