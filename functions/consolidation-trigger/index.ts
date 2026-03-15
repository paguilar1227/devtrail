import { loadConfig } from '../../src/config.js';
import { createDbClient } from '../../src/db/client.js';
import { GeminiEmbeddingProvider } from '../../src/providers/gemini-embedding.js';
import { AnthropicLLMProvider } from '../../src/providers/anthropic-llm.js';
import { runConsolidation } from '../../src/consolidation/runner.js';

export default async function timerTrigger(): Promise<void> {
  const config = loadConfig();
  const db = createDbClient(config.databaseUrl);

  try {
    await runConsolidation({
      db,
      consolidationLLM: new AnthropicLLMProvider(config.anthropicApiKey),
      embeddingProvider: new GeminiEmbeddingProvider(config.geminiApiKey),
      reviewMode: config.reviewMode,
    });
  } finally {
    await db.close();
  }
}
