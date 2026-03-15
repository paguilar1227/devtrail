import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('reminder-comments', () => {
  it('inserts a comment', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'cmt-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    const { insertComment } = await import('../../../src/db/reminder-comments.js');
    const result = await insertComment(db, {
      content: 'Made progress on auth module today',
      embedding: new Array(3072).fill(0),
      reminderId: 'rem-1',
      source: 'telegram',
    });
    expect(result.id).toBe('cmt-1');
    const callArgs = vi.mocked(db.query).mock.calls[0];
    expect(callArgs[1]).toContain('rem-1');
    expect(callArgs[1]).toContain('Made progress on auth module today');
  });

  it('finds comments by reminder id ordered by created_at ASC', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        { id: 'cmt-1', content: 'First note', reminder_id: 'rem-1', source: 'mcp', created_at: new Date('2026-03-13') },
        { id: 'cmt-2', content: 'Second note', reminder_id: 'rem-1', source: 'telegram', created_at: new Date('2026-03-14') },
      ],
      command: 'SELECT', rowCount: 2, oid: 0, fields: [],
    });
    const { findCommentsByReminderId } = await import('../../../src/db/reminder-comments.js');
    const results = await findCommentsByReminderId(db, 'rem-1');
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('First note');
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain('ORDER BY created_at ASC');
  });

  it('deletes all comments for a reminder', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'DELETE', rowCount: 3, oid: 0, fields: [],
    });
    const { deleteCommentsByReminderId } = await import('../../../src/db/reminder-comments.js');
    await deleteCommentsByReminderId(db, 'rem-1');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM reminder_comments'),
      ['rem-1'],
    );
  });

  it('returns empty array when reminder has no comments', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [],
    });
    const { findCommentsByReminderId } = await import('../../../src/db/reminder-comments.js');
    const results = await findCommentsByReminderId(db, 'rem-999');
    expect(results).toHaveLength(0);
  });
});
