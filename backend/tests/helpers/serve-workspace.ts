// Isolated browser fixture: real PostgreSQL semantics and Azure Blob emulator.
// Run from repository root after starting Azurite, with OPEN_BRAIN_TEST_FIXTURE=1.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readFile, readdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { BlobServiceClient } from '@azure/storage-blob';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/app.js';
import { StubEmbeddingProvider, StubLLMProvider } from '../../src/providers/stub.js';
import { createBlobStorage } from '../../src/storage/blob.js';
import type { DbClient } from '../../src/db/client.js';
import type { ServiceDeps } from '../../src/services/index.js';

if (process.env.OPEN_BRAIN_TEST_FIXTURE !== '1') throw new Error('Only run with an explicit isolated-test opt-in.');
const directory = await mkdtemp(join(tmpdir(), 'open-brain-browser-'));
const pg = new PGlite(join(directory, 'db'), { extensions: { vector, uuid_ossp } });
const query = async (sql: string, params?: unknown[]) => {
  const result = await pg.query(sql, params);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
const db = {
  query, pool: { query },
  transaction: (fn: any) => pg.transaction(tx => fn({
    query: async (sql: string, params?: unknown[]) => {
      const result = await tx.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
  })),
} as unknown as DbClient;
for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
  await pg.exec(await readFile(join('migrations', file), 'utf8'));
}
const config = parse(await readFile('backend/.env.example'));
const connection = config.AZURE_STORAGE_CONNECTION_STRING;
if (!connection.includes('127.0.0.1:10010')) throw new Error('Fixture must use the local Azurite emulator.');
await BlobServiceClient.fromConnectionString(connection).getContainerClient(config.AZURE_STORAGE_CONTAINER).createIfNotExists();
const llm = new StubLLMProvider();
const deps = {
  db, config: { apiKey: config.OPEN_BRAIN_API_KEY, llmProvider: 'stub' },
  embeddingProvider: new StubEmbeddingProvider(), metadataLLM: llm, mediaMetadataLLM: llm,
  ragFastLLM: llm, ragDeepLLM: llm, queryDepthLLM: llm,
  blobStorage: createBlobStorage(connection, config.AZURE_STORAGE_CONTAINER),
} as unknown as ServiceDeps;
const server = serve({ fetch: createApp(deps).fetch, hostname: '127.0.0.1', port: 3001 },
  () => console.log(JSON.stringify({ fixtureUrl: 'http://127.0.0.1:3001', directory })));
process.on('SIGTERM', () => server.close(() => { void pg.close().then(() => process.exit()); }));
