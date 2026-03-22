import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function mockLLM(): LLMProvider {
  return { complete: vi.fn() };
}

describe('phase1', () => {
  it('creates new facts from a cluster of captures using tags format', async () => {
    const db = mockDb();
    const llm = mockLLM();

    const llmResponse: LLMResponse = {
      content: JSON.stringify({
        actions: [
          {
            action: 'create_fact',
            content: 'Prefers TypeScript over JavaScript',
            tags: ['preference', 'skill'],
            confidence: 0.8,
            source_capture_ids: ['cap-1', 'cap-2'],
          },
        ],
      }),
      tokensUsed: { input: 1000, output: 200, total: 1200 },
    };
    vi.mocked(llm.complete).mockResolvedValueOnce(llmResponse);

    // Mock DB insert
    vi.mocked(db.query).mockResolvedValue({
      rows: [{ id: 'fact-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [],
    });
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'fact-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [
        { id: 'cap-1', content: 'I love TypeScript', embedding: [], source: ['telegram'] },
        { id: 'cap-2', content: 'JS is okay but TS is better', embedding: [], source: ['api'] },
      ],
      existingFacts: [],
      reviewMode: 'hybrid',
    });

    expect(result.factsCreated).toBeGreaterThan(0);
    expect(llm.complete).toHaveBeenCalled();
  });

  it('computes source union from cluster captures and stores it on the fact', async () => {
    const db = mockDb();
    const llm = mockLLM();

    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [
          {
            action: 'create_fact',
            content: 'Uses multiple channels',
            tags: ['pattern'],
            confidence: 0.7,
            source_capture_ids: ['cap-a', 'cap-b'],
          },
        ],
      }),
      tokensUsed: { input: 500, output: 100, total: 600 },
    });

    let insertedSource: string[] | undefined;
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const txClient = {
        query: vi.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes('INSERT INTO facts')) {
            // source is $3 in: INSERT INTO facts (content, tags, source, ...)
            insertedSource = params[2];
          }
          return Promise.resolve({ rows: [{ id: 'fact-x' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] });
        }),
        release: vi.fn(),
      };
      return fn(txClient as any);
    });

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    await processCluster(db, llm, {
      captures: [
        { id: 'cap-a', content: 'Via Telegram', embedding: [], source: ['telegram'] },
        { id: 'cap-b', content: 'Via API', embedding: [], source: ['api'] },
      ],
      existingFacts: [],
      reviewMode: 'autonomous',
    });

    // Source union of ['telegram'] + ['api'] = ['telegram', 'api'] (order may vary)
    expect(insertedSource).toBeDefined();
    expect(insertedSource).toContain('telegram');
    expect(insertedSource).toContain('api');
    expect(insertedSource!.length).toBe(2);
  });

  it('updates existing fact with previous version tracking', async () => {
    const db = mockDb();
    const llm = mockLLM();

    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [
          {
            action: 'update_fact',
            fact_id: 'fact-existing',
            content: 'Strongly prefers TypeScript over JavaScript',
            confidence: 0.95,
            reason: 'Additional evidence from new captures',
          },
        ],
      }),
      tokensUsed: { input: 1500, output: 300, total: 1800 },
    });

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'fact-existing' }], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [{ id: 'cap-3', content: 'TS generics are amazing', embedding: [], source: ['telegram'] }],
      existingFacts: [
        { id: 'fact-existing', content: 'Prefers TypeScript', confidence: 0.8, origin: 'consolidation', tags: ['preference'] },
      ],
      reviewMode: 'hybrid',
    });

    expect(result.factsUpdated).toBeGreaterThan(0);
  });

  it('respects noise criteria — only discards if all 7 conditions met', async () => {
    const db = mockDb();
    const llm = mockLLM();

    // LLM says this capture has no profile relevance
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({ actions: [{ action: 'discard', reason: 'Purely transactional' }] }),
      tokensUsed: { input: 500, output: 50, total: 550 },
    });

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [{ id: 'cap-4', content: 'Acknowledged receipt of package', embedding: [], source: ['telegram'] }],
      existingFacts: [],
      reviewMode: 'hybrid',
    });

    expect(result.factsCreated).toBe(0);
  });

  it('never overwrites user_edited facts', async () => {
    const db = mockDb();
    const llm = mockLLM();

    // LLM tries to update a user_edited fact
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [{
          action: 'update_fact',
          fact_id: 'fact-user-edited',
          content: 'New contradicting info',
          confidence: 0.7,
          reason: 'New evidence',
        }],
      }),
      tokensUsed: { input: 1000, output: 200, total: 1200 },
    });

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'flag-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    const result = await processCluster(db, llm, {
      captures: [{ id: 'cap-5', content: 'Contradicting info', embedding: [], source: ['api'] }],
      existingFacts: [
        { id: 'fact-user-edited', content: 'User said this', confidence: 1.0, origin: 'user_edited', tags: ['preference'] },
      ],
      reviewMode: 'hybrid',
    });

    // Should flag for review, not update
    expect(result.itemsFlagged).toBeGreaterThan(0);
  });

  it('auto-approves preference/skill/interest/dislike/resource tags in hybrid mode', async () => {
    const db = mockDb();
    const llm = mockLLM();

    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [{
          action: 'create_fact',
          content: 'Dislikes meetings without agendas',
          tags: ['dislike'],
          confidence: 0.75,
          source_capture_ids: ['cap-6'],
        }],
      }),
      tokensUsed: { input: 400, output: 80, total: 480 },
    });

    let insertedReviewStatus: string | undefined;
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const txClient = {
        query: vi.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes('INSERT INTO facts')) {
            // review_status is $6 in: (content, tags, source, confidence, source_capture_ids, origin, review_status)
            insertedReviewStatus = params[5];
          }
          return Promise.resolve({ rows: [], command: 'INSERT', rowCount: 1, oid: 0, fields: [] });
        }),
        release: vi.fn(),
      };
      return fn(txClient as any);
    });

    const { processCluster } = await import('../../../src/consolidation/phase1.js');
    await processCluster(db, llm, {
      captures: [{ id: 'cap-6', content: 'Meetings without agendas are a waste', embedding: [], source: ['telegram'] }],
      existingFacts: [],
      reviewMode: 'hybrid',
    });

    expect(insertedReviewStatus).toBe('auto_approved');
  });
});
