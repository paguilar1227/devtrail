import type { ServiceDeps } from './index.js';
import { searchWithTimings } from './search.js';
import { classifyQueryDepth, type QueryDepth } from './query-depth.js';

export interface RagOptions {
  projectId?: string;
  tags?: string[];
  maxChunks?: number;
  entityTypes?: Array<'document' | 'note' | 'todo'>;
  /** Force a depth or leave as 'auto' to let the classifier decide. */
  depth?: QueryDepth | 'auto';
}

export interface Citation {
  content_item_id?: string;
  title: string;
  type: string;
  chunk_preview: string;
  similarity: number;
  source_url?: string | null;  // set when the content item was ingested from a URL
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
  const maxChunks = opts.maxChunks ?? 6;
  const requestedDepth = opts.depth ?? 'auto';
  const pipelineStart = performance.now();
  console.log(
    `[rag] Question: "${question.slice(0, 100)}", project: ${opts.projectId ?? 'global'}, depth: ${requestedDepth}`,
  );

  // Resolve depth. Auto → classifier; otherwise trust the caller's override.
  let depth: QueryDepth;
  let depthReason: string;
  let classifyMs = 0;
  if (requestedDepth === 'auto') {
    const classifyStart = performance.now();
    const classification = await classifyQueryDepth(deps, question);
    classifyMs = Math.round(performance.now() - classifyStart);
    depth = classification.depth;
    depthReason = classification.reason;
  } else {
    depth = requestedDepth;
    depthReason = `caller forced ${requestedDepth}`;
  }

  // Retrieve relevant chunks (same retrieval path for both depths — the routing
  // only affects synthesis).
  const { hits, timings: searchTimings } = await searchWithTimings(deps, question, {
    projectId: opts.projectId,
    entityTypes: opts.entityTypes,
    tags: opts.tags,
    limit: maxChunks,
    threshold: 0.2,
  });

  if (hits.length === 0) {
    const totalMs = Math.round(performance.now() - pipelineStart);
    return {
      answer: `I don't have any information in your knowledge base${opts.projectId ? ' for this project' : ''} that relates to this question.`,
      citations: [],
      used_chunks: 0,
      meta: {
        depth_used: depth,
        depth_reason: depthReason,
        timings_ms: {
          classify: classifyMs,
          embed: searchTimings.embed_ms,
          db_scan: searchTimings.db_scan_ms,
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
      citations.push({
        content_item_id: c.content_item_id,
        title: c.parent_title,
        type: c.parent_type,
        chunk_preview: (c.content ?? '').slice(0, 150),
        similarity: c.similarity,
        source_url: c.parent_source_url ?? null,
      });
    } else if (hit.type === 'todo' && hit.todo) {
      const t = hit.todo;
      contextParts.push(`[${num}] (todo — status: ${t.status}, priority: ${t.priority ?? 'none'})\n${t.content}`);
      citations.push({
        title: t.content.slice(0, 80),
        type: 'todo',
        chunk_preview: `Status: ${t.status}, Due: ${t.due_date ?? 'none'}`,
        similarity: t.similarity,
      });
    }
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
    { systemPrompt: SYSTEM_PROMPT, maxTokens },
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
        synthesize: synthesizeMs,
        total: totalMs,
      },
    },
  };
}
