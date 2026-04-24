/**
 * Backfill entity graph for existing content_items.
 *
 * Idempotent: runs buildGraphEdges on each content_item. Entity resolution
 * collapses duplicates via (canonical_name, type) / aliases / embedding
 * similarity, so repeated runs don't create duplicate entities.
 *
 * Skips items that already have any chunk_entities edges (assumed already
 * processed). Pass --force to re-run everything.
 *
 * Run:
 *   DATABASE_URL=... GEMINI_API_KEY=... ANTHROPIC_API_KEY=... \
 *     npx tsx scripts/backfill-entities.ts
 */

import { createDbClient } from '../src/db/client.js';
import { GeminiEmbeddingProvider } from '../src/providers/gemini-embedding.js';
import { AnthropicLLMProvider } from '../src/providers/anthropic-llm.js';
import { buildGraphEdges } from '../src/services/entities.js';
import { getChunksByContentItem } from '../src/db/chunks.js';
import type { ServiceDeps } from '../src/services/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!DATABASE_URL || !GEMINI_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('Required env: DATABASE_URL, GEMINI_API_KEY, ANTHROPIC_API_KEY');
  process.exit(1);
}

const FORCE = process.argv.includes('--force');

async function main() {
  const db = createDbClient(DATABASE_URL!);

  // Only the fields buildGraphEdges + its deps actually need.
  const deps: Pick<ServiceDeps, 'db' | 'embeddingProvider' | 'metadataLLM'> = {
    db,
    embeddingProvider: new GeminiEmbeddingProvider(GEMINI_API_KEY!),
    metadataLLM: new AnthropicLLMProvider(ANTHROPIC_API_KEY!, 'claude-haiku-4-5-20251001'),
  };

  const items = await db.query(
    `SELECT ci.id, ci.title, ci.content, ci.type,
            (SELECT COUNT(*) FROM chunk_entities ce
              JOIN chunks c ON c.id = ce.chunk_id
             WHERE c.content_item_id = ci.id) AS existing_edges
       FROM content_items ci
      WHERE ci.archived = false
        AND ci.content IS NOT NULL
      ORDER BY ci.created_at ASC`,
  );

  const total = items.rows.length;
  console.log(`Found ${total} content items.`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const startAll = Date.now();

  for (const row of items.rows) {
    const edgesExist = parseInt(row.existing_edges, 10) > 0;
    if (edgesExist && !FORCE) {
      skipped++;
      continue;
    }

    const started = Date.now();
    try {
      const chunks = await getChunksByContentItem(db, row.id);
      if (chunks.length === 0) {
        console.log(`  [${processed + skipped + failed + 1}/${total}] skip "${row.title}" — no chunks`);
        skipped++;
        continue;
      }
      const result = await buildGraphEdges(deps as ServiceDeps, row.content, chunks);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `  [${processed + skipped + failed + 1}/${total}] "${row.title}" — ` +
        `${result.entityCount} entities, ${result.edgeCount} edges (${elapsed}s)`,
      );
      processed++;
    } catch (err) {
      console.error(
        `  [${processed + skipped + failed + 1}/${total}] FAILED "${row.title}":`,
        err instanceof Error ? err.message : err,
      );
      failed++;
    }
  }

  const elapsedAll = ((Date.now() - startAll) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsedAll}s. processed=${processed}, skipped=${skipped}, failed=${failed}`);

  // Report totals
  const stats = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM entities) AS entity_count,
      (SELECT COUNT(*) FROM chunk_entities) AS edge_count
  `);
  console.log(`Graph now: ${stats.rows[0].entity_count} entities, ${stats.rows[0].edge_count} edges`);

  await db.close();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
