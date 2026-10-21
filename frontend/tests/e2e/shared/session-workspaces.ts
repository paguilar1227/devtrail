import { test, expect, stamp } from '../helpers/setup';
import { gotoView, gotoProjectPage } from '../helpers/nav';

const base = 'http://localhost:3001/api/v1';
const headers = { Authorization: 'Bearer local-dev-key-not-secret', 'Content-Type': 'application/json' };
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
export function defineSessionWorkspaceTests() {
  test('session ownership, shared timeline tags, moves and confirmed deletion', async ({ page }) => {
    const name = stamp(), noteName = `${name} note`, taskName = `${name} todo`;
    const project = (await api('/projects', 'POST', { name: `${name} project` })).project;
    await page.reload();
    await gotoView(page, 'Sessions');
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    const modal = page.locator('.modal');
    await modal.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await modal.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const session = (await api('/sessions')).sessions.find((s: any) => s.name === name);
    expect(session.project_id).toBeNull();

    await page.getByRole('tab', { name: /^Notes/ }).click();
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await page.locator('.note-title-input').fill(noteName);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByRole('button', { name: new RegExp(noteName) })).toBeVisible();
    const note = (await api(`/content?session_id=${session.id}&type=note`)).items[0];
    expect(note.session_id).toBe(session.id);
    await api(`/content/${note.id}`, 'PUT', { tags: ['shared', 'notes-only'] });

    await page.getByRole('tab', { name: /^Documents/ }).click();
    await page.getByRole('button', { name: 'Upload artifact' }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Session-owned original file'),
    });
    await page.getByRole('button', { name: 'Process 1', exact: true }).click();
    await expect(page.locator('.modal-foot').getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
    await page.locator('.modal-foot').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect.poll(async () => (await api(`/content?session_id=${session.id}&type=document`)).items.length).toBe(1);
    const document = (await api(`/content?session_id=${session.id}&type=document`)).items[0];
    expect(document.session_id).toBe(session.id);
    await expect.poll(async () => (await api(`/content/${document.id}`)).item.processing_status).toBe('ready');
    const download = (await api(`/content/${document.id}`)).item.blob_url;
    expect((await fetch(download)).status).toBe(200);

    await page.getByRole('tab', { name: /^Todos/ }).click();
    await page.getByRole('textbox', { name: 'New session todo' }).fill(taskName);
    await page.getByRole('button', { name: 'Add todo', exact: true }).click();
    await expect(page.getByRole('button', { name: taskName, exact: true })).toBeVisible();
    const todo = (await api(`/todos?session_id=${session.id}`)).todos[0];
    await api(`/todos/${todo.id}`, 'PUT', { tags: ['shared', 'tasks-only'] });

    await page.getByRole('button', { name: 'Manage session' }).click();
    await modal.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await modal.getByRole('button', { name: 'Save changes' }).click();
    await expect(modal).toHaveCount(0);
    expect((await api(`/sessions/${session.id}`)).session.project_id).toBe(project.id);
    expect((await api(`/todos/${todo.id}`)).todo.project_id).toBe(project.id);
    expect((await api(`/content/${note.id}`)).item.project_ids).toEqual([project.id]);

    await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.timeline-event')).not.toHaveCount(0);
    await page.getByRole('button', { name: 'Filter by tags' }).click();
    await page.getByRole('checkbox', { name: '#shared', exact: true }).check();
    await page.getByRole('checkbox', { name: '#notes-only', exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(page.locator('.timeline-card h4').filter({ hasText: taskName })).toHaveCount(0);
    await expect(page.locator('.timeline-card h4').filter({ hasText: noteName }).first()).toBeVisible();
    await page.getByRole('button', { name: 'OR', exact: true }).click();
    const colors = await page.getByRole('button', { name: 'OR', exact: true }).evaluate(element => {
      const style = getComputedStyle(element);
      return { text: style.color, background: style.backgroundColor };
    });
    expect(colors.text).not.toBe(colors.background);
    await expect(page.locator('.timeline-card h4').filter({ hasText: taskName }).first()).toBeVisible();

    await page.screenshot({ path: test.info().outputPath('session-timeline.png'), fullPage: true });
    await gotoProjectPage(page, project.name);
    await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
    await expect(page.getByText(`Session: ${name}`).first()).toBeVisible();
    await page.getByRole('textbox', { name: 'Search timeline' }).fill(taskName);
    await expect(page.getByRole('status')).toContainText('Match');
    await expect(page.locator('.timeline-event.current')).toContainText(taskName);

    await gotoView(page, 'Sessions');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage session' }).click();
    await page.getByRole('button', { name: 'Delete session', exact: true }).click();
    const remove = page.getByRole('button', { name: 'Delete session forever' });
    await expect(remove).toBeDisabled();
    await page.locator('.modal input').fill(name);
    await remove.click();
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
    expect((await api('/sessions')).sessions.some((s: any) => s.id === session.id)).toBe(false);
    expect((await api(`/content?session_id=${session.id}`)).items).toHaveLength(0);
    expect((await api(`/todos?session_id=${session.id}`)).todos).toHaveLength(0);
    expect((await fetch(download)).status).toBe(404);
    await api(`/projects/${project.id}?hard=true`, 'DELETE');
  });
}
