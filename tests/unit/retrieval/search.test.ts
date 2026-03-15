// tests/unit/retrieval/search.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { EmbeddingProvider } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function mockEmbed(): EmbeddingProvider {
  return { embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)), dimensions: 3072 };
}

describe('searchThoughts', () => {
  it('returns insight tier when insight matches', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: 'i1', content: 'Analytical personality', category: 'pattern',
                 confidence: 0.9, similarity: 0.88 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'personality', 0.5, 10);

    expect(results[0].tier).toBe('insight');
    expect(results[0].confidence).toBe(0.9);
  });

  it('falls back to facts when no insights match', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{ id: 'f1', content: 'Prefers TypeScript', category: 'preference',
                 confidence: 0.8, similarity: 0.75 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // facts

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'typescript', 0.5, 10);

    expect(results[0].tier).toBe('fact');
  });

  it('falls back to captures when no insights or facts match', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // facts
      .mockResolvedValueOnce({
        rows: [{ id: 'c1', content: 'Raw thought about hiking', similarity: 0.6 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // captures

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'hiking', 0.5, 10);

    expect(results[0].tier).toBe('capture');
  });

  it('appends evidence for low-confidence results (<0.7)', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{ id: 'f1', content: 'Might like hiking', category: 'preference',
                 confidence: 0.5, similarity: 0.7, source_capture_ids: ['c1'] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // low-confidence fact
      .mockResolvedValueOnce({
        rows: [{ id: 'c1', content: 'Mentioned hiking once', similarity: 0.6 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // source captures for evidence

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'hiking', 0.5, 10);

    expect(results[0].note).toContain('Moderate confidence');
    expect(results[0].evidence).toBeDefined();
    expect(results[0].evidence!.length).toBeGreaterThan(0);
  });
});
