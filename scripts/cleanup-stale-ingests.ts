/**
 * Cleanup stale URL-ingest rows from the pre-fix pipeline era.
 *
 * Targets:
 *   1. Documents with a PDF-like source_url AND title='Untitled' (pdf-parse
 *      import was broken, so PDFs saved via url-ingest got stubbed out)
 *   2. All documents sourced from x.com / twitter.com (possibly duplicated;
 *      delete so a fresh save can settle the duplication question)
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/cleanup-stale-ingests.ts            # dry-run
 *   DATABASE_URL=... npx tsx scripts/cleanup-stale-ingests.ts --execute  # actually delete
 */

import { createDbClient } from '../backend/src/db/client.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL env var required');
  process.exit(1);
}

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const db = createDbClient(DATABASE_URL!);

  // Broken PDFs: saved as application/pdf but Flash couldn't title them.
  const pdfCandidates = await db.query(
    `SELECT id, title, source_url, created_at
       FROM content_items
      WHERE type = 'document' AND archived = false
        AND mime_type = 'application/pdf'
        AND title = 'Untitled'
      ORDER BY created_at DESC`,
  );

  // All X/Twitter rows — delete so a fresh save can settle the duplication question.
  const xCandidates = await db.query(
    `SELECT id, title, source_url, created_at
       FROM content_items
      WHERE type = 'document' AND archived = false
        AND (source_url ILIKE '%://x.com/%' OR source_url ILIKE '%://twitter.com/%')
      ORDER BY created_at DESC`,
  );

  // 404/placeholder stubs that slipped in before the HTTP-status guard shipped.
  const stubCandidates = await db.query(
    `SELECT id, title, source_url, created_at
       FROM content_items
      WHERE type = 'document' AND archived = false
        AND (
             title ILIKE '%doesnotexist%'
          OR title ILIKE '%does not exist%'
          OR title = 'Example Domain'
          OR source_url ILIKE '%ShouldNotExist%'
        )
      ORDER BY created_at DESC`,
  );

  const print = (label: string, rows: Array<Record<string, unknown>>) => {
    console.log(`\n=== ${label} ===`);
    for (const row of rows) {
      const ts = (row.created_at as Date).toISOString().slice(0, 19);
      console.log(`  ${row.id}  ${ts}  "${String(row.title).slice(0, 50)}"  ${row.source_url}`);
    }
    console.log(`Total: ${rows.length}`);
  };

  print('PDF candidates (mime=pdf, title=Untitled)', pdfCandidates.rows);
  print('X candidates (x.com / twitter.com)', xCandidates.rows);
  print('Stub candidates (404/placeholder titles)', stubCandidates.rows);

  const allIds = Array.from(new Set([
    ...pdfCandidates.rows.map((r) => r.id as string),
    ...xCandidates.rows.map((r) => r.id as string),
    ...stubCandidates.rows.map((r) => r.id as string),
  ]));
  console.log(`\nTotal rows to delete: ${allIds.length}`);

  if (!EXECUTE) {
    console.log('\nDry-run only. Re-run with --execute to delete.');
    await db.close();
    return;
  }

  if (allIds.length === 0) {
    console.log('\nNothing to delete.');
    await db.close();
    return;
  }

  console.log('\nExecuting delete...');
  const deleted = await db.query(
    `DELETE FROM content_items WHERE id = ANY($1::uuid[]) RETURNING id`,
    [allIds],
  );
  console.log(`Deleted ${deleted.rowCount} rows (chunks cascade via FK).`);

  await db.close();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
