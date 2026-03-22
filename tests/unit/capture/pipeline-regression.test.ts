// tests/unit/capture/pipeline-regression.test.ts — Section 11: Pipeline regressions
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCapturePipeline, type PipelineInput } from '../../../src/capture/pipeline.js';
import { computeFileHash } from '../../../src/capture/dedup.js';

// Mock sub-modules
vi.mock('../../../src/db/captures.js', () => ({
  insertCapture: vi.fn().mockResolvedValue({ id: 'cap-123' }),
  findSimilarCaptures: vi.fn().mockResolvedValue([]),
  findCapturesByHashes: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/capture/metadata.js', () => ({
  extractMetadata: vi.fn().mockResolvedValue({
    people: [],
    topics: ['test'],
    action_items: [],
    dates: [],
    type: 'statement',
    tags: [],
  }),
}));

vi.mock('../../../src/capture/media-convert.js', () => ({
  convertForEmbedding: vi.fn().mockResolvedValue({
    data: Buffer.from('converted'),
    mimeType: 'image/jpeg',
    originalMimeType: 'image/jpeg',
  }),
}));

import { insertCapture, findSimilarCaptures, findCapturesByHashes } from '../../../src/db/captures.js';
import { extractMetadata } from '../../../src/capture/metadata.js';
import { convertForEmbedding } from '../../../src/capture/media-convert.js';

const mockInsertCapture = vi.mocked(insertCapture);
const mockFindSimilarCaptures = vi.mocked(findSimilarCaptures);
const mockFindCapturesByHashes = vi.mocked(findCapturesByHashes);
const mockExtractMetadata = vi.mocked(extractMetadata);
const mockConvertForEmbedding = vi.mocked(convertForEmbedding);

function makeInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() } as any,
    embeddingProvider: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), dimensions: 3072 },
    metadataLLM: { complete: vi.fn() },
    blobStorage: {
      upload: vi.fn().mockResolvedValue('https://blob.example.com/file'),
      exists: vi.fn(),
      getUrl: vi.fn(),
    },
    content: 'Test capture',
    files: [],
    source: 'api',
    ...overrides,
  } as unknown as PipelineInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertCapture.mockResolvedValue({ id: 'cap-123' });
  mockFindSimilarCaptures.mockResolvedValue([]);
  mockFindCapturesByHashes.mockResolvedValue([]);
  mockConvertForEmbedding.mockResolvedValue({
    data: Buffer.from('converted'),
    mimeType: 'image/jpeg',
    originalMimeType: 'image/jpeg',
  });
});

describe('Section 11: Pipeline Regressions', () => {
  it('11.1 Text-only: calls embed + extractMetadata + insertCapture', async () => {
    const input = makeInput();
    const result = await runCapturePipeline(input);

    expect(result.success).toBe(true);
    expect(input.embeddingProvider.embed).toHaveBeenCalledWith('Test capture', undefined);
    expect(mockExtractMetadata).toHaveBeenCalledWith(input.metadataLLM, 'Test capture');
    expect(mockInsertCapture).toHaveBeenCalled();
  });

  it('11.2 computeFileHash returns SHA-256 hex', () => {
    const hash = computeFileHash(Buffer.from('hello'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // SHA-256 of "hello"
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('11.3 All file hashes match existing → returns {success: false}', async () => {
    const fileData = Buffer.from('existing-file-data');
    const hash = computeFileHash(fileData);

    mockFindCapturesByHashes.mockResolvedValueOnce([
      { file_hashes: [hash], file_urls: ['https://blob.example.com/existing'] },
    ]);

    const input = makeInput({
      files: [{ data: fileData, contentType: 'image/jpeg', filename: 'photo.jpg' }],
    });

    const result = await runCapturePipeline(input);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Duplicate file(s)');
  });

  it('11.4 Some file hashes match → capture succeeds, reuses URLs for matched', async () => {
    const existingData = Buffer.from('existing');
    const newData = Buffer.from('new-file');
    const existingHash = computeFileHash(existingData);

    mockFindCapturesByHashes.mockResolvedValueOnce([
      { file_hashes: [existingHash], file_urls: ['https://blob.example.com/existing'] },
    ]);

    const input = makeInput({
      files: [
        { data: existingData, contentType: 'image/jpeg', filename: 'old.jpg' },
        { data: newData, contentType: 'image/png', filename: 'new.png' },
      ],
    });

    const result = await runCapturePipeline(input);
    expect(result.success).toBe(true);
    // The existing file should NOT be re-uploaded (blobStorage.upload called once for new file)
    expect(input.blobStorage.upload).toHaveBeenCalledTimes(1);
  });

  it('11.5 Similarity > 0.95 → returns {success: false}', async () => {
    mockFindSimilarCaptures.mockResolvedValueOnce([
      { id: 'existing-cap', similarity: 0.98, content: 'similar', content_types: ['text'], file_urls: null, file_hashes: null, embedding: [], metadata: {}, source: 'api', status: 'pending', archived: false, created_at: new Date(), updated_at: new Date() },
    ]);

    const input = makeInput();
    const result = await runCapturePipeline(input);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Semantic duplicate');
  });

  it('11.6 Similarity <= 0.95 → proceeds', async () => {
    mockFindSimilarCaptures.mockResolvedValueOnce([]);
    const input = makeInput();
    const result = await runCapturePipeline(input);
    expect(result.success).toBe(true);
  });

  it('11.7 Unsupported MIME → capture succeeds with warnings', async () => {
    mockConvertForEmbedding.mockRejectedValueOnce(
      new Error('Unsupported MIME type for embedding: application/zip'),
    );

    const input = makeInput({
      files: [{ data: Buffer.from('zip'), contentType: 'application/zip', filename: 'archive.zip' }],
    });

    const result = await runCapturePipeline(input);
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('unsupported type');
  });

  it('11.8 convertForEmbedding throws → capture succeeds with warnings, text-only embed', async () => {
    mockConvertForEmbedding.mockRejectedValueOnce(new Error('conversion failed'));

    const input = makeInput({
      files: [{ data: Buffer.from('bad-audio'), contentType: 'audio/flac', filename: 'test.flac' }],
    });

    const result = await runCapturePipeline(input);
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    // Embed should have been called with text only (no files)
    expect(input.embeddingProvider.embed).toHaveBeenCalledWith('Test capture', undefined);
  });

  it('11.9 File upload and metadata extraction happen in parallel (both called)', async () => {
    const input = makeInput({
      files: [{ data: Buffer.from('photo-data'), contentType: 'image/jpeg', filename: 'photo.jpg' }],
    });

    const result = await runCapturePipeline(input);
    expect(result.success).toBe(true);
    // Both should have been called
    expect(input.blobStorage.upload).toHaveBeenCalled();
    expect(mockExtractMetadata).toHaveBeenCalled();
  });

  it('11.10 Warnings array populated when files cant be embedded', async () => {
    // Return empty buffer (simulating ffmpeg not available)
    mockConvertForEmbedding.mockResolvedValueOnce({
      data: Buffer.alloc(0),
      mimeType: 'audio/wav',
      originalMimeType: 'audio/ogg',
    });

    const input = makeInput({
      files: [{ data: Buffer.from('audio-data'), contentType: 'audio/ogg', filename: 'voice.ogg' }],
    });

    const result = await runCapturePipeline(input);
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('conversion failed');
  });

  it('11.11 Caller-provided valid tags are stored (bypass metadata tags)', async () => {
    mockExtractMetadata.mockResolvedValueOnce({
      people: [], topics: [], action_items: [], dates: [], type: 'statement', tags: ['skill'],
    });

    const input = makeInput({ tags: ['preference', 'goal'] });
    const result = await runCapturePipeline(input);

    expect(result.success).toBe(true);
    expect(mockInsertCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: ['preference', 'goal'] }),
    );
  });

  it('11.12 No caller tags → uses tags from metadata extraction', async () => {
    mockExtractMetadata.mockResolvedValueOnce({
      people: [], topics: [], action_items: [], dates: [], type: 'statement', tags: ['skill', 'interest'],
    });

    const input = makeInput(); // no tags field
    const result = await runCapturePipeline(input);

    expect(result.success).toBe(true);
    expect(mockInsertCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: ['skill', 'interest'] }),
    );
  });

  it('11.13 Empty caller tags array → falls back to metadata tags', async () => {
    mockExtractMetadata.mockResolvedValueOnce({
      people: [], topics: [], action_items: [], dates: [], type: 'statement', tags: ['decision'],
    });

    const input = makeInput({ tags: [] });
    const result = await runCapturePipeline(input);

    expect(result.success).toBe(true);
    expect(mockInsertCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: ['decision'] }),
    );
  });
});
