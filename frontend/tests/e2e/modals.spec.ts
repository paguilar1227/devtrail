import { expect, test, type Page } from '@playwright/test';
import { waitForAppReady } from './helpers/utils';

async function openProjectChat(page: Page) {
  await page.goto('/');
  await waitForAppReady(page);
  if ((page.viewportSize()?.width ?? 0) < 820) {
    await page.locator('.mtab', { hasText: 'Projects' }).click();
    await page.locator('.proj-card', { hasText: 'ClaudePit' }).first().click();
  } else {
    await page.locator('.sb-item:has(.label:text-is("ClaudePit"))').click();
  }
  await expect(page.locator('.proj-hero h1', { hasText: 'ClaudePit' })).toBeVisible();
}

test.describe('UploadModal', () => {
  test('opens via Add button on project detail', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await expect(page.locator('.modal-head h3', { hasText: 'Add to ClaudePit' })).toBeVisible();
  });

  test('renders dropzone with copy', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await expect(page.locator('.dropzone')).toContainText('Drop files here');
  });

  test('default tags include research and auth, both removable', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await expect(page.locator('.modal .tag.removable')).toHaveCount(2);
  });

  test('uploading row shows progress bar and percentage', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await expect(page.locator('.modal .doc-row').first()).toContainText('64%');
  });

  test('queued row shows "queued"', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await expect(page.locator('.modal .doc-row').nth(1)).toContainText('queued');
  });

  test('Close button closes', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await page.locator('.modal-foot .btn', { hasText: 'Close' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('Esc closes', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('clicking overlay closes', async ({ page, viewport }) => {
    // Mobile modals are fullscreen (no overlay margin) — overlay-click is a desktop-only affordance.
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await expect(page.locator('.modal')).toBeVisible();
    const overlay = page.locator('.modal-overlay');
    const box = await overlay.boundingBox();
    if (!box) throw new Error('overlay box not found');
    await overlay.click({ position: { x: Math.floor(box.width / 2), y: 4 } });
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('clicking inside modal does not close', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.proj-hero .btn-primary', { hasText: 'Add' }).click();
    await page.locator('.modal h3').click();
    await expect(page.locator('.modal')).toBeVisible();
  });
});

test.describe('NoteEditorModal', () => {
  async function openNewNote(page: Page) {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Notes' }).click();
    await page.locator('.btn', { hasText: 'New note' }).click();
  }

  async function openEditNote(page: Page) {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Notes' }).click();
    await page.locator('.note-card').first().click();
  }

  test('new note: title prefilled', async ({ page }) => {
    await openNewNote(page);
    await expect(page.locator('.modal input').first()).toHaveValue('Untitled note');
  });

  test('new note: footer says draft', async ({ page }) => {
    await openNewNote(page);
    await expect(page.locator('.modal-foot')).toContainText('draft');
  });

  test('edit note: title prefilled with note title', async ({ page }) => {
    await openEditNote(page);
    await expect(page.locator('.modal input').first()).not.toHaveValue('');
  });

  test('removing tag removes chip', async ({ page }) => {
    await openEditNote(page);
    const before = await page.locator('.modal .tag.removable').count();
    if (before > 0) {
      await page.locator('.modal .tag.removable .x').first().click();
      await expect(page.locator('.modal .tag.removable')).toHaveCount(before - 1);
    }
  });

  test('typing in body updates word count', async ({ page }) => {
    await openNewNote(page);
    const ta = page.locator('.modal textarea');
    await ta.fill('one two three four five six seven');
    await expect(page.locator('.modal-foot')).toContainText('7 words');
  });

  test('Cancel closes', async ({ page }) => {
    await openNewNote(page);
    await page.locator('.modal-foot .btn', { hasText: 'Cancel' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });
});

test.describe('DocReaderDrawer', () => {
  test('opens for ready doc and renders metadata', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Documents' }).click();
    await page
      .locator('.doc-row')
      .filter({ has: page.locator('.status.ready') })
      .first()
      .locator('div')
      .filter({ has: page.locator('.nm') })
      .first()
      .click();
    await expect(page.locator('.drawer')).toBeVisible();
    await expect(page.locator('.drawer-body')).toContainText('created');
  });

  test('Esc closes drawer', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Documents' }).click();
    await page
      .locator('.doc-row')
      .filter({ has: page.locator('.status.ready') })
      .first()
      .locator('div')
      .filter({ has: page.locator('.nm') })
      .first()
      .click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer')).toHaveCount(0);
  });

  test('X button in header closes', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Documents' }).click();
    await page
      .locator('.doc-row')
      .filter({ has: page.locator('.status.ready') })
      .first()
      .locator('div')
      .filter({ has: page.locator('.nm') })
      .first()
      .click();
    await page.locator('.drawer-head .btn-icon').click();
    await expect(page.locator('.drawer')).toHaveCount(0);
  });
});

test.describe('TodoDetailDrawer', () => {
  test('opens with title and priority chips', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Todos' }).click();
    await page
      .locator('.todo .nm', { hasText: 'Wire up streaming' })
      .first()
      .click();
    await expect(page.locator('.drawer')).toBeVisible();
    await expect(page.locator('.drawer-head .ti', { hasText: 'Wire up streaming' })).toBeVisible();
  });

  test('comments render when present', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Todos' }).click();
    await page
      .locator('.todo .nm', { hasText: 'Wire up streaming' })
      .first()
      .click();
    await expect(page.locator('.drawer .comment')).toHaveCount(3);
  });

  test('Esc closes', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Todos' }).click();
    await page
      .locator('.todo .nm', { hasText: 'Wire up streaming' })
      .first()
      .click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer')).toHaveCount(0);
  });
});

test.describe('ConfirmModal — bulk', () => {
  test('archive action shows correct title', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Documents' }).click();
    await page.locator('.doc-row .bulk-checkbox').first().click();
    await page.locator('.bulk-bar .btn-danger', { hasText: 'Archive' }).click();
    await expect(page.locator('.modal-head h3')).toHaveText('Archive 1 documents?');
  });

  test('Cancel closes without effect', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Documents' }).click();
    await page.locator('.doc-row .bulk-checkbox').first().click();
    await page.locator('.bulk-bar .btn-danger', { hasText: 'Archive' }).click();
    await page.locator('.modal-foot .btn', { hasText: 'Cancel' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    // Selection remains
    await expect(page.locator('.bulk-bar')).toBeVisible();
  });

  test('Archive button enabled and closes on click', async ({ page }) => {
    await openProjectChat(page);
    await page.locator('.tabs .tab', { hasText: 'Documents' }).click();
    await page.locator('.doc-row .bulk-checkbox').first().click();
    await page.locator('.bulk-bar .btn-danger', { hasText: 'Archive' }).click();
    await page.locator('.modal-foot .btn-danger', { hasText: 'Archive' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });
});

test.describe('ConfirmModal — rename tag', () => {
  async function openRename(page: Page) {
    await page.goto('/');
    await waitForAppReady(page);
    if ((page.viewportSize()?.width ?? 0) < 820) {
      await page.locator('.mtab', { hasText: 'More' }).click();
      await page.locator('.m-sheet-row', { hasText: 'Tags' }).click();
    } else {
      await page.locator('.sb-item:has(.label:text-is("Tags"))').click();
    }
    await page.locator('.tag-row .btn', { hasText: 'Rename' }).first().click();
  }

  test('confirm disabled until exact match typed', async ({ page }) => {
    await openRename(page);
    const confirm = page.locator('.modal-foot .btn-primary', { hasText: 'Rename' });
    await expect(confirm).toBeDisabled();
    await page.locator('.modal input.input-mono').fill('not-the-tag');
    await expect(confirm).toBeDisabled();
  });

  test('confirm enabled when typed correctly', async ({ page }) => {
    await openRename(page);
    // First tag in TAGS fixture is "architecture"
    await page.locator('.modal input.input-mono').fill('architecture');
    await expect(page.locator('.modal-foot .btn-primary', { hasText: 'Rename' })).toBeEnabled();
  });

  test('Esc closes', async ({ page }) => {
    await openRename(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
  });
});

test.describe('NewProjectModal', () => {
  test('opens via sidebar New project (desktop)', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item.dim:has(.label:text-is("New project"))').click();
    await expect(page.locator('.modal-head h3', { hasText: 'New project' })).toBeVisible();
  });

  test('5 accent dots rendered', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item.dim:has(.label:text-is("New project"))').click();
    await expect(page.locator('.modal .sb-proj-dot')).toHaveCount(5);
  });

  test('Cancel closes', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop only');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item.dim:has(.label:text-is("New project"))').click();
    await page.locator('.modal-foot .btn', { hasText: 'Cancel' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });
});

test.describe('Modal generic', () => {
  test('opening a modal does not change route', async ({ page, viewport }) => {
    test.skip(!!viewport && viewport.width < 820, 'desktop new-project trigger lives in sidebar');
    await page.goto('/');
    await waitForAppReady(page);
    await page.locator('.sb-item.dim:has(.label:text-is("New project"))').click();
    // Crumbs should now be Projects (since the action triggers route + modal)
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();
  });
});
