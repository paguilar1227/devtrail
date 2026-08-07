// Todos view on mobile (TODOS-M-1..5) — parity with
// desktop/todos/todos-view.spec.ts. Drag works on mobile too: the grip is
// always visible under data-mobile and carries touch-action: none, so
// dnd-kit's PointerSensor owns the gesture instead of the scroll.
import type { Page } from '@playwright/test';
import { createTodo, listTodos } from '../../helpers/api';
import { test, expect, stamp } from '../../helpers/setup';
import { gotoView } from '../../helpers/nav';
import { waitForAppReady } from '../../helpers/utils';

async function openTodos(page: Page) {
  // The Todos page shares the TodosPanel (and its ['todos','panel','personal']
  // query key) with Home's default Todos tab, which the page fixture already
  // warmed at boot. Reload first so todos created via REST inside a test
  // aren't hidden behind the 30s staleTime.
  await page.reload();
  await waitForAppReady(page);
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

test('todos mobile: dragging a subtask reorders it within its parent', async ({ page }) => {
  // The drag grip is a first-class mobile affordance now (always visible,
  // touch-action: none). Same nested-reorder contract as desktop.
  const parentTitle = stamp() + ' m-drag parent';
  const subA = stamp() + ' m-sub A';
  const subB = stamp() + ' m-sub B';
  const parent = await createTodo(parentTitle, null);
  const a = await createTodo(subA, null, { parent_id: parent.id });
  const b = await createTodo(subB, null, { parent_id: parent.id });
  await openTodos(page);

  const parentRow = rowByTitle(page, parentTitle);
  await expect(parentRow).toBeVisible();
  await parentRow.locator('.prow-chev').click();
  const rowA = rowByTitle(page, subA);
  const rowB = rowByTitle(page, subB);
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  // Unranked children order newest-first — read the actual initial order
  // and drag the BOTTOM sibling onto the TOP one so a swap proves the drag.
  const visualOrder = async () => {
    const titles = await page.locator('.todos-section .prow-todo .ti').allInnerTexts();
    const ia = titles.findIndex((x) => x.includes(subA));
    const ib = titles.findIndex((x) => x.includes(subB));
    return { ia, ib };
  };
  const before = await visualOrder();
  expect(before.ia).not.toBe(-1);
  expect(before.ib).not.toBe(-1);
  const [topRow, bottomRow, topId, bottomId] =
    before.ia < before.ib ? [rowA, rowB, a.id, b.id] : [rowB, rowA, b.id, a.id];

  await bottomRow.scrollIntoViewIfNeeded();
  const g = await bottomRow.locator('.prow-grip').boundingBox();
  const t = await topRow.boundingBox();
  if (!g || !t) throw new Error('missing drag boxes');
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 12, g.y + g.height / 2 - 12);
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect.poll(async () => {
    const now = await visualOrder();
    const draggedFirst = bottomId === b.id ? now.ib < now.ia : now.ia < now.ib;
    return now.ia !== -1 && now.ib !== -1 && draggedFirst;
  }).toBe(true);
  await expect.poll(async () => {
    const todos = await listTodos({ project_id: 'null' });
    const byId = new Map(todos.map((x) => [x.id, x]));
    const mTop = byId.get(topId)?.manual_order;
    const mBottom = byId.get(bottomId)?.manual_order;
    return mTop != null && mBottom != null && mBottom < mTop;
  }).toBe(true);
});
