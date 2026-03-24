// src/services/index.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/types.js';
import type { BlobStorage } from '../storage/blob.js';
import type { Config } from '../config.js';

export interface ServiceDeps {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;
  consolidationLLM: LLMProvider;
  retrievalLLM: LLMProvider;
  blobStorage: BlobStorage;
  config: Config;
}
