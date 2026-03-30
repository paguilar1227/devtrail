import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { ServiceDeps } from '../../../src/services/index.js';
import { getDailyCheckinContext } from '../../../src/services/checkin.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function makeDeps(db?: DbClient): ServiceDeps {
  return {
    db: db ?? mockDb(),
    embeddingProvider: {} as any,
    metadataLLM: {} as any,
    consolidationLLM: {} as any,
    retrievalLLM: {} as any,
    blobStorage: {} as any,
    config: {
      timezone: 'America/Chicago',
      dailyReportTime: '09:00',
    } as any,
  };
}

function emptyResult(rows: unknown[] = []) {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as any;
}

// Helper: mock all 9 parallel queries getDailyCheckinContext runs
function mockCheckinQueries(
  db: DbClient,
  opts: {
    consolidationLogs?: Array<{ status: string }>;
    facts?: Array<{ id: string; content: string; tags: string[] }>;
    insights?: Array<{ id: string; content: string; tags: string[] }>;
    capturesNew?: number;
    capturesArchived?: number;
    pendingFacts?: unknown[];
    pendingInsights?: unknown[];
    reminderStats?: { active: number; due_today: number; overdue: number };
    totals?: { captures: number; facts: number; insights: number };
  } = {},
) {
  const queryMock = vi.mocked(db.query);
  queryMock
    .mockResolvedValueOnce(emptyResult(opts.consolidationLogs ?? []))
    .mockResolvedValueOnce(emptyResult(opts.facts ?? []))
    .mockResolvedValueOnce(emptyResult(opts.insights ?? []))
    .mockResolvedValueOnce(emptyResult([{ count: opts.capturesNew ?? 0 }]))
    .mockResolvedValueOnce(emptyResult([{ count: opts.capturesArchived ?? 0 }]))
    .mockResolvedValueOnce(emptyResult(opts.pendingFacts ?? []))
    .mockResolvedValueOnce(emptyResult(opts.pendingInsights ?? []))
    .mockResolvedValueOnce(emptyResult([opts.reminderStats ?? { active: 0, due_today: 0, overdue: 0 }]))
    .mockResolvedValueOnce(emptyResult([opts.totals ?? { captures: 0, facts: 0, insights: 0 }]));
}

describe('getDailyCheckinContext', () => {
  it('correctly splits consolidation logs into success vs no-op counts', async () => {
    const db = mockDb();
    mockCheckinQueries(db, {
      consolidationLogs: [
        { status: 'success' },
        { status: 'no-op' },
        { status: 'success' },
        { status: 'no-op' },
        { status: 'no-op' },
      ],
    });

    const ctx = await getDailyCheckinContext(makeDeps(db));

    expect(ctx.activity.consolidationRuns).toBe(5);
    expect(ctx.activity.consolidationSuccesses).toBe(2);
    expect(ctx.activity.consolidationNoOps).toBe(3);
  });

  it('sums pending review across both facts and insights', async () => {
    const db = mockDb();
    mockCheckinQueries(db, {
      pendingFacts: [{ id: 'pf1' }, { id: 'pf2' }, { id: 'pf3' }],
      pendingInsights: [{ id: 'pi1' }, { id: 'pi2' }],
    });

    const ctx = await getDailyCheckinContext(makeDeps(db));

    expect(ctx.activity.pendingReview).toBe(5);
  });

  it('strips embeddings from facts/insights — returns only id, content, tags', async () => {
    const db = mockDb();
    mockCheckinQueries(db, {
      facts: [{ id: 'f1', content: 'A fact', tags: ['preference'], embedding: [0.1, 0.2], confidence: 0.9 } as any],
      insights: [{ id: 'i1', content: 'An insight', tags: ['pattern'], embedding: [0.3], source_fact_ids: ['f1'] } as any],
    });

    const ctx = await getDailyCheckinContext(makeDeps(db));

    // Should only have id, content, tags — no embedding or other DB fields
    expect(Object.keys(ctx.activity.factsCreated[0])).toEqual(['id', 'content', 'tags']);
    expect(Object.keys(ctx.activity.insightsCreated[0])).toEqual(['id', 'content', 'tags']);
  });

  it('includes all 5 questions and agent instructions', async () => {
    const db = mockDb();
    mockCheckinQueries(db);

    const ctx = await getDailyCheckinContext(makeDeps(db));

    expect(ctx.questions).toHaveLength(5);
    // Questions should be reflective, not operational
    expect(ctx.questions.some(q => q.includes('decision'))).toBe(true);
    expect(ctx.questions.some(q => q.includes('frustrated') || q.includes('energized'))).toBe(true);
    expect(ctx.questions.some(q => q.includes('learn'))).toBe(true);
    // Instructions should tell Claude how to conduct the checkin
    expect(ctx.instructions).toContain('capture_thought');
    expect(ctx.instructions).toContain('ONE AT A TIME');
  });
});
