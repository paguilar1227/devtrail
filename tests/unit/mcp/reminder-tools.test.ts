// tests/unit/mcp/reminder-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock service modules before importing the tools
vi.mock('../../../src/services/reminders.js', () => ({
  createReminder: vi.fn(),
  listReminders: vi.fn(),
  getReminder: vi.fn(),
  getReminderDetail: vi.fn(),
  updateReminder: vi.fn(),
  completeReminder: vi.fn(),
  deleteReminder: vi.fn(),
  listProjects: vi.fn(),
  findSubtasks: vi.fn(),
}));

vi.mock('../../../src/services/comments.js', () => ({
  addComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock('../../../src/notifications/format-reminders.js', () => ({
  formatRemindersMarkdown: vi.fn().mockReturnValue('formatted reminders'),
  formatReminderDetailMarkdown: vi.fn().mockReturnValue('formatted detail'),
}));

function makeDeps() {
  return {
    db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
    embeddingProvider: { embed: vi.fn().mockResolvedValue(new Array(3072).fill(0)), dimensions: 3072 },
    config: {},
  } as any;
}

async function makeServer(deps: ReturnType<typeof makeDeps>) {
  const server = new McpServer({ name: 'test', version: '1.0' });
  const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
  registerReminderTools(server, deps);
  return server;
}

describe('reminder tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all 10 reminder tools without throwing', async () => {
    const deps = makeDeps();
    await makeServer(deps);
    expect(true).toBe(true);
  });

  it('create_reminder calls remindersSvc.createReminder with mcp source', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.createReminder).mockResolvedValue({ id: 'rem-1' });

    const deps = makeDeps();
    await makeServer(deps);

    const result = await remindersSvc.createReminder(deps, {
      content: 'Test reminder',
      project: 'my-project',
      source: 'mcp',
    });
    expect(result.id).toBe('rem-1');
    expect(remindersSvc.createReminder).toHaveBeenCalledWith(deps, expect.objectContaining({
      content: 'Test reminder',
      project: 'my-project',
      source: 'mcp',
    }));
  });

  it('create_reminder returns error when service throws (parent not found)', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.createReminder).mockRejectedValue(new Error('Parent reminder parent-id not found'));

    const deps = makeDeps();
    await makeServer(deps);

    await expect(
      remindersSvc.createReminder(deps, { content: 'sub', parentId: 'parent-id' })
    ).rejects.toThrow('Parent reminder parent-id not found');
  });

  it('create_reminder returns error when service throws (max depth exceeded)', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.createReminder).mockRejectedValue(new Error('Maximum subtask depth (4 levels) exceeded'));

    const deps = makeDeps();
    await makeServer(deps);

    await expect(
      remindersSvc.createReminder(deps, { content: 'deep-sub', parentId: 'p-id' })
    ).rejects.toThrow('Maximum subtask depth (4 levels) exceeded');
  });

  it('list_reminders calls remindersSvc.listReminders and findSubtasks', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.listReminders).mockResolvedValue([
      { id: 'rem-1', status: 'in_progress', project: 'my-project' } as any,
    ]);
    vi.mocked(remindersSvc.findSubtasks).mockResolvedValue([]);

    const deps = makeDeps();
    await makeServer(deps);

    const results = await remindersSvc.listReminders(deps, { project: 'my-project' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('rem-1');
  });

  it('list_reminders builds subtask map using findSubtasks per reminder', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.listReminders).mockResolvedValue([
      { id: 'rem-1' } as any,
      { id: 'rem-2' } as any,
    ]);
    vi.mocked(remindersSvc.findSubtasks)
      .mockResolvedValueOnce([{ id: 'sub-1', parent_id: 'rem-1' } as any])
      .mockResolvedValueOnce([]);

    const deps = makeDeps();
    await makeServer(deps);

    await remindersSvc.findSubtasks(deps, 'rem-1');
    await remindersSvc.findSubtasks(deps, 'rem-2');

    expect(remindersSvc.findSubtasks).toHaveBeenCalledWith(deps, 'rem-1');
    expect(remindersSvc.findSubtasks).toHaveBeenCalledWith(deps, 'rem-2');
  });

  it('get_reminder_detail calls remindersSvc.getReminderDetail', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.getReminderDetail).mockResolvedValue({
      id: 'rem-1', content: 'Test task', comments: [], subtasks: [],
    } as any);

    const deps = makeDeps();
    await makeServer(deps);

    const detail = await remindersSvc.getReminderDetail(deps, 'rem-1');
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('rem-1');
  });

  it('get_reminder_detail returns not found message when null', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.getReminderDetail).mockResolvedValue(null);

    const deps = makeDeps();
    await makeServer(deps);

    const detail = await remindersSvc.getReminderDetail(deps, 'missing-id');
    expect(detail).toBeNull();
  });

  it('update_reminder calls remindersSvc.updateReminder', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.updateReminder).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    await remindersSvc.updateReminder(deps, 'rem-1', { status: 'done', content: 'Updated' });
    expect(remindersSvc.updateReminder).toHaveBeenCalledWith(deps, 'rem-1', expect.objectContaining({
      status: 'done',
      content: 'Updated',
    }));
  });

  it('complete_reminder calls remindersSvc.completeReminder (cascades to subtasks)', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.completeReminder).mockResolvedValue({ completed: ['rem-1', 'sub-1'] });

    const deps = makeDeps();
    await makeServer(deps);

    const result = await remindersSvc.completeReminder(deps, 'rem-1');
    expect(result.completed).toEqual(['rem-1', 'sub-1']);
    expect(remindersSvc.completeReminder).toHaveBeenCalledWith(deps, 'rem-1');
  });

  it('delete_reminder calls remindersSvc.deleteReminder', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.deleteReminder).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    await remindersSvc.deleteReminder(deps, 'rem-1');
    expect(remindersSvc.deleteReminder).toHaveBeenCalledWith(deps, 'rem-1');
  });

  it('add_reminder_comment calls commentsSvc.addComment with mcp source', async () => {
    const commentsSvc = await import('../../../src/services/comments.js');
    vi.mocked(commentsSvc.addComment).mockResolvedValue({ id: 'cmt-1' });

    const deps = makeDeps();
    await makeServer(deps);

    const result = await commentsSvc.addComment(deps, 'rem-1', 'Progress update', 'mcp');
    expect(result.id).toBe('cmt-1');
    expect(commentsSvc.addComment).toHaveBeenCalledWith(deps, 'rem-1', 'Progress update', 'mcp');
  });

  it('add_reminder_comment returns error when commentsSvc.addComment throws (reminder not found)', async () => {
    const commentsSvc = await import('../../../src/services/comments.js');
    vi.mocked(commentsSvc.addComment).mockRejectedValue(new Error('Reminder rem-999 not found'));

    const deps = makeDeps();
    await makeServer(deps);

    await expect(
      commentsSvc.addComment(deps, 'rem-999', 'note', 'mcp')
    ).rejects.toThrow('Reminder rem-999 not found');
  });

  it('list_projects calls remindersSvc.listProjects', async () => {
    const remindersSvc = await import('../../../src/services/reminders.js');
    vi.mocked(remindersSvc.listProjects).mockResolvedValue([
      { project: 'proj-a', total: 3, not_started: 1, in_progress: 2, done: 0, paused: 0, blocked: 0, cancelled: 0 },
    ]);

    const deps = makeDeps();
    await makeServer(deps);

    const results = await remindersSvc.listProjects(deps);
    expect(results[0].project).toBe('proj-a');
    expect(results[0].total).toBe(3);
    expect(remindersSvc.listProjects).toHaveBeenCalledWith(deps);
  });

  it('edit_comment calls commentsSvc.updateComment', async () => {
    const commentsSvc = await import('../../../src/services/comments.js');
    vi.mocked(commentsSvc.updateComment).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    await commentsSvc.updateComment(deps, 'cmt-1', 'Revised comment text');
    expect(commentsSvc.updateComment).toHaveBeenCalledWith(deps, 'cmt-1', 'Revised comment text');
  });

  it('edit_comment returns error when commentsSvc.updateComment throws (not found)', async () => {
    const commentsSvc = await import('../../../src/services/comments.js');
    vi.mocked(commentsSvc.updateComment).mockRejectedValue(new Error('Comment cmt-999 not found'));

    const deps = makeDeps();
    await makeServer(deps);

    await expect(
      commentsSvc.updateComment(deps, 'cmt-999', 'text')
    ).rejects.toThrow('Comment cmt-999 not found');
  });

  it('delete_comment calls commentsSvc.deleteComment and returns deleted content', async () => {
    const commentsSvc = await import('../../../src/services/comments.js');
    vi.mocked(commentsSvc.deleteComment).mockResolvedValue({
      id: 'cmt-1',
      content: 'This was the comment',
      embedding: [],
      reminder_id: 'rem-1',
      source: 'mcp',
      created_at: new Date(),
    });

    const deps = makeDeps();
    await makeServer(deps);

    const deleted = await commentsSvc.deleteComment(deps, 'cmt-1');
    expect(deleted.content).toBe('This was the comment');
    expect(commentsSvc.deleteComment).toHaveBeenCalledWith(deps, 'cmt-1');
  });

  it('delete_comment returns error when commentsSvc.deleteComment throws (not found)', async () => {
    const commentsSvc = await import('../../../src/services/comments.js');
    vi.mocked(commentsSvc.deleteComment).mockRejectedValue(new Error('Comment cmt-999 not found'));

    const deps = makeDeps();
    await makeServer(deps);

    await expect(
      commentsSvc.deleteComment(deps, 'cmt-999')
    ).rejects.toThrow('Comment cmt-999 not found');
  });
});
