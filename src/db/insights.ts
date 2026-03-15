import type { DbClient } from './client.js';

export interface InsightInsert {
  content: string;
  category: string;
  embedding: number[];
  confidence: number;
  sourceFactIds: string[];
  origin: string;
}

export interface InsightRow {
  id: string;
  content: string;
  category: string;
  embedding: number[];
  confidence: number;
  source_fact_ids: string[];
  origin: string;
  review_status: string;
  archived: boolean;
  generated_at: Date;
  updated_at: Date;
  edited_at: Date | null;
}

export async function insertInsight(db: DbClient, insight: InsightInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO insights (content, category, embedding, confidence, source_fact_ids, origin)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [insight.content, insight.category, JSON.stringify(insight.embedding),
     insight.confidence, insight.sourceFactIds, insight.origin],
  );
  return result.rows[0];
}

export async function findApprovedInsights(db: DbClient): Promise<InsightRow[]> {
  const result = await db.query(
    `SELECT * FROM insights
     WHERE review_status IN ('auto_approved', 'user_approved')
       AND archived = false
     ORDER BY confidence DESC`,
    [],
  );
  return result.rows;
}

export async function findSimilarInsights(
  db: DbClient, embedding: number[], threshold: number, limit: number,
): Promise<Array<InsightRow & { similarity: number }>> {
  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM insights
     WHERE archived = false AND review_status != 'user_rejected'
       AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
     ORDER BY similarity DESC LIMIT $3`,
    [JSON.stringify(embedding), threshold, limit],
  );
  return result.rows;
}

export async function setInsightReviewStatus(
  db: DbClient, id: string, status: string, content?: string,
): Promise<void> {
  if (content) {
    await db.query(
      `UPDATE insights SET review_status = $1, content = $2, origin = 'user_edited',
       edited_at = now(), embedding = NULL, updated_at = now() WHERE id = $3`,
      [status, content, id],
    );
  } else {
    await db.query(
      `UPDATE insights SET review_status = $1, updated_at = now() WHERE id = $2`,
      [status, id],
    );
  }
}

export async function setInsightArchived(db: DbClient, id: string, archived: boolean): Promise<void> {
  await db.query(
    `UPDATE insights SET archived = $1, updated_at = now() WHERE id = $2`,
    [archived, id],
  );
}

export async function getInsightById(db: DbClient, id: string): Promise<InsightRow | null> {
  const result = await db.query(`SELECT * FROM insights WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findPendingReviewInsights(db: DbClient, limit: number): Promise<InsightRow[]> {
  const result = await db.query(
    `SELECT * FROM insights WHERE review_status = 'pending_review' AND archived = false
     ORDER BY generated_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function findAllInsights(db: DbClient): Promise<InsightRow[]> {
  const result = await db.query(
    `SELECT * FROM insights WHERE archived = false AND review_status != 'user_rejected'
     ORDER BY confidence DESC`,
    [],
  );
  return result.rows;
}
