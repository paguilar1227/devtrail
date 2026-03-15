import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('consolidation-log', () => {
  it('inserts a consolidation log entry', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'log-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    const { insertConsolidationLog } = await import('../../../src/db/consolidation-log.js');
    await insertConsolidationLog(db, {
      status: 'success',
      capturesProcessed: 8,
      factsCreated: 2,
      factsUpdated: 3,
      insightsCreated: 1,
      insightsRegenerated: 0,
      duplicatesDetected: 0,
      itemsFlagged: 3,
      modelUsed: 'claude-opus-4-6',
      tokensUsed: 45000,
      durationMs: 12000,
      errorMessage: null,
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consolidation_log'),
      expect.arrayContaining(['success', 8, 2, 3]),
    );
  });

  it('fetches the latest consolidation run', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'log-1', status: 'success', run_at: new Date() }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { getLatestConsolidationRun } = await import('../../../src/db/consolidation-log.js');
    const latest = await getLatestConsolidationRun(db);
    expect(latest?.status).toBe('success');
  });
});
