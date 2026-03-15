import type { DbClient } from './client.js';

export interface ConsolidationLogInsert {
  status: string;
  capturesProcessed: number;
  factsCreated: number;
  factsUpdated: number;
  insightsCreated: number;
  insightsRegenerated: number;
  duplicatesDetected: number;
  itemsFlagged: number;
  modelUsed: string;
  tokensUsed: number;
  durationMs: number;
  errorMessage: string | null;
}

export interface ConsolidationLogRow {
  id: string;
  run_at: Date;
  status: string;
  captures_processed: number;
  facts_created: number;
  facts_updated: number;
  insights_created: number;
  insights_regenerated: number;
  duplicates_detected: number;
  items_flagged: number;
  model_used: string;
  tokens_used: number;
  duration_ms: number;
  error_message: string | null;
}

export async function insertConsolidationLog(
  db: DbClient, log: ConsolidationLogInsert,
): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO consolidation_log
       (status, captures_processed, facts_created, facts_updated,
        insights_created, insights_regenerated, duplicates_detected,
        items_flagged, model_used, tokens_used, duration_ms, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [log.status, log.capturesProcessed, log.factsCreated, log.factsUpdated,
     log.insightsCreated, log.insightsRegenerated, log.duplicatesDetected,
     log.itemsFlagged, log.modelUsed, log.tokensUsed, log.durationMs, log.errorMessage],
  );
  return result.rows[0];
}

export async function getLatestConsolidationRun(
  db: DbClient,
): Promise<ConsolidationLogRow | null> {
  const result = await db.query(
    `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT 1`,
    [],
  );
  return result.rows[0] ?? null;
}

export async function getConsolidationStats(
  db: DbClient,
): Promise<{ totalRuns: number; lastRunAt: Date | null; lastStatus: string | null }> {
  const result = await db.query(
    `SELECT count(*) as total_runs,
            max(run_at) as last_run_at,
            (SELECT status FROM consolidation_log ORDER BY run_at DESC LIMIT 1) as last_status
     FROM consolidation_log`,
    [],
  );
  const row = result.rows[0];
  return {
    totalRuns: parseInt(row.total_runs, 10),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
  };
}
