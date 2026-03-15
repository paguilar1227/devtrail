import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/types.js';
import { findCapturesByStatus } from '../db/captures.js';
import { findActiveFacts } from '../db/facts.js';
import { findAllInsights } from '../db/insights.js';
import { findRecentlyCompletedReminders } from '../db/reminders.js';
import { getLatestConsolidationRun, insertConsolidationLog } from '../db/consolidation-log.js';
import { dbscan } from './clustering.js';
import { processCluster } from './phase1.js';
import { runPhase2 } from './phase2.js';
import { runPhase3 } from './phase3.js';

const PHASE1_TOKEN_BUDGET = 80_000;
const PHASE2_TOKEN_BUDGET = 50_000;

export interface ConsolidationDeps {
  db: DbClient;
  consolidationLLM: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  reviewMode: string;
  sendNotification?: (message: string) => Promise<void>;
  digestEnabled?: boolean;
}

export async function runConsolidation(deps: ConsolidationDeps): Promise<void> {
  const startTime = Date.now();
  const { db, consolidationLLM, embeddingProvider, reviewMode } = deps;

  // Guard: skip if nothing to do
  const pendingCaptures = await findCapturesByStatus(db, 'pending');
  const lastRun = await getLatestConsolidationRun(db);

  // Also check recently completed reminders (profile signal)
  const since = lastRun?.run_at ?? new Date(0);
  const completedReminders = await findRecentlyCompletedReminders(db, since);

  if (pendingCaptures.length === 0 && completedReminders.length === 0) {
    // Check if any facts were updated since last run
    const updatedFacts = await db.query(
      `SELECT count(*) as count FROM facts WHERE updated_at > $1`,
      [since],
    );
    if (parseInt(updatedFacts.rows[0].count) === 0) {
      await insertConsolidationLog(db, {
        status: 'no-op', capturesProcessed: 0, factsCreated: 0, factsUpdated: 0,
        insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0, itemsFlagged: 0,
        modelUsed: 'claude-opus-4-6', tokensUsed: 0, durationMs: Date.now() - startTime,
        errorMessage: null,
      });
      return;
    }
  }

  let totalTokens = 0;
  let totalFactsCreated = 0;
  let totalFactsUpdated = 0;
  let totalItemsFlagged = 0;

  // --- Phase 1: Capture → Fact promotion ---
  try {
    // Include completed reminders as captures for consolidation
    const allInputs = [
      ...pendingCaptures.map((c) => ({ id: c.id, content: c.content, embedding: c.embedding })),
      ...completedReminders.map((r) => ({
        id: r.id,
        content: `[Completed reminder] ${r.content}`,
        embedding: r.embedding,
      })),
    ];

    if (allInputs.length > 0) {
      const existingFacts = await findActiveFacts(db, 0.0);
      const clusters = dbscan(
        allInputs.filter((c) => c.embedding?.length > 0),
        { eps: 0.3, minSamples: 2 },
      );

      let phase1Tokens = 0;
      for (const cluster of clusters) {
        // Estimate next call cost: ~500 tokens per capture + ~200 per existing fact
        const estimatedCost = cluster.length * 500 + existingFacts.length * 200;
        if (phase1Tokens + estimatedCost > PHASE1_TOKEN_BUDGET) {
          // Remaining captures stay 'pending' for next run
          break;
        }

        const clusterResult = await processCluster(db, consolidationLLM, {
          captures: cluster,
          existingFacts: existingFacts.map((f) => ({
            id: f.id, content: f.content, confidence: f.confidence,
            origin: f.origin, category: f.category,
          })),
          reviewMode,
        });

        phase1Tokens += clusterResult.tokensUsed;
        totalFactsCreated += clusterResult.factsCreated;
        totalFactsUpdated += clusterResult.factsUpdated;
        totalItemsFlagged += clusterResult.itemsFlagged;
      }
      totalTokens += phase1Tokens;
    }
  } catch (err) {
    await insertConsolidationLog(db, {
      status: 'failed', capturesProcessed: pendingCaptures.length,
      factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
      insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0,
      itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
      tokensUsed: totalTokens, durationMs: Date.now() - startTime,
      errorMessage: String(err),
    });
    throw err;
  }

  // --- Phase 2: Fact → Insight generation ---
  let insightsCreated = 0;
  let insightsRegenerated = 0;
  try {
    const activeFacts = await findActiveFacts(db, 0.3);
    const existingInsights = await findAllInsights(db);

    if (activeFacts.length >= 2) {
      // Estimate Phase 2 cost: ~200 tokens per fact + ~300 per existing insight
      const estimatedPhase2Cost = activeFacts.length * 200 + existingInsights.length * 300;
      if (estimatedPhase2Cost > PHASE2_TOKEN_BUDGET) {
        // Defer insight generation to next run
        await insertConsolidationLog(db, {
          status: 'partial', capturesProcessed: pendingCaptures.length,
          factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
          insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0,
          itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
          tokensUsed: totalTokens, durationMs: Date.now() - startTime,
          errorMessage: 'Phase 2 deferred: estimated token cost exceeds budget',
        });
        return;
      }

      const phase2Result = await runPhase2(db, consolidationLLM, {
        facts: activeFacts.map((f) => ({
          id: f.id, content: f.content, category: f.category, confidence: f.confidence,
        })),
        existingInsights: existingInsights.map((i) => ({
          id: i.id, content: i.content, category: i.category,
          confidence: i.confidence, source_fact_ids: i.source_fact_ids,
        })),
      });

      insightsCreated = phase2Result.insightsCreated;
      insightsRegenerated = phase2Result.insightsRegenerated;
      totalTokens += phase2Result.tokensUsed;
      totalItemsFlagged += insightsCreated; // All new insights are pending_review
    }
  } catch (err) {
    await insertConsolidationLog(db, {
      status: 'partial', capturesProcessed: pendingCaptures.length,
      factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
      insightsCreated: 0, insightsRegenerated: 0, duplicatesDetected: 0,
      itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
      tokensUsed: totalTokens, durationMs: Date.now() - startTime,
      errorMessage: `Phase 2 failed: ${String(err)}`,
    });
    // Phase 1 clusters are already committed — don't throw, just log
    return;
  }

  // --- Phase 3: Embed, store & notify ---
  const phase3Result = await runPhase3(db, embeddingProvider, {
    sendNotification: deps.sendNotification,
    digestEnabled: deps.digestEnabled,
  });

  await insertConsolidationLog(db, {
    status: 'success', capturesProcessed: pendingCaptures.length,
    factsCreated: totalFactsCreated, factsUpdated: totalFactsUpdated,
    insightsCreated, insightsRegenerated, duplicatesDetected: 0,
    itemsFlagged: totalItemsFlagged, modelUsed: 'claude-opus-4-6',
    tokensUsed: totalTokens, durationMs: Date.now() - startTime,
    errorMessage: null,
  });
}
