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
}

export async function searchThoughts(
  db: DbClient,
  embeddingProvider: EmbeddingProvider,
  query: string,
  threshold: number,
  limit: number,
  tags?: string[],
): Promise<SearchResult[]> {
  const queryEmbedding = await embeddingProvider.embed(query);

  // Tier 1: Search insights first
  const insights = await findSimilarInsights(db, queryEmbedding, threshold, limit, tags);
  if (insights.length > 0) {
    return insights.map((i) => ({
      tier: 'insight' as const,
      confidence: i.confidence,
      content: i.content,
      tags: i.tags,
      note: i.confidence < 0.7 ? 'Moderate confidence — based on mixed evidence' : null,
      evidence: null,
    }));
  }

  // Tier 2: Search facts
  const facts = await findSimilarFacts(db, queryEmbedding, threshold, limit, tags);
  if (facts.length > 0) {
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

      results.push({
        tier: 'fact',
        confidence: fact.confidence,
        content: fact.content,
        tags: fact.tags,
        note,
        evidence,
      });
    }
    return results;
  }

  // Tier 3: Fall back to raw captures
  const captures = await findSimilarCaptures(db, queryEmbedding, threshold, limit, tags);
  return captures.slice(0, limit).map((c) => ({
    tier: 'capture' as const,
    confidence: null,
    content: c.content,
    tags: c.tags,
    note: null,
    evidence: null,
  }));
}
