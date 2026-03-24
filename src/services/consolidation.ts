// src/services/consolidation.ts
import type { ServiceDeps } from './index.js';
import type { ConsolidationLogRow } from '../db/consolidation-log.js';
import { runConsolidation as runConsolidationPipeline } from '../consolidation/runner.js';

export type { ConsolidationLogRow };

export interface ConsolidationResult {
  status: string;
  capturesProcessed: number;
  factsCreated: number;
  factsUpdated: number;
  insightsCreated: number;
  durationMs: number;
  tokensUsed: number;
  errorMessage: string | null;
}

/**
 * Run the 3-phase consolidation pipeline.
 */
export async function runConsolidation(
  deps: ServiceDeps,
  sendNotification?: (message: string) => Promise<void>,
): Promise<void> {
  await runConsolidationPipeline({
    db: deps.db,
    consolidationLLM: deps.consolidationLLM,
    embeddingProvider: deps.embeddingProvider,
    reviewMode: deps.config.reviewMode,
    sendNotification,
    digestEnabled: deps.config.dailyDigestEnabled,
  });
}

/**
 * Return recent consolidation log entries.
 */
export async function getConsolidationLogs(
  deps: ServiceDeps,
  limit?: number,
): Promise<ConsolidationLogRow[]> {
  const result = await deps.db.query(
    `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT $1`,
    [limit ?? 10],
  );
  return result.rows;
}
