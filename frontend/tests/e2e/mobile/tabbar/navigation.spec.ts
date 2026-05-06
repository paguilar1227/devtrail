// Mobile bottom-tabbar — the always-visible primary nav. Walks through
// the three top-level routes the tabbar exposes (Home / Projects / Inbox),
// asserting the page hero h1 after each tap. The More tab is covered by
// mobile/more/* specs.
import { expect, test } from '@playwright/test';
import { TABBAR } from '../../helpers/setup';
import '../../helpers/setup';

test('mobile tabbar: Home / Projects / Inbox each route to their own page', async ({ page }) => {
  // App lands on Home; verify, then click each tab and check the hero. We
  // visit Home last to confirm the round-trip back to the starting view.
  const tab = (label: string) => page.locator(`${TABBAR} .mtab`, { hasText: label });
  const hero = (text: RegExp | string) => page.locator('main h1', { hasText: text });

  await expect(hero(/Welcome back/)).toBeVisible();

  await tab('Projects').click();
  await expect(hero(/^Projects$/)).toBeVisible();

  await tab('Inbox').click();
  await expect(hero(/^Inbox$/)).toBeVisible();

  await tab('Home').click();
  await expect(hero(/Welcome back/)).toBeVisible();
});
