// Project view — tab bar + Documents / Notes / Todos tabs (PTAB, PDOC,
// PNOTE, PTODO). Every test arranges its own throwaway project over REST so
// nothing leans on the seed's counts; a reload makes the fresh project
// visible to the sidebar (desktop) / Projects grid (mobile) before nav.
//
// Audit findings (untested, inert): Todos-tab filter chips + Top/Sub pill +
// "Add details" button; Notes-tab Pinned/Processing chips; bulk-bar
// "Tag" / "Move to project" buttons.

import type { Page } from '@playwright/test';
import {
  createDoc,
  createNote,
  createProject,
  createTodo,
  listContent,
  pinContent,
  updateTodo,
  waitForContentReady,
} from '../helpers/api';
import { test, expect, stamp } from '../helpers/setup';
import { gotoProjectPage, gotoView } from '../helpers/nav';
import { isMobileViewport, waitForAppReady } from '../helpers/utils';

async function openFreshProject(page: Page, name: string) {
  // The project list was fetched when the app booted — before the fixture
  // existed. Reload so both device navigation surfaces know about it.
  await page.reload();
  await waitForAppReady(page);
  await gotoProjectPage(page, name);
}

const tab = (page: Page, label: string) => page.locator('[role="tab"]', { hasText: label });

export function defineProjectTabsTests() {
  test('project tabs: badges render counts and switching swaps the panel', async ({ page }) => {
    const name = `${stamp()} TabsProj`;
    const p = await createProject(name, 'tab-count fixture');
    const doc = await createDoc(`${stamp()} tab doc`, 'doc body', { projectIds: [p.id] });
    const note = await createNote(`${stamp()} tab note`, 'note body', { projectIds: [p.id] });
    // Counts race the async ingest — gate on readiness so the badge numbers
    // are deterministic on both device profiles.
    await waitForContentReady(doc.id);
    await waitForContentReady(note.id);
    const parent = await createTodo(`${stamp()} tab todo`, p.id);
    await createTodo(`${stamp()} tab subtodo`, p.id, { parent_id: parent.id });

    await openFreshProject(page, name);
    await expect(tab(page, 'Documents').locator('.ct')).toHaveText('1');
    await expect(tab(page, 'Notes').locator('.ct')).toHaveText('1');
    await expect(tab(page, 'Todos').locator('.ct')).toHaveText('2');

    // Chat is the default panel; each tab swaps in its own surface.
    await expect(page.locator('.composer')).toBeVisible();
    await tab(page, 'Documents').click();
    await expect(page.locator('.doc-list .doc-row')).toHaveCount(1);
    await tab(page, 'Notes').click();
    await expect(page.locator('.note-grid .note-card')).toHaveCount(1);
    await tab(page, 'Todos').click();
    // The Todos tab renders the shared sectioned panel; the parent todo is
    // a top-level row (its subtask stays collapsed behind the chevron).
    await expect(page.locator('.todos-panel')).toBeVisible();
    await expect(page.locator('.todos-panel .prow-todo', { hasText: 'tab todo' })).toBeVisible();
  });

  test('documents tab: type filter chips narrow files vs URLs', async ({ page }) => {
    const name = `${stamp()} DocFilterProj`;
    const p = await createProject(name, 'doc type-filter fixture');
    const docTitle = `${stamp()} filter doc`;
    await createDoc(docTitle, 'doc body', { projectIds: [p.id] });

    await openFreshProject(page, name);
    await tab(page, 'Documents').click();
    const row = page.locator('.doc-row', { hasText: docTitle });
    await expect(row).toBeVisible();

    // Uploaded file = binary → survives the Files chip, dies under URLs.
    await page.locator('.filter-chip', { hasText: 'Files' }).click();
    await expect(row).toBeVisible();
    await page.locator('.filter-chip', { hasText: 'URLs' }).click();
    await expect(page.locator('.doc-list .doc-row')).toHaveCount(0);
    await page.locator('.filter-chip', { hasText: 'Any type' }).click();
    await expect(row).toBeVisible();
  });

  test('documents tab: pin round-trips through the Pinned filter', async ({ page }) => {
    // Row actions (Pin/Reprocess/Archive) are display:none below 820px by
    // design — desktop-only interaction (documented in the coverage plan).
    test.skip(isMobileViewport(page), 'doc row actions are hidden on mobile by design');
    const name = `${stamp()} DocPinProj`;
    const p = await createProject(name, 'doc pin fixture');
    const docTitle = `${stamp()} pin doc`;
    await createDoc(docTitle, 'doc body', { projectIds: [p.id] });

    await openFreshProject(page, name);
    await tab(page, 'Documents').click();
    const row = page.locator('.doc-row', { hasText: docTitle });
    await expect(row).toBeVisible();

    await row.locator('button[title="Pin"]').click();
    await page.locator('.filter-chip', { hasText: 'Pinned' }).click();
    await expect(row).toBeVisible();

    await row.locator('button[title="Unpin"]').click();
    await expect(page.locator('.doc-list .doc-row')).toHaveCount(0);
  });

  test('documents tab: archive removes the row and lands it in Archived', async ({ page }) => {
    test.skip(isMobileViewport(page), 'doc row actions are hidden on mobile by design');
    const name = `${stamp()} DocArchProj`;
    const p = await createProject(name, 'doc archive fixture');
    const docTitle = `${stamp()} archive doc`;
    await createDoc(docTitle, 'doc body', { projectIds: [p.id] });

    await openFreshProject(page, name);
    await tab(page, 'Documents').click();
    const row = page.locator('.doc-row', { hasText: docTitle });
    await expect(row).toBeVisible();
    await row.locator('button[title="Archive"]').click();
    await expect(page.getByText('No documents in this project yet.')).toBeVisible();

    await gotoView(page, 'Archived');
    await page.locator('.filter-chip', { hasText: 'Documents' }).click();
    await expect(page.locator('.row', { hasText: docTitle })).toBeVisible();
  });

  test('documents tab: bulk select raises the bulk bar; Clear dismisses it', async ({ page }) => {
    const name = `${stamp()} DocBulkProj`;
    const p = await createProject(name, 'doc bulk fixture');
    await createDoc(`${stamp()} bulk doc`, 'doc body', { projectIds: [p.id] });

    await openFreshProject(page, name);
    await tab(page, 'Documents').click();
    await page.locator('.doc-row .bulk-checkbox').first().click();
    const bulkBar = page.locator('.bulk-bar');
    await expect(bulkBar).toBeVisible();
    await expect(bulkBar.locator('.ct')).toHaveText('1 selected');
    await bulkBar.getByRole('button', { name: 'Clear' }).click();
    await expect(bulkBar).toHaveCount(0);
  });

  test('notes tab: New note creates a card in the grid', async ({ page }) => {
    const name = `${stamp()} NoteProj`;
    await createProject(name, 'notes-tab create fixture');
    await openFreshProject(page, name);
    await tab(page, 'Notes').click();

    const title = `${stamp()} created note`;
    await page.locator('button', { hasText: 'New note' }).first().click();
    await expect(page.locator('.modal-head h3', { hasText: 'New note' })).toBeVisible();
    await page.locator('.modal input.input').first().fill(title);
    const cm = page.locator('.modal .cm-content');
    await cm.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Body from the shared notes-tab spec.');
    await page.locator('.modal-foot .btn-primary', { hasText: 'Save' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.note-card', { hasText: title })).toBeVisible();
  });

  test('notes tab: search flips the card grid to flat rows and back', async ({ page }) => {
    const name = `${stamp()} NoteSearchProj`;
    const p = await createProject(name, 'notes-tab search fixture');
    const noteTitle = `${stamp()} searchable note`;
    const note = await createNote(noteTitle, 'unmistakable llamacorn payload', { projectIds: [p.id] });
    // Hybrid search only surfaces ready rows — gate on ingest completion so
    // the single debounced search fires against an indexed note.
    await waitForContentReady(note.id);

    await openFreshProject(page, name);
    await tab(page, 'Notes').click();
    await expect(page.locator('.note-grid')).toBeVisible();

    await page.getByPlaceholder(`Search ${name} notes… try #tag`).fill('llamacorn');
    await expect(page.locator('.note-grid')).toHaveCount(0);
    await expect(page.locator('.todo-list-drawer-rows .prow', { hasText: noteTitle })).toBeVisible();

    await page.getByPlaceholder(`Search ${name} notes… try #tag`).fill('');
    await expect(page.locator('.note-grid')).toBeVisible();
  });

  test('todos tab: quick-add lands in the sections; checkbox moves it to the Done group', async ({ page }) => {
    const name = `${stamp()} TodoAddProj`;
    await createProject(name, 'todos-tab quick-add fixture');
    await openFreshProject(page, name);
    await tab(page, 'Todos').click();

    const title = `${stamp()} quick-added`;
    await page.getByPlaceholder(`Add a todo to ${name} — Enter to save`).fill(title);
    await page.keyboard.press('Enter');

    // Fast path: no drawer — the row lands straight in the open sections.
    const row = page.locator('.todos-panel .todos-section .prow-todo', { hasText: title });
    await expect(row).toBeVisible();

    await row.locator('.checkbox').click();
    // Completed top-levels collapse into the Done group at the bottom —
    // the row leaves the open list until Done is expanded.
    await expect(row).toHaveCount(0);
    await page.locator('.todos-done-head').click();
    const doneRow = page.locator('.todos-done .prow-todo', { hasText: title });
    await expect(doneRow).toBeVisible();
    await expect(doneRow).toHaveClass(/prow-done/);
  });

  test('todos tab: chevron expands and collapses the subtask tree', async ({ page }) => {
    const name = `${stamp()} TodoHierProj`;
    const p = await createProject(name, 'todos-tab hierarchy fixture');
    const parentTitle = `${stamp()} hier parent`;
    const parent = await createTodo(parentTitle, p.id);
    const childTitle = `${stamp()} hier child`;
    await createTodo(childTitle, p.id, { parent_id: parent.id });

    await openFreshProject(page, name);
    await tab(page, 'Todos').click();

    // Collapsed by default: the parent row renders, the child does not.
    const parentRow = page.locator('.todos-panel .prow-todo', { hasText: parentTitle });
    await expect(parentRow).toBeVisible();
    await expect(page.locator('.todos-panel .prow-todo', { hasText: childTitle })).toHaveCount(0);

    // Expand via the chevron: the child renders nested at depth 1.
    await parentRow.locator('.prow-chev').click();
    await expect(page.locator('.todos-panel .prow-todo[data-depth="1"]', { hasText: childTitle })).toBeVisible();

    // Collapse hides it again.
    await parentRow.locator('.prow-chev').click();
    await expect(page.locator('.todos-panel .prow-todo', { hasText: childTitle })).toHaveCount(0);
  });

  test('todos tab: priority + due-lens chips narrow the sections; Clear restores', async ({ page }) => {
    const name = `${stamp()} TodoChipProj`;
    const p = await createProject(name, 'todos-tab chip fixture');
    const plain = await createTodo(`${stamp()} chip plain`, p.id);
    const overdue = await createTodo(`${stamp()} chip overdue`, p.id);
    await updateTodo(overdue.id, { due_date: '2020-01-01T12:00:00.000Z' });
    const p1 = await createTodo(`${stamp()} chip p-one`, p.id);
    await updateTodo(p1.id, { priority: 'P1' });
    const done = await createTodo(`${stamp()} chip done`, p.id);
    await updateTodo(done.id, { status: 'done' });
    void plain;

    await openFreshProject(page, name);
    await tab(page, 'Todos').click();
    // Scope to the open sections: done top-levels always live in the
    // collapsed Done group, independent of the filter chips.
    const row = (title: string) =>
      page.locator('.todos-panel .todos-section:not(.todos-done) .prow-todo', { hasText: title });
    const chips = page.locator('.todos-panel .todos-filters');
    await expect(chips).toBeVisible();

    // Default: open rows visible, the done row collapsed away.
    await expect(row('chip plain')).toBeVisible();
    await expect(row('chip done')).toHaveCount(0);

    // Overdue lens: only the overdue row survives in the sections.
    await chips.locator('.filter-chip', { hasText: 'Overdue' }).click();
    await expect(row('chip overdue')).toBeVisible();
    await expect(row('chip plain')).toHaveCount(0);

    // Stack P1 on top: the overdue row (P3) drops too — nothing is both
    // P1 and overdue. Then drop the due lens: the P1 row remains.
    await chips.locator('.filter-chip', { hasText: /^P1$/ }).click();
    await expect(row('chip overdue')).toHaveCount(0);
    await chips.locator('.filter-chip', { hasText: 'Overdue' }).click();
    await expect(row('chip p-one')).toBeVisible();
    await expect(row('chip plain')).toHaveCount(0);

    // Clear restores every open row; the done row is reachable via Done.
    await chips.locator('button', { hasText: 'Clear' }).click();
    await expect(row('chip plain')).toBeVisible();
    await expect(row('chip overdue')).toBeVisible();
    await page.locator('.todos-done-head').click();
    await expect(page.locator('.todos-done .prow-todo', { hasText: 'chip done' })).toBeVisible();
  });

  test('todos tab: Add details creates from the draft and opens the detail drawer (intent fix)', async ({ page }) => {
    const name = `${stamp()} TodoDetailProj`;
    await createProject(name, 'todos-tab add-details fixture');
    await openFreshProject(page, name);
    await tab(page, 'Todos').click();

    const title = `${stamp()} detailed todo`;
    const input = page.getByPlaceholder(`Add a todo to ${name} — Enter to save`);
    // Disabled until there's a draft.
    await expect(page.getByRole('button', { name: 'Add details' })).toBeDisabled();
    await input.fill(title);
    await page.getByRole('button', { name: 'Add details' }).click();

    // Detail drawer opens on the freshly created todo…
    const drawer = page.locator('.drawer');
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(drawer).toContainText(title);
    await drawer.locator('.drawer-head button[aria-label="Close"]').click();

    // …and the row is in the open sections.
    await expect(
      page.locator('.todos-panel .todos-section .prow-todo', { hasText: title }),
    ).toBeVisible();
  });

  test('notes tab: Pinned chip narrows to pinned notes (intent fix)', async ({ page }) => {
    const name = `${stamp()} NoteChipProj`;
    const p = await createProject(name, 'notes-tab chip fixture');
    const pinned = await createNote(`${stamp()} pinned note`, 'pinned body', { projectIds: [p.id] });
    await createNote(`${stamp()} plain note`, 'plain body', { projectIds: [p.id] });
    await pinContent(pinned.id);

    await openFreshProject(page, name);
    await tab(page, 'Notes').click();
    await expect(page.locator('.note-card', { hasText: 'plain note' })).toBeVisible();

    await page.locator('.filter-chip', { hasText: 'Pinned' }).click();
    await expect(page.locator('.note-card', { hasText: 'pinned note' })).toBeVisible();
    await expect(page.locator('.note-card', { hasText: 'plain note' })).toHaveCount(0);

    await page.locator('.filter-chip', { hasText: /^All/ }).click();
    await expect(page.locator('.note-card', { hasText: 'plain note' })).toBeVisible();
  });

  test('documents tab: bulk Tag and Move to project act on the selection (intent fix)', async ({ page }) => {
    const nameA = `${stamp()} BulkSrcProj`;
    const nameB = `${stamp()} BulkDstProj`;
    const a = await createProject(nameA, 'bulk source');
    const b = await createProject(nameB, 'bulk destination');
    const docTitle = `${stamp()} bulk-actions doc`;
    const doc = await createDoc(docTitle, 'doc body', { projectIds: [a.id] });

    await openFreshProject(page, nameA);
    await tab(page, 'Documents').click();
    const row = page.locator('.doc-row', { hasText: docTitle });
    await expect(row).toBeVisible();

    // Bulk Tag: select → Tag → type → Enter; the tag chip lands on the row.
    await row.locator('.bulk-checkbox').click();
    await page.locator('.bulk-bar').getByRole('button', { name: 'Tag', exact: true }).click();
    const tag = `e2etag-bulk-${Math.random().toString(36).slice(2, 6)}`;
    await page.locator('.bulk-bar input').fill(tag);
    await page.locator('.bulk-bar input').press('Enter');
    await expect(row.locator('.tag', { hasText: tag })).toBeVisible();
    await expect.poll(async () => {
      const items = await listContent({ project_id: a.id, type: 'document' });
      return items.find((i) => i.id === doc.id)?.tags ?? [];
    }).toContain(tag);

    // Bulk Move: select → Move to project → choose B; the row leaves A.
    await row.locator('.bulk-checkbox').click();
    await page.locator('.bulk-bar').getByRole('button', { name: 'Move to project' }).click();
    await page.locator('.bulk-bar select').selectOption({ label: nameB });
    await expect(page.getByText('No documents in this project yet.')).toBeVisible();
    await expect.poll(async () => {
      const items = await listContent({ project_id: b.id, type: 'document' });
      return items.some((i) => i.id === doc.id);
    }).toBe(true);
  });

  test('todos tab: search filters to flat ranked rows; clearing restores sections', async ({ page }) => {
    const name = `${stamp()} TodoSearchProj`;
    const p = await createProject(name, 'todos-tab search fixture');
    const title = `${stamp()} kraken hunt todo`;
    await createTodo(title, p.id);

    await openFreshProject(page, name);
    await tab(page, 'Todos').click();
    await expect(page.locator('.todos-panel .todos-section').first()).toBeVisible();

    await page.getByPlaceholder(`Search ${name} todos… try #tag`).fill('kraken');
    await expect(page.locator('.todos-search-rows .prow-todo', { hasText: title })).toBeVisible();
    await expect(page.locator('.todos-panel .todos-section')).toHaveCount(0);

    await page.getByPlaceholder(`Search ${name} todos… try #tag`).fill('');
    await expect(page.locator('.todos-panel .todos-section').first()).toBeVisible();
  });
}
