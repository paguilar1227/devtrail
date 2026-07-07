// Tags catalog + tag detail page — shared suite (TAGS-1..6).
//
// Tag fixtures use kebab-case names derived from a timestamp (tags can't
// carry the `e2e:` colon prefix), attached to stamp()-titled content so the
// standard sweep removes them (tags disappear with their carriers).
//
// Audit finding (untested, inert): the ⋯ button on tag rows has no handler.
// Rename IS wired and covered by TAGS-6.

import { createNote, createTodo } from '../helpers/api';
import { test, expect, stamp } from '../helpers/setup';
import { gotoView } from '../helpers/nav';

const kebabTag = () => `e2etag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export function defineTagsTests() {
  test('tags: filter input narrows rows and shows the no-match state', async ({ page }) => {
    await gotoView(page, 'Tags');
    await expect(page.locator('.proj-hero h1')).toHaveText('Tags');

    // Personal scope is the default; the seed guarantees a #reading tag on
    // personal notes and a #home tag on others.
    const reading = page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: /^reading$/ }) });
    await expect(reading).toBeVisible();

    await page.getByPlaceholder('Filter tags…').fill('reading');
    await expect(reading).toBeVisible();
    await expect(page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: /^home$/ }) })).toHaveCount(0);

    await page.getByPlaceholder('Filter tags…').fill('zz-no-such-tag');
    await expect(page.getByText('No tags match "zz-no-such-tag"')).toBeVisible();
  });

  test('tags: scope dropdown flips the inventory from personal to corpus-wide', async ({ page }) => {
    await gotoView(page, 'Tags');
    // #rag lives only on project content (RAG Research seed notes) — absent
    // in the default Personal scope, present under All projects.
    const rag = page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: /^rag$/ }) });
    await expect(page.locator('.tag-row').first()).toBeVisible(); // list loaded
    await expect(rag).toHaveCount(0);

    await page.locator('select#tags-scope').selectOption('all');
    await expect(rag).toBeVisible();
  });

  test('tags: row click routes to the detail page and Back returns', async ({ page }) => {
    await gotoView(page, 'Tags');
    await page
      .locator('.tag-row', { has: page.locator('.tag-name', { hasText: /^reading$/ }) })
      .click();

    await expect(page.locator('.proj-hero h1')).toContainText('reading');
    // Seeded #reading notes are personal, so the default scope shows them.
    await expect(page.locator('.tag-detail-section-h', { hasText: 'Notes' })).toBeVisible();

    await page.getByRole('button', { name: 'Back to tags' }).click();
    await expect(page.locator('.proj-hero h1')).toHaveText('Tags');
  });

  test('tag detail: scope toggle — project tag empty under Personal, populated under All', async ({ page }) => {
    await gotoView(page, 'Tags');
    await page.locator('select#tags-scope').selectOption('all');
    await page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: /^rag$/ }) }).click();
    await expect(page.locator('.proj-hero h1')).toContainText('rag');

    // Detail page defaults back to Personal — #rag has no personal carriers.
    await expect(page.getByText(/Nothing tagged/)).toBeVisible();

    // Scope flip re-keys three parallel list queries (notes/docs/todos) on
    // top of the mount-time fetches — allow the refetch churn a wider
    // window than the 5s default before the sections render.
    await page.locator('select#tag-detail-scope').selectOption('all');
    await expect(page.locator('.tag-detail-section-h', { hasText: 'Notes' })).toBeVisible({ timeout: 15000 });
  });

  test('tag detail: rows open the right surface (todo → drawer, note → editor)', async ({ page }) => {
    const tag = kebabTag();
    const noteTitle = `${stamp()} tagged note`;
    const todoTitle = `${stamp()} tagged todo`;
    await createNote(noteTitle, 'note body for tag-detail routing', { tags: [tag] });
    await createTodo(todoTitle, null, { tags: [tag] });

    await gotoView(page, 'Tags');
    await page.getByPlaceholder('Filter tags…').fill(tag);
    await page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: tag }) }).click();

    // Todo row → detail drawer.
    await page.locator('.tag-detail-row', { hasText: todoTitle }).click();
    await expect(page.locator('.drawer')).toBeVisible();
    await expect(page.locator('.drawer')).toContainText(todoTitle);
    await page.locator('.drawer-head button[aria-label="Close"]').click();
    await expect(page.locator('.drawer')).toHaveCount(0);

    // Note row → editor modal (the title lives in an input, so assert value).
    await page.locator('.tag-detail-section', { hasText: 'Notes' }).locator('.prow', { hasText: noteTitle }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.modal input.input').first()).toHaveValue(noteTitle);
  });

  test('tags: rename via the modal updates the catalog row', async ({ page }) => {
    const oldTag = kebabTag();
    const newTag = `${oldTag}-renamed`;
    await createNote(`${stamp()} rename carrier`, 'note body for the rename-tag spec', { tags: [oldTag] });

    await gotoView(page, 'Tags');
    await page.getByPlaceholder('Filter tags…').fill(oldTag);
    const row = page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: oldTag }) });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Rename' }).click();
    await expect(page.locator('.modal-head h3', { hasText: 'Rename tag' })).toBeVisible();
    await page.locator('#rename-tag-input').fill(newTag);
    await page.locator('.modal-foot .btn-primary', { hasText: 'Rename' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);

    // Catalog refetches: old name gone, new name present.
    await page.getByPlaceholder('Filter tags…').fill(newTag);
    await expect(
      page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: newTag }) }),
    ).toBeVisible();
    await page.getByPlaceholder('Filter tags…').fill(oldTag);
    await expect(
      page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: new RegExp(`^${oldTag}$`) }) }),
    ).toHaveCount(0);
  });

  test('tags: Delete strips the tag corpus-wide after a typed confirm (intent fix)', async ({ page }) => {
    const tag = kebabTag();
    await createNote(`${stamp()} delete-tag carrier`, 'note body for the delete-tag spec', { tags: [tag] });

    await gotoView(page, 'Tags');
    await page.getByPlaceholder('Filter tags…').fill(tag);
    const row = page.locator('.tag-row', { has: page.locator('.tag-name', { hasText: tag }) });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Delete' }).click();
    // Typed gate: the danger button is disabled until the tag name matches.
    const confirm = page.locator('.modal-foot .btn-danger', { hasText: 'Delete tag' });
    await expect(confirm).toBeDisabled();
    await page.locator('.modal input.input').first().fill(tag);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // The catalog refetches without the tag.
    await expect(row).toHaveCount(0);
    await expect(page.getByText(`No tags match "${tag}"`)).toBeVisible();
  });
}
