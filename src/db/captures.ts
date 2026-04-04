import type { DbClient } from './client.js';

export interface CaptureInsert {
  content: string;
  contentTypes: string[];
  fileUrls: string[] | null;
  fileHashes: string[] | null;
  embedding: number[];
  metadata: Record<string, unknown>;
  source: string[];
  tags: string[];
  extractedText: string | null;
}

export interface CaptureRow {
  id: string;
  content: string;
  content_types: string[];
  file_urls: string[] | null;
  file_hashes: string[] | null;
  embedding: number[];
  metadata: Record<string, unknown>;
  source: string[];
  tags: string[];
  extracted_text: string | null;
  status: string;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function insertCapture(
  db: DbClient,
  capture: CaptureInsert,
): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO captures (content, content_types, file_urls, file_hashes, embedding, metadata, source, tags, extracted_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      capture.content,
      capture.contentTypes,
      capture.fileUrls,
      capture.fileHashes,
      JSON.stringify(capture.embedding),
      JSON.stringify(capture.metadata),
      capture.source,
      capture.tags,
      capture.extractedText,
    ],
  );
  return result.rows[0];
}

export async function updateCaptureTags(db: DbClient, id: string, tags: string[]): Promise<string[] | null> {
  const result = await db.query(
    `UPDATE captures SET tags = $1, updated_at = now() WHERE id = $2 RETURNING tags`,
    [tags, id],
  );
  return result.rows[0]?.tags ?? null;
}

export async function findCapturesByStatus(
  db: DbClient,
  status: string,
): Promise<CaptureRow[]> {
  const result = await db.query(
    `SELECT * FROM captures WHERE status = $1 AND archived = false ORDER BY created_at ASC`,
    [status],
  );
  return result.rows;
}

export async function updateCaptureStatus(
  db: DbClient,
  id: string,
  status: string,
): Promise<void> {
  await db.query(
    `UPDATE captures SET status = $1, updated_at = now() WHERE id = $2`,
    [status, id],
  );
}

export async function findSimilarCaptures(
  db: DbClient,
  embedding: number[],
  threshold: number,
  limit: number = 20,
  tags?: string[],
): Promise<Array<CaptureRow & { similarity: number }>> {
  const params: any[] = [JSON.stringify(embedding), threshold, limit];
  let tagFilter = '';
  if (tags && tags.length > 0) {
    params.push(tags);
    tagFilter = `AND tags @> $${params.length}`;
  }
  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM captures
     WHERE archived = false
       AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
       ${tagFilter}
     ORDER BY similarity DESC
     LIMIT $3`,
    params,
  );
  return result.rows;
}

export async function setCaptureArchived(
  db: DbClient,
  id: string,
  archived: boolean,
): Promise<void> {
  await db.query(
    `UPDATE captures SET archived = $1, updated_at = now() WHERE id = $2`,
    [archived, id],
  );
}

export async function getCaptureById(
  db: DbClient,
  id: string,
): Promise<CaptureRow | null> {
  const result = await db.query(`SELECT * FROM captures WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function countCapturesCreatedSince(db: DbClient, since: Date): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int as count FROM captures WHERE created_at >= $1 AND archived = false`,
    [since],
  );
  return result.rows[0].count;
}

export async function countCapturesArchivedSince(db: DbClient, since: Date): Promise<number> {
  // Uses updated_at as proxy for archive time (archived=true sets updated_at=now())
  const result = await db.query(
    `SELECT count(*)::int as count FROM captures WHERE archived = true AND updated_at >= $1`,
    [since],
  );
  return result.rows[0].count;
}

export async function findCapturesByHashes(
  db: DbClient,
  hashes: string[],
): Promise<Array<{ file_hashes: string[]; file_urls: string[] }>> {
  const result = await db.query(
    `SELECT file_hashes, file_urls FROM captures
     WHERE file_hashes && $1 AND archived = false`,
    [hashes],
  );
  return result.rows;
}
