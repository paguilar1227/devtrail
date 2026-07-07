// Notes view on mobile (NOTES-M-1..3) — parity additions on top of the
// existing drill-down navigation spec: tag filtering in the list view,
// creating a note filed into the selected folder, and the pin glyph.
import type { Page } from '@playwright/test';
import { createNote, pinContent } from '../../helpers/api';
import { test, expect, MORE_SHEET, openMoreSheet, stamp } from '../../helpers/setup';
import { selectTagChip } from '../../helpers/nav';

async function openNotesMobile(page: Page) {
  await openMoreSheet(page);
  await page.locator(`${MORE_SHEET} .m-sheet-row`, { hasText: 'Notes' }).click();
  await expect(page.locator('.notes-mobile')).toBeVisible();
}

const treeRow = (page: Page, name: string) =>
  page.locator('.notes-tree-row', { has: page.locator(`.lbl:text-is("${name}")`) });

test('notes mobile: tag filter narrows the list', async ({ page }) => {
  const tag = `e2etag-mn-${Math.random().toString(36).slice(2, 6)}`;
  const tagged = `${stamp()} tagged note`;
  const plain = `${stamp()} plain note`;
  await createNote(tagged, 'tagged body', { tags: [tag] });
  await createNote(plain, 'plain body');

  await openNotesMobile(page);
  await treeRow(page, 'All notes').click();
  await expect(page.locator('.notes-mobile[data-view="list"]')).toBeVisible();

  const rows = page.locator('.notes-list-rows .prow-note');
  await expect(rows.filter({ hasText: tagged })).toHaveCount(1);
  await expect(rows.filter({ hasText: plain })).toHaveCount(1);

  // The fresh tag likely overflows into "+N more" on the phone viewport.
  const tagBar = page.locator('.notes-mobile .home-tag-filter');
  await selectTagChip(page, tagBar, tag);
  await expect(rows.filter({ hasText: tagged })).toHaveCount(1);
  await expect(rows.filter({ hasText: plain })).toHaveCount(0);

  await tagBar.locator('.home-tag-filter-clear').click();
  await expect(rows.filter({ hasText: plain })).toHaveCount(1);
});

test('notes mobile: New note from a selected folder files it there', async ({ page }) => {
  await openNotesMobile(page);
  await treeRow(page, 'travel').click();
  await expect(page.locator('.notes-mobile-title')).toHaveText('travel');

  const title = `${stamp()} filed note`;
  await page.locator('.notes-mobile button[aria-label="New note"]').click();
  await expect(page.locator('.modal-head h3', { hasText: 'New note' })).toBeVisible();
  await page.locator('.modal input.input').first().fill(title);
  const cm = page.locator('.modal .cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Filed from the mobile drill-down.');
  await page.locator('.modal-foot .btn-primary', { hasText: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);

  // Still inside the travel folder — the fresh note shows in its list.
  await expect(page.locator('.notes-list-rows .prow-note', { hasText: title })).toBeVisible();
});

test('notes mobile: pinned note shows the pin glyph in the list', async ({ page }) => {
  const pinnedTitle = `${stamp()} pinned note`;
  const plainTitle = `${stamp()} unpinned note`;
  const pinned = await createNote(pinnedTitle, 'pinned body');
  await createNote(plainTitle, 'plain body');
  await pinContent(pinned.id);

  await openNotesMobile(page);
  await treeRow(page, 'All notes').click();

  const rows = page.locator('.notes-list-rows .prow-note');
  await expect(rows.filter({ hasText: pinnedTitle }).locator('.prow-pin')).toBeVisible();
  await expect(rows.filter({ hasText: plainTitle }).locator('.prow-pin')).toHaveCount(0);
});
