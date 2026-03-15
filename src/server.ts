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

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Open Brain v2 running on http://localhost:${info.port}`);
});
