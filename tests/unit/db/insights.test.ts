import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('insights', () => {
  it('inserts an insight with pending_review status', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    const { insertInsight } = await import('../../../src/db/insights.js');
    const result = await insertInsight(db, {
      content: 'User shows strong analytical tendencies',
      tags: ['pattern', 'behavior'],
      source: ['telegram', 'mcp'],
      embedding: new Array(3072).fill(0),
      confidence: 0.75,
      sourceFactIds: ['f1', 'f2', 'f3'],
      origin: 'consolidation',
    });
    expect(result.id).toBe('ins-1');
  });

  it('finds approved insights for profile', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1', review_status: 'user_approved' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { findApprovedInsights } = await import('../../../src/db/insights.js');
    await findApprovedInsights(db);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("review_status IN ('auto_approved', 'user_approved')"),
      [],
    );
  });

  it('finds similar insights by embedding', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1', similarity: 0.92 }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { findSimilarInsights } = await import('../../../src/db/insights.js');
    const results = await findSimilarInsights(db, new Array(3072).fill(0), 0.5, 10);
    expect(results[0].similarity).toBe(0.92);
  });

  it('sets review status with content edit', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'ins-1' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });
    const { setInsightReviewStatus } = await import('../../../src/db/insights.js');
    await setInsightReviewStatus(db, 'ins-1', 'user_approved', 'Edited insight content');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("origin = 'user_edited'"),
      expect.arrayContaining(['user_approved', 'Edited insight content', 'ins-1']),
    );
  });

  it('updates insight tags and returns new tag array', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ tags: ['pattern', 'behavior'] }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });
    const { updateInsightTags } = await import('../../../src/db/insights.js');
    const result = await updateInsightTags(db, 'ins-1', ['pattern', 'behavior']);
    expect(result).toEqual(['pattern', 'behavior']);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE insights SET tags'),
      [['pattern', 'behavior'], 'ins-1'],
    );
  });

  it('returns null from updateInsightTags when insight not found', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [],
    });
    const { updateInsightTags } = await import('../../../src/db/insights.js');
    const result = await updateInsightTags(db, 'nonexistent', ['tag']);
    expect(result).toBeNull();
  });
});
