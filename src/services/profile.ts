// src/services/profile.ts
import type { ServiceDeps } from './index.js';
import { getUserProfile as retrievalGetUserProfile } from '../retrieval/profile.js';

export interface BrainStats {
  captures: number;
  facts: number;
  insights: number;
  reminders: number;
  pendingReview: number;
  factsByTag: Array<{ tag: string; count: string }>;
  insightsByTag: Array<{ tag: string; count: string }>;
  capturesBySource: Array<{ src: string; count: string }>;
  capturesByTag: Array<{ tag: string; count: string }>;
}

/**
 * LLM-synthesized profile summary.
 */
export async function getUserProfile(deps: ServiceDeps): Promise<string> {
  return retrievalGetUserProfile(deps.db, deps.retrievalLLM);
}

/**
 * System dashboard: counts, tag breakdowns, source breakdowns.
 */
export async function getBrainStats(deps: ServiceDeps): Promise<BrainStats> {
  const stats = await deps.db.query(`
    SELECT
      (SELECT count(*) FROM captures WHERE archived = false) AS captures_count,
      (SELECT count(*) FROM facts WHERE archived = false) AS facts_count,
      (SELECT count(*) FROM insights WHERE archived = false) AS insights_count,
      (SELECT count(*) FROM reminders WHERE archived = false) AS reminders_count,
      (SELECT count(*) FROM facts WHERE review_status = 'pending_review') AS facts_pending,
      (SELECT count(*) FROM insights WHERE review_status = 'pending_review') AS insights_pending
  `);

  const factTags = await deps.db.query(`
    SELECT unnest(tags) AS tag, count(*) as count FROM facts
    WHERE archived = false AND review_status != 'user_rejected'
    GROUP BY tag ORDER BY count DESC
  `);

  const insightTags = await deps.db.query(`
    SELECT unnest(tags) AS tag, count(*) as count FROM insights
    WHERE archived = false AND review_status != 'user_rejected'
    GROUP BY tag ORDER BY count DESC
  `);

  const capturesBySource = await deps.db.query(`
    SELECT unnest(source) AS src, count(*) as count FROM captures
    WHERE archived = false
    GROUP BY src ORDER BY count DESC
  `);

  const capturesByTag = await deps.db.query(`
    SELECT unnest(tags) AS tag, count(*) as count FROM captures
    WHERE archived = false
    GROUP BY tag ORDER BY count DESC
  `);

  const row = stats.rows[0];
  return {
    captures: parseInt(row.captures_count),
    facts: parseInt(row.facts_count),
    insights: parseInt(row.insights_count),
    reminders: parseInt(row.reminders_count),
    pendingReview: parseInt(row.facts_pending) + parseInt(row.insights_pending),
    factsByTag: factTags.rows,
    insightsByTag: insightTags.rows,
    capturesBySource: capturesBySource.rows,
    capturesByTag: capturesByTag.rows,
  };
}
