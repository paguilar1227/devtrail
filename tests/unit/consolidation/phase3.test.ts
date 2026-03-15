import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { EmbeddingProvider } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('phase3', () => {
  it('embeds all facts and insights with null embeddings', async () => {
    const db = mockDb();
    const embedding: EmbeddingProvider = {
      embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
      dimensions: 3072,
    };

    // Query for items needing embeddings
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: 'f1', content: 'fact content' }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // facts with null embedding
      .mockResolvedValueOnce({
        rows: [{ id: 'i1', content: 'insight content' }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // insights with null embedding
      .mockResolvedValue({
        rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
      }); // updates

    const { runPhase3 } = await import('../../../src/consolidation/phase3.js');
    const result = await runPhase3(db, embedding);

    expect(embedding.embed).toHaveBeenCalledTimes(2); // once per item
    expect(result.itemsEmbedded).toBe(2);
  });
});
