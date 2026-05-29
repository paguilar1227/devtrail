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
});
