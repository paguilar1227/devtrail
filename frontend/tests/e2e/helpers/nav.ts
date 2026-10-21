// Device-aware navigation helpers. Shared workflow suites (tests/e2e/shared/*)
// call these instead of clicking the sidebar directly, so one workflow
// definition runs unchanged under both the chromium-desktop and
// chromium-mobile Playwright projects.
//
// Desktop: sidebar rows (labels match the Workspace section).
// Mobile:  Home/Projects live on the tabbar; everything else is a row in
//          the More bottom-sheet (which auto-closes on selection).

import { expect, type Page } from '@playwright/test';
import { MORE_SHEET, TABBAR, navTo, openMoreSheet, projectTo } from './setup';
import { isMobileViewport } from './utils';

export type ViewLabel = 'Home' | 'Projects' | 'Notes' | 'Todos' | 'Sessions' | 'Activity' | 'Tags' | 'Archived';

const TABBAR_VIEWS: ReadonlySet<ViewLabel> = new Set<ViewLabel>(['Home', 'Projects']);

/** Navigate to a top-level view on either device class. */
export async function gotoView(page: Page, label: ViewLabel): Promise<void> {
  if (!isMobileViewport(page)) {
    await navTo(page, label);
    return;
  }
  if (TABBAR_VIEWS.has(label)) {
    await page.locator(`${TABBAR} .mtab`, { hasText: label }).click();
    return;
  }
  await openMoreSheet(page);
  await page.locator(`${MORE_SHEET} .m-sheet-row`, { hasText: label }).click();
  await expect(page.locator(MORE_SHEET)).toHaveCount(0);
}

/** Navigate to a project's detail page by name.
 *  Desktop: sidebar projects list. Mobile: Projects tab → card in the grid. */
export async function gotoProjectPage(page: Page, name: string): Promise<void> {
  if (!isMobileViewport(page)) {
    await projectTo(page, name);
  } else {
    await gotoView(page, 'Projects');
    // Cards are the default view; the name renders in .proj-card .nm.
    await page.locator('.proj-card', { has: page.locator('.nm', { hasText: name }) }).first().click();
  }
  await expect(page.locator('.proj-hero h1')).toHaveText(name);
}

/** Toggle a tag chip in a HomeTagFilter bar. On narrow (mobile) viewports
 *  low-usage tags overflow behind the "+N more" picker, so fall back to
 *  opening it and selecting the tag from the searchable popover. */
export async function selectTagChip(page: Page, bar: ReturnType<Page['locator']>, tag: string): Promise<void> {
  const chip = bar.locator('.home-tag-filter-chips .home-filter-chip', { hasText: tag }).first();
  if (await chip.isVisible().catch(() => false)) {
    await chip.click();
    return;
  }
  // button, not the hidden [data-measure-more] span the fit-measurer renders
  await bar.locator('button.home-filter-chip-more').click();
  const popover = page.locator('.tag-picker-popover');
  await expect(popover).toBeVisible();
  await popover.locator('.tag-picker-search input').fill(tag);
  await popover.locator('.tag-picker-row', { hasText: tag }).first().click();
  await page.keyboard.press('Escape'); // close the picker; the filter stays applied
  await expect(popover).toHaveCount(0);
}

/** Open the Settings modal on either device class. */
export async function openSettings(page: Page): Promise<void> {
  if (!isMobileViewport(page)) {
    await page.locator('button.sb-footer').click();
  } else {
    await openMoreSheet(page);
    await page.locator(`${MORE_SHEET} .m-sheet-row`, { hasText: 'Account & preferences' }).click();
  }
  await expect(page.locator('.modal')).toBeVisible();
}
