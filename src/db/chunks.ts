import type { DbClient } from './client.js';

export type ChunkType = 'text' | 'image' | 'audio_segment' | 'video_keyframe';

export interface ChunkInsert {
  contentItemId: string;
  chunkIndex: number;
  chunkType: ChunkType;
  content: string | null;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface ChunkRow {
  id: string;
  content_item_id: string;
  chunk_index: number;
  chunk_type: ChunkType;
  content: string | null;
  embedding: number[];
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function insertChunk(db: DbClient, chunk: ChunkInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO chunks (content_item_id, chunk_index, chunk_type, content, embedding, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      chunk.contentItemId, chunk.chunkIndex, chunk.chunkType, chunk.content,
      JSON.stringify(chunk.embedding), JSON.stringify(chunk.metadata),
    ],
  );
  return result.rows[0];
}

export async function insertChunks(db: DbClient, chunks: ChunkInsert[]): Promise<void> {
  if (chunks.length === 0) return;
  // Insert in a transaction for atomicity
  await db.transaction(async (tx) => {
    for (const chunk of chunks) {
      await tx.query(
        `INSERT INTO chunks (content_item_id, chunk_index, chunk_type, content, embedding, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          chunk.contentItemId, chunk.chunkIndex, chunk.chunkType, chunk.content,
          JSON.stringify(chunk.embedding), JSON.stringify(chunk.metadata),
        ],
      );
    }
  });
}

export async function getChunksByContentItem(
  db: DbClient,
  contentItemId: string,
): Promise<ChunkRow[]> {
  const result = await db.query(
    `SELECT * FROM chunks WHERE content_item_id = $1 ORDER BY chunk_index ASC`,
    [contentItemId],
  );
  return result.rows;
}

export async function deleteChunksByContentItem(db: DbClient, contentItemId: string): Promise<void> {
  await db.query(`DELETE FROM chunks WHERE content_item_id = $1`, [contentItemId]);
}

/**
 * Semantic chunk search result. Deliberately omits the raw embedding vector —
 * consumers (MCP/REST) don't need it and including a 3072-dim float array per hit
 * bloats response payloads by ~40KB each. Use the dedicated chunk fetch if you
 * need the raw vector for something internal.
 */
export interface ChunkSearchResult {
  id: string;
  content_item_id: string;
  chunk_index: number;
  chunk_type: ChunkType;
  content: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  similarity: number;
  parent_type: string;
  parent_title: string;
  parent_project_ids: string[];
  parent_tags: string[];
  parent_source_url: string | null;
}

export async function findSimilarChunks(
  db: DbClient,
  embedding: number[],
  threshold: number,
  limit: number = 10,
  opts: { projectId?: string; parentType?: 'document' | 'note'; tags?: string[] } = {},
): Promise<ChunkSearchResult[]> {
  const conditions = ['ci.archived = false', '1 - (c.embedding <=> $1::vector) > $2'];
  const params: unknown[] = [JSON.stringify(embedding), threshold, limit];
  let i = 4;

  if (opts.projectId) {
    conditions.push(`ci.project_ids @> ARRAY[$${i++}]::uuid[]`);
    params.push(opts.projectId);
  }
  if (opts.parentType) {
    conditions.push(`ci.type = $${i++}`);
    params.push(opts.parentType);
  }
  if (opts.tags && opts.tags.length > 0) {
    conditions.push(`ci.tags @> $${i++}`);
    params.push(opts.tags);
  }

  // Explicit column list — must NOT include c.embedding (huge and not useful to consumers).
  const result = await db.query(
    `SELECT c.id, c.content_item_id, c.chunk_index, c.chunk_type,
            c.content, c.metadata, c.created_at,
            1 - (c.embedding <=> $1::vector) AS similarity,
            ci.type AS parent_type,
            ci.title AS parent_title,
            ci.project_ids AS parent_project_ids,
            ci.tags AS parent_tags,
            ci.source_url AS parent_source_url
     FROM chunks c
     JOIN content_items ci ON ci.id = c.content_item_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY similarity DESC
     LIMIT $3`,
    params,
  );
  return result.rows;
}
