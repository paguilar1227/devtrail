// tests/unit/app.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { runCapturePipeline } from '../../src/capture/pipeline.js';

// Mock all dependencies that app.ts will import
vi.mock('../../src/capture/pipeline.js', () => ({
  runCapturePipeline: vi.fn(),
}));

vi.mock('../../src/telegram/webhook.js', () => ({
  setupTelegramWebhook: vi.fn(),
}));

const mockRunCapturePipeline = vi.mocked(runCapturePipeline);

beforeEach(() => {
  mockRunCapturePipeline.mockReset();
});

describe('Hono app', () => {
  it('rejects requests without auth token', async () => {
    const app = createApp({} as any);

    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    });

    expect(res.status).toBe(401);
  });

  it('accepts requests with valid Bearer token', async () => {
    mockRunCapturePipeline.mockResolvedValueOnce({
      success: true,
      captureId: 'cap-1',
    });

    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn().mockResolvedValue([]), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
      config: { apiKey: 'test-key-123' },
    };

    const app = createApp(deps as any);
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'I love TypeScript', source: 'api' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.captureId).toBe('cap-1');
  });

  it('returns 409 for duplicate captures', async () => {
    mockRunCapturePipeline.mockResolvedValueOnce({
      success: false,
      reason: 'Semantic duplicate detected',
    });

    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn().mockResolvedValue([]), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
      config: { apiKey: 'test-key-123' },
    };

    const app = createApp(deps as any);
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'duplicate', source: 'api' }),
    });

    expect(res.status).toBe(409);
  });

  it('returns health check on GET /', async () => {
    const app = createApp({} as any);
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });
});
