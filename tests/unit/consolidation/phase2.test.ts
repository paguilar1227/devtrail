import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('phase2', () => {
  it('generates insights from active facts using tags format', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: JSON.stringify({
          insights: [{
            content: 'User has a strong analytical personality that drives both career and hobby choices',
            tags: ['pattern'],
            confidence: 0.85,
            source_fact_ids: ['f1', 'f2', 'f3'],
          }],
          updates: [],
          invalidations: [],
        }),
        tokensUsed: { input: 3000, output: 500, total: 3500 },
      } satisfies LLMResponse),
    };

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'ins-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { runPhase2 } = await import('../../../src/consolidation/phase2.js');
    const result = await runPhase2(db, llm, {
      facts: [
        { id: 'f1', content: 'Prefers TypeScript', tags: ['preference'], confidence: 0.9, source: ['telegram'] },
        { id: 'f2', content: 'Works as software engineer', tags: ['milestone'], confidence: 1.0, source: ['api'] },
        { id: 'f3', content: 'Enjoys solving complex problems', tags: ['interest'], confidence: 0.8, source: ['telegram'] },
      ],
      existingInsights: [],
    });

    expect(result.insightsCreated).toBe(1);
  });

  it('computes source union from contributing facts and stores it on the insight', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: JSON.stringify({
          insights: [{
            content: 'Cross-channel pattern detected',
            tags: ['pattern'],
            confidence: 0.8,
            source_fact_ids: ['f1', 'f2'],
          }],
          updates: [],
          invalidations: [],
        }),
        tokensUsed: { input: 2000, output: 300, total: 2300 },
      }),
    };

    let insertedSource: string[] | undefined;
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const txClient = {
        query: vi.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes('INSERT INTO insights')) {
            // source is $3 in: (content, tags, source, confidence, source_fact_ids, ...)
            insertedSource = params[2];
          }
          return Promise.resolve({ rows: [], command: 'INSERT', rowCount: 1, oid: 0, fields: [] });
        }),
        release: vi.fn(),
      };
      return fn(txClient as any);
    });

    const { runPhase2 } = await import('../../../src/consolidation/phase2.js');
    await runPhase2(db, llm, {
      facts: [
        { id: 'f1', content: 'Fact from Telegram', tags: ['preference'], confidence: 0.9, source: ['telegram'] },
        { id: 'f2', content: 'Fact from API', tags: ['skill'], confidence: 0.85, source: ['api'] },
      ],
      existingInsights: [],
    });

    // Source union: ['telegram'] + ['api'] → ['telegram', 'api']
    expect(insertedSource).toBeDefined();
    expect(insertedSource).toContain('telegram');
    expect(insertedSource).toContain('api');
    expect(insertedSource!.length).toBe(2);
  });

  it('does not create insights that restate a single fact', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: JSON.stringify({ insights: [], updates: [], invalidations: [] }),
        tokensUsed: { input: 1000, output: 100, total: 1100 },
      }),
    };

    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: vi.fn().mockResolvedValue({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }),
      release: vi.fn(),
    } as any));

    const { runPhase2 } = await import('../../../src/consolidation/phase2.js');
    const result = await runPhase2(db, llm, {
      facts: [{ id: 'f1', content: 'Likes pizza', tags: ['preference'], confidence: 0.7, source: ['telegram'] }],
      existingInsights: [],
    });

    expect(result.insightsCreated).toBe(0);
  });

  it('skips insights with fewer than 2 source_fact_ids', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: JSON.stringify({
          insights: [{
            content: 'Single fact insight — should be skipped',
            tags: ['pattern'],
            confidence: 0.9,
            source_fact_ids: ['f1'],  // Only 1 — violates the rule
          }],
          updates: [],
          invalidations: [],
        }),
        tokensUsed: { input: 500, output: 80, total: 580 },
      }),
    };

    const txQuery = vi.fn().mockResolvedValue({ rows: [], command: 'INSERT', rowCount: 0, oid: 0, fields: [] });
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn({
      query: txQuery,
      release: vi.fn(),
    } as any));

    const { runPhase2 } = await import('../../../src/consolidation/phase2.js');
    const result = await runPhase2(db, llm, {
      facts: [{ id: 'f1', content: 'Likes coffee', tags: ['preference'], confidence: 0.8, source: ['telegram'] }],
      existingInsights: [],
    });

    expect(result.insightsCreated).toBe(0);
    // Verify no INSERT was called
    const insertCalls = txQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO insights'));
    expect(insertCalls).toHaveLength(0);
  });
});
