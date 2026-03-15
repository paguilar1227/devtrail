// tests/unit/retrieval/profile.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('getUserProfile', () => {
  it('synthesizes profile from insights + uncovered facts + active reminders', async () => {
    const db = mockDb();
    const llm: LLMProvider = {
      complete: vi.fn().mockResolvedValueOnce({
        content: 'Pedro is a software engineer who prefers TypeScript...',
        tokensUsed: { input: 500, output: 200, total: 700 },
      } satisfies LLMResponse),
    };

    // approved insights
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [
          { id: 'i1', content: 'Strong analytical personality', category: 'pattern',
            confidence: 0.9, source_fact_ids: ['f1', 'f2'] },
        ],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      })
      // high-confidence facts NOT covered by insights
      .mockResolvedValueOnce({
        rows: [
          { id: 'f3', content: 'Uses Claude for coding', category: 'habit', confidence: 0.95 },
        ],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      })
      // active reminders
      .mockResolvedValueOnce({
        rows: [
          { id: 'r1', content: 'Research Rust CLI tools', status: 'in_progress', category: 'learning' },
        ],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

    const { getUserProfile } = await import('../../../src/retrieval/profile.js');
    const profile = await getUserProfile(db, llm);

    expect(llm.complete).toHaveBeenCalled();
    expect(typeof profile).toBe('string');
    expect(profile.length).toBeGreaterThan(0);
  });

  it('returns fallback when no data exists', async () => {
    const db = mockDb();
    const llm: LLMProvider = { complete: vi.fn() };

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

    const { getUserProfile } = await import('../../../src/retrieval/profile.js');
    const profile = await getUserProfile(db, llm);

    expect(profile).toContain('No profile data');
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
