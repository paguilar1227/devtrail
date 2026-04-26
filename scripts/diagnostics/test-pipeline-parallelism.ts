/**
 * Pipeline parallelism timing diagnostic.
 *
 * Mocks providers + DB with realistic delays and runs createContentItem
 * twice (once with a single-chunk input, once with a multi-chunk input)
 * to surface the wall-clock effect of A+B+C parallelism.
 *
 * Run: npx tsx scripts/diagnostics/test-pipeline-parallelism.ts
 *
 * Reports:
 *   - total wall-clock for the ingest
 *   - max concurrent embed calls observed
 *   - max concurrent metadata-LLM calls observed
 *   - sequential-equivalent baseline (for context)
 */

import type { ServiceDeps } from '../../src/services/index.js';
import type { LLMResponse } from '../../src/providers/types.js';
import { createContentItem } from '../../src/services/content-items.js';

const EMBED_LATENCY_MS = 200;
const META_LLM_LATENCY_MS = 1500;
const ENTITY_LLM_LATENCY_MS = 1500;

function makeConcurrencyTracker(name: string) {
  let inFlight = 0;
  let max = 0;
  let total = 0;
  return {
    enter() { inFlight++; total++; if (inFlight > max) max = inFlight; },
    exit() { inFlight--; },
    report() { return { name, max, total }; },
  };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function makeDeps(): { deps: ServiceDeps; embedTracker: ReturnType<typeof makeConcurrencyTracker>; llmTracker: ReturnType<typeof makeConcurrencyTracker> } {
  const embedTracker = makeConcurrencyTracker('embed');
  const llmTracker = makeConcurrencyTracker('metadata-llm');

  // Per-call DB shim. We keep it dumb — return what content-items.ts expects
  // for inserts and what entities.ts expects for graph-edge construction.
  let nextChunkId = 1;
  const dbQuery = async (sql: string, _params?: unknown[]) => {
    if (sql.includes('INSERT INTO content_items')) {
      return { rows: [{ id: 'ci-1' }] } as any;
    }
    if (sql.includes('INSERT INTO chunks')) {
      // Return ids for each inserted chunk in the multi-row insert
      // (insertChunks does VALUES ($1...), ($n+1...)). We don't introspect —
      // just return rows count.
      return { rows: [], rowCount: 1 } as any;
    }
    if (sql.includes('FROM chunks')) {
      // getChunksByContentItem
      return {
        rows: Array.from({ length: 8 }, (_, i) => ({
          id: `chunk-${i}`,
          content: 'A chunk of content with words like RAG and pgvector and Anthropic.',
          content_item_id: 'ci-1',
          chunk_index: i,
        })),
      } as any;
    }
    if (sql.includes('FROM entities')) {
      // findEntityByCanonical / findEntityByAlias / findEntityByEmbedding — all miss
      return { rows: [] } as any;
    }
    if (sql.includes('INSERT INTO entities')) {
      return { rows: [{ id: `ent-${nextChunkId++}`, canonical_name: 'X', type: 'concept', aliases: [], embedding: [], created_at: new Date() }] } as any;
    }
    if (sql.includes('UPDATE entities')) {
      return { rows: [] } as any;
    }
    if (sql.includes('UPDATE content_items')) {
      return { rows: [] } as any;
    }
    if (sql.includes('source_url')) {
      return { rows: [] } as any;
    }
    return { rows: [] } as any;
  };

  const deps: ServiceDeps = {
    db: {
      pool: {} as any,
      query: dbQuery as any,
      transaction: (async (fn: any) => fn({ query: dbQuery })) as any,
      close: (async () => {}) as any,
    } as any,
    embeddingProvider: {
      embed: (async () => {
        embedTracker.enter();
        try {
          await sleep(EMBED_LATENCY_MS);
          return new Array(3072).fill(0.1);
        } finally { embedTracker.exit(); }
      }) as any,
      dimensions: 3072,
    },
    metadataLLM: {
      complete: (async (_msgs: any, opts: any): Promise<LLMResponse> => {
        llmTracker.enter();
        try {
          // Distinguish entity extraction (system prompt mentions "Extract distinct entities")
          // from metadata extraction. Both pay similar latency in real life.
          const isEntities = typeof opts?.systemPrompt === 'string' && opts.systemPrompt.includes('Extract distinct entities');
          await sleep(isEntities ? ENTITY_LLM_LATENCY_MS : META_LLM_LATENCY_MS);
          if (isEntities) {
            return {
              content: JSON.stringify([
                { canonical_name: 'RAG', type: 'concept', aliases: ['retrieval-augmented generation'], confidence: 0.9, mentions: ['RAG'] },
                { canonical_name: 'pgvector', type: 'tool', aliases: [], confidence: 0.95, mentions: ['pgvector'] },
                { canonical_name: 'Anthropic', type: 'org', aliases: [], confidence: 0.9, mentions: ['Anthropic'] },
                { canonical_name: 'Haiku 4.5', type: 'tool', aliases: [], confidence: 0.85, mentions: ['Haiku'] },
                { canonical_name: 'Gemini', type: 'tool', aliases: [], confidence: 0.85, mentions: ['Gemini'] },
              ]),
              tokensUsed: { input: 100, output: 100, total: 200 },
            };
          }
          return {
            content: JSON.stringify({ title: 'Test Title', topics: ['testing'], tags: ['perf'], extracted_text: null }),
            tokensUsed: { input: 100, output: 50, total: 150 },
          };
        } finally { llmTracker.exit(); }
      }) as any,
    },
    mediaMetadataLLM: { complete: (async () => ({ content: '{}', tokensUsed: { input: 0, output: 0, total: 0 } })) as any },
    ragFastLLM: { complete: (async () => ({ content: 'ok', tokensUsed: { input: 0, output: 0, total: 0 } })) as any },
    ragDeepLLM: { complete: (async () => ({ content: 'ok', tokensUsed: { input: 0, output: 0, total: 0 } })) as any },
    queryDepthLLM: { complete: (async () => ({ content: '{"depth":"fast","reason":"x"}', tokensUsed: { input: 0, output: 0, total: 0 } })) as any },
    blobStorage: {
      upload: (async () => 'https://blob/file') as any,
      exists: (async () => false) as any,
      getUrl: (() => 'https://blob/file') as any,
      getReadSasUrl: ((u: string) => u) as any,
    },
    config: {
      apiKey: 'test', xaiApiKey: 'x', firecrawlApiKey: 'f', supadataApiKey: 's',
    } as any,
  };

  return { deps, embedTracker, llmTracker };
}

function chunkSizedText(targetChunks: number): string {
  // chunker uses ~500 tokens per chunk with sentence-boundary alignment.
  // approximateTokens = chars/4 → ~2000 chars per chunk to land near target.
  // Build distinct sentences so the chunker actually splits.
  const sentence = 'This is a sentence about RAG, pgvector, Anthropic Haiku 4.5, and Gemini, used to build out enough text to force chunking. ';
  const perChunk = 2200;
  const total = targetChunks * perChunk;
  let out = '';
  while (out.length < total) out += sentence;
  return out;
}

async function timeIngest(label: string, contentChunks: number): Promise<void> {
  const { deps, embedTracker, llmTracker } = makeDeps();
  const content = chunkSizedText(contentChunks);
  const t0 = Date.now();
  const result = await createContentItem(deps, { type: 'note', content, title: 'Bench note' });
  const elapsed = Date.now() - t0;

  const e = embedTracker.report();
  const l = llmTracker.report();

  // Sequential-equivalent: metadata (1500) + chunks*200 + entity-extract (1500)
  // + entityResolveSteps (each new entity does 1 embed in step 3 = ~5 * 200 = 1000)
  const seqEquiv = META_LLM_LATENCY_MS + result.chunkCount * EMBED_LATENCY_MS + ENTITY_LLM_LATENCY_MS + 5 * EMBED_LATENCY_MS;

  console.log(`\n=== ${label} ===`);
  console.log(`  chunks created      : ${result.chunkCount}`);
  console.log(`  embed calls (total) : ${e.total}    max-concurrent: ${e.max}`);
  console.log(`  llm calls   (total) : ${l.total}    max-concurrent: ${l.max}`);
  console.log(`  wall-clock          : ${elapsed} ms`);
  console.log(`  sequential baseline : ${seqEquiv} ms (theoretical)`);
  console.log(`  speedup vs seq      : ${(seqEquiv / elapsed).toFixed(2)}x`);
}

async function main() {
  console.log(`Latency model: embed=${EMBED_LATENCY_MS}ms, metadata-llm=${META_LLM_LATENCY_MS}ms, entity-llm=${ENTITY_LLM_LATENCY_MS}ms`);
  console.log(`Concurrency caps: EMBED=6, ENTITY_RESOLVE=6`);
  await timeIngest('1-chunk note (boundary case)', 1);
  await timeIngest('3-chunk note (typical YouTube transcript-ish)', 3);
  await timeIngest('8-chunk note (long YouTube / mid PDF)', 8);
  await timeIngest('30-chunk note (arXiv-scale PDF)', 30);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
