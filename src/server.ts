// src/server.ts — add at the VERY TOP, before all other imports
import appInsights from 'applicationinsights';

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  appInsights.setup()
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)  // tracks PostgreSQL, HTTP calls to Gemini/Anthropic
    .setAutoCollectConsole(true)
    .start();
}

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createDbClient } from './db/client.js';
import { GeminiEmbeddingProvider } from './providers/gemini-embedding.js';
import { GeminiLLMProvider } from './providers/gemini-llm.js';
import { AnthropicLLMProvider } from './providers/anthropic-llm.js';
import { createBlobStorage } from './storage/blob.js';
import { createApp } from './app.js';
import { startDueDateChecker, startDailyReport } from './notifications/due-date-checker.js';

const config = loadConfig();

const deps = {
  db: createDbClient(config.databaseUrl),
  embeddingProvider: new GeminiEmbeddingProvider(config.geminiApiKey),
  metadataLLM: new GeminiLLMProvider(config.geminiApiKey),
  consolidationLLM: new AnthropicLLMProvider(config.anthropicApiKey),
  retrievalLLM: new GeminiLLMProvider(config.geminiApiKey),
  blobStorage: createBlobStorage(config.azureStorageConnectionString, config.azureStorageContainer),
  config,
};

// Run migrations on startup (idempotent — safe to run every boot)
async function runMigrations() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // Use raw pool to avoid pgvector type registration (extension doesn't exist yet)
    const result = await deps.db.pool.query(
      "SELECT count(*) as count FROM pg_tables WHERE schemaname = 'public' AND tablename = 'captures'",
    );

    if (parseInt(result.rows[0].count) === 0) {
      console.log('Running database migration 001...');
      const migrationPath = join(__dirname, '..', 'migrations', '001_initial_schema.sql');
      const sql = readFileSync(migrationPath, 'utf-8');
      await deps.db.pool.query(sql);
      console.log('Migration 001 complete.');
    } else {
      console.log('Database tables already exist, checking for incremental migrations.');
    }

    // Migration 002: tags and source arrays
    // Idempotent: check if captures.tags column already exists before running
    const m002Check = await deps.db.pool.query(
      `SELECT count(*) as count FROM information_schema.columns
       WHERE table_name = 'captures' AND column_name = 'tags'`,
    );
    if (parseInt(m002Check.rows[0].count) === 0) {
      console.log('Running database migration 002...');
      const migrationPath = join(__dirname, '..', 'migrations', '002_tags_and_source_array.sql');
      const sql = readFileSync(migrationPath, 'utf-8');
      await deps.db.pool.query(sql);
      console.log('Migration 002 complete.');
    }

    // Migration 003: extracted_text column for media text extraction
    const m003Check = await deps.db.pool.query(
      `SELECT count(*) as count FROM information_schema.columns
       WHERE table_name = 'captures' AND column_name = 'extracted_text'`,
    );
    if (parseInt(m003Check.rows[0].count) === 0) {
      console.log('Running database migration 003...');
      const migrationPath = join(__dirname, '..', 'migrations', '003_extracted_text.sql');
      const sql = readFileSync(migrationPath, 'utf-8');
      await deps.db.pool.query(sql);
      console.log('Migration 003 complete.');
    }

    console.log('All migrations up to date.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

const app = createApp(deps);

runMigrations().then(() => {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Open Brain v2 running on http://localhost:${info.port}`);

    // Start background notification checkers
    startDueDateChecker({ db: deps.db, config });
    startDailyReport({ db: deps.db, config });
    console.log(`Due date checker and daily report started (timezone: ${config.timezone}, report at: ${config.dailyReportTime})`);
  });
});
