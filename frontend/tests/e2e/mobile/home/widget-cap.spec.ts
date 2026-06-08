// Home dashboard columns are previews, not full lists — each caps at 6
// rendered rows with a "View N more" footer to the drawer.
//
// On mobile this is the surface that broke: the grid's min-height band is
// removed, so .pcol-rows is sized by its own content and the useFitCount
// loop measures itself instead of real viewport space — tall rows (notes)
// climbed until every item rendered (unbounded, over-long widget), short
// rows (docs) collapsed to the min:3 floor. ColumnWidget now bypasses the
// measure on mobile and renders a fixed MAX_ROWS=6 preview. The seed has
// >6 personal notes and >6 personal docs, so both exercise the cap.
import { expect, test } from '@playwright/test';
import '../../helpers/setup';

const CAP = 6;

const col = (page: import('@playwright/test').Page, pcol: string) =>
  page.locator(`[data-pcol="${pcol}"]`);

test('home columns cap at 6 rows on mobile (notes climb / docs collapse both fixed)', async ({ page }) => {
  await page.goto('/?key=local-dev-key-not-secret');
  await expect(col(page, 'notes').locator('.prow-note').first()).toBeVisible();

  // Notes: 31 personal notes seeded; tall rows used to climb to all 31.
  // Capped, with the full count still on the header chip + the remainder
  // behind the footer.
  await expect(col(page, 'notes').locator('.prow-note')).toHaveCount(CAP);
  await expect(col(page, 'notes').locator('.pcol-more')).toContainText('more');

  // Documents: 9 personal docs seeded; short rows used to collapse to the
  // min floor (3). Capped/filled to CAP now.
  await expect(col(page, 'documents').locator('.prow-doc')).toHaveCount(CAP);
  await expect(col(page, 'documents').locator('.pcol-more')).toContainText('more');

  // The header count chip reflects the TRUE total, not the capped preview
  // — so the column reads "Notes 31" over CAP visible rows.
  const headerCount = Number(
    (await col(page, 'notes').locator('.pcol-h .ct').innerText()).trim(),
  );
  expect(headerCount).toBeGreaterThan(CAP);
});
