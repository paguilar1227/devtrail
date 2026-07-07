// Thin device wrapper — the workflow lives in shared/theme.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineThemeTests } from '../../shared/theme';
import { expect, test } from '../../helpers/setup';

defineThemeTests();

// SET-2 — desktop-only: ⌘⇧L / Ctrl+Shift+L flips the theme (a keyboard-only
// surface with no mobile affordance; exclusion documented in the plan).

test('theme desktop: Cmd/Ctrl+Shift+L flips data-theme', async ({ page }) => {
  const initial = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.keyboard.press('ControlOrMeta+Shift+L');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(initial);
  await page.keyboard.press('ControlOrMeta+Shift+L');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(initial);
});
