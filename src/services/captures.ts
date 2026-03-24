// src/services/captures.ts
import type { ServiceDeps } from './index.js';
import type { CaptureRow } from '../db/captures.js';
import { getCaptureById, findCapturesByStatus, setCaptureArchived } from '../db/captures.js';
import { runCapturePipeline, type FileInput, type PipelineResult } from '../capture/pipeline.js';
import { searchThoughts as retrievalSearch, type SearchResult } from '../retrieval/search.js';

export type { CaptureRow, SearchResult };

export type CaptureResult =
  | { captureId: string; warnings?: string[] }
  | { error: true; reason: string };

/**
 * Run the full capture pipeline: dedup, embed, metadata, insert.
 */
export async function captureThought(
  deps: ServiceDeps,
  content: string,
  files: FileInput[],
  tags: string[] | undefined,
  source: string[],
): Promise<CaptureResult> {
  const result: PipelineResult = await runCapturePipeline({
    db: deps.db,
    embeddingProvider: deps.embeddingProvider,
    metadataLLM: deps.metadataLLM,
    blobStorage: deps.blobStorage,
    content,
    files,
    source,
    tags,
  });

  if (!result.success) {
    return { error: true, reason: result.reason ?? 'Unknown error' };
  }

  return { captureId: result.captureId!, warnings: result.warnings };
}

/**
 * Tiered semantic search: insights → facts → captures.
 */
export async function searchThoughts(
  deps: ServiceDeps,
  query: string,
  threshold: number,
  limit: number,
  tags?: string[],
): Promise<SearchResult[]> {
  return retrievalSearch(deps.db, deps.embeddingProvider, query, threshold, limit, tags);
}

/**
 * Return a single capture by ID, or null if not found.
 */
export async function getCapture(
  deps: ServiceDeps,
  id: string,
): Promise<CaptureRow | null> {
  return getCaptureById(deps.db, id);
}

/**
 * List captures by status. Defaults to 'pending' if no status provided.
 */
export async function listCaptures(
  deps: ServiceDeps,
  limit?: number,
  status?: string,
): Promise<CaptureRow[]> {
  const rows = await findCapturesByStatus(deps.db, status ?? 'pending');
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Soft-archive a capture.
 */
export async function archiveCapture(
  deps: ServiceDeps,
  id: string,
): Promise<void> {
  await setCaptureArchived(deps.db, id, true);
}

/**
 * Restore an archived capture.
 */
export async function unarchiveCapture(
  deps: ServiceDeps,
  id: string,
): Promise<void> {
  await setCaptureArchived(deps.db, id, false);
}
