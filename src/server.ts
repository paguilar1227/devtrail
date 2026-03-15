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
    // Use raw pool to avoid pgvector type registration (extension doesn't exist yet)
    const result = await deps.db.pool.query(
      "SELECT count(*) as count FROM pg_tables WHERE schemaname = 'public' AND tablename = 'captures'",
    );
    if (parseInt(result.rows[0].count) > 0) {
      console.log('Database tables already exist, skipping migration.');
      return;
    }

    console.log('Running database migration...');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(__dirname, '..', 'migrations', '001_initial_schema.sql');
    const sql = readFileSync(migrationPath, 'utf-8');

    // Split on semicolons and execute each statement (pg doesn't support multi-statement in one query)
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      await deps.db.pool.query(statement);
    }
    console.log('Database migration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

const app = createApp(deps);

runMigrations().then(() => {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Open Brain v2 running on http://localhost:${info.port}`);
  });
});
