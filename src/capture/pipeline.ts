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

  const fileSummary = files.length > 0
    ? files.map((f) => `${f.filename} (${f.contentType}, ${(f.data.length / 1024).toFixed(1)} KB)`).join(', ')
    : 'none';
  console.log(`[pipeline] Starting — source: [${source}], content: ${content.length} chars, files: ${files.length} [${fileSummary}], caller tags: ${validTags ? `[${validTags.join(', ')}]` : 'none'}`);

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
  const convertedFiles = files.length > 0
    ? await Promise.all(
        files.map(async (f) => {
          try {
            const converted = await convertForEmbedding(f.data, f.contentType);
            // If ffmpeg wasn't available the returned buffer is empty — skip that file
            if (converted.data.length === 0) {
              console.warn(`[pipeline] Conversion produced empty buffer — ${f.filename} (${f.contentType}), skipping embed`);
              warnings.push(`File "${f.filename}" (${f.contentType}): conversion failed, stored but not embedded.`);
              return null;
            }
            console.log(`[pipeline] Converted ${f.filename}: ${f.contentType} → ${converted.mimeType} (${(f.data.length / 1024).toFixed(1)} KB → ${(converted.data.length / 1024).toFixed(1)} KB)`);
            return { data: converted.data, mimeType: converted.mimeType };
          } catch (err) {
            // Unsupported type — skip embedding this file, embed text only
            console.warn(`[pipeline] Conversion failed — ${f.filename} (${f.contentType}): ${err instanceof Error ? err.message : err}`);
            warnings.push(`File "${f.filename}" (${f.contentType}): unsupported type for embedding, stored but not embedded.`);
            return null;
          }
        }),
      ).then((results) => {
        const valid = results.filter((r): r is { data: Buffer; mimeType: string } => r !== null);
        return valid.length > 0 ? valid : undefined;
      })
    : undefined;

  // Step 4: Upload files + Extract metadata (in parallel)
  // Only send visual files (images, PDFs) to metadata extraction — audio/video content
  // is already captured as text (transcription/summary) so re-analyzing wastes tokens.
  const metadataFiles = convertedFiles?.filter((f) =>
    f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf',
  );
  const metadataFilesOrUndef = metadataFiles && metadataFiles.length > 0 ? metadataFiles : undefined;
  if (convertedFiles && metadataFiles) {
    const skipped = convertedFiles.length - metadataFiles.length;
    if (skipped > 0) console.log(`[pipeline] Skipping ${skipped} audio/video file(s) from metadata extraction (content already has transcription)`);
  }

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
    // Extract metadata + text from content and visual files only
    extractMetadata(metadataLLM, content, metadataFilesOrUndef),
  ]);

  // Step 5: Generate embedding — include extracted_text so the vector captures media content
  const embeddingText = metadata.extracted_text
    ? `${content}\n\n${metadata.extracted_text}`
    : content;
  console.log(`[pipeline] Embedding text length: ${embeddingText.length} (content: ${content.length}${metadata.extracted_text ? `, extracted: ${metadata.extracted_text.length}` : ''}), files for embed: ${convertedFiles?.length ?? 0}`);
  const embedding = await embeddingProvider.embed(embeddingText, convertedFiles);

  // Step 6: Semantic dedup check (against ALL captures)
  const dedup = await checkSemanticDedup(db, embedding);
  if (dedup.isDuplicate) {
    console.log(`[pipeline] Semantic duplicate — similarity: ${dedup.similarity?.toFixed(3)}, existing: ${dedup.existingId}`);
    return {
      success: false,
      reason: `Semantic duplicate detected (similarity: ${dedup.similarity?.toFixed(3)}). Existing capture: ${dedup.existingId}`,
    };
  }

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
    extractedText: metadata.extracted_text,
  });

  console.log(`[pipeline] Captured ${result.id} — source: [${source}], tags: [${finalTags.join(', ')}], files: ${fileUrls.length}, extracted_text: ${metadata.extracted_text ? `${metadata.extracted_text.length} chars` : 'null'}`);
  return { success: true, captureId: result.id, warnings: warnings.length > 0 ? warnings : undefined };
}
