// Home activity widget on mobile (HOME-M-7..8) — parity with
// desktop/home/activity-click.spec.ts + activity-filter.spec.ts (the filter
// case is condensed: in-place update, dashboard stays mounted).
import { expect, test } from '../../helpers/setup';

test('home mobile activity: clicking a row opens the underlying entity modal', async ({ page }) => {
  await expect(page.locator('.stat-activity .activity-list-compact')).toBeVisible();
  const firstRow = page.locator('.stat-activity .activity-row').first();
  await expect(firstRow).toBeVisible();

  const title = (await firstRow.locator('.text b').innerText()).trim();
  expect(title.length).toBeGreaterThan(0);

  await firstRow.click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  // Todos/docs open read surfaces (title in text); notes open the editor,
  // where the title lives in an <input> value — accept either.
  await expect(async () => {
    const text = await dialog.innerText();
    if (text.includes(title)) return;
    const inputValues = await dialog.locator('input').evaluateAll(
      (els) => els.map((el) => (el as HTMLInputElement).value),
    );
    expect(inputValues.some((v) => v.includes(title))).toBe(true);
  }).toPass({ timeout: 10000 });
});

test('home mobile activity: changing the filter updates in place, dashboard stays mounted', async ({ page }) => {
  await expect(page.locator('.stat-activity .activity-list-compact')).toBeVisible();
  const grid = page.locator('.home-personal-grid');
  await expect(grid).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/activity') && r.url().includes('kinds=ingest')),
    page.locator('.stat-activity select').selectOption('ingest'),
  ]);
  await expect(page.locator('.stat-activity select')).toHaveValue('ingest');

  await expect(grid).toBeVisible();
  await expect(page.locator('.stat-activity')).toBeVisible();
});
