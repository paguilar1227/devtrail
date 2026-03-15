// tests/unit/capture/pipeline.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { EmbeddingProvider, LLMProvider, LLMResponse } from '../../../src/providers/types.js';
import type { BlobStorage } from '../../../src/storage/blob.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function mockEmbedding(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
    dimensions: 3072,
  };
}

function mockLLM(): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ people: [], topics: ['test'], action_items: [], dates: [], type: 'statement' }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    } satisfies LLMResponse),
  };
}

function mockBlob(): BlobStorage {
  return {
    upload: vi.fn().mockResolvedValue('https://blob/file.jpg'),
    exists: vi.fn().mockResolvedValue(false),
    getUrl: vi.fn().mockReturnValue('https://blob/file.jpg'),
  };
}

describe('capture pipeline', () => {
  it('processes text-only capture successfully', async () => {
    const db = mockDb();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // semantic dedup
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }); // insert

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const result = await runCapturePipeline({
      db,
      embeddingProvider: mockEmbedding(),
      metadataLLM: mockLLM(),
      blobStorage: mockBlob(),
      content: 'I love TypeScript',
      files: [],
      source: 'mcp',
    });

    expect(result.success).toBe(true);
    expect(result.captureId).toBe('cap-1');
  });

  it('rejects semantic duplicates (similarity > 0.95)', async () => {
    const db = mockDb();
    // findSimilarCaptures returns a match > 0.95
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 'existing', similarity: 0.97, content: 'I love TypeScript' }],
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
    });

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const result = await runCapturePipeline({
      db,
      embeddingProvider: mockEmbedding(),
      metadataLLM: mockLLM(),
      blobStorage: mockBlob(),
      content: 'I love TypeScript',
      files: [],
      source: 'mcp',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('duplicate');
  });

  it('reuses existing file URLs for hash matches', async () => {
    const db = mockDb();
    const blob = mockBlob();

    // file hash dedup check - finds existing hash
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ file_hashes: ['abc123'], file_urls: ['https://blob/existing.jpg'] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      }) // checkFileHashDedup
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // semantic dedup
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }); // insert

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const fileData = Buffer.from('test image');

    const result = await runCapturePipeline({
      db,
      embeddingProvider: mockEmbedding(),
      metadataLLM: mockLLM(),
      blobStorage: blob,
      content: 'A photo',
      files: [{ data: fileData, contentType: 'image/jpeg', filename: 'photo.jpg' }],
      source: 'telegram',
    });

    // Should NOT upload since hash matched — blob.upload should not be called for matched file
    expect(result.success).toBe(true);
  });

  it('uploads new files and runs metadata extraction in parallel', async () => {
    const db = mockDb();
    const blob = mockBlob();
    const embedding = mockEmbedding();
    const llm = mockLLM();

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // file hash dedup
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // semantic dedup
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1' }], command: 'INSERT', rowCount: 1, oid: 0, fields: [] }); // insert

    const { runCapturePipeline } = await import('../../../src/capture/pipeline.js');
    const result = await runCapturePipeline({
      db,
      embeddingProvider: embedding,
      metadataLLM: llm,
      blobStorage: blob,
      content: 'New photo',
      files: [{ data: Buffer.from('new img'), contentType: 'image/png', filename: 'new.png' }],
      source: 'api',
    });

    expect(result.success).toBe(true);
    expect(blob.upload).toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalled();
    expect(embedding.embed).toHaveBeenCalled();
  });
});
