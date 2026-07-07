// Projects page — filters, grid/list toggle, routing (PROJ-1..4).
//
// Audit finding (untested, inert): the per-row ⋯ button in list view has
// no handler.

import { createProject, findProjectByName } from '../helpers/api';
import { expect, test, stamp } from '../helpers/setup';
import { gotoView } from '../helpers/nav';
import { waitForAppReady } from '../helpers/utils';

const ARCHIVED_SEED = 'Old MCP Spike (archived)';
const ACTIVE_SEED = 'ClaudePit';

export function defineProjectsPageTests() {
  test('projects: Active/Archived/All chips gate the archived seed project', async ({ page }) => {
    await gotoView(page, 'Projects');
    await expect(page.locator('.proj-hero h1')).toHaveText('Projects');

    const archivedCard = page.locator('.proj-card', { has: page.locator('.nm', { hasText: ARCHIVED_SEED }) });
    const activeCard = page.locator('.proj-card', { has: page.locator('.nm', { hasText: ACTIVE_SEED }) });

    // Default = Active.
    await expect(activeCard).toBeVisible();
    await expect(archivedCard).toHaveCount(0);

    await page.locator('.filter-chip', { hasText: 'Archived' }).click();
    await expect(archivedCard).toBeVisible();
    await expect(activeCard).toHaveCount(0);

    await page.locator('.filter-chip', { hasText: /^All/ }).click();
    await expect(archivedCard).toBeVisible();
    await expect(activeCard).toBeVisible();
  });

  test('projects: Grid ↔ List toggle swaps the layout', async ({ page }) => {
    await gotoView(page, 'Projects');
    await expect(page.locator('.proj-grid')).toBeVisible();

    await page.locator('.seg-toggle button', { hasText: 'List' }).click();
    await expect(page.locator('.proj-grid')).toHaveCount(0);
    await expect(page.locator('.row-list .project-row').first()).toBeVisible();

    await page.locator('.seg-toggle button', { hasText: 'Grid' }).click();
    await expect(page.locator('.proj-grid')).toBeVisible();
  });

  test('projects: card click and list-row click both open the project page', async ({ page }) => {
    await gotoView(page, 'Projects');
    await page.locator('.proj-card', { has: page.locator('.nm', { hasText: ACTIVE_SEED }) }).click();
    await expect(page.locator('.proj-hero h1')).toHaveText(ACTIVE_SEED);

    await gotoView(page, 'Projects');
    await page.locator('.seg-toggle button', { hasText: 'List' }).click();
    await page.locator('.project-row', { hasText: ACTIVE_SEED }).click();
    await expect(page.locator('.proj-hero h1')).toHaveText(ACTIVE_SEED);
  });

  test('projects: list-row ⋯ menu pins, archives, restores and deletes (intent fix)', async ({ page }) => {
    const name = `${stamp()} RowMenuProj`;
    await createProject(name, 'throwaway for the list-row menu spec');
    // The projects query was cached before the fixture existed.
    await page.reload();
    await waitForAppReady(page);

    await gotoView(page, 'Projects');
    await page.locator('.seg-toggle button', { hasText: 'List' }).click();
    const row = page.locator('.project-row', { hasText: name });
    await expect(row).toBeVisible();
    const menuBtn = row.getByRole('button', { name: 'Project actions' });
    const menu = page.locator('.proj-menu');

    // Pin → backend round-trip, menu relabels to Unpin.
    await menuBtn.click();
    await menu.getByRole('menuitem', { name: /^Pin$/ }).click();
    await expect.poll(async () => (await findProjectByName(name))?.pinned_at).not.toBeNull();
    await menuBtn.click();
    await expect(menu.getByRole('menuitem', { name: /^Unpin$/ })).toBeVisible();

    // Archive → the row leaves the Active filter and appears under Archived.
    await menu.getByRole('menuitem', { name: /Archive/ }).click();
    await expect(row).toHaveCount(0);
    await page.locator('.filter-chip', { hasText: 'Archived' }).click();
    await expect(row).toBeVisible();

    // Restore from the archived listing.
    await menuBtn.click();
    await menu.getByRole('menuitem', { name: /Restore/ }).click();
    await expect(row).toHaveCount(0);
    await page.locator('.filter-chip', { hasText: 'Active' }).click();
    await expect(row).toBeVisible();

    // Delete — typed confirm, then gone for good.
    await menuBtn.click();
    await menu.getByRole('menuitem', { name: /Delete project/ }).click();
    const del = page.locator('.modal-foot .btn-danger', { hasText: 'Delete forever' });
    await expect(del).toBeDisabled();
    await page.locator('.modal input.input').first().fill(name);
    await expect(del).toBeEnabled();
    await del.click();
    await expect(row).toHaveCount(0);
    await expect.poll(async () => await findProjectByName(name)).toBeUndefined();
  });

  test('projects: page-level New project button opens the create modal', async ({ page }) => {
    await gotoView(page, 'Projects');
    await page.locator('.proj-hero .btn-primary', { hasText: 'New project' }).click();
    await expect(page.locator('.modal-head h3', { hasText: 'New project' })).toBeVisible();
    await page.locator('.modal-head button[aria-label="Close"]').click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });
}
