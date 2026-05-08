// Recent activity widget on Home — each row is a button that opens the
// underlying entity's modal (note editor, todo drawer, doc reader). Without
// this, the widget is a fancy read-only list. The test walks: Home → click
// the first activity row → assert a modal dialog opens.
import { expect, test } from '@playwright/test';
import '../../helpers/setup';

test('home activity: clicking a row opens the underlying entity modal', async ({ page }) => {
  // Wait for the activity card to finish loading — its rows render after
  // the listActivity query resolves, so a bare .arow query can race with
  // the SPA's first paint on cold start.
  await expect(page.locator('.stat-activity .arows')).toBeVisible();
  const firstRow = page.locator('.stat-activity .arow').first();
  await expect(firstRow).toBeVisible();

  // Capture the title text so we can verify the right entity opened.
  const title = (await firstRow.locator('.atext b').innerText()).trim();
  expect(title.length).toBeGreaterThan(0);

  await firstRow.click();

  // All three modals (note/todo/doc) render as role="dialog" — a single
  // assertion covers every entity kind. The click triggers an async
  // fetch for the full entity, so allow extra time on CI's slower
  // runner — the default 5s timeout is tight here.
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  // The opened modal should reference the same entity by title.
  await expect(dialog).toContainText(title);
});
