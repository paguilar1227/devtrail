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
      source: 'telegram',
      sourceContext: 'Chat about dinner plans',
      dueDate: null,
    });
    expect(result.id).toBe('rem-1');
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
});
