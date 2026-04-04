// src/retrieval/search.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { findSimilarInsights } from '../db/insights.js';
import { findSimilarFacts } from '../db/facts.js';
import { findSimilarCaptures } from '../db/captures.js';

export interface SearchResult {
  tier: 'insight' | 'fact' | 'capture';
  confidence: number | null;
  content: string;
  tags: string[];
  note: string | null;
  evidence: Array<{ content: string; tier: string }> | null;
  file_urls: string[] | null;
}

export async function searchThoughts(
  db: DbClient,
  embeddingProvider: EmbeddingProvider,
  query: string,
  threshold: number,
  limit: number,
  tags?: string[],
): Promise<SearchResult[]> {
  console.log(`[search] Query: "${query.slice(0, 80)}", threshold: ${threshold}, limit: ${limit}, tags: ${tags ? `[${tags.join(', ')}]` : 'none'}`);
  const queryEmbedding = await embeddingProvider.embed(query);

  // Tier 1: Search insights first
  const insights = await findSimilarInsights(db, queryEmbedding, threshold, limit, tags);
  if (insights.length > 0) {
    console.log(`[search] Tier 1 hit — ${insights.length} insight(s): ${insights.map((i) => `"${i.content.slice(0, 60)}" (sim: ${(i as any).similarity?.toFixed(3)}, conf: ${i.confidence})`).join('; ')}`);
    // Trace back: insight → source_fact_ids → facts → source_capture_ids → captures → file_urls
    const allFactIds = [...new Set(insights.flatMap((i) => i.source_fact_ids ?? []))];
    const fileUrlMap = allFactIds.length > 0
      ? await getFileUrlsForFacts(db, allFactIds)
      : new Map<string, string[]>();
    if (fileUrlMap.size > 0) console.log(`[search] File URLs traced for ${fileUrlMap.size} fact(s)`);

    return insights.map((i) => {
      const urls = (i.source_fact_ids ?? []).flatMap((fid: string) => fileUrlMap.get(fid) ?? []);
      return {
        tier: 'insight' as const,
        confidence: i.confidence,
        content: i.content,
        tags: i.tags,
        note: i.confidence < 0.7 ? 'Moderate confidence — based on mixed evidence' : null,
        evidence: null,
        file_urls: urls.length > 0 ? [...new Set(urls)] : null,
      };
    });
  }

  console.log(`[search] Tier 1 miss — no insights above threshold`);

  // Tier 2: Search facts
  const facts = await findSimilarFacts(db, queryEmbedding, threshold, limit, tags);
  if (facts.length > 0) {
    console.log(`[search] Tier 2 hit — ${facts.length} fact(s): ${facts.map((f) => `"${f.content.slice(0, 60)}" (sim: ${(f as any).similarity?.toFixed(3)}, conf: ${f.confidence})`).join('; ')}`);
    // Trace back: fact → source_capture_ids → captures → file_urls
    const allCaptureIds = [...new Set(facts.flatMap((f) => f.source_capture_ids ?? []))];
    const captureFileUrls = allCaptureIds.length > 0
      ? await getFileUrlsForCaptures(db, allCaptureIds)
      : new Map<string, string[]>();
    if (captureFileUrls.size > 0) console.log(`[search] File URLs traced for ${captureFileUrls.size} capture(s)`);

    const results: SearchResult[] = [];
    for (const fact of facts) {
      let evidence: Array<{ content: string; tier: string }> | null = null;
      let note: string | null = null;

      if (fact.confidence < 0.7 && fact.source_capture_ids?.length > 0) {
        note = 'Moderate confidence — based on mixed evidence';
        const sourceCaptures = await db.query(
          `SELECT content FROM captures WHERE id = ANY($1) AND archived = false LIMIT 5`,
          [fact.source_capture_ids],
        );
        evidence = sourceCaptures.rows.map((c: any) => ({ content: c.content, tier: 'capture' }));
      }

      const urls = (fact.source_capture_ids ?? []).flatMap((cid: string) => captureFileUrls.get(cid) ?? []);
      results.push({
        tier: 'fact',
        confidence: fact.confidence,
        content: fact.content,
        tags: fact.tags,
        note,
        evidence,
        file_urls: urls.length > 0 ? [...new Set(urls)] : null,
      });
    }
    return results;
  }

  console.log(`[search] Tier 2 miss — no facts above threshold`);

  // Tier 3: Fall back to raw captures
  const captures = await findSimilarCaptures(db, queryEmbedding, threshold, limit, tags);
  if (captures.length === 0) {
    console.log(`[search] No results at any tier for query "${query.slice(0, 80)}"`);
    return [];
  }
  const withFiles = captures.filter((c) => c.file_urls?.length);
  console.log(`[search] Tier 3 fallback — ${captures.length} capture(s)${withFiles.length > 0 ? `, ${withFiles.length} with files` : ''}: ${captures.slice(0, 3).map((c) => `"${c.content.slice(0, 50)}" (sim: ${c.similarity.toFixed(3)}${c.file_urls?.length ? ', files: ' + c.file_urls.length : ''})`).join('; ')}`);
  return captures.slice(0, limit).map((c) => ({
    tier: 'capture' as const,
    confidence: null,
    content: c.content,
    tags: c.tags,
    note: null,
    evidence: null,
    file_urls: c.file_urls ?? null,
  }));
}

/** Batch-fetch file_urls for a list of capture IDs */
async function getFileUrlsForCaptures(
  db: DbClient,
  captureIds: string[],
): Promise<Map<string, string[]>> {
  const result = await db.query(
    `SELECT id, file_urls FROM captures WHERE id = ANY($1) AND file_urls IS NOT NULL AND archived = false`,
    [captureIds],
  );
  const map = new Map<string, string[]>();
  for (const row of result.rows) {
    if (row.file_urls?.length > 0) map.set(row.id, row.file_urls);
  }
  return map;
}

/** Batch-fetch file_urls for facts by tracing through their source captures */
async function getFileUrlsForFacts(
  db: DbClient,
  factIds: string[],
): Promise<Map<string, string[]>> {
  // Get source_capture_ids for all facts at once
  const factsResult = await db.query(
    `SELECT id, source_capture_ids FROM facts WHERE id = ANY($1)`,
    [factIds],
  );
  const allCaptureIds: string[] = [...new Set(factsResult.rows.flatMap((f: any) => f.source_capture_ids ?? []))];
  if (allCaptureIds.length === 0) return new Map();

  const captureFileUrls = await getFileUrlsForCaptures(db, allCaptureIds);

  // Map fact_id → aggregated file_urls from its source captures
  const map = new Map<string, string[]>();
  for (const fact of factsResult.rows) {
    const captureIds: string[] = fact.source_capture_ids ?? [];
    const urls: string[] = captureIds.flatMap((cid) => captureFileUrls.get(cid) ?? []);
    if (urls.length > 0) map.set(fact.id, [...new Set(urls)]);
  }
  return map;
}
