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
        rows: [{ id: 'i1', content: 'Analytical personality', tags: ['pattern'],
                 confidence: 0.9, similarity: 0.88, source_fact_ids: [] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'personality', 0.5, 10);

    expect(results[0].tier).toBe('insight');
    expect(results[0].confidence).toBe(0.9);
    expect(results[0].file_urls).toBeNull();
  });

  it('falls back to facts when no insights match', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{ id: 'f1', content: 'Prefers TypeScript', tags: ['preference'],
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
        rows: [{ id: 'c1', content: 'Raw thought about hiking', tags: [], similarity: 0.6 }],
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
        rows: [{ id: 'f1', content: 'Might like hiking', tags: ['interest'],
                 confidence: 0.5, similarity: 0.7, source_capture_ids: ['c1'] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // low-confidence fact
      .mockResolvedValueOnce({
        rows: [{ id: 'c1', file_urls: null }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // file_urls traceback for captures
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

  it('passes tags to db query when provided', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: 'i1', content: 'TypeScript skill', tags: ['skill'],
                 confidence: 0.9, similarity: 0.88, source_fact_ids: [] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    await searchThoughts(db, mockEmbed(), 'typescript', 0.5, 10, ['skill']);

    // The db.query should have been called with ['skill'] as the tags param
    const callArgs = vi.mocked(db.query).mock.calls[0];
    expect(callArgs[1]).toContain(JSON.stringify(new Array(3072).fill(0.1)));
    expect(callArgs[1]).toContain(0.5);
    expect(callArgs[1]).toContain(10);
    // tags array is the last param when provided
    const params = callArgs[1] as any[];
    expect(params[params.length - 1]).toEqual(['skill']);
  });

  it('works without tags (regression)', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: 'i1', content: 'Prefers remote work', tags: ['preference'],
                 confidence: 0.85, similarity: 0.82, source_fact_ids: [] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'remote work', 0.5, 10);

    expect(results[0].tier).toBe('insight');
    // Verify no tags param was added (only 3 params: embedding, threshold, limit)
    const callArgs = vi.mocked(db.query).mock.calls[0];
    expect((callArgs[1] as any[]).length).toBe(3);
  });

  // --- file_urls in search results ---

  it('capture results include file_urls from the capture row', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // facts
      .mockResolvedValueOnce({
        rows: [{
          id: 'c1', content: 'Photo of whiteboard', tags: ['resource'], similarity: 0.7,
          file_urls: ['https://blob.example.com/whiteboard.jpg'],
        }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // captures

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'whiteboard', 0.5, 10);

    expect(results[0].tier).toBe('capture');
    expect(results[0].file_urls).toEqual(['https://blob.example.com/whiteboard.jpg']);
  });

  it('capture results with no files have null file_urls', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // facts
      .mockResolvedValueOnce({
        rows: [{ id: 'c1', content: 'Just text', tags: [], similarity: 0.6, file_urls: null }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }); // captures

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'text', 0.5, 10);

    expect(results[0].file_urls).toBeNull();
  });

  it('fact results trace back to source captures for file_urls', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{
          id: 'f1', content: 'Prefers visual planning', tags: ['preference'],
          confidence: 0.8, similarity: 0.75, source_capture_ids: ['c1', 'c2'],
        }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // facts
      .mockResolvedValueOnce({
        rows: [
          { id: 'c1', file_urls: ['https://blob.example.com/diagram.png'] },
          { id: 'c2', file_urls: null }, // c2 has no files
        ],
        command: 'SELECT', rowCount: 2, oid: 0, fields: [],
      }); // file_urls traceback for captures

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'visual planning', 0.5, 10);

    expect(results[0].tier).toBe('fact');
    expect(results[0].file_urls).toEqual(['https://blob.example.com/diagram.png']);
  });

  it('fact results with no source files have null file_urls', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{
          id: 'f1', content: 'Prefers TypeScript', tags: ['preference'],
          confidence: 0.8, similarity: 0.75, source_capture_ids: ['c1'],
        }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // facts
      .mockResolvedValueOnce({
        rows: [], // no captures have file_urls
        command: 'SELECT', rowCount: 0, oid: 0, fields: [],
      }); // file_urls traceback

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'typescript', 0.5, 10);

    expect(results[0].file_urls).toBeNull();
  });

  it('insight results trace through facts to source captures for file_urls', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{
          id: 'i1', content: 'Visual thinker pattern', tags: ['pattern'],
          confidence: 0.9, similarity: 0.88, source_fact_ids: ['f1', 'f2'],
        }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // insights
      .mockResolvedValueOnce({
        rows: [
          { id: 'f1', source_capture_ids: ['c1'] },
          { id: 'f2', source_capture_ids: ['c2', 'c3'] },
        ],
        command: 'SELECT', rowCount: 2, oid: 0, fields: [],
      }) // facts → source_capture_ids
      .mockResolvedValueOnce({
        rows: [
          { id: 'c1', file_urls: ['https://blob.example.com/sketch1.png'] },
          { id: 'c3', file_urls: ['https://blob.example.com/sketch2.png'] },
        ],
        command: 'SELECT', rowCount: 2, oid: 0, fields: [],
      }); // captures → file_urls

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'visual thinking', 0.5, 10);

    expect(results[0].tier).toBe('insight');
    expect(results[0].file_urls).toBeDefined();
    expect(results[0].file_urls).toContain('https://blob.example.com/sketch1.png');
    expect(results[0].file_urls).toContain('https://blob.example.com/sketch2.png');
  });

  it('deduplicates file_urls when multiple captures share the same file', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // insights
      .mockResolvedValueOnce({
        rows: [{
          id: 'f1', content: 'Uses diagrams', tags: ['pattern'],
          confidence: 0.8, similarity: 0.75, source_capture_ids: ['c1', 'c2'],
        }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // facts
      .mockResolvedValueOnce({
        rows: [
          { id: 'c1', file_urls: ['https://blob.example.com/shared.png'] },
          { id: 'c2', file_urls: ['https://blob.example.com/shared.png'] }, // same file
        ],
        command: 'SELECT', rowCount: 2, oid: 0, fields: [],
      }); // traceback

    const { searchThoughts } = await import('../../../src/retrieval/search.js');
    const results = await searchThoughts(db, mockEmbed(), 'diagrams', 0.5, 10);

    expect(results[0].file_urls).toEqual(['https://blob.example.com/shared.png']);
  });
});
