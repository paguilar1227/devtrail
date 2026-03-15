import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('reminders', () => {
  it('inserts a reminder', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    const { insertReminder } = await import('../../../src/db/reminders.js');
    const result = await insertReminder(db, {
      content: 'Buy groceries',
      embedding: new Array(3072).fill(0),
      category: 'personal',
      project: null,
      section: null,
      parentId: null,
      depth: 0,
      priority: null,
      source: 'telegram',
      sourceContext: 'Chat about dinner plans',
      dueDate: null,
    });
    expect(result.id).toBe('rem-1');
  });

  it('inserts a reminder with project, section, and priority', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-2' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    const { insertReminder } = await import('../../../src/db/reminders.js');
    const result = await insertReminder(db, {
      content: 'Implement auth module',
      embedding: new Array(3072).fill(0),
      category: 'work',
      project: 'deep-research-engine',
      section: 'backend',
      parentId: null,
      depth: 0,
      priority: 'P1',
      source: 'mcp',
      sourceContext: null,
      dueDate: null,
    });
    expect(result.id).toBe('rem-2');
    const callArgs = vi.mocked(db.query).mock.calls[0];
    expect(callArgs[1]).toContain('deep-research-engine');
    expect(callArgs[1]).toContain('backend');
    expect(callArgs[1]).toContain('P1');
  });

  it('inserts a subtask with parent_id and depth', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-3' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    const { insertReminder } = await import('../../../src/db/reminders.js');
    const result = await insertReminder(db, {
      content: 'Write unit tests',
      embedding: new Array(3072).fill(0),
      category: null,
      project: 'deep-research-engine',
      section: 'backend',
      parentId: 'rem-2',
      depth: 1,
      priority: null,
      source: 'mcp',
      sourceContext: null,
      dueDate: null,
    });
    expect(result.id).toBe('rem-3');
    const callArgs = vi.mocked(db.query).mock.calls[0];
    expect(callArgs[1]).toContain('rem-2');
    expect(callArgs[1]).toContain(1); // depth
  });

  it('lists active reminders filtered by status', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'not_started' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { listReminders } = await import('../../../src/db/reminders.js');
    const results = await listReminders(db, { status: 'not_started', limit: 20 });
    expect(results).toHaveLength(1);
  });

  it('lists reminders filtered by project and section', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', project: 'my-project', section: 'backend' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { listReminders } = await import('../../../src/db/reminders.js');
    const results = await listReminders(db, { project: 'my-project', section: 'backend' });
    expect(results).toHaveLength(1);
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain('project');
    expect(sql).toContain('section');
  });

  it('lists reminders filtered by priority', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', priority: 'P1' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { listReminders } = await import('../../../src/db/reminders.js');
    const results = await listReminders(db, { priority: 'P1' });
    expect(results).toHaveLength(1);
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain('priority');
  });

  it('top_level_only defaults to true (adds depth = 0 filter)', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [],
    });
    const { listReminders } = await import('../../../src/db/reminders.js');
    await listReminders(db, {});
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain('depth = 0');
  });

  it('top_level_only=false omits depth filter', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [],
    });
    const { listReminders } = await import('../../../src/db/reminders.js');
    await listReminders(db, { top_level_only: false });
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).not.toContain('depth = 0');
  });

  it('include_done=false excludes done and cancelled', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [],
    });
    const { listReminders } = await import('../../../src/db/reminders.js');
    await listReminders(db, { include_done: false });
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain("status != 'done'");
    expect(sql).toContain("status != 'cancelled'");
  });

  it('marks reminder as done', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'done' }],
      command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });
    const { completeReminder } = await import('../../../src/db/reminders.js');
    await completeReminder(db, 'rem-1');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'done'"),
      ['rem-1'],
    );
  });

  it('completeReminder does NOT touch subtasks (single row update)', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });
    const { completeReminder } = await import('../../../src/db/reminders.js');
    await completeReminder(db, 'rem-1');
    // Only one query should be issued — no cascade
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('deleteReminder cascades to subtasks and comments', async () => {
    const db = mockDb();
    // collectDescendantIds -> finds one child
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: 'child-1' }], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })
      // collectDescendantIds for child-1 -> no children
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
      // delete comments for child-1
      .mockResolvedValueOnce({ rows: [], command: 'DELETE', rowCount: 0, oid: 0, fields: [] })
      // delete comments for root
      .mockResolvedValueOnce({ rows: [], command: 'DELETE', rowCount: 0, oid: 0, fields: [] })
      // delete subtasks
      .mockResolvedValueOnce({ rows: [], command: 'DELETE', rowCount: 1, oid: 0, fields: [] })
      // delete root
      .mockResolvedValueOnce({ rows: [], command: 'DELETE', rowCount: 1, oid: 0, fields: [] });

    const { deleteReminder } = await import('../../../src/db/reminders.js');
    await deleteReminder(db, 'rem-1');

    // Verify delete queries were issued
    const calls = vi.mocked(db.query).mock.calls;
    const deleteCommentCalls = calls.filter(c => (c[0] as string).includes('DELETE FROM reminder_comments'));
    const deleteReminderCalls = calls.filter(c => (c[0] as string).includes('DELETE FROM reminders'));
    expect(deleteCommentCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteReminderCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('findSubtasks returns children of a given reminder', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'child-1', parent_id: 'rem-1' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { findSubtasks } = await import('../../../src/db/reminders.js');
    const results = await findSubtasks(db, 'rem-1');
    expect(results).toHaveLength(1);
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain('parent_id');
  });

  it('listProjects returns project stats', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ project: 'my-project', total: 5, not_started: 2, in_progress: 1, done: 2, paused: 0, blocked: 0, cancelled: 0 }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { listProjects } = await import('../../../src/db/reminders.js');
    const results = await listProjects(db);
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe('my-project');
    expect(results[0].total).toBe(5);
  });

  it('finds recently completed reminders for consolidation', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'done' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { findRecentlyCompletedReminders } = await import('../../../src/db/reminders.js');
    const results = await findRecentlyCompletedReminders(db, new Date('2026-03-13'));
    expect(results).toHaveLength(1);
  });

  it('findActiveReminders includes paused and blocked statuses', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'paused' }, { id: 'rem-2', status: 'blocked' }],
      command: 'SELECT', rowCount: 2, oid: 0, fields: [],
    });
    const { findActiveReminders } = await import('../../../src/db/reminders.js');
    const results = await findActiveReminders(db);
    expect(results).toHaveLength(2);
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain('paused');
    expect(sql).toContain('blocked');
  });
});
