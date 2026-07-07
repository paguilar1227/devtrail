// Activity page — feed, kind filter chips, click-through (ACT-1..2).

import { createTodo, updateTodo } from '../helpers/api';
import { test, expect, stamp } from '../helpers/setup';
import { gotoView } from '../helpers/nav';

export function defineActivityPageTests() {
  test('activity: kind filter chips narrow the feed', async ({ page }) => {
    // Arrange one guaranteed "edit" event (updating a todo) so the Edits
    // filter always has our row regardless of seed freshness.
    const title = `${stamp()} activity filter probe`;
    const todo = await createTodo(title);
    await updateTodo(todo.id, { priority: 'P1' });

    await gotoView(page, 'Activity');
    await expect(page.locator('.proj-hero h1')).toHaveText('Activity');
    await expect(page.locator('.activity-row').first()).toBeVisible();

    await page.locator('.filter-chip', { hasText: 'Edits' }).click();
    const row = page.locator('.activity-row', { hasText: title }).first();
    await expect(row).toBeVisible();

    // Comments excludes both the create (ingest) and update (edit) events —
    // the probe todo has no comments, so it must drop out entirely.
    await page.locator('.filter-chip', { hasText: 'Comments' }).click();
    await expect(page.locator('.activity-row', { hasText: title })).toHaveCount(0);

    await page.locator('.filter-chip', { hasText: /^All/ }).click();
    await expect(page.locator('.activity-row', { hasText: title }).first()).toBeVisible();
  });

  test('activity: feed groups by day and a row click opens the entity', async ({ page }) => {
    const title = `${stamp()} activity click probe`;
    await createTodo(title);

    await gotoView(page, 'Activity');
    await expect(page.locator('.activity-day').first()).toHaveText('Today');

    await page.locator('.activity-row', { hasText: title }).first().click();
    await expect(page.locator('.drawer')).toBeVisible();
    await expect(page.locator('.drawer')).toContainText(title);
  });
}
