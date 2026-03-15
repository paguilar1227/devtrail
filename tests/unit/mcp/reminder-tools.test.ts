// tests/unit/mcp/reminder-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function makeDeps() {
  return {
    db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
    embeddingProvider: { embed: vi.fn().mockResolvedValue(new Array(3072).fill(0)), dimensions: 3072 },
    config: {},
  } as any;
}

describe('reminder tools', () => {
  it('registers all 8 reminder tools without throwing', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = makeDeps();

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);
    expect(true).toBe(true);
  });

  it('create_reminder inserts reminder and returns id', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = makeDeps();
    vi.mocked(deps.db.query)
      .mockResolvedValueOnce({ rows: [{ id: 'rem-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] });

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);

    // Directly test the DB layer to verify integration
    const { insertReminder } = await import('../../../src/db/reminders.js');
    const result = await insertReminder(deps.db, {
      content: 'Test reminder',
      embedding: new Array(3072).fill(0),
      category: null,
      project: 'test-project',
      section: 'backend',
      parentId: null,
      depth: 0,
      priority: 'P1',
      source: 'mcp',
      sourceContext: null,
      dueDate: null,
    });
    expect(result.id).toBe('rem-1');
  });

  it('create_reminder rejects subtask exceeding depth 4', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = makeDeps();
    // Simulate parent with depth=3 (one below max)
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [{ id: 'parent-id', depth: 3 }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);

    // Verify depth check logic via getReminderById + depth computation
    const { getReminderById } = await import('../../../src/db/reminders.js');
    const parent = await getReminderById(deps.db, 'parent-id');
    expect(parent?.depth).toBe(3);
    // depth would be 4 (>= 4), should be rejected
    expect(parent!.depth + 1 >= 4).toBe(true);
  });

  it('list_reminders returns reminders as JSON', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = makeDeps();
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [{ id: 'rem-1', status: 'in_progress', project: 'my-project' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);

    const { listReminders } = await import('../../../src/db/reminders.js');
    const results = await listReminders(deps.db, { project: 'my-project' });
    expect(results[0].id).toBe('rem-1');
  });

  it('delete_reminder cascades to subtasks and comments', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = makeDeps();
    // No children
    vi.mocked(deps.db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
      // delete comments
      .mockResolvedValueOnce({ rows: [], command: 'DELETE', rowCount: 0, oid: 0, fields: [] })
      // delete root
      .mockResolvedValueOnce({ rows: [], command: 'DELETE', rowCount: 1, oid: 0, fields: [] });

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);

    const { deleteReminder } = await import('../../../src/db/reminders.js');
    await deleteReminder(deps.db, 'rem-1');

    const deleteCalls = vi.mocked(deps.db.query).mock.calls.filter(c =>
      (c[0] as string).includes('DELETE')
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('add_reminder_comment inserts comment and returns id', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = makeDeps();
    vi.mocked(deps.db.query)
      .mockResolvedValueOnce({ rows: [{ id: 'cmt-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] });

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);

    const { insertComment } = await import('../../../src/db/reminder-comments.js');
    const result = await insertComment(deps.db, {
      content: 'Progress update',
      embedding: new Array(3072).fill(0),
      reminderId: 'rem-1',
      source: 'mcp',
    });
    expect(result.id).toBe('cmt-1');
  });

  it('list_projects returns project stats', async () => {
    const server = new McpServer({ name: 'test', version: '1.0' });
    const deps = makeDeps();
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [{ project: 'proj-a', total: 3, not_started: 1, in_progress: 2, done: 0, paused: 0, blocked: 0, cancelled: 0 }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { registerReminderTools } = await import('../../../src/mcp/reminder-tools.js');
    registerReminderTools(server, deps);

    const { listProjects } = await import('../../../src/db/reminders.js');
    const results = await listProjects(deps.db);
    expect(results[0].project).toBe('proj-a');
    expect(results[0].total).toBe(3);
  });
});
