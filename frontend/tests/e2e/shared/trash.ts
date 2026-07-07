// Archived (Trash) view — shared suite (TRASH-1..6 in the coverage plan).
// Runs under both device projects via thin specs in desktop/ and mobile/.
//
// TRASH-4..6 pin the intent-fix work (2026-07-03): Restore, Delete forever
// (typing-gated) and Empty archive were rendered-but-inert buttons; they now
// perform the actions their labels promise. Arrange/teardown goes through
// REST (fixtures are stamp()ed, so the setup sweep removes them).

import {
  archiveContent,
  archiveProject,
  archiveTodo,
  createDoc,
  createNote,
  createProject,
  createTodo,
  getContentItem,
  listContent,
  listProjects,
  listTodos,
} from '../helpers/api';
import { test, expect, stamp } from '../helpers/setup';
import { gotoView } from '../helpers/nav';

export function defineTrashTests() {
  test('archived view: seed project listed, kind chips narrow the rows', async ({ page }) => {
    await gotoView(page, 'Archived');
    await expect(page.locator('.proj-hero h1')).toHaveText('Archived');

    // The seed archives exactly one project; it must be in the default (All) list.
    const seedProject = page.locator('.row', { hasText: 'Old MCP Spike (archived)' });
    await expect(seedProject).toBeVisible();

    // Projects chip → only project rows remain (every row meta says "project ·").
    await page.locator('.filter-chip', { hasText: 'Projects' }).click();
    await expect(seedProject).toBeVisible();
    const rows = page.locator('.row-list .row');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      await expect(rows.nth(i).locator('.row-meta')).toContainText('project ·');
    }

    // A chip that excludes projects hides the seed project row.
    await page.locator('.filter-chip', { hasText: 'Notes' }).click();
    await expect(seedProject).toHaveCount(0);
  });

  test('archived view: soft-deleted todo appears under the Todos filter', async ({ page }) => {
    const title = `${stamp()} archived todo`;
    const todo = await createTodo(title);
    await archiveTodo(todo.id);

    await gotoView(page, 'Archived');
    await page.locator('.filter-chip', { hasText: 'Todos' }).click();
    const row = page.locator('.row', { hasText: title });
    await expect(row).toBeVisible();
    // Project-less todos render as Inbox in the meta line.
    await expect(row.locator('.row-meta')).toContainText('todo · Inbox');
  });

  test('archived view: archived note and document appear under their kind filters', async ({ page }) => {
    const noteTitle = `${stamp()} archived note`;
    const docTitle = `${stamp()} archived doc`;
    const note = await createNote(noteTitle, 'body for the archived-note fixture');
    const doc = await createDoc(docTitle, 'body for the archived-doc fixture');
    await archiveContent(note.id);
    await archiveContent(doc.id);

    await gotoView(page, 'Archived');
    await page.locator('.filter-chip', { hasText: 'Notes' }).click();
    await expect(page.locator('.row', { hasText: noteTitle })).toBeVisible();
    await expect(page.locator('.row', { hasText: docTitle })).toHaveCount(0);

    await page.locator('.filter-chip', { hasText: 'Documents' }).click();
    await expect(page.locator('.row', { hasText: docTitle })).toBeVisible();
    await expect(page.locator('.row', { hasText: noteTitle })).toHaveCount(0);
  });

  test('archived view: Restore brings a todo back to the active list', async ({ page }) => {
    const title = `${stamp()} restore me`;
    const todo = await createTodo(title);
    await archiveTodo(todo.id);

    await gotoView(page, 'Archived');
    const row = page.locator('.row', { hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Restore' }).click();

    // Row leaves the archive and the todo is active again on the backend.
    await expect(row).toHaveCount(0);
    await expect.poll(async () => {
      const todos = await listTodos({ project_id: 'null' });
      return todos.some((t) => t.id === todo.id);
    }).toBe(true);
  });

  test('archived view: Delete forever is gated on typing the title, then hard-deletes', async ({ page }) => {
    const title = `${stamp()} purge me`;
    const todo = await createTodo(title);
    await archiveTodo(todo.id);

    await gotoView(page, 'Archived');
    const row = page.locator('.row', { hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Delete forever' }).click();

    // Confirm modal: the danger button stays disabled until the exact title
    // is typed (the header copy promises this gate).
    const confirm = page.locator('.modal-foot .btn-danger', { hasText: 'Delete forever' });
    await expect(confirm).toBeDisabled();
    await page.locator('.modal input.input').first().fill(title);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(row).toHaveCount(0);
    // Hard-deleted: gone even from the archived listing.
    await expect.poll(async () => {
      const todos = await listTodos({ include_archived: true });
      return todos.some((t) => t.id === todo.id);
    }).toBe(false);
  });

  test('archived view: Empty archive purges every listed item after confirm', async ({ page }) => {
    const todoTitle = `${stamp()} empty-victim todo`;
    const noteTitle = `${stamp()} empty-victim note`;
    const todo = await createTodo(todoTitle);
    const note = await createNote(noteTitle, 'body for the empty-archive spec');
    await archiveTodo(todo.id);
    await archiveContent(note.id);

    // Empty archive nukes the SEED's archived fixtures too (the archived
    // project + note other suites assert on). Snapshot them first and
    // recreate equivalents afterwards so the shared seed contract survives.
    const seedSnapshot = await snapshotSeedArchive();

    try {
      await gotoView(page, 'Archived');
      await expect(page.locator('.row', { hasText: todoTitle })).toBeVisible();
      await expect(page.locator('.row', { hasText: noteTitle })).toBeVisible();

      await page.getByRole('button', { name: 'Empty archive' }).click();
      await expect(page.locator('.modal-head h3', { hasText: 'Empty the archive?' })).toBeVisible();
      await page.locator('.modal-foot .btn-danger', { hasText: 'Delete all forever' }).click();

      // Everything currently listed is purged — the empty state renders.
      await expect(page.getByText('Archive is empty.')).toBeVisible({ timeout: 20000 });
      await expect.poll(async () => {
        const todos = await listTodos({ include_archived: true });
        return todos.some((t) => t.id === todo.id);
      }).toBe(false);
    } finally {
      await recreateSeedArchive(seedSnapshot);
    }
  });
}

// ---- seed snapshot/recreate for the destructive Empty-archive flow ----

interface SeedArchiveSnapshot {
  projects: Array<{ name: string; description: string | null }>;
  // Projects are recreated with NEW ids, so notes reference them by name.
  notes: Array<{ title: string; content: string; projectNames: string[]; tags: string[] }>;
  todos: Array<{ content: string; projectName: string | null }>;
}

async function snapshotSeedArchive(): Promise<SeedArchiveSnapshot> {
  const allProjects = await listProjects();
  const nameById = new Map(allProjects.map((p) => [p.id, p.name]));
  const projects = allProjects
    .filter((p) => p.status === 'archived' && !p.name.startsWith('e2e:'))
    .map((p) => ({ name: p.name, description: p.description }));
  const notes: SeedArchiveSnapshot['notes'] = [];
  for (const c of await listContent({ include_archived: true })) {
    if (!c.archived || c.title.startsWith('e2e:') || c.type !== 'note') continue;
    const full = await getContentItem(c.id);
    notes.push({
      title: c.title,
      content: full.content ?? '',
      projectNames: c.project_ids.map((id) => nameById.get(id)).filter((n): n is string => !!n),
      tags: c.tags ?? [],
    });
  }
  const todos = (await listTodos({ include_archived: true }))
    .filter((t) => t.archived && !t.content.startsWith('e2e:'))
    .map((t) => ({ content: t.content, projectName: t.project_id ? nameById.get(t.project_id) ?? null : null }));
  return { projects, notes, todos };
}

async function recreateSeedArchive(snap: SeedArchiveSnapshot): Promise<void> {
  for (const p of snap.projects) {
    const created = await createProject(p.name, p.description ?? undefined);
    await archiveProject(created.id);
  }
  // Resolve project names AFTER recreating archived projects so notes/todos
  // that lived in them re-attach to the new rows.
  const idByName = new Map((await listProjects()).map((p) => [p.name, p.id]));
  for (const n of snap.notes) {
    const projectIds = n.projectNames.map((name) => idByName.get(name)).filter((id): id is string => !!id);
    const created = await createNote(n.title, n.content, { projectIds, tags: n.tags });
    await archiveContent(created.id);
  }
  for (const t of snap.todos) {
    const created = await createTodo(t.content, t.projectName ? idByName.get(t.projectName) ?? null : null);
    await archiveTodo(created.id);
  }
}
