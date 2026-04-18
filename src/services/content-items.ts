import { createHash } from 'crypto';
import type { ServiceDeps } from './index.js';
import {
  insertContentItem, listContentItems as dbListContentItems,
  getContentItemById, updateContentItem as dbUpdate,
  archiveContentItem, unarchiveContentItem,
  deleteContentItemHard,
  findByFileHash,
  type ContentItemRow, type ContentType, type ListContentItemsFilters,
} from '../db/content-items.js';
import { insertChunks, deleteChunksByContentItem, type ChunkInsert, type ChunkType } from '../db/chunks.js';
import { extractMetadata } from '../capture/metadata.js';
import { chunkText, approximateTokens } from '../capture/chunker.js';

export interface CreateContentInput {
  type: ContentType;
  content?: string;            // text content (notes, or extracted text for documents)
  title?: string;              // optional — auto-generated if missing
  file?: {                     // optional file (for documents or note with embedded media)
    data: Buffer;
    mimeType: string;
    filename: string;
  };
  projectIds?: string[];
  tags?: string[];
  sourceUrl?: string;          // optional — set for URL-ingested content
}

export interface CreateContentResult {
  id: string;
  title: string;
  chunkCount: number;
  warnings?: string[];
}

/**
 * Create a content item (document or note) and chunk it for search.
 *
 * Pipeline:
 *   1. File hash dedup (if file provided)
 *   2. Upload file to blob storage (if file)
 *   3. Extract metadata via Gemini Flash (title, tags, topics, extracted_text)
 *   4. Determine final content text (user content + extracted_text)
 *   5. Chunk text (500/100 with sentence-boundary alignment)
 *   6. Embed each chunk
 *   7. Insert content_item with whole-item embedding for docs with media
 *   8. Insert chunks
 */
export async function createContentItem(
  deps: ServiceDeps,
  input: CreateContentInput,
): Promise<CreateContentResult> {
  const warnings: string[] = [];

  // Step 1: dedup by file hash
  let fileHash: string | null = null;
  let blobUrl: string | null = null;
  if (input.file) {
    fileHash = createHash('sha256').update(input.file.data).digest('hex');
    console.log(`[content] File hash: ${fileHash}`);

    const existing = await findByFileHash(deps.db, fileHash);
    if (existing) {
      console.log(`[content] Duplicate file detected, returning existing: ${existing.id}`);
      return { id: existing.id, title: existing.title, chunkCount: 0, warnings: ['Duplicate file — returning existing item.'] };
    }
  }

  // Step 2: upload blob (if file)
  if (input.file) {
    const blobName = `${Date.now()}-${input.file.filename}`;
    blobUrl = await deps.blobStorage.upload(blobName, input.file.data, input.file.mimeType);
    console.log(`[content] Uploaded to blob: ${blobUrl}`);
  }

  // Step 3: metadata extraction (includes title + extracted_text from media)
  const filesForMeta = input.file ? [{ data: input.file.data, mimeType: input.file.mimeType }] : undefined;
  const metadata = await extractMetadata(deps.metadataLLM, input.content ?? '', filesForMeta);

  // Step 4: final text (what gets chunked and embedded)
  const parts: string[] = [];
  if (input.content) parts.push(input.content);
  if (metadata.extracted_text) parts.push(metadata.extracted_text);
  const fullText = parts.join('\n\n').trim();

  // Step 5: resolve title and tags
  const title = input.title?.trim() || metadata.title || 'Untitled';
  const titleSource = input.title?.trim() ? 'user' : (input.file ? 'filename' : 'ai_generated');
  const finalTags = input.tags && input.tags.length > 0
    ? input.tags
    : metadata.tags;

  // Step 6: whole-item embedding (for hybrid search on docs with media)
  let wholeItemEmbedding: number[] | null = null;
  const shouldWholeEmbed = input.type === 'document' && input.file;
  if (shouldWholeEmbed) {
    try {
      wholeItemEmbedding = await deps.embeddingProvider.embed(
        fullText || metadata.title,
        input.file ? [{ data: input.file.data, mimeType: input.file.mimeType }] : undefined,
      );
    } catch (err) {
      console.warn(`[content] Whole-item multimodal embedding failed, skipping:`, err);
      warnings.push('Whole-item embedding failed; relying on chunks only.');
    }
  }

  // Step 7: insert content_item
  const inserted = await insertContentItem(deps.db, {
    type: input.type,
    title,
    titleSource: titleSource as 'user' | 'ai_generated' | 'filename',
    content: fullText || null,
    blobUrl,
    mimeType: input.file?.mimeType ?? null,
    fileHash,
    projectIds: input.projectIds ?? [],
    tags: finalTags,
    embedding: wholeItemEmbedding,
    metadata: {
      topics: metadata.topics,
      filename: input.file?.filename,
    },
    sourceUrl: input.sourceUrl ?? null,
  });

  // Step 8: chunk the text and embed each chunk
  let chunkCount = 0;
  if (fullText) {
    const textChunks = chunkText(fullText);
    console.log(`[content] Split into ${textChunks.length} text chunk(s) — total tokens ~${approximateTokens(fullText)}`);

    const chunksToInsert: ChunkInsert[] = [];
    for (let i = 0; i < textChunks.length; i++) {
      const chunkEmbedding = await deps.embeddingProvider.embed(textChunks[i]);
      chunksToInsert.push({
        contentItemId: inserted.id,
        chunkIndex: i,
        chunkType: 'text' as ChunkType,
        content: textChunks[i],
        embedding: chunkEmbedding,
        metadata: { token_estimate: approximateTokens(textChunks[i]) },
      });
    }
    await insertChunks(deps.db, chunksToInsert);
    chunkCount = chunksToInsert.length;
  } else if (input.file && input.type === 'document') {
    // Pure image/media document with no extracted text — store one "image" chunk using the whole-item embedding
    if (wholeItemEmbedding) {
      await insertChunks(deps.db, [{
        contentItemId: inserted.id,
        chunkIndex: 0,
        chunkType: 'image' as ChunkType,
        content: null,
        embedding: wholeItemEmbedding,
        metadata: { mime_type: input.file.mimeType },
      }]);
      chunkCount = 1;
    }
  }

  console.log(`[content] Created ${input.type} ${inserted.id} — title: "${title}", chunks: ${chunkCount}`);
  return {
    id: inserted.id,
    title,
    chunkCount,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function listContentItems(
  deps: ServiceDeps,
  filters: ListContentItemsFilters = {},
): Promise<ContentItemRow[]> {
  return dbListContentItems(deps.db, filters);
}

export async function getContentItem(deps: ServiceDeps, id: string): Promise<ContentItemRow | null> {
  return getContentItemById(deps.db, id);
}

export async function updateContentItem(
  deps: ServiceDeps,
  id: string,
  patch: {
    title?: string;
    content?: string;
    projectIds?: string[];
    tags?: string[];
  },
): Promise<ContentItemRow | null> {
  // If content changed, we'd need to re-chunk. For v1, keep it simple: chunks are immutable.
  // TODO: re-chunk on content update (future work).
  if (patch.content !== undefined) {
    // Delete old chunks, re-chunk new content
    await deleteChunksByContentItem(deps.db, id);
    if (patch.content) {
      const textChunks = chunkText(patch.content);
      const chunks: ChunkInsert[] = [];
      for (let i = 0; i < textChunks.length; i++) {
        const embedding = await deps.embeddingProvider.embed(textChunks[i]);
        chunks.push({
          contentItemId: id,
          chunkIndex: i,
          chunkType: 'text' as ChunkType,
          content: textChunks[i],
          embedding,
          metadata: { token_estimate: approximateTokens(textChunks[i]) },
        });
      }
      await insertChunks(deps.db, chunks);
    }
  }
  return dbUpdate(deps.db, id, {
    title: patch.title,
    content: patch.content,
    projectIds: patch.projectIds,
    tags: patch.tags,
  });
}

export async function archiveContentItemById(deps: ServiceDeps, id: string): Promise<void> {
  await archiveContentItem(deps.db, id);
}

export async function unarchiveContentItemById(deps: ServiceDeps, id: string): Promise<void> {
  await unarchiveContentItem(deps.db, id);
}

/** Hard delete a content item. Chunks cascade via FK. Does NOT remove blob storage files. */
export async function deleteContentItemHardById(deps: ServiceDeps, id: string): Promise<void> {
  await deleteContentItemHard(deps.db, id);
}
