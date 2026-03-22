import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('phase2', () => {
  it('generates insights from active facts', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: JSON.stringify({
          insights: [{
            content: 'User has a strong analytical personality that drives both career and hobby choices',
            category: 'pattern',
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
        { id: 'f1', content: 'Prefers TypeScript', tags: ['preference'], confidence: 0.9 },
        { id: 'f2', content: 'Works as software engineer', tags: ['history'], confidence: 1.0 },
        { id: 'f3', content: 'Enjoys solving complex problems', tags: ['personality'], confidence: 0.8 },
      ],
      existingInsights: [],
    });

    expect(result.insightsCreated).toBe(1);
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
      facts: [{ id: 'f1', content: 'Likes pizza', tags: ['preference'], confidence: 0.7 }],
      existingInsights: [],
    });

    expect(result.insightsCreated).toBe(0);
  });
});
