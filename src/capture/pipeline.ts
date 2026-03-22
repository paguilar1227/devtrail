// src/capture/pipeline.ts
import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/types.js';
import type { BlobStorage } from '../storage/blob.js';
import { insertCapture } from '../db/captures.js';
import { computeFileHash, checkFileHashDedup, checkSemanticDedup } from './dedup.js';
import { extractMetadata } from './metadata.js';
import { convertForEmbedding } from './media-convert.js';
import { validateTags } from './tags.js';

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
  source: string[];
  tags?: string[];
}

export interface PipelineResult {
  success: boolean;
  captureId?: string;
  reason?: string;
  warnings?: string[];
}

export async function runCapturePipeline(input: PipelineInput): Promise<PipelineResult> {
  const { db, embeddingProvider, metadataLLM, blobStorage, content, files, source } = input;
  const validTags = input.tags ? validateTags(input.tags) : null;

  // Step 1: Compute file hashes
  const fileHashes = files.map((f) => computeFileHash(f.data));
  const contentTypes = files.length > 0
    ? files.map((f) => f.contentType.split('/')[0]) // 'image/jpeg' → 'image'
    : ['text'];

  // Step 2: File hash check — if ALL files already exist with the same hashes,
  // this is a duplicate upload. Block it. (Same file bytes = same document.)
  // If only SOME match, reuse existing URLs for those and upload the new ones.
  let existingUrls = new Map<string, string>();
  if (fileHashes.length > 0) {
    console.log(`[pipeline] File hashes: ${fileHashes.join(', ')}`);
    existingUrls = await checkFileHashDedup(db, fileHashes);
    console.log(`[pipeline] Existing hash matches: ${existingUrls.size} of ${fileHashes.length}`);
    const allFilesExist = fileHashes.every((h) => existingUrls.has(h));
    if (allFilesExist) {
      return {
        success: false,
        reason: `Duplicate file(s) detected (exact hash match). Already captured.`,
      };
    }
  }

  // Step 3: Convert files to Gemini-supported MIME types, then generate embedding
  // NOTE: conversion happens AFTER hash check so we always hash the original bytes.
  //       The original file (not converted) is what gets uploaded to blob storage.
  const warnings: string[] = [];
  const embeddingFiles = files.length > 0
    ? await Promise.all(
        files.map(async (f) => {
          try {
            const converted = await convertForEmbedding(f.data, f.contentType);
            // If ffmpeg wasn't available the returned buffer is empty — skip that file
            if (converted.data.length === 0) {
              warnings.push(`File "${f.filename}" (${f.contentType}): conversion failed, stored but not embedded.`);
              return null;
            }
            return { data: converted.data, mimeType: converted.mimeType };
          } catch {
            // Unsupported type — skip embedding this file, embed text only
            warnings.push(`File "${f.filename}" (${f.contentType}): unsupported type for embedding, stored but not embedded.`);
            return null;
          }
        }),
      ).then((results) => {
        const valid = results.filter((r): r is { data: Buffer; mimeType: string } => r !== null);
        return valid.length > 0 ? valid : undefined;
      })
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

  // Step 7: Determine final tags — caller-provided tags win; fall back to LLM-extracted tags
  const finalTags = (validTags && validTags.length > 0) ? validTags : metadata.tags ?? [];

  // Step 8: Insert into captures table
  const result = await insertCapture(db, {
    content,
    contentTypes,
    fileUrls: fileUrls.length > 0 ? fileUrls : null,
    fileHashes: fileHashes.length > 0 ? fileHashes : null,
    embedding,
    metadata: metadata as unknown as Record<string, unknown>,
    source,
    tags: finalTags,
  });

  return { success: true, captureId: result.id, warnings: warnings.length > 0 ? warnings : undefined };
}
