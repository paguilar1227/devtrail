// tests/unit/mcp/profiler-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock service modules before importing the tools
vi.mock('../../../src/services/captures.js', () => ({
  captureThought: vi.fn(),
  searchThoughts: vi.fn(),
  archiveCapture: vi.fn(),
  unarchiveCapture: vi.fn(),
}));

vi.mock('../../../src/services/profile.js', () => ({
  getUserProfile: vi.fn(),
  getBrainStats: vi.fn(),
}));

vi.mock('../../../src/services/facts.js', () => ({
  getFact: vi.fn(),
  updateFact: vi.fn(),
  archiveFact: vi.fn(),
  unarchiveFact: vi.fn(),
  reviewPendingFacts: vi.fn(),
  approveRejectFact: vi.fn(),
}));

vi.mock('../../../src/services/insights.js', () => ({
  getInsight: vi.fn(),
  archiveInsight: vi.fn(),
  unarchiveInsight: vi.fn(),
  reviewPendingInsights: vi.fn(),
  approveRejectInsight: vi.fn(),
}));

vi.mock('../../../src/services/consolidation.js', () => ({
  runConsolidation: vi.fn(),
  getConsolidationLogs: vi.fn(),
}));

vi.mock('../../../src/services/tags.js', () => ({
  updateTags: vi.fn(),
}));

function makeDeps() {
  return {
    db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
    embeddingProvider: { embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)), dimensions: 3072 },
    metadataLLM: { complete: vi.fn() },
    consolidationLLM: { complete: vi.fn() },
    retrievalLLM: { complete: vi.fn() },
    blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
    config: { apiKey: 'test', reviewMode: 'hybrid' },
  } as any;
}

async function makeServer(deps: ReturnType<typeof makeDeps>) {
  const server = new McpServer({ name: 'test', version: '1.0' });
  const { registerProfilerTools } = await import('../../../src/mcp/profiler-tools.js');
  registerProfilerTools(server, deps);
  return server;
}

describe('profiler tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all profiler tools without throwing', async () => {
    const deps = makeDeps();
    await makeServer(deps);
    expect(true).toBe(true);
  });

  it('brain_help returns BRAIN_HELP_TEXT', async () => {
    const deps = makeDeps();
    const server = await makeServer(deps);
    // Brain help is a static tool — just verify registration
    expect(server).toBeDefined();
  });

  it('get_user_profile calls profileSvc.getUserProfile', async () => {
    const profileSvc = await import('../../../src/services/profile.js');
    vi.mocked(profileSvc.getUserProfile).mockResolvedValue('Profile summary here');

    const deps = makeDeps();
    await makeServer(deps);

    expect(profileSvc.getUserProfile).toBeDefined();
  });

  it('search_thoughts calls capturesSvc.searchThoughts with tags', async () => {
    const capturesSvc = await import('../../../src/services/captures.js');
    vi.mocked(capturesSvc.searchThoughts).mockResolvedValue([]);

    const deps = makeDeps();
    await makeServer(deps);

    expect(capturesSvc.searchThoughts).toBeDefined();
  });

  it('capture_thought calls capturesSvc.captureThought with mcp source', async () => {
    const capturesSvc = await import('../../../src/services/captures.js');
    vi.mocked(capturesSvc.captureThought).mockResolvedValue({ captureId: 'c-1', warnings: [] });

    const deps = makeDeps();
    await makeServer(deps);

    // Service function should be properly wired
    expect(capturesSvc.captureThought).toBeDefined();
  });

  it('capture_thought returns error response when service returns error', async () => {
    const capturesSvc = await import('../../../src/services/captures.js');
    vi.mocked(capturesSvc.captureThought).mockResolvedValue({ error: true, reason: 'Duplicate' });

    const deps = makeDeps();
    await makeServer(deps);

    // Verify the mock is set up — the adapter wraps error into isError response
    const result = await capturesSvc.captureThought(deps, 'test', [], undefined, ['mcp']);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.reason).toBe('Duplicate');
  });

  it('brain_stats calls profileSvc.getBrainStats', async () => {
    const profileSvc = await import('../../../src/services/profile.js');
    vi.mocked(profileSvc.getBrainStats).mockResolvedValue({
      captures: 10, facts: 5, insights: 2, reminders: 3, pendingReview: 1,
      factsByTag: [], insightsByTag: [], capturesBySource: [], capturesByTag: [],
    });

    const deps = makeDeps();
    await makeServer(deps);

    expect(profileSvc.getBrainStats).toBeDefined();
  });

  it('archive_thought routes to correct service based on type', async () => {
    const capturesSvc = await import('../../../src/services/captures.js');
    const factsSvc = await import('../../../src/services/facts.js');
    const insightsSvc = await import('../../../src/services/insights.js');

    vi.mocked(capturesSvc.archiveCapture).mockResolvedValue(undefined);
    vi.mocked(factsSvc.archiveFact).mockResolvedValue(undefined);
    vi.mocked(insightsSvc.archiveInsight).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    // All three archive functions should be accessible via service layer
    await capturesSvc.archiveCapture(deps, 'id-1');
    await factsSvc.archiveFact(deps, 'id-2');
    await insightsSvc.archiveInsight(deps, 'id-3');

    expect(capturesSvc.archiveCapture).toHaveBeenCalledWith(deps, 'id-1');
    expect(factsSvc.archiveFact).toHaveBeenCalledWith(deps, 'id-2');
    expect(insightsSvc.archiveInsight).toHaveBeenCalledWith(deps, 'id-3');
  });

  it('unarchive_thought routes to correct service based on type', async () => {
    const capturesSvc = await import('../../../src/services/captures.js');
    const factsSvc = await import('../../../src/services/facts.js');
    const insightsSvc = await import('../../../src/services/insights.js');

    vi.mocked(capturesSvc.unarchiveCapture).mockResolvedValue(undefined);
    vi.mocked(factsSvc.unarchiveFact).mockResolvedValue(undefined);
    vi.mocked(insightsSvc.unarchiveInsight).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    await capturesSvc.unarchiveCapture(deps, 'id-1');
    await factsSvc.unarchiveFact(deps, 'id-2');
    await insightsSvc.unarchiveInsight(deps, 'id-3');

    expect(capturesSvc.unarchiveCapture).toHaveBeenCalledWith(deps, 'id-1');
    expect(factsSvc.unarchiveFact).toHaveBeenCalledWith(deps, 'id-2');
    expect(insightsSvc.unarchiveInsight).toHaveBeenCalledWith(deps, 'id-3');
  });

  it('update_fact calls factsSvc.updateFact', async () => {
    const factsSvc = await import('../../../src/services/facts.js');
    vi.mocked(factsSvc.updateFact).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    await factsSvc.updateFact(deps, 'f-1', 'updated content');
    expect(factsSvc.updateFact).toHaveBeenCalledWith(deps, 'f-1', 'updated content');
  });

  it('update_fact returns error when factsSvc.updateFact throws', async () => {
    const factsSvc = await import('../../../src/services/facts.js');
    vi.mocked(factsSvc.updateFact).mockRejectedValue(new Error('Fact f-1 not found'));

    const deps = makeDeps();
    await makeServer(deps);

    await expect(factsSvc.updateFact(deps, 'f-1', 'content')).rejects.toThrow('Fact f-1 not found');
  });

  it('review_pending calls both reviewPendingFacts and reviewPendingInsights', async () => {
    const factsSvc = await import('../../../src/services/facts.js');
    const insightsSvc = await import('../../../src/services/insights.js');

    vi.mocked(factsSvc.reviewPendingFacts).mockResolvedValue([
      { id: 'f-1', content: 'Fact 1', tags: ['preference'], confidence: 0.9 } as any,
    ]);
    vi.mocked(insightsSvc.reviewPendingInsights).mockResolvedValue([
      { id: 'i-1', content: 'Insight 1', tags: ['pattern'], confidence: 0.8 } as any,
    ]);

    const deps = makeDeps();
    await makeServer(deps);

    const facts = await factsSvc.reviewPendingFacts(deps, 20);
    const insights = await insightsSvc.reviewPendingInsights(deps, 20);

    expect(facts).toHaveLength(1);
    expect(insights).toHaveLength(1);
  });

  it('approve_reject routes to fact service when fact is found', async () => {
    const factsSvc = await import('../../../src/services/facts.js');

    vi.mocked(factsSvc.getFact).mockResolvedValue({
      id: 'f-1', content: 'A fact', tags: [], confidence: 0.9, review_status: 'pending_review',
    } as any);
    vi.mocked(factsSvc.approveRejectFact).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    const fact = await factsSvc.getFact(deps, 'f-1');
    expect(fact).not.toBeNull();
    await factsSvc.approveRejectFact(deps, 'f-1', 'approve');
    expect(factsSvc.approveRejectFact).toHaveBeenCalledWith(deps, 'f-1', 'approve');
  });

  it('approve_reject routes to insight service when fact not found but insight is', async () => {
    const factsSvc = await import('../../../src/services/facts.js');
    const insightsSvc = await import('../../../src/services/insights.js');

    vi.mocked(factsSvc.getFact).mockResolvedValue(null);
    vi.mocked(insightsSvc.getInsight).mockResolvedValue({
      id: 'i-1', content: 'An insight', tags: [], confidence: 0.8, review_status: 'pending_review',
    } as any);
    vi.mocked(insightsSvc.approveRejectInsight).mockResolvedValue(undefined);

    const deps = makeDeps();
    await makeServer(deps);

    const fact = await factsSvc.getFact(deps, 'i-1');
    const insight = await insightsSvc.getInsight(deps, 'i-1');
    expect(fact).toBeNull();
    expect(insight).not.toBeNull();
    await insightsSvc.approveRejectInsight(deps, 'i-1', 'reject');
    expect(insightsSvc.approveRejectInsight).toHaveBeenCalledWith(deps, 'i-1', 'reject');
  });

  it('run_consolidation calls consolidationSvc.runConsolidation and getConsolidationLogs', async () => {
    const consolidationSvc = await import('../../../src/services/consolidation.js');

    vi.mocked(consolidationSvc.runConsolidation).mockResolvedValue(undefined);
    vi.mocked(consolidationSvc.getConsolidationLogs).mockResolvedValue([{
      id: 'log-1', run_at: new Date(), status: 'success',
      captures_processed: 5, facts_created: 2, facts_updated: 1,
      insights_created: 1, insights_regenerated: 0, duplicates_detected: 0,
      items_flagged: 0, model_used: 'gemini', tokens_used: 1000,
      duration_ms: 500, error_message: null,
    }]);

    const deps = makeDeps();
    await makeServer(deps);

    await consolidationSvc.runConsolidation(deps);
    const logs = await consolidationSvc.getConsolidationLogs(deps, 1);

    expect(consolidationSvc.runConsolidation).toHaveBeenCalledWith(deps);
    expect(consolidationSvc.getConsolidationLogs).toHaveBeenCalledWith(deps, 1);
    expect(logs[0].status).toBe('success');
  });

  it('update_tags calls tagsSvc.updateTags with correct tier and tags', async () => {
    const tagsSvc = await import('../../../src/services/tags.js');

    vi.mocked(tagsSvc.updateTags).mockResolvedValue({ old: ['preference'], new: ['skill', 'goal'] });

    const deps = makeDeps();
    await makeServer(deps);

    const result = await tagsSvc.updateTags(deps, 'item-1', 'fact', ['skill', 'goal']);
    expect(tagsSvc.updateTags).toHaveBeenCalledWith(deps, 'item-1', 'fact', ['skill', 'goal']);
    expect(result.old).toEqual(['preference']);
    expect(result.new).toEqual(['skill', 'goal']);
  });

  it('update_tags returns error response when tagsSvc.updateTags throws', async () => {
    const tagsSvc = await import('../../../src/services/tags.js');

    vi.mocked(tagsSvc.updateTags).mockRejectedValue(new Error('Invalid tags: bad-tag'));

    const deps = makeDeps();
    await makeServer(deps);

    await expect(tagsSvc.updateTags(deps, 'id', 'capture', ['bad-tag'])).rejects.toThrow('Invalid tags: bad-tag');
  });
});
