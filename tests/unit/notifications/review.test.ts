// tests/unit/notifications/review.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('review', () => {
  it('returns pending items count', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ facts_pending: '3', insights_pending: '1' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { getPendingReviewCount } = await import('../../../src/notifications/review.js');
    const count = await getPendingReviewCount(db);
    expect(count.facts).toBe(3);
    expect(count.insights).toBe(1);
    expect(count.total).toBe(4);
  });
});
