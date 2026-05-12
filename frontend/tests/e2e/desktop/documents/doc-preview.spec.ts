// Doc reader drawer renders an inline preview for each kind of document
// source — PDF embed, image with click-to-enlarge, audio player. The text
// extracted by the ingest pipeline is still rendered below as a separate
// "Extracted text" panel; this spec asserts the source-media surface, not
// the extracted text. Backend SAS-signing is verified implicitly: if the
// blob URL weren't signed, Azurite would 403 and the <img> would never
// hit naturalWidth > 0.
import { expect, test } from '@playwright/test';
import '../../helpers/setup';
import { navTo } from '../../helpers/setup';

// Helper: open the drawer for the doc whose Ingested activity row matches
// the title text. Activity rows are <div role="button" class="activity-row">,
// not <button> — keep the selector class-based.
async function openDocFromActivity(page: import('@playwright/test').Page, title: string) {
  await navTo(page, 'Activity');
  const row = page
    .locator('.activity-row')
    .filter({ hasText: `Ingested ${title}` })
    .first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const drawer = page.locator('[role="dialog"]');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  return drawer;
}

// Walk through the "(no text content)" ingest rows (which are the image
// and the audio in the seed) until the drawer's mime chip matches the
// expected one. Lets the test be order-agnostic about which doc was
// ingested first.
async function openNoTextDocByMime(page: import('@playwright/test').Page, mime: string) {
  await navTo(page, 'Activity');
  await expect(page.locator('h1', { hasText: 'Activity' })).toBeVisible();
  // Wait for the activity list to populate. Without this, the row query
  // races the data fetch and returns 0.
  await expect(page.locator('.activity-row').first()).toBeVisible({ timeout: 15000 });
  const rows = page
    .locator('.activity-row')
    .filter({ hasText: 'Ingested (no text content)' });
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  const drawer = page.locator('[role="dialog"]');
  for (let i = 0; i < count; i++) {
    await rows.nth(i).scrollIntoViewIfNeeded();
    await rows.nth(i).click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    const actual = (await drawer.locator('.doc-mime').innerText()).trim();
    if (actual === mime) return drawer;
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);
  }
  throw new Error(`No "(no text content)" doc found with mime ${mime}`);
}

test('doc preview: PDF doc renders an inline embed and a Download link', async ({ page }) => {
  const drawer = await openDocFromActivity(page, 'Sample document for E2E tests');

  // The mime chip is the canonical signal that this is the PDF row, not a
  // different one with the same name.
  await expect(drawer.locator('.doc-mime')).toHaveText('application/pdf');

  // The preview panel exists and contains the <object>/<embed> tag pair.
  // Computed-style check: the panel should be tall enough to actually act
  // as a viewer — anything under 200px means the aspect-ratio rule isn't
  // applying and the embed isn't usable. The <object> always renders in
  // the DOM, even in headless Chromium where the PDF plugin is missing —
  // in that case the fallback children render instead, which is fine for
  // our purposes (we're not asserting visual PDF rendering).
  const panel = drawer.locator('.doc-preview-pdf');
  await expect(panel).toBeVisible();
  const height = await panel.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(200);
  await expect(panel.locator('object')).toHaveCount(1);

  // The action-row Download link must point at the SAS-signed URL.
  // Multiple Download anchors exist (chip-row + in-object fallback for
  // headless Chromium) — both share the same blob href, so picking the
  // first one and asserting `sig=` is sufficient and stable.
  const download = drawer.locator('a[download]').first();
  const href = await download.getAttribute('href');
  expect(href).toBeTruthy();
  expect(href!).toContain('sig=');
});

test('doc preview: image doc renders an inline image with click-to-enlarge', async ({ page }) => {
  // The PNG in the seed has no extracted title (image-only doc in stub
  // mode), so it shows up as "(no text content)" in the activity row.
  // openNoTextDocByMime walks all such rows and stops on the image one.
  const drawer = await openNoTextDocByMime(page, 'image/png');

  const trigger = drawer.locator('.doc-preview-image');
  await expect(trigger).toBeVisible();

  // The <img> must actually load — naturalWidth > 0 proves the SAS-signed
  // URL hit Azurite/Azure successfully. A 403 (no SAS) would leave it 0.
  const img = trigger.locator('img');
  await expect.poll(
    async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth),
    { timeout: 5000 },
  ).toBeGreaterThan(0);

  // Click the trigger and assert the lightbox dialog mounts.
  await trigger.click();
  const lightbox = page.locator('.doc-preview-lightbox');
  await expect(lightbox).toBeVisible();
  await page.locator('.doc-preview-lightbox-close').click();
  await expect(lightbox).toHaveCount(0);
});

test('doc preview: audio doc renders a native player', async ({ page }) => {
  // Same disambiguation as the image test — we walk through "(no text
  // content)" rows until the audio one opens.
  const drawer = await openNoTextDocByMime(page, 'audio/wav');

  const audio = drawer.locator('.doc-preview-audio audio');
  await expect(audio).toHaveCount(1);
  // Audio metadata should load — duration > 0 proves the SAS URL fetched
  // the bytes. The seeded sample.wav is ~5s.
  await expect.poll(
    async () => audio.evaluate((el: HTMLAudioElement) => el.duration),
    { timeout: 5000 },
  ).toBeGreaterThan(0);
});
