import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/types.js';
import type { BlobStorage } from '../storage/blob.js';
import type { Config } from '../config.js';

export interface ServiceDeps {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;    // Gemini Flash for metadata + title generation
  ragLLM: LLMProvider;          // Claude Opus for RAG synthesis (REST /rag endpoint)
  blobStorage: BlobStorage;
  config: Config;
}
