// src/capture/dedup.ts
import { createHash } from 'crypto';
import type { DbClient } from '../db/client.js';
import { findSimilarCaptures, findCapturesByHashes } from '../db/captures.js';

const SEMANTIC_DEDUP_THRESHOLD = 0.95;

export function computeFileHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function checkFileHashDedup(
  db: DbClient,
  hashes: string[],
): Promise<Map<string, string>> {
  const matches = await findCapturesByHashes(db, hashes);
  const hashToUrl = new Map<string, string>();

  for (const row of matches) {
    if (row.file_hashes && row.file_urls) {
      for (let i = 0; i < row.file_hashes.length; i++) {
        if (hashes.includes(row.file_hashes[i]) && row.file_urls[i]) {
          hashToUrl.set(row.file_hashes[i], row.file_urls[i]);
        }
      }
    }
  }

  return hashToUrl;
}

export interface SemanticDedupResult {
  isDuplicate: boolean;
  similarity: number | null;
  existingId: string | null;
}

export async function checkSemanticDedup(
  db: DbClient,
  embedding: number[],
): Promise<SemanticDedupResult> {
  const similar = await findSimilarCaptures(db, embedding, SEMANTIC_DEDUP_THRESHOLD);

  if (similar.length > 0) {
    console.log(`[dedup] Semantic duplicate found — similarity: ${similar[0].similarity.toFixed(3)}, existing: ${similar[0].id.slice(0, 8)}, threshold: ${SEMANTIC_DEDUP_THRESHOLD}`);
    return {
      isDuplicate: true,
      similarity: similar[0].similarity,
      existingId: similar[0].id,
    };
  }

  console.log(`[dedup] Passed — no matches above ${SEMANTIC_DEDUP_THRESHOLD} threshold`);

  return { isDuplicate: false, similarity: null, existingId: null };
}
