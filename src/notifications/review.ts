// src/notifications/review.ts
import type { DbClient } from '../db/client.js';

export interface PendingReviewCount {
  facts: number;
  insights: number;
  total: number;
}

export async function getPendingReviewCount(db: DbClient): Promise<PendingReviewCount> {
  const result = await db.query(`
    SELECT
      (SELECT count(*) FROM facts WHERE review_status = 'pending_review' AND archived = false) AS facts_pending,
      (SELECT count(*) FROM insights WHERE review_status = 'pending_review' AND archived = false) AS insights_pending
  `);

  const row = result.rows[0];
  const facts = parseInt(row.facts_pending);
  const insights = parseInt(row.insights_pending);

  return { facts, insights, total: facts + insights };
}
