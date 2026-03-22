import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('facts', () => {
  it('inserts a new fact with source_capture_ids', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'fact-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    const { insertFact } = await import('../../../src/db/facts.js');
    const result = await insertFact(db, {
      content: 'Prefers TypeScript over JavaScript',
      tags: ['preference', 'technology'],
      source: ['telegram'],
      embedding: new Array(3072).fill(0),
      confidence: 0.8,
      sourceCaptureIds: ['cap-1', 'cap-2'],
      origin: 'consolidation',
      reviewStatus: 'auto_approved',
    });
    expect(result.id).toBe('fact-1');
  });

  it('updates a fact and pushes previous version', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'fact-1' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });
    const { updateFactContent } = await import('../../../src/db/facts.js');
    await updateFactContent(db, 'fact-1', {
      content: 'Strongly prefers TypeScript',
      confidence: 0.9,
      reason: 'Multiple captures reinforce this',
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('previous_versions'),
      expect.arrayContaining(['Strongly prefers TypeScript', 0.9]),
    );
  });

  it('marks fact as user_edited with confidence 1.0', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'fact-1' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });
    const { userEditFact } = await import('../../../src/db/facts.js');
    await userEditFact(db, 'fact-1', 'Corrected fact content');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("origin = 'user_edited'"),
      expect.arrayContaining(['Corrected fact content', 1.0]),
    );
  });

  it('finds active facts for consolidation', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'f1', confidence: 0.8 }], command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { findActiveFacts } = await import('../../../src/db/facts.js');
    const facts = await findActiveFacts(db, 0.3);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("review_status != 'user_rejected'"),
      [0.3],
    );
  });

  it('finds facts by similarity', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'f1', similarity: 0.88 }], command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });
    const { findSimilarFacts } = await import('../../../src/db/facts.js');
    const results = await findSimilarFacts(db, new Array(3072).fill(0), 0.5, 10);
    expect(results[0].similarity).toBe(0.88);
  });

  it('updates fact tags and returns new tag array', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ tags: ['preference', 'technology'] }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
    });
    const { updateFactTags } = await import('../../../src/db/facts.js');
    const result = await updateFactTags(db, 'fact-1', ['preference', 'technology']);
    expect(result).toEqual(['preference', 'technology']);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE facts SET tags'),
      [['preference', 'technology'], 'fact-1'],
    );
  });

  it('returns null from updateFactTags when fact not found', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [],
    });
    const { updateFactTags } = await import('../../../src/db/facts.js');
    const result = await updateFactTags(db, 'nonexistent', ['tag']);
    expect(result).toBeNull();
  });
});
