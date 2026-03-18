// tests/integration/api.test.ts — Sections 1-10: REST API endpoints
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { runCapturePipeline } from '../../src/capture/pipeline.js';
import { runConsolidation } from '../../src/consolidation/runner.js';

// Mock modules
vi.mock('../../src/capture/pipeline.js', () => ({
  runCapturePipeline: vi.fn(),
}));

vi.mock('../../src/consolidation/runner.js', () => ({
  runConsolidation: vi.fn(),
}));

vi.mock('../../src/telegram/webhook.js', () => ({
  setupTelegramWebhook: vi.fn(),
}));

const mockRunCapturePipeline = vi.mocked(runCapturePipeline);
const mockRunConsolidation = vi.mocked(runConsolidation);

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db: {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
      close: vi.fn(),
    },
    embeddingProvider: { embed: vi.fn().mockResolvedValue([0.1, 0.2]), dimensions: 3072 },
    metadataLLM: { complete: vi.fn() },
    consolidationLLM: { complete: vi.fn() },
    retrievalLLM: { complete: vi.fn() },
    blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
    config: {
      apiKey: 'test-key-123',
      databaseUrl: 'postgres://localhost/test',
      azureStorageConnectionString: 'test',
      azureStorageContainer: 'test',
      geminiApiKey: 'test',
      anthropicApiKey: 'test',
      telegramBotToken: 'test:token',
      telegramWebhookSecret: 'webhook-secret',
      telegramChatId: '12345',
      port: 3000,
      nodeEnv: 'test',
      reviewMode: 'autonomous',
      dailyDigestEnabled: false,
      timezone: 'America/Chicago',
      dailyReportTime: '09:00',
    },
    ...overrides,
  } as unknown as AppDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Section 1: Health Check ────────────────────────────────────────────────

describe('Section 1: Health Check', () => {
  it('1.1 GET / returns 200 with correct body', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', service: 'open-brain-v2' });
  });

  it('1.2 GET / without auth header still returns 200', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});

// ─── Section 2: Authentication ──────────────────────────────────────────────

describe('Section 2: Authentication', () => {
  it('2.1 POST /api/v1/capture without Authorization returns 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('2.2 POST /api/v1/capture with wrong Bearer token returns 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-key',
      },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('2.3 POST /api/v1/capture with "Token xxx" (wrong format) returns 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Token test-key-123',
      },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('2.4 POST /api/v1/capture with correct Bearer token does not return 401', async () => {
    mockRunCapturePipeline.mockResolvedValueOnce({ success: true, captureId: 'cap-1' });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).not.toBe(401);
  });
});

// ─── Section 3: Rate Limiting ───────────────────────────────────────────────

describe('Section 3: Rate Limiting', () => {
  it('3.1 First 100 requests succeed', async () => {
    mockRunCapturePipeline.mockResolvedValue({ success: true, captureId: 'cap-1' });
    const app = createApp(makeDeps());
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key-123',
    };

    // Send 100 requests
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        app.request('/api/v1/capture', {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'test' }),
        }),
      ),
    );

    for (const res of results) {
      expect(res.status).not.toBe(429);
    }
  });

  it('3.2 101st request returns 429', async () => {
    mockRunCapturePipeline.mockResolvedValue({ success: true, captureId: 'cap-1' });
    const app = createApp(makeDeps());
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key-123',
    };

    // Send 100 requests first
    for (let i = 0; i < 100; i++) {
      await app.request('/api/v1/capture', {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'test' }),
      });
    }

    // 101st should be rate limited
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'test' }),
    });
    expect(res.status).toBe(429);
  });

  it('3.3 After 60s window, requests succeed again', async () => {
    mockRunCapturePipeline.mockResolvedValue({ success: true, captureId: 'cap-1' });
    const app = createApp(makeDeps());
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key-123',
    };

    const originalDateNow = Date.now;
    let mockTime = originalDateNow();

    try {
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

      // Exhaust rate limit
      for (let i = 0; i < 100; i++) {
        await app.request('/api/v1/capture', {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'test' }),
        });
      }

      // Verify we're rate limited
      let res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'test' }),
      });
      expect(res.status).toBe(429);

      // Advance time by 61 seconds
      mockTime += 61_000;

      // Should work again
      res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'test' }),
      });
      expect(res.status).not.toBe(429);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ─── Section 4: Capture Endpoint ────────────────────────────────────────────

describe('Section 4: Capture Endpoint', () => {
  it('4.1 Valid text capture returns 201 with captureId', async () => {
    mockRunCapturePipeline.mockResolvedValueOnce({ success: true, captureId: 'cap-abc' });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'I love TypeScript' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.captureId).toBe('cap-abc');
  });

  it('4.2 Missing content returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('4.3 Content not a string (number) returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it('4.4 Semantic duplicate returns 409', async () => {
    mockRunCapturePipeline.mockResolvedValueOnce({
      success: false,
      reason: 'Semantic duplicate detected (similarity: 0.980)',
    });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'duplicate content' }),
    });
    expect(res.status).toBe(409);
  });

  it('4.5 File hash duplicate returns 409', async () => {
    // Don't send file_urls — the pipeline handles hash dedup internally
    mockRunCapturePipeline.mockResolvedValueOnce({
      success: false,
      reason: 'Duplicate file(s) detected (exact hash match). Already captured.',
    });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'photo note' }),
    });
    expect(res.status).toBe(409);
  });

  it('4.6 file_urls downloads and captures (mock fetch)', async () => {
    // Mock global fetch for file download
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    }) as any;

    mockRunCapturePipeline.mockResolvedValueOnce({ success: true, captureId: 'cap-file' });
    const app = createApp(makeDeps());

    try {
      const res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-key-123',
        },
        body: JSON.stringify({ content: 'photo note', file_urls: ['https://example.com/photo.jpg'] }),
      });
      expect(res.status).toBe(201);
      // Verify pipeline was called with files
      expect(mockRunCapturePipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({ contentType: 'image/jpeg', filename: 'photo.jpg' }),
          ]),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('4.7 Unsupported file MIME returns 201 with warnings array', async () => {
    mockRunCapturePipeline.mockResolvedValueOnce({
      success: true,
      captureId: 'cap-warn',
      warnings: ['File "archive.zip" (application/zip): unsupported type for embedding, stored but not embedded.'],
    });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key-123',
      },
      body: JSON.stringify({ content: 'zip file', file_urls: [] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toBeDefined();
    expect(body.warnings).toHaveLength(1);
  });

  it('4.8 Unreachable file_url returns 400', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;

    const app = createApp(makeDeps());

    try {
      const res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-key-123',
        },
        body: JSON.stringify({ content: 'broken file', file_urls: ['https://broken.example.com/file.pdf'] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Failed to download file');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── Section 5: GET /api/v1/captures ────────────────────────────────────────

describe('Section 5: GET /api/v1/captures', () => {
  it('5.1 Returns captures as JSON array', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: '1', content: 'test', content_types: ['text'], file_urls: null, source: 'api', status: 'pending', created_at: new Date() },
        ],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/captures', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('1');
  });

  it('5.2 Respects limit query parameter', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    await app.request('/api/v1/captures?limit=5', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $1'),
      [5],
    );
  });
});

// ─── Section 6: GET /api/v1/facts ───────────────────────────────────────────

describe('Section 6: GET /api/v1/facts', () => {
  it('6.1 Returns facts as JSON array ordered by confidence', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: '1', content: 'fact one', category: 'preference', confidence: 0.9, origin: 'capture', review_status: 'approved' },
        ],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/facts', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ─── Section 7: GET /api/v1/insights ────────────────────────────────────────

describe('Section 7: GET /api/v1/insights', () => {
  it('7.1 Returns insights as JSON array', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '1', content: 'insight', category: 'health', confidence: 0.85 }],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/insights', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ─── Section 8: GET /api/v1/consolidation/logs ──────────────────────────────

describe('Section 8: GET /api/v1/consolidation/logs', () => {
  it('8.1 Returns consolidation logs as JSON array', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '1', status: 'success', captures_processed: 5, run_at: new Date() }],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/consolidation/logs', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ─── Section 9: GET /api/v1/reminders ───────────────────────────────────────

describe('Section 9: GET /api/v1/reminders', () => {
  it('9.1 Returns reminders as JSON array', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '1', content: 'buy milk', status: 'not_started', priority: 'P1' }],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/reminders', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('9.2 Filters by status query parameter', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    await app.request('/api/v1/reminders?status=in_progress', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('status = $1'),
      expect.arrayContaining(['in_progress']),
    );
  });

  it('9.3 Filters by project query parameter', async () => {
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    await app.request('/api/v1/reminders?project=work', {
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('project = $'),
      expect.arrayContaining(['work']),
    );
  });
});

// ─── Section 10: Consolidation Trigger ──────────────────────────────────────

describe('Section 10: Consolidation Trigger', () => {
  it('10.1 Mock successful consolidation returns 200 with log entry', async () => {
    mockRunConsolidation.mockResolvedValueOnce(undefined);
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '1', status: 'success', captures_processed: 3 }],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/consolidation/trigger', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(body.log).toBeDefined();
  });

  it('10.2 Mock no-op (nothing to process) returns 200 with no-op log', async () => {
    mockRunConsolidation.mockResolvedValueOnce(undefined);
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '1', status: 'no-op', captures_processed: 0 }],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/consolidation/trigger', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.log.status).toBe('no-op');
  });

  it('10.3 Mock consolidation throws returns 500 with error', async () => {
    mockRunConsolidation.mockRejectedValueOnce(new Error('LLM API down'));
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '1', status: 'failed' }],
      }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/consolidation/trigger', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test-key-123' },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toContain('LLM API down');
  });
});
