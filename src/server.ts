import { serve } from '@hono/node-server';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createDbClient } from './db/client.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createBlobStorage } from './storage/blob.js';
import { GeminiEmbeddingProvider } from './providers/gemini-embedding.js';
import { GeminiLLMProvider } from './providers/gemini-llm.js';
import { AnthropicLLMProvider } from './providers/anthropic-llm.js';
import type { ServiceDeps } from './services/index.js';

const config = loadConfig();
const db = createDbClient(config.databaseUrl);

const deps: ServiceDeps = {
  db,
  embeddingProvider: new GeminiEmbeddingProvider(config.geminiApiKey),
  metadataLLM: new GeminiLLMProvider(config.geminiApiKey),
  ragLLM: new AnthropicLLMProvider(config.anthropicApiKey),
  blobStorage: createBlobStorage(config.azureStorageConnectionString, config.azureStorageContainer),
  config,
};

async function runMigrations(): Promise<void> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // Migration 001: initial schema
    const existsResult = await deps.db.pool.query(
      "SELECT count(*) as count FROM pg_tables WHERE schemaname = 'public' AND tablename = 'projects'",
    );
    if (parseInt(existsResult.rows[0].count) === 0) {
      console.log('Running migration 001...');
      const sql = readFileSync(join(__dirname, '..', 'migrations', '001_schema.sql'), 'utf-8');
      await deps.db.pool.query(sql);
      console.log('Migration 001 complete.');
    } else {
      console.log('Schema 001 already present.');
    }

    // Migration 002: source_url column for URL-ingested content
    const m002Check = await deps.db.pool.query(
      `SELECT count(*) as count FROM information_schema.columns
       WHERE table_name = 'content_items' AND column_name = 'source_url'`,
    );
    if (parseInt(m002Check.rows[0].count) === 0) {
      console.log('Running migration 002...');
      const sql = readFileSync(join(__dirname, '..', 'migrations', '002_source_url.sql'), 'utf-8');
      await deps.db.pool.query(sql);
      console.log('Migration 002 complete.');
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
    console.log(`Open Brain v2 listening on port ${info.port}`);
  });
});
