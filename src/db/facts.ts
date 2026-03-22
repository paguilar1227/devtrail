import type { DbClient } from './client.js';

export interface FactInsert {
  content: string;
  tags: string[];
  source: string[];
  embedding: number[];
  confidence: number;
  sourceCaptureIds: string[];
  origin: string;
  reviewStatus: string;
}

export interface FactRow {
  id: string;
  content: string;
  tags: string[];
  source: string[];
  embedding: number[];
  confidence: number;
  source_capture_ids: string[];
  origin: string;
  review_status: string;
  previous_versions: Array<{ content: string; confidence: number; changed_at: string; reason: string }>;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
}

export async function insertFact(db: DbClient, fact: FactInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO facts (content, tags, source, embedding, confidence, source_capture_ids, origin, review_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [fact.content, fact.tags, fact.source, JSON.stringify(fact.embedding), fact.confidence,
     fact.sourceCaptureIds, fact.origin, fact.reviewStatus],
  );
  return result.rows[0];
}

export async function updateFactTags(db: DbClient, id: string, tags: string[]): Promise<string[] | null> {
  const result = await db.query(
    `UPDATE facts SET tags = $1, updated_at = now() WHERE id = $2 RETURNING tags`,
    [tags, id],
  );
  return result.rows[0]?.tags ?? null;
}

export async function updateFactContent(
  db: DbClient,
  id: string,
  update: { content: string; confidence: number; reason: string },
): Promise<void> {
  await db.query(
    `UPDATE facts SET
       previous_versions = previous_versions || jsonb_build_array(
         jsonb_build_object('content', content, 'confidence', confidence,
                            'changed_at', now()::text, 'reason', $3)
       ),
       content = $1,
       confidence = $2,
       embedding = NULL,
       updated_at = now()
     WHERE id = $4 AND origin != 'user_edited'`,
    [update.content, update.confidence, update.reason, id],
  );
}

export async function userEditFact(db: DbClient, id: string, content: string): Promise<void> {
  await db.query(
    `UPDATE facts SET
       previous_versions = previous_versions || jsonb_build_array(
         jsonb_build_object('content', old.content, 'confidence', old.confidence,
                            'changed_at', now()::text, 'reason', 'user edit')
       ),
       content = $1,
       confidence = $2,
       origin = 'user_edited',
       edited_at = now(),
       embedding = NULL,
       updated_at = now()
     FROM (SELECT content, confidence FROM facts WHERE id = $3) AS old
     WHERE facts.id = $3`,
    [content, 1.0, id],
  );
}

export async function findActiveFacts(db: DbClient, minConfidence: number): Promise<FactRow[]> {
  const result = await db.query(
    `SELECT * FROM facts
     WHERE review_status != 'user_rejected'
       AND archived = false
       AND confidence >= $1
     ORDER BY confidence DESC`,
    [minConfidence],
  );
  return result.rows;
}

export async function findSimilarFacts(
  db: DbClient, embedding: number[], threshold: number, limit: number,
  tags?: string[],
): Promise<Array<FactRow & { similarity: number }>> {
  const params: any[] = [JSON.stringify(embedding), threshold, limit];
  let tagFilter = '';
  if (tags && tags.length > 0) {
    params.push(tags);
    tagFilter = `AND tags @> $${params.length}`;
  }
  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM facts
     WHERE archived = false AND review_status != 'user_rejected'
       AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
       ${tagFilter}
     ORDER BY similarity DESC LIMIT $3`,
    params,
  );
  return result.rows;
}

export async function setFactReviewStatus(
  db: DbClient, id: string, status: string,
): Promise<void> {
  await db.query(
    `UPDATE facts SET review_status = $1, updated_at = now() WHERE id = $2`,
    [status, id],
  );
}

export async function setFactArchived(db: DbClient, id: string, archived: boolean): Promise<void> {
  await db.query(
    `UPDATE facts SET archived = $1, updated_at = now() WHERE id = $2`,
    [archived, id],
  );
}

export async function getFactById(db: DbClient, id: string): Promise<FactRow | null> {
  const result = await db.query(`SELECT * FROM facts WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findPendingReviewFacts(db: DbClient, limit: number): Promise<FactRow[]> {
  const result = await db.query(
    `SELECT * FROM facts WHERE review_status = 'pending_review' AND archived = false
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function addSourceCaptureIds(
  db: DbClient, id: string, captureIds: string[],
): Promise<void> {
  await db.query(
    `UPDATE facts SET
       source_capture_ids = array_cat(source_capture_ids, $1),
       updated_at = now()
     WHERE id = $2`,
    [captureIds, id],
  );
}
