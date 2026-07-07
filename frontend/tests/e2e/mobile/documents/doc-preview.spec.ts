// Doc reader drawer on mobile (DOC-M-1..3) — parity with the desktop
// preview spec's PDF / image / project-chip contracts, opened from the
// Activity feed (reached via the More sheet). The drawer is fullscreen on
// mobile (covered by drawer-fullscreen.spec.ts); here we assert the
// preview surfaces themselves.
import type { Page } from '@playwright/test';
import { expect, test } from '../../helpers/setup';
import { gotoView } from '../../helpers/nav';

async function openDocFromActivity(page: Page, title: string) {
  await gotoView(page, 'Activity');
  const row = page.locator('.activity-row').filter({ hasText: `Ingested ${title}` }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const drawer = page.locator('[role="dialog"]');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  return drawer;
}

test('doc preview mobile: PDF renders an inline embed with a Download (rscd) link', async ({ page }) => {
  const drawer = await openDocFromActivity(page, 'Sample document for E2E tests');

  await expect(drawer.locator('.doc-mime')).toHaveText('application/pdf');
  const panel = drawer.locator('.doc-preview-pdf');
  await expect(panel).toBeVisible();
  await expect(panel.locator('object[type="application/pdf"]')).toHaveCount(1);

  const download = drawer.getByRole('link', { name: /Download/ });
  await expect(download).toBeVisible();
  expect(await download.getAttribute('href')).toContain('rscd=');
});

test('doc preview mobile: image doc renders inline with tap-to-enlarge lightbox', async ({ page }) => {
  await gotoView(page, 'Activity');
  await expect(page.locator('.activity-row').first()).toBeVisible({ timeout: 15000 });

  // Walk ingested rows until the image/png doc drawer comes up (same
  // strategy as the desktop spec — the OCR-stubbed title is fixture data,
  // the mime line is the authoritative signal).
  const rows = page.locator('.activity-row').filter({ hasText: /^Ingested / });
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  const drawer = page.locator('[role="dialog"]');
  let found = false;
  for (let i = 0; i < count; i++) {
    await rows.nth(i).scrollIntoViewIfNeeded();
    await rows.nth(i).click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    const mimeEl = drawer.locator('.doc-mime');
    if ((await mimeEl.count()) > 0 && (await mimeEl.innerText()).trim() === 'image/png') {
      found = true;
      break;
    }
    await drawer.locator('.drawer-head button[aria-label="Close"]').click();
    await expect(drawer).toHaveCount(0);
  }
  expect(found).toBe(true);

  const trigger = drawer.locator('.doc-preview-image');
  await expect(trigger).toBeVisible();
  const img = trigger.locator('img');
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await trigger.click();
  const lightbox = page.locator('.doc-preview-lightbox');
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  await expect(drawer).toBeVisible(); // Esc closed only the lightbox
});

test('doc preview mobile: project chip navigates to that project view', async ({ page }) => {
  const drawer = await openDocFromActivity(page, 'Sample document for E2E tests');

  const chip = drawer.locator('.meta-projects .tag-link').first();
  await expect(chip).toHaveText('RAG Research');
  await chip.click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('h1', { hasText: 'RAG Research' })).toBeVisible({ timeout: 5000 });
});
