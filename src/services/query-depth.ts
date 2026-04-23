// src/services/query-depth.ts
//
// Classifies an incoming RAG question as "fast" (single-fact / direct lookup)
// or "thorough" (multi-hop, synthesis, contradiction analysis). Routing
// decision drives which synthesis model runs: fast stays on gpt-5-4 base
// for snappy answers, thorough escalates to gpt-5-4-pro via Responses API.
//
// Uses Haiku 4.5 — the same provider we already wired for metadata.
// Cost: ~$0.0001 per call, latency ~300ms.

import type { ServiceDeps } from './index.js';

export type QueryDepth = 'fast' | 'thorough';

export interface DepthClassification {
  depth: QueryDepth;
  reason: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You classify retrieval-augmented questions into one of two processing depths.

- "fast" — direct lookup, single-fact retrieval, simple summary, definition query, or question answerable from a single source. Examples:
  - "What did I save about pgvector?"
  - "Summarize the Domain-Driven Design note."
  - "What's the title of the paper I saved last week?"
  - "When did I save the InstructGPT paper?"

- "thorough" — multi-hop reasoning, comparison across sources, contradiction / tradeoff analysis, inference beyond the explicit text, temporal or aggregation queries. Examples:
  - "Compare the approach in my research report to the InstructGPT paper."
  - "What are the tradeoffs between the embedding models I've read about?"
  - "Which of my notes contradict each other on the topic of RAG?"
  - "Across all my saved material, what's the consensus on GraphRAG?"
  - "Why would the approach in paper X fail under condition Y?"

When in doubt, lean "fast". Only return "thorough" when the question clearly needs to reason across multiple pieces of evidence.

Return a single JSON object:
{"depth": "fast" | "thorough", "reason": "<one short sentence>"}`;

export async function classifyQueryDepth(
  deps: ServiceDeps,
  question: string,
): Promise<DepthClassification> {
  try {
    const res = await deps.queryDepthLLM.complete(
      [{ role: 'user', content: question }],
      {
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        responseFormat: 'json',
        maxTokens: 200,
      },
    );

    const parsed = JSON.parse(res.content) as { depth?: string; reason?: string };
    const depth: QueryDepth = parsed.depth === 'thorough' ? 'thorough' : 'fast';
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 200)
      : 'no reason given';

    console.log(`[rag:classify] "${question.slice(0, 80)}" → ${depth} (${reason})`);
    return { depth, reason };
  } catch (err) {
    // Fail safe: default to fast if the classifier breaks. Worst case is a
    // less-thorough answer, not a broken call.
    console.warn(
      `[rag:classify] Classifier failed, defaulting to fast:`,
      err instanceof Error ? err.message : err,
    );
    return { depth: 'fast', reason: 'classifier error — defaulted to fast' };
  }
}
