// src/capture/pipeline.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/types.js';
import type { BlobStorage } from '../storage/blob.js';
import { insertCapture } from '../db/captures.js';
import { computeFileHash, checkFileHashDedup, checkSemanticDedup } from './dedup.js';
import { extractMetadata } from './metadata.js';

export interface FileInput {
  data: Buffer;
  contentType: string;
  filename: string;
}

export interface PipelineInput {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;
  blobStorage: BlobStorage;
  content: string;
  files: FileInput[];
  source: string;
}

export interface PipelineResult {
  success: boolean;
  captureId?: string;
  reason?: string;
}

export async function runCapturePipeline(input: PipelineInput): Promise<PipelineResult> {
  const { db, embeddingProvider, metadataLLM, blobStorage, content, files, source } = input;

  // Step 1: Compute file hashes
  const fileHashes = files.map((f) => computeFileHash(f.data));
  const contentTypes = files.length > 0
    ? files.map((f) => f.contentType.split('/')[0]) // 'image/jpeg' → 'image'
    : ['text'];

  // Step 2: File hash check (storage optimization — reuse existing URLs)
  let existingUrls = new Map<string, string>();
  if (fileHashes.length > 0) {
    existingUrls = await checkFileHashDedup(db, fileHashes);
  }

  // Step 3: Generate embedding (from text + file bytes together)
  const embeddingFiles = files.length > 0
    ? files.map((f) => ({ data: f.data, mimeType: f.contentType }))
    : undefined;
  const embedding = await embeddingProvider.embed(content, embeddingFiles);

  // Step 4: Semantic dedup check (against ALL captures)
  const dedup = await checkSemanticDedup(db, embedding);
  if (dedup.isDuplicate) {
    return {
      success: false,
      reason: `Semantic duplicate detected (similarity: ${dedup.similarity?.toFixed(3)}). Existing capture: ${dedup.existingId}`,
    };
  }

  // Steps 5 & 6: Upload files + Extract metadata (in parallel)
  const [fileUrls, metadata] = await Promise.all([
    // Upload files that don't already exist
    Promise.all(
      files.map(async (file, i) => {
        const hash = fileHashes[i];
        if (existingUrls.has(hash)) {
          return existingUrls.get(hash)!;
        }
        const blobName = `${Date.now()}-${file.filename}`;
        return blobStorage.upload(blobName, file.data, file.contentType);
      }),
    ),
    // Extract metadata
    extractMetadata(metadataLLM, content),
  ]);

  // Step 7: Insert into captures table
  const result = await insertCapture(db, {
    content,
    contentTypes,
    fileUrls: fileUrls.length > 0 ? fileUrls : null,
    fileHashes: fileHashes.length > 0 ? fileHashes : null,
    embedding,
    metadata: metadata as unknown as Record<string, unknown>,
    source,
  });

  return { success: true, captureId: result.id };
}
