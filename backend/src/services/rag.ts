import type { ServiceDeps } from './index.js';
import { searchWithTimings } from './search.js';
import { classifyQueryDepth, type QueryDepth } from './query-depth.js';
import { withSpan } from '../observability.js';

export interface RagOptions {
  sessionId?: string;
  projectId?: string | null;
  tags?: string[];
  maxChunks?: number;
  entityTypes?: Array<'document' | 'note' | 'todo'>;
  /** Force a depth or leave as 'auto' to let the classifier decide. */
  depth?: QueryDepth | 'auto';
  /**
   * Override reasoning effort on the thorough path. Ignored on fast
   * (gpt-5-4 chat completions has no reasoning). Default is whatever
   * the upstream Azure default is (currently medium for gpt-5.4-pro).
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

// Must stay a superset of the wire contract (RagCitationSchema in
// @devtrail/shared): the frontend Zod-parses the REST response and
// REQUIRES `id`, `content_item_id`, `title`, `excerpt`; `type` is an
// optional schema field that survives the parse — the Chat tab's
// "Open source" routing (note/document/todo) depends on it, so don't
// treat it as discardable. The remaining extras (chunk_preview /
// similarity / retrieval_path) are stripped by the web client's parse
// but kept for the MCP `ask` tool, which returns this object verbatim.
// Regression test: tests/unit/services/rag-citation-schema.test.ts
export interface Citation {
  id: string;                  // chunk id (todo id for todo hits)
  content_item_id: string;     // parent content item (todo id for todo hits)
  title: string;
  excerpt: string;             // what the UI shows when a citation is expanded
  type: string;
  chunk_preview: string;
  similarity: number | null;
  source_url?: string | null;  // set when the content item was ingested from a URL
  retrieval_path?: Array<{
    step: 'vector' | 'entity' | 'lexical';
    score?: number;
    entity?: { canonical_name: string; type: string };
    confidence?: number;
  }>;
}

/** Map a search hit to a wire-conformant citation. Todos aren't content
 *  items, so their own id doubles as content_item_id — both fields must be
 *  UUIDs per the schema. Returns null for hit shapes that carry no payload.
 *  Structurally typed (SearchHit-compatible) so the schema regression test
 *  can feed minimal fixtures. */
export function hitToCitation(hit: {
  type: string;
  retrieval_path?: Citation['retrieval_path'];
  chunk?: {
    id: string;
    content_item_id: string;
    parent_title: string;
    parent_type: string;
    content: string | null;
    similarity: number | null;
    parent_source_url?: string | null;
  };
  todo?: {
    id: string;
    content: string;
    status: string;
    due_date?: string | Date | null;
    similarity: number | null;
  };
}): Citation | null {
  if (hit.type === 'chunk' && hit.chunk) {
    const c = hit.chunk;
    return {
      id: c.id,
      content_item_id: c.content_item_id,
      title: c.parent_title,
      excerpt: (c.content ?? '').slice(0, 500),
      type: c.parent_type,
      chunk_preview: (c.content ?? '').slice(0, 150),
      similarity: c.similarity,
      source_url: c.parent_source_url ?? null,
      retrieval_path: hit.retrieval_path,
    };
  }
  if (hit.type === 'todo' && hit.todo) {
    const t = hit.todo;
    // due_date can arrive as a Date (pg row) or string — normalize so the
    // excerpt never carries a verbose Date.prototype.toString().
    const due = t.due_date instanceof Date ? t.due_date.toISOString() : t.due_date ?? 'none';
    const preview = `Status: ${t.status}, Due: ${due}`;
    return {
      id: t.id,
      content_item_id: t.id,
      title: t.content.slice(0, 80),
      excerpt: preview,
      type: 'todo',
      chunk_preview: preview,
      similarity: t.similarity,
      retrieval_path: hit.retrieval_path,
    };
  }
  return null;
}

export interface RagResult {
  answer: string;
  citations: Citation[];
  used_chunks: number;
  meta: {
    depth_used: QueryDepth;
    depth_reason: string;     // why this depth was picked (classifier's output, or "caller forced fast/thorough")
    timings_ms: {
      classify: number;       // 0 when caller forced a depth (classifier skipped)
      embed: number;          // query embedding call (Gemini Embedding 2)
      db_scan: number;        // pgvector cosine scan (no HNSW today — linear)
      graph: number;          // chunk_entities expansion + entity lookups
      synthesize: number;     // final LLM call (GPT-5.4 fast or Pro thorough)
      total: number;          // end-to-end wall time
    };
  };
}

const SYSTEM_PROMPT = `You are a helpful assistant answering questions using ONLY the provided context from a personal knowledge base.

Rules:
- Answer concisely and directly, using the context to support your response
- If the context doesn't contain the answer, say so — do NOT make up information
- Cite sources inline using [1], [2], etc. matching the numbered context passages
- When a context passage has a source URL in its header, include the URL inline with the citation (e.g., "[1] (https://...)"). This lets the user jump to the original.
- If context is ambiguous or contradictory, mention it
- Preserve specific details: names, numbers, dates, quotes`;

export async function ragQuery(
  deps: ServiceDeps,
  question: string,
  opts: RagOptions = {},
): Promise<RagResult> {
  return withSpan(
    'rag.query',
    {
      'rag.depth_requested': String(opts.depth ?? 'fast'),
      'rag.project_id': opts.projectId === null ? 'personal' : opts.projectId ?? '',
      'rag.question_length': question.length,
    },
    () => ragQueryImpl(deps, question, opts),
  );
}

async function ragQueryImpl(
  deps: ServiceDeps,
  question: string,
  opts: RagOptions = {},
): Promise<RagResult> {
  const maxChunks = opts.maxChunks ?? 6;
  // Default to 'fast'. The depth classifier (Haiku) historically routed
  // some queries to the 'thorough' tier (gpt-5.4-pro Responses API), which
  // pays 22-36× the latency of fast for marginal-to-zero quality gain on
  // retrieval-grounded queries. See docs/profiles/2026-04-25-rag-effort-baseline.md
  // for the data. 'auto' and 'thorough' remain available as opt-in via
  // the `depth` param when callers explicitly want the reasoning tier.
  // Once gpt-5.5 quota lands and we re-profile, this default may flip back
  // to 'auto' if a faster reasoning option proves worth it.
  const requestedDepth = opts.depth ?? 'fast';
  const pipelineStart = performance.now();
  console.log(
    `[rag] Question: "${question.slice(0, 100)}", project: ${opts.projectId === null ? 'personal' : opts.projectId ?? 'global'}, depth: ${requestedDepth}`,
  );

  // Resolve depth + extract query entities. Auto → classifier; forced → skip.
  let depth: QueryDepth;
  let depthReason: string;
  let queryEntities: Array<{ name: string; type: 'person' | 'org' | 'concept' | 'tool' | 'paper' }> = [];
  let classifyMs = 0;
  if (requestedDepth === 'auto') {
    const classifyStart = performance.now();
    const classification = await classifyQueryDepth(deps, question);
    classifyMs = Math.round(performance.now() - classifyStart);
    depth = classification.depth;
    depthReason = classification.reason;
    queryEntities = classification.entities;
  } else {
    depth = requestedDepth;
    depthReason = `caller forced ${requestedDepth}`;
  }

  // Retrieve relevant chunks. Graph expansion uses query entities if present.
  const { hits, timings: searchTimings } = await searchWithTimings(deps, question, {
    projectId: opts.projectId, sessionId: opts.sessionId,
    entityTypes: opts.entityTypes,
    tags: opts.tags,
    limit: maxChunks,
    threshold: 0.2,
    queryEntities,
  });

  if (hits.length === 0) {
    const totalMs = Math.round(performance.now() - pipelineStart);
    return {
      answer: `I don't have any information in your knowledge base${opts.projectId ? ' for this project' : opts.projectId === null ? ' in your personal space' : ''} that relates to this question.`,
      citations: [],
      used_chunks: 0,
      meta: {
        depth_used: depth,
        depth_reason: depthReason,
        timings_ms: {
          classify: classifyMs,
          embed: searchTimings.embed_ms,
          db_scan: searchTimings.db_scan_ms,
          graph: searchTimings.graph_ms,
          synthesize: 0,
          total: totalMs,
        },
      },
    };
  }

  // Build context from chunks + todos
  const contextParts: string[] = [];
  const citations: Citation[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const num = i + 1;
    if (hit.type === 'chunk' && hit.chunk) {
      const c = hit.chunk;
      const urlPart = c.parent_source_url ? ` — source: ${c.parent_source_url}` : '';
      contextParts.push(
        `[${num}] (${c.parent_type}: "${c.parent_title}"${urlPart})\n${c.content ?? '[media content]'}`,
      );
    } else if (hit.type === 'todo' && hit.todo) {
      const t = hit.todo;
      contextParts.push(`[${num}] (todo — status: ${t.status}, priority: ${t.priority ?? 'none'})\n${t.content}`);
    }
    const citation = hitToCitation(hit);
    if (citation) citations.push(citation);
  }

  const context = contextParts.join('\n\n');
  const userPrompt = `Context from knowledge base:\n\n${context}\n\n---\n\nQuestion: ${question}`;

  console.log(`[rag] Sending to LLM — ${hits.length} chunks, ${context.length} context chars, depth: ${depth}`);

  const llm = depth === 'thorough' ? deps.ragDeepLLM : deps.ragFastLLM;
  // Thorough mode burns reasoning tokens against the output budget, so give
  // it more room. Fast mode stays tight.
  const maxTokens = depth === 'thorough' ? 8192 : 2048;

  const synthStart = performance.now();
  const response = await llm.complete(
    [{ role: 'user', content: userPrompt }],
    {
      systemPrompt: SYSTEM_PROMPT,
      maxTokens,
      // Only pass effort on the thorough path — chat completions ignores it.
      ...(depth === 'thorough' && opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    },
  );
  const synthesizeMs = Math.round(performance.now() - synthStart);
  const totalMs = Math.round(performance.now() - pipelineStart);

  console.log(
    `[rag] LLM response — depth: ${depth}, tokens: ${response.tokensUsed.total}, answer length: ${response.content.length} ` +
    `— classify ${classifyMs}ms, embed ${searchTimings.embed_ms}ms, db ${searchTimings.db_scan_ms}ms, synth ${synthesizeMs}ms, total ${totalMs}ms`,
  );

  return {
    answer: response.content,
    citations,
    used_chunks: hits.length,
    meta: {
      depth_used: depth,
      depth_reason: depthReason,
      timings_ms: {
        classify: classifyMs,
        embed: searchTimings.embed_ms,
        db_scan: searchTimings.db_scan_ms,
        graph: searchTimings.graph_ms,
        synthesize: synthesizeMs,
        total: totalMs,
      },
    },
  };
}
