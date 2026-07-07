// Todos view on mobile (TODOS-M-1..4) — parity with
// desktop/todos/todos-view.spec.ts minus drag-reorder (dnd-kit pointer drags
// are a desktop interaction; the cross-section move is covered there).
import type { Page } from '@playwright/test';
import { createTodo } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';
import { gotoView } from '../../helpers/nav';

async function openTodos(page: Page) {
  await gotoView(page, 'Todos');
  await expect(page.locator('.todos-view')).toBeVisible({ timeout: 10000 });
}

/** Todo row by title, optionally scoped to a container (e.g. '.todos-done'). */
const rowByTitle = (page: Page, title: string, root = 'body') =>
  page.locator(`${root} .prow-todo`, { has: page.locator('.ti', { hasText: title }) });

test('todos mobile: sectioned list with a Done group + filters renders', async ({ page }) => {
  await openTodos(page);
  await expect(page.locator('h1', { hasText: 'Todos' })).toBeVisible();
  await expect(page.locator('.todos-section').first()).toBeVisible();
  await expect(page.locator('.todos-done')).toBeVisible();
  await expect(page.locator('.todos-filters .filter-chip', { hasText: 'P1' })).toBeVisible();
});

test('todos mobile: completing a todo moves it to the Done group, struck through', async ({ page }) => {
  const title = stamp();
  await createTodo(title, null);
  await openTodos(page);
  const row = rowByTitle(page, title);
  await expect(row).toBeVisible();
  await row.locator('.checkbox').click();

  await page.locator('.todos-done-head').click();
  const doneRow = rowByTitle(page, title, '.todos-done');
  await expect(doneRow).toBeVisible();
  await expect(doneRow).toHaveClass(/prow-done/);
});

test('todos mobile: tag filter narrows the list to matching todos', async ({ page }) => {
  const tag = `e2etag-mt-${Math.random().toString(36).slice(2, 6)}`;
  const tagged = `${stamp()} tagged`;
  const plain = `${stamp()} plain`;
  await createTodo(tagged, null, { tags: [tag] });
  await createTodo(plain, null);

  await openTodos(page);
  const tagBar = page.locator('.todos-view .home-tag-filter');
  await expect(tagBar).toBeVisible();
  await tagBar.locator('.home-tag-filter-chips .home-filter-chip', { hasText: tag }).click();

  const openRows = page.locator('.todos-body .todos-section .prow-todo');
  await expect(openRows.filter({ hasText: tagged })).toHaveCount(1);
  await expect(openRows.filter({ hasText: plain })).toHaveCount(0);

  await tagBar.locator('.home-tag-filter-clear').click();
  await expect(openRows.filter({ hasText: plain })).toHaveCount(1);
});

test('todos mobile: Add section reveals an inline input that creates an empty section', async ({ page }) => {
  await openTodos(page);
  await page.locator('.todos-toolbar button', { hasText: 'Add section' }).click();
  await page.locator('.todos-section-input').fill('QA-mobile-empty');
  await page.locator('.todos-section-input').press('Enter');
  const sec = page.locator('.todos-section', { has: page.locator('.todos-section-name', { hasText: 'QA-mobile-empty' }) });
  await expect(sec).toBeVisible();
  await expect(sec.locator('.todos-section-empty')).toBeVisible();
});
