// Project hero actions on mobile (PHERO-M-1..2) — parity with
// desktop/projects/projects.spec.ts (pin) and project-menu.spec.ts
// (⋯ menu walkthrough). Navigation goes through the Projects tab grid
// instead of the sidebar.
import { createProject, findProjectByName } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';
import { gotoProjectPage } from '../../helpers/nav';
import { waitForAppReady } from '../../helpers/utils';

test('project hero mobile: pin toggle round-trips through the backend', async ({ page }) => {
  const name = stamp() + ' MobilePin';
  await createProject(name, 'throwaway for the mobile pin spec');
  await page.reload();
  await waitForAppReady(page);
  await gotoProjectPage(page, name);

  // getByRole: the accessible name is whitespace-normalized ("Pin"), unlike
  // hasText regex anchors against raw text content (same pitfall the desktop
  // spec documents).
  const hero = page.locator('.proj-hero');
  await hero.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(hero.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
  await expect.poll(async () => (await findProjectByName(name))?.pinned_at).not.toBeNull();

  await hero.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(hero.getByRole('button', { name: 'Pin', exact: true })).toBeVisible();
  await expect.poll(async () => (await findProjectByName(name))?.pinned_at ?? null).toBeNull();
});

test('project ⋯ menu mobile: edit, archive/restore, delete', async ({ page }) => {
  const name = stamp() + ' MobileMenu';
  const created = await createProject(name, 'throwaway for the mobile ⋯ menu spec');
  await page.reload();
  await waitForAppReady(page);
  await gotoProjectPage(page, name);

  const hero = page.locator('.proj-hero');
  const more = hero.getByRole('button', { name: 'More project actions' });
  const menu = page.locator('.proj-menu');

  // Edit: modal pre-filled, rename persists.
  await more.click();
  await menu.getByRole('menuitem', { name: /Edit project/ }).click();
  await expect(page.locator('.modal-head h3')).toHaveText('Edit project');
  const nameInput = page.locator('.modal input.input').first();
  await expect(nameInput).toHaveValue(name);
  const renamed = name + ' R';
  await nameInput.fill(renamed);
  await page.locator('.modal-foot .btn-primary', { hasText: 'Save' }).click();
  await expect(hero.locator('h1', { hasText: renamed })).toBeVisible();
  expect((await findProjectByName(renamed))?.id).toBe(created.id);

  // Archive → Restore.
  await more.click();
  await menu.getByRole('menuitem', { name: /Archive/ }).click();
  await expect(hero.getByText(/Archived project/i)).toBeVisible();
  await more.click();
  await menu.getByRole('menuitem', { name: /Restore/ }).click();
  await expect(hero.getByText(/Active project/i)).toBeVisible();

  // Delete, gated on typing the project name.
  await more.click();
  await menu.getByRole('menuitem', { name: /Delete project/ }).click();
  const del = page.locator('.modal-foot .btn-danger', { hasText: 'Delete forever' });
  await expect(del).toBeDisabled();
  await page.locator('.modal input.input').first().fill(renamed);
  await expect(del).toBeEnabled();
  await del.click();

  await expect(hero.locator('h1', { hasText: renamed })).toHaveCount(0);
  await expect.poll(async () => await findProjectByName(renamed)).toBeUndefined();
});
