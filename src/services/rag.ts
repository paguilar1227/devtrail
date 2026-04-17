import type { ServiceDeps } from './index.js';
import { search } from './search.js';

export interface RagOptions {
  projectId?: string;
  tags?: string[];
  maxChunks?: number;
  entityTypes?: Array<'document' | 'note' | 'todo'>;
}

export interface Citation {
  content_item_id?: string;
  title: string;
  type: string;
  chunk_preview: string;
  similarity: number;
}

export interface RagResult {
  answer: string;
  citations: Citation[];
  used_chunks: number;
}

const SYSTEM_PROMPT = `You are a helpful assistant answering questions using ONLY the provided context from a personal knowledge base.

Rules:
- Answer concisely and directly, using the context to support your response
- If the context doesn't contain the answer, say so — do NOT make up information
- Cite sources inline using [1], [2], etc. matching the numbered context passages
- If context is ambiguous or contradictory, mention it
- Preserve specific details: names, numbers, dates, quotes`;

export async function ragQuery(
  deps: ServiceDeps,
  question: string,
  opts: RagOptions = {},
): Promise<RagResult> {
  const maxChunks = opts.maxChunks ?? 6;
  console.log(`[rag] Question: "${question.slice(0, 100)}", project: ${opts.projectId ?? 'global'}`);

  // Retrieve relevant chunks
  const hits = await search(deps, question, {
    projectId: opts.projectId,
    entityTypes: opts.entityTypes,
    tags: opts.tags,
    limit: maxChunks,
    threshold: 0.2,
  });

  if (hits.length === 0) {
    return {
      answer: `I don't have any information in your knowledge base${opts.projectId ? ' for this project' : ''} that relates to this question.`,
      citations: [],
      used_chunks: 0,
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
      contextParts.push(`[${num}] (${c.parent_type}: "${c.parent_title}")\n${c.content ?? '[media content]'}`);
      citations.push({
        content_item_id: c.content_item_id,
        title: c.parent_title,
        type: c.parent_type,
        chunk_preview: (c.content ?? '').slice(0, 150),
        similarity: c.similarity,
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

  console.log(`[rag] Sending to LLM — ${hits.length} chunks, ${context.length} context chars`);

  const response = await deps.ragLLM.complete(
    [{ role: 'user', content: userPrompt }],
    { systemPrompt: SYSTEM_PROMPT, maxTokens: 2048 },
  );

  console.log(`[rag] LLM response — tokens: ${response.tokensUsed.total}, answer length: ${response.content.length}`);

  return {
    answer: response.content,
    citations,
    used_chunks: hits.length,
  };
}
