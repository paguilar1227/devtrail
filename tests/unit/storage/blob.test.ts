// tests/unit/storage/blob.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpload = vi.fn();
const mockGetProperties = vi.fn();
const mockGetBlockBlobClient = vi.fn(() => ({
  upload: mockUpload,
  getProperties: mockGetProperties,
  url: 'https://storage.blob.core.windows.net/container/test-file',
}));
const mockGetContainerClient = vi.fn(() => ({
  getBlockBlobClient: mockGetBlockBlobClient,
}));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: {
    fromConnectionString: vi.fn(() => ({
      getContainerClient: mockGetContainerClient,
    })),
  },
}));

describe('BlobStorage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads a file and returns the URL', async () => {
    mockUpload.mockResolvedValueOnce({});

    const { createBlobStorage } = await import('../../../src/storage/blob.js');
    const storage = createBlobStorage('conn-string', 'test-container');

    const url = await storage.upload('test-file.jpg', Buffer.from('data'), 'image/jpeg');
    expect(url).toContain('test-file');
    expect(mockUpload).toHaveBeenCalled();
  });

  it('checks if a blob exists', async () => {
    mockGetProperties.mockResolvedValueOnce({});

    const { createBlobStorage } = await import('../../../src/storage/blob.js');
    const storage = createBlobStorage('conn-string', 'test-container');

    const exists = await storage.exists('test-file.jpg');
    expect(exists).toBe(true);
  });

  it('returns false when blob does not exist', async () => {
    mockGetProperties.mockRejectedValueOnce({ statusCode: 404 });

    const { createBlobStorage } = await import('../../../src/storage/blob.js');
    const storage = createBlobStorage('conn-string', 'test-container');

    const exists = await storage.exists('missing.jpg');
    expect(exists).toBe(false);
  });
});
