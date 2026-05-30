// Notes view (Folders browser) — Bear-style 3-column view reached from the
// sidebar. Folders are hierarchical slash-tags; the tree, the filtered list,
// and the editable folder-path chip are all derived from notes in scope.
//
// Pinned against the deterministic seed (scripts/seed-local.ts FOLDER_MAP):
//   cooking → coffee(3) + recipes(2) = 5; travel(4); health(2); etc.

import { expect, test, type Page } from '@playwright/test';
import '../../helpers/setup';

async function openNotes(page: Page) {
  await page.locator('.sidebar .sb-item', { has: page.locator('.label:text-is("Notes")') }).click();
  await expect(page.locator('.notes-view')).toBeVisible({ timeout: 10000 });
}

const treeRow = (page: Page, name: string) =>
  page.locator('.notes-tree-row', { has: page.locator(`.lbl:text-is("${name}")`) });

const listRows = (page: Page) => page.locator('.notes-list-rows .prow-note');

test.describe('Notes view: Folders browser', () => {
  test('sidebar opens the 3-column folder browser', async ({ page }) => {
    await openNotes(page);
    await expect(page.locator('.notes-tree')).toBeVisible();
    await expect(page.locator('.notes-list')).toBeVisible();
    await expect(page.locator('.notes-detail')).toBeVisible();
    await expect(page.locator('.notes-tree-row', { hasText: 'All notes' })).toBeVisible();
  });

  test('folder tree shows the seeded hierarchy with counts', async ({ page }) => {
    await openNotes(page);
    const cooking = treeRow(page, 'cooking');
    await expect(cooking).toBeVisible();
    await expect(cooking.locator('.ct')).toHaveText('5');
    await expect(treeRow(page, 'travel')).toBeVisible();
    // Expand cooking → coffee + recipes children appear.
    await cooking.locator('.notes-tree-chev').click();
    await expect(treeRow(page, 'coffee')).toBeVisible();
    await expect(treeRow(page, 'recipes')).toBeVisible();
  });

  test('clicking a folder reveals its children + filters the list (incl. descendants)', async ({ page }) => {
    await openNotes(page);
    // Clicking the row both selects AND reveals children (no chevron needed).
    await treeRow(page, 'cooking').click();
    await expect(listRows(page)).toHaveCount(5); // coffee(3) + recipes(2)
    await expect(treeRow(page, 'coffee')).toBeVisible();
    await expect(treeRow(page, 'recipes')).toBeVisible();
    await treeRow(page, 'coffee').click();
    await expect(listRows(page)).toHaveCount(3);
    await expect(page.locator('.notes-list-rows')).toContainText('Pour-over recipe — Hario V60');
  });

  test('selecting a note shows its content + a single click-to-edit folder chip', async ({ page }) => {
    await openNotes(page);
    await treeRow(page, 'cooking').click();
    await listRows(page).first().click();
    await expect(page.locator('.notes-detail-body')).toBeVisible();
    // ONE folder chip (a note belongs to one folder); no remove × and no
    // "+ Folder" button while a folder exists.
    await expect(page.locator('.notes-folder-chip')).toContainText('cooking/');
    await expect(page.locator('.notes-folder-add')).toHaveCount(0);
    await expect(page.locator('.notes-folder-bar .tag .x')).toHaveCount(0);
  });

  test('Cmd/Ctrl+1 toggles the folder tree column', async ({ page }) => {
    await openNotes(page);
    await expect(page.locator('.notes-cols[data-tree="true"]')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+1');
    await expect(page.locator('.notes-cols[data-tree="false"]')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+1');
    await expect(page.locator('.notes-cols[data-tree="true"]')).toBeVisible();
  });

  // Regression: removing a folder segment down to a SINGLE top-level segment
  // (travel/japan → travel) used to drop the note out of the tree entirely,
  // because folders were slash-tags and a slash-less path read as a flat tag.
  // With a first-class `folder` field, a single segment is a real folder, so
  // the note must remain — filed directly under the parent. Mutates + restores
  // the seed so the shared DB is left untouched for other specs.
  test('removing a folder segment files the note under the parent folder', async ({ page }) => {
    await openNotes(page);
    await treeRow(page, 'travel').click();
    await treeRow(page, 'japan').click();
    await listRows(page).first().click();
    await expect(page.locator('.notes-folder-chip')).toHaveText('travel/japan');

    // Move up a level: travel/japan → travel (a single-segment top-level folder).
    await page.locator('.notes-folder-chip').click();
    await page.locator('.notes-folder-input').fill('travel');
    await page.locator('.notes-folder-input').press('Enter');

    // The note keeps a (single-segment) folder and shows under "travel" —
    // it does NOT vanish, and the chip is NOT replaced by "+ Folder".
    await expect(page.locator('.notes-folder-chip')).toHaveText('travel');
    await expect(page.locator('.notes-folder-add')).toHaveCount(0);
    await treeRow(page, 'travel').click();
    await expect(page.locator('.notes-list-rows')).toContainText('Travel — Tokyo bucket list');

    // Restore the seed: move it back to travel/japan.
    await page.locator('.notes-folder-chip').click();
    await page.locator('.notes-folder-input').fill('travel/japan');
    await page.locator('.notes-folder-input').press('Enter');
    await expect(page.locator('.notes-folder-chip')).toHaveText('travel/japan');
  });
});
