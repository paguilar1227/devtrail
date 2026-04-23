import type { ServiceDeps } from './index.js';
import { findSimilarChunks, type ChunkSearchResult } from '../db/chunks.js';
import { findSimilarTodos, type TodoSearchResult } from '../db/todos.js';

export interface SearchOptions {
  projectId?: string;
  entityTypes?: Array<'document' | 'note' | 'todo'>;
  tags?: string[];
  limit?: number;
  threshold?: number;
}

export interface SearchHit {
  type: 'chunk' | 'todo';
  similarity: number;
  // chunk-specific (no raw embedding — stripped in DB layer)
  chunk?: ChunkSearchResult;
  // todo-specific (no raw embedding — stripped in DB layer)
  todo?: TodoSearchResult;
}

export interface SearchTimings {
  embed_ms: number;
  db_scan_ms: number;
  total_ms: number;
}

export interface SearchResultWithTimings {
  hits: SearchHit[];
  timings: SearchTimings;
}

/**
 * Unified semantic search across chunks (documents + notes) and todos.
 * Returns ranked hits across entity types.
 */
export async function search(
  deps: ServiceDeps,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const { hits } = await searchWithTimings(deps, query, opts);
  return hits;
}

export async function searchWithTimings(
  deps: ServiceDeps,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResultWithTimings> {
  // Default 0.65. Gemini Embedding 2 (3072-dim) has a natural floor around
  // 0.5 even for unrelated content because high-dim cosine similarity
  // clusters near 0.5-0.7 for "not obviously about the query" pairs. 0.65
  // is the observed break between "related" and "noise" on this corpus.
  // Caller can override via opts.threshold (MCP + REST expose it).
  const { projectId, entityTypes, tags, limit = 10, threshold = 0.65 } = opts;
  const totalStart = performance.now();
  console.log(`[search] query: "${query.slice(0, 80)}", project: ${projectId ?? 'global'}, types: ${entityTypes?.join(',') ?? 'all'}, tags: ${tags?.join(',') ?? 'none'}`);

  const embedStart = performance.now();
  const queryEmbedding = await deps.embeddingProvider.embed(query);
  const embedMs = Math.round(performance.now() - embedStart);

  const searchChunks = !entityTypes || entityTypes.some((t) => t === 'document' || t === 'note');
  const searchTodos = !entityTypes || entityTypes.includes('todo');

  const dbStart = performance.now();
  const [chunks, todos] = await Promise.all([
    searchChunks
      ? findSimilarChunks(deps.db, queryEmbedding, threshold, limit, {
          projectId,
          parentType: entityTypes && entityTypes.length === 1
            ? (entityTypes[0] === 'document' || entityTypes[0] === 'note' ? entityTypes[0] : undefined)
            : undefined,
          tags,
        })
      : Promise.resolve([]),
    searchTodos && !tags  // tags-on-todos filtering TBD; skip for v1 simplicity
      ? findSimilarTodos(deps.db, queryEmbedding, threshold, limit)
          .then((todos) => projectId ? todos.filter((t) => t.project_id === projectId) : todos)
      : Promise.resolve([]),
  ]);
  const dbMs = Math.round(performance.now() - dbStart);

  const hits: SearchHit[] = [
    ...chunks.map((c) => ({ type: 'chunk' as const, similarity: c.similarity, chunk: c })),
    ...todos.map((t) => ({ type: 'todo' as const, similarity: t.similarity, todo: t })),
  ];

  hits.sort((a, b) => b.similarity - a.similarity);
  const result = hits.slice(0, limit);
  const totalMs = Math.round(performance.now() - totalStart);

  console.log(
    `[search] returning ${result.length} hits (${chunks.length} chunks, ${todos.length} todos) ` +
    `— embed ${embedMs}ms, db ${dbMs}ms, total ${totalMs}ms`,
  );
  return {
    hits: result,
    timings: { embed_ms: embedMs, db_scan_ms: dbMs, total_ms: totalMs },
  };
}
