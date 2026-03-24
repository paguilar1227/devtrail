// tests/integration/api.test.ts — REST API endpoint tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { runCapturePipeline } from '../../src/capture/pipeline.js';
import { runConsolidation } from '../../src/consolidation/runner.js';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../../src/capture/pipeline.js', () => ({
  runCapturePipeline: vi.fn(),
}));

vi.mock('../../src/consolidation/runner.js', () => ({
  runConsolidation: vi.fn(),
}));

vi.mock('../../src/telegram/webhook.js', () => ({
  setupTelegramWebhook: vi.fn(),
}));

// Mock all service modules so app.ts calls go to our vi.fn() stubs
vi.mock('../../src/services/captures.js', () => ({
  captureThought: vi.fn(),
  searchThoughts: vi.fn(),
  getCapture: vi.fn(),
  listCaptures: vi.fn(),
  archiveCapture: vi.fn(),
  unarchiveCapture: vi.fn(),
}));

vi.mock('../../src/services/facts.js', () => ({
  getFact: vi.fn(),
  listFacts: vi.fn(),
  updateFact: vi.fn(),
  archiveFact: vi.fn(),
  unarchiveFact: vi.fn(),
  reviewPendingFacts: vi.fn(),
  approveRejectFact: vi.fn(),
}));

vi.mock('../../src/services/insights.js', () => ({
  getInsight: vi.fn(),
  listInsights: vi.fn(),
  updateInsight: vi.fn(),
  archiveInsight: vi.fn(),
  unarchiveInsight: vi.fn(),
  reviewPendingInsights: vi.fn(),
  approveRejectInsight: vi.fn(),
}));

vi.mock('../../src/services/reminders.js', () => ({
  createReminder: vi.fn(),
  listReminders: vi.fn(),
  getReminder: vi.fn(),
  getReminderDetail: vi.fn(),
  updateReminder: vi.fn(),
  completeReminder: vi.fn(),
  deleteReminder: vi.fn(),
  reparentReminder: vi.fn(),
  listProjects: vi.fn(),
  findActiveReminders: vi.fn(),
  findAllReminders: vi.fn(),
  findSubtasks: vi.fn(),
  findRemindersDueOnDate: vi.fn(),
  findOverdueReminders: vi.fn(),
  findRecentlyCompletedReminders: vi.fn(),
  resolveReminderId: vi.fn(),
}));

vi.mock('../../src/services/comments.js', () => ({
  addComment: vi.fn(),
  listComments: vi.fn(),
  getComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock('../../src/services/profile.js', () => ({
  getUserProfile: vi.fn(),
  getBrainStats: vi.fn(),
}));

vi.mock('../../src/services/consolidation.js', () => ({
  runConsolidation: vi.fn(),
  getConsolidationLogs: vi.fn(),
}));

vi.mock('../../src/services/tags.js', () => ({
  updateTags: vi.fn(),
  getAllowedTags: vi.fn(),
}));

// ─── Typed references to mocked service functions ────────────────────────────

import * as capturesSvc from '../../src/services/captures.js';
import * as factsSvc from '../../src/services/facts.js';
import * as insightsSvc from '../../src/services/insights.js';
import * as remindersSvc from '../../src/services/reminders.js';
import * as commentsSvc from '../../src/services/comments.js';
import * as profileSvc from '../../src/services/profile.js';
import * as consolidationSvc from '../../src/services/consolidation.js';
import * as tagsSvc from '../../src/services/tags.js';

const mockRunCapturePipeline = vi.mocked(runCapturePipeline);
const mockRunConsolidation = vi.mocked(runConsolidation);

// ─── Shared helpers ──────────────────────────────────────────────────────────

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

const AUTH = { Authorization: 'Bearer test-key-123' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Section 1: Health Check ─────────────────────────────────────────────────

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

// ─── Section 2: Authentication ───────────────────────────────────────────────

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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('2.3 POST /api/v1/capture with "Token xxx" (wrong format) returns 401', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Token test-key-123' },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('2.4 POST /api/v1/capture with correct Bearer token does not return 401', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValueOnce({ captureId: 'cap-1' });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).not.toBe(401);
  });
});

// ─── Section 3: Rate Limiting ────────────────────────────────────────────────

describe('Section 3: Rate Limiting', () => {
  it('3.1 First 100 requests succeed', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValue({ captureId: 'cap-1' });
    const app = createApp(makeDeps());

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        app.request('/api/v1/capture', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ content: 'test' }),
        }),
      ),
    );

    for (const res of results) {
      expect(res.status).not.toBe(429);
    }
  });

  it('3.2 101st request returns 429', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValue({ captureId: 'cap-1' });
    const app = createApp(makeDeps());

    for (let i = 0; i < 100; i++) {
      await app.request('/api/v1/capture', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 'test' }),
      });
    }

    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'test' }),
    });
    expect(res.status).toBe(429);
  });

  it('3.3 After 60s window, requests succeed again', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValue({ captureId: 'cap-1' });
    const app = createApp(makeDeps());
    let mockTime = Date.now();

    try {
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

      for (let i = 0; i < 100; i++) {
        await app.request('/api/v1/capture', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ content: 'test' }),
        });
      }

      let res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 'test' }),
      });
      expect(res.status).toBe(429);

      mockTime += 61_000;

      res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 'test' }),
      });
      expect(res.status).not.toBe(429);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ─── Section 4: POST /api/v1/capture (alias) ────────────────────────────────

describe('Section 4: Capture Endpoint (POST /api/v1/capture alias)', () => {
  it('4.1 Valid text capture returns 201 with captureId', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValueOnce({ captureId: 'cap-abc' });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: JSON_HEADERS,
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
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('4.3 Content not a string (number) returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it('4.4 Semantic duplicate returns 409', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValueOnce({
      error: true,
      reason: 'Semantic duplicate detected (similarity: 0.980)',
    });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'duplicate content' }),
    });
    expect(res.status).toBe(409);
  });

  it('4.5 File hash duplicate returns 409', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValueOnce({
      error: true,
      reason: 'Duplicate file(s) detected (exact hash match). Already captured.',
    });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'photo note' }),
    });
    expect(res.status).toBe(409);
  });

  it('4.6 file_urls downloads and passes files to service', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    }) as unknown as typeof fetch;

    vi.mocked(capturesSvc.captureThought).mockResolvedValueOnce({ captureId: 'cap-file' });
    const app = createApp(makeDeps());

    try {
      const res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 'photo note', file_urls: ['https://example.com/photo.jpg'] }),
      });
      expect(res.status).toBe(201);
      expect(capturesSvc.captureThought).toHaveBeenCalledWith(
        expect.anything(),
        'photo note',
        expect.arrayContaining([
          expect.objectContaining({ contentType: 'image/jpeg', filename: 'photo.jpg' }),
        ]),
        undefined,
        ['api'],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('4.7 Unsupported file MIME returns 201 with warnings array', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValueOnce({
      captureId: 'cap-warn',
      warnings: ['File "archive.zip" (application/zip): unsupported type for embedding, stored but not embedded.'],
    });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/capture', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'zip file', file_urls: [] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toHaveLength(1);
  });

  it('4.8 Unreachable file_url returns 400', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;
    const app = createApp(makeDeps());

    try {
      const res = await app.request('/api/v1/capture', {
        method: 'POST',
        headers: JSON_HEADERS,
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
    vi.mocked(capturesSvc.listCaptures).mockResolvedValueOnce([
      { id: '1', content: 'test', content_types: ['text'], file_urls: null, source: ['api'], status: 'pending', created_at: new Date(), tags: [] } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('1');
  });

  it('5.2 Respects limit query parameter', async () => {
    vi.mocked(capturesSvc.listCaptures).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/captures?limit=5', { headers: AUTH });
    expect(capturesSvc.listCaptures).toHaveBeenCalledWith(expect.anything(), 5, undefined);
  });

  it('5.3 Filters by status query parameter', async () => {
    vi.mocked(capturesSvc.listCaptures).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/captures?status=processed', { headers: AUTH });
    expect(capturesSvc.listCaptures).toHaveBeenCalledWith(expect.anything(), 10, 'processed');
  });

  it('5.4 Response strips embedding field', async () => {
    vi.mocked(capturesSvc.listCaptures).mockResolvedValueOnce([
      { id: '1', content: 'test', embedding: [0.1, 0.2, 0.3], tags: [] } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures', { headers: AUTH });
    const body = await res.json();
    expect(body[0].embedding).toBeUndefined();
  });
});

// ─── Section 6: GET + POST /api/v1/captures/:id ──────────────────────────────

describe('Section 6: Capture CRUD', () => {
  it('6.1 GET /api/v1/captures/:id returns 200 with the capture', async () => {
    vi.mocked(capturesSvc.getCapture).mockResolvedValueOnce({
      id: 'cap-123', content: 'hello', embedding: [0.1], tags: [],
    } as any);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures/cap-123', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('cap-123');
    expect(body.embedding).toBeUndefined();
  });

  it('6.2 GET /api/v1/captures/:id returns 404 when not found', async () => {
    vi.mocked(capturesSvc.getCapture).mockResolvedValueOnce(null);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures/missing', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('6.3 POST /api/v1/captures creates a capture and returns 201', async () => {
    vi.mocked(capturesSvc.captureThought).mockResolvedValueOnce({ captureId: 'cap-new' });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'brand new thought' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.captureId).toBe('cap-new');
  });

  it('6.4 PATCH /api/v1/captures/:id/tags returns updated tags', async () => {
    vi.mocked(tagsSvc.updateTags).mockResolvedValueOnce({ old: ['preference'], new: ['goal'] });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures/cap-123/tags', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tags: ['goal'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new).toEqual(['goal']);
    expect(tagsSvc.updateTags).toHaveBeenCalledWith(expect.anything(), 'cap-123', 'capture', ['goal']);
  });

  it('6.5 PATCH /api/v1/captures/:id/tags with non-array returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures/cap-123/tags', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tags: 'preference' }),
    });
    expect(res.status).toBe(400);
  });

  it('6.6 POST /api/v1/captures/:id/archive returns 200', async () => {
    vi.mocked(capturesSvc.archiveCapture).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures/cap-123/archive', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
  });

  it('6.7 POST /api/v1/captures/:id/unarchive returns 200', async () => {
    vi.mocked(capturesSvc.unarchiveCapture).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/captures/cap-123/unarchive', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
  });
});

// ─── Section 7: Facts ────────────────────────────────────────────────────────

describe('Section 7: Facts CRUD', () => {
  it('7.1 GET /api/v1/facts returns array (strips embeddings)', async () => {
    vi.mocked(factsSvc.listFacts).mockResolvedValueOnce([
      { id: '1', content: 'fact', embedding: [0.1], tags: ['preference'] } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].embedding).toBeUndefined();
  });

  it('7.2 GET /api/v1/facts passes min_confidence query param', async () => {
    vi.mocked(factsSvc.listFacts).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/facts?min_confidence=0.8', { headers: AUTH });
    expect(factsSvc.listFacts).toHaveBeenCalledWith(expect.anything(), 20, 0.8);
  });

  it('7.3 GET /api/v1/facts/:id returns fact', async () => {
    vi.mocked(factsSvc.getFact).mockResolvedValueOnce({ id: 'fact-1', content: 'hello', embedding: [0.1], tags: [] } as any);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('fact-1');
    expect(body.embedding).toBeUndefined();
  });

  it('7.4 GET /api/v1/facts/:id returns 404 when not found', async () => {
    vi.mocked(factsSvc.getFact).mockResolvedValueOnce(null);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/missing', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('7.5 PUT /api/v1/facts/:id updates content', async () => {
    vi.mocked(factsSvc.updateFact).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'updated fact' }),
    });
    expect(res.status).toBe(200);
    expect(factsSvc.updateFact).toHaveBeenCalledWith(expect.anything(), 'fact-1', 'updated fact');
  });

  it('7.6 PUT /api/v1/facts/:id with missing content returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('7.7 PUT /api/v1/facts/:id returns 404 when fact not found', async () => {
    vi.mocked(factsSvc.updateFact).mockRejectedValueOnce(new Error('Fact fact-missing not found'));
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-missing', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('7.8 PATCH /api/v1/facts/:id/tags updates tags', async () => {
    vi.mocked(tagsSvc.updateTags).mockResolvedValueOnce({ old: [], new: ['decision'] });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1/tags', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tags: ['decision'] }),
    });
    expect(res.status).toBe(200);
    expect(tagsSvc.updateTags).toHaveBeenCalledWith(expect.anything(), 'fact-1', 'fact', ['decision']);
  });

  it('7.9 POST /api/v1/facts/:id/archive returns ok', async () => {
    vi.mocked(factsSvc.archiveFact).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1/archive', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
  });

  it('7.10 POST /api/v1/facts/:id/unarchive returns ok', async () => {
    vi.mocked(factsSvc.unarchiveFact).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1/unarchive', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
  });

  it('7.11 POST /api/v1/facts/:id/approve approves the fact', async () => {
    vi.mocked(factsSvc.approveRejectFact).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1/approve', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(factsSvc.approveRejectFact).toHaveBeenCalledWith(expect.anything(), 'fact-1', 'approve');
  });

  it('7.12 POST /api/v1/facts/:id/reject rejects the fact', async () => {
    vi.mocked(factsSvc.approveRejectFact).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/fact-1/reject', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(factsSvc.approveRejectFact).toHaveBeenCalledWith(expect.anything(), 'fact-1', 'reject');
  });

  it('7.13 POST /api/v1/facts/:id/approve returns 404 when fact not found', async () => {
    vi.mocked(factsSvc.approveRejectFact).mockRejectedValueOnce(new Error('Fact missing not found'));
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/facts/missing/approve', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(404);
  });
});

// ─── Section 8: Insights ─────────────────────────────────────────────────────

describe('Section 8: Insights CRUD', () => {
  it('8.1 GET /api/v1/insights returns array (strips embeddings)', async () => {
    vi.mocked(insightsSvc.listInsights).mockResolvedValueOnce([
      { id: '1', content: 'insight', embedding: [0.1], tags: [] } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].embedding).toBeUndefined();
  });

  it('8.2 GET /api/v1/insights/:id returns insight', async () => {
    vi.mocked(insightsSvc.getInsight).mockResolvedValueOnce({ id: 'ins-1', content: 'hello', embedding: [0.1], tags: [] } as any);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights/ins-1', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('ins-1');
    expect(body.embedding).toBeUndefined();
  });

  it('8.3 GET /api/v1/insights/:id returns 404 when not found', async () => {
    vi.mocked(insightsSvc.getInsight).mockResolvedValueOnce(null);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights/missing', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('8.4 PUT /api/v1/insights/:id updates content', async () => {
    vi.mocked(insightsSvc.updateInsight).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights/ins-1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'updated' }),
    });
    expect(res.status).toBe(200);
    expect(insightsSvc.updateInsight).toHaveBeenCalledWith(expect.anything(), 'ins-1', 'updated');
  });

  it('8.5 PATCH /api/v1/insights/:id/tags updates tags', async () => {
    vi.mocked(tagsSvc.updateTags).mockResolvedValueOnce({ old: [], new: ['pattern'] });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights/ins-1/tags', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tags: ['pattern'] }),
    });
    expect(res.status).toBe(200);
    expect(tagsSvc.updateTags).toHaveBeenCalledWith(expect.anything(), 'ins-1', 'insight', ['pattern']);
  });

  it('8.6 POST /api/v1/insights/:id/archive returns ok', async () => {
    vi.mocked(insightsSvc.archiveInsight).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights/ins-1/archive', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
  });

  it('8.7 POST /api/v1/insights/:id/approve approves the insight', async () => {
    vi.mocked(insightsSvc.approveRejectInsight).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights/ins-1/approve', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(insightsSvc.approveRejectInsight).toHaveBeenCalledWith(expect.anything(), 'ins-1', 'approve');
  });

  it('8.8 POST /api/v1/insights/:id/reject rejects the insight', async () => {
    vi.mocked(insightsSvc.approveRejectInsight).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/insights/ins-1/reject', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(insightsSvc.approveRejectInsight).toHaveBeenCalledWith(expect.anything(), 'ins-1', 'reject');
  });
});

// ─── Section 9: Reminders ────────────────────────────────────────────────────

describe('Section 9: Reminders CRUD', () => {
  it('9.1 GET /api/v1/reminders returns array (strips embeddings)', async () => {
    vi.mocked(remindersSvc.listReminders).mockResolvedValueOnce([
      { id: '1', content: 'buy milk', embedding: [0.1], status: 'not_started' } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].embedding).toBeUndefined();
  });

  it('9.2 GET /api/v1/reminders passes status filter', async () => {
    vi.mocked(remindersSvc.listReminders).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/reminders?status=in_progress', { headers: AUTH });
    expect(remindersSvc.listReminders).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'in_progress' }),
    );
  });

  it('9.3 GET /api/v1/reminders passes project filter', async () => {
    vi.mocked(remindersSvc.listReminders).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/reminders?project=work', { headers: AUTH });
    expect(remindersSvc.listReminders).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ project: 'work' }),
    );
  });

  it('9.4 POST /api/v1/reminders creates a reminder', async () => {
    vi.mocked(remindersSvc.createReminder).mockResolvedValueOnce({ id: 'rem-new' });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'finish report', project: 'work' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('rem-new');
    expect(remindersSvc.createReminder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: 'finish report', project: 'work' }),
    );
  });

  it('9.5 POST /api/v1/reminders with missing content returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('9.6 GET /api/v1/reminders/:id returns detail with subtasks', async () => {
    vi.mocked(remindersSvc.getReminderDetail).mockResolvedValueOnce({
      id: 'rem-1', content: 'task', embedding: [0.1], subtasks: [
        { id: 'sub-1', content: 'subtask', embedding: [0.2] } as any,
      ], comments: [],
    } as any);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('rem-1');
    expect(body.embedding).toBeUndefined();
    expect(body.subtasks[0].embedding).toBeUndefined();
  });

  it('9.7 GET /api/v1/reminders/:id returns 404 when not found', async () => {
    vi.mocked(remindersSvc.getReminderDetail).mockResolvedValueOnce(null);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/missing', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('9.8 PATCH /api/v1/reminders/:id updates fields', async () => {
    vi.mocked(remindersSvc.updateReminder).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'in_progress', priority: 'P1' }),
    });
    expect(res.status).toBe(200);
    expect(remindersSvc.updateReminder).toHaveBeenCalledWith(
      expect.anything(),
      'rem-1',
      expect.objectContaining({ status: 'in_progress', priority: 'P1' }),
    );
  });

  it('9.9 POST /api/v1/reminders/:id/complete returns completed IDs', async () => {
    vi.mocked(remindersSvc.completeReminder).mockResolvedValueOnce({ completed: ['rem-1', 'sub-1'] });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1/complete', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toEqual(['rem-1', 'sub-1']);
  });

  it('9.10 DELETE /api/v1/reminders/:id deletes the reminder', async () => {
    vi.mocked(remindersSvc.deleteReminder).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(remindersSvc.deleteReminder).toHaveBeenCalledWith(expect.anything(), 'rem-1');
  });

  it('9.11 POST /api/v1/reminders/:id/reparent moves to new parent', async () => {
    vi.mocked(remindersSvc.reparentReminder).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1/reparent', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ parent_id: 'rem-parent' }),
    });
    expect(res.status).toBe(200);
    expect(remindersSvc.reparentReminder).toHaveBeenCalledWith(expect.anything(), 'rem-1', 'rem-parent');
  });

  it('9.12 POST /api/v1/reminders/:id/reparent with null parent_id moves to root', async () => {
    vi.mocked(remindersSvc.reparentReminder).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1/reparent', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(remindersSvc.reparentReminder).toHaveBeenCalledWith(expect.anything(), 'rem-1', null);
  });
});

// ─── Section 10: Comments ─────────────────────────────────────────────────────

describe('Section 10: Comments CRUD', () => {
  it('10.1 GET /api/v1/reminders/:id/comments returns comments (strips embeddings)', async () => {
    vi.mocked(commentsSvc.listComments).mockResolvedValueOnce([
      { id: 'cmt-1', content: 'looks good', embedding: [0.1], reminder_id: 'rem-1', created_at: new Date() } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1/comments', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('cmt-1');
    expect(body[0].embedding).toBeUndefined();
  });

  it('10.2 POST /api/v1/reminders/:id/comments adds a comment', async () => {
    vi.mocked(commentsSvc.addComment).mockResolvedValueOnce({ id: 'cmt-new' });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1/comments', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'nice work' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('cmt-new');
    expect(commentsSvc.addComment).toHaveBeenCalledWith(expect.anything(), 'rem-1', 'nice work', 'api');
  });

  it('10.3 POST /api/v1/reminders/:id/comments with missing content returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/rem-1/comments', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('10.4 POST /api/v1/reminders/:id/comments returns 404 when reminder not found', async () => {
    vi.mocked(commentsSvc.addComment).mockRejectedValueOnce(new Error('Reminder missing not found'));
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/reminders/missing/comments', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  it('10.5 GET /api/v1/comments/:id returns a comment', async () => {
    vi.mocked(commentsSvc.getComment).mockResolvedValueOnce({
      id: 'cmt-1', content: 'hello', embedding: [0.1], reminder_id: 'rem-1', created_at: new Date(),
    } as any);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/comments/cmt-1', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('cmt-1');
    expect(body.embedding).toBeUndefined();
  });

  it('10.6 GET /api/v1/comments/:id returns 404 when not found', async () => {
    vi.mocked(commentsSvc.getComment).mockResolvedValueOnce(null);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/comments/missing', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('10.7 PUT /api/v1/comments/:id updates a comment', async () => {
    vi.mocked(commentsSvc.updateComment).mockResolvedValueOnce(undefined);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/comments/cmt-1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'updated comment' }),
    });
    expect(res.status).toBe(200);
    expect(commentsSvc.updateComment).toHaveBeenCalledWith(expect.anything(), 'cmt-1', 'updated comment');
  });

  it('10.8 PUT /api/v1/comments/:id with missing content returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/comments/cmt-1', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('10.9 PUT /api/v1/comments/:id returns 404 when comment not found', async () => {
    vi.mocked(commentsSvc.updateComment).mockRejectedValueOnce(new Error('Comment missing not found'));
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/comments/missing', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('10.10 DELETE /api/v1/comments/:id deletes and returns the comment', async () => {
    vi.mocked(commentsSvc.deleteComment).mockResolvedValueOnce({
      id: 'cmt-1', content: 'bye', embedding: [0.1], reminder_id: 'rem-1', created_at: new Date(),
    } as any);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/comments/cmt-1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('cmt-1');
    expect(body.embedding).toBeUndefined();
  });

  it('10.11 DELETE /api/v1/comments/:id returns 404 when not found', async () => {
    vi.mocked(commentsSvc.deleteComment).mockRejectedValueOnce(new Error('Comment missing not found'));
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/comments/missing', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(404);
  });
});

// ─── Section 11: Search ──────────────────────────────────────────────────────

describe('Section 11: Search', () => {
  it('11.1 POST /api/v1/search returns results', async () => {
    vi.mocked(capturesSvc.searchThoughts).mockResolvedValueOnce([
      { id: 'cap-1', content: 'TypeScript is great', tier: 'capture', score: 0.95 } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: 'typescript preferences' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('cap-1');
  });

  it('11.2 POST /api/v1/search passes threshold and limit', async () => {
    vi.mocked(capturesSvc.searchThoughts).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/search', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: 'health', threshold: 0.85, limit: 5 }),
    });
    expect(capturesSvc.searchThoughts).toHaveBeenCalledWith(expect.anything(), 'health', 0.85, 5, undefined);
  });

  it('11.3 POST /api/v1/search passes tags filter', async () => {
    vi.mocked(capturesSvc.searchThoughts).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/search', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: 'fitness', tags: ['health'] }),
    });
    expect(capturesSvc.searchThoughts).toHaveBeenCalledWith(expect.anything(), 'fitness', 0.7, 10, ['health']);
  });

  it('11.4 POST /api/v1/search with missing query returns 400', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Section 12: Profile and Stats ───────────────────────────────────────────

describe('Section 12: Profile and Stats', () => {
  it('12.1 GET /api/v1/profile returns profile string', async () => {
    vi.mocked(profileSvc.getUserProfile).mockResolvedValueOnce('Pedro is a software engineer...');
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/profile', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toContain('Pedro');
  });

  it('12.2 GET /api/v1/stats returns brain stats', async () => {
    vi.mocked(profileSvc.getBrainStats).mockResolvedValueOnce({
      captures: 42,
      facts: 10,
      insights: 3,
      reminders: 7,
      pendingReview: 2,
      factsByTag: [{ tag: 'preference', count: '5' }],
      insightsByTag: [],
      capturesBySource: [{ src: 'telegram', count: '30' }],
      capturesByTag: [],
    });
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/stats', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.captures).toBe(42);
    expect(body.facts).toBe(10);
  });
});

// ─── Section 13: Review Pending ──────────────────────────────────────────────

describe('Section 13: Review Pending', () => {
  it('13.1 GET /api/v1/review/pending returns both facts and insights by default', async () => {
    vi.mocked(factsSvc.reviewPendingFacts).mockResolvedValueOnce([
      { id: 'f1', content: 'pending fact', embedding: [0.1], tags: [] } as any,
    ]);
    vi.mocked(insightsSvc.reviewPendingInsights).mockResolvedValueOnce([
      { id: 'i1', content: 'pending insight', embedding: [0.2], tags: [] } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/review/pending', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toHaveLength(1);
    expect(body.insights).toHaveLength(1);
    expect(body.facts[0].embedding).toBeUndefined();
    expect(body.insights[0].embedding).toBeUndefined();
  });

  it('13.2 GET /api/v1/review/pending?type=fact returns only facts', async () => {
    vi.mocked(factsSvc.reviewPendingFacts).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/review/pending?type=fact', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toBeDefined();
    expect(body.insights).toBeUndefined();
    expect(insightsSvc.reviewPendingInsights).not.toHaveBeenCalled();
  });

  it('13.3 GET /api/v1/review/pending?type=insight returns only insights', async () => {
    vi.mocked(insightsSvc.reviewPendingInsights).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/review/pending?type=insight', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insights).toBeDefined();
    expect(body.facts).toBeUndefined();
    expect(factsSvc.reviewPendingFacts).not.toHaveBeenCalled();
  });
});

// ─── Section 14: Projects ────────────────────────────────────────────────────

describe('Section 14: Projects', () => {
  it('14.1 GET /api/v1/projects returns project list', async () => {
    vi.mocked(remindersSvc.listProjects).mockResolvedValueOnce([
      { project: 'work', total: 5, not_started: 2, in_progress: 2, done: 1, paused: 0, blocked: 0, cancelled: 0 },
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/projects', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].project).toBe('work');
  });
});

// ─── Section 15: Consolidation ───────────────────────────────────────────────

describe('Section 15: Consolidation', () => {
  it('15.1 GET /api/v1/consolidation/logs returns log array', async () => {
    vi.mocked(consolidationSvc.getConsolidationLogs).mockResolvedValueOnce([
      { id: '1', status: 'success', captures_processed: 5, run_at: new Date() } as any,
    ]);
    const app = createApp(makeDeps());
    const res = await app.request('/api/v1/consolidation/logs', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('15.2 GET /api/v1/consolidation/logs passes limit parameter', async () => {
    vi.mocked(consolidationSvc.getConsolidationLogs).mockResolvedValueOnce([]);
    const app = createApp(makeDeps());
    await app.request('/api/v1/consolidation/logs?limit=5', { headers: AUTH });
    expect(consolidationSvc.getConsolidationLogs).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('15.3 POST /api/v1/consolidation/trigger runs consolidation and returns log', async () => {
    vi.mocked(consolidationSvc.runConsolidation).mockResolvedValueOnce(undefined);
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [{ id: '1', status: 'success', captures_processed: 3 }] }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/consolidation/trigger', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(body.log).toBeDefined();
  });

  it('15.4 POST /api/v1/consolidation/trigger returns 500 on error', async () => {
    vi.mocked(consolidationSvc.runConsolidation).mockRejectedValueOnce(new Error('LLM API down'));
    const mockDb = {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [{ id: '1', status: 'failed' }] }),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const app = createApp(makeDeps({ db: mockDb as any }));
    const res = await app.request('/api/v1/consolidation/trigger', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toContain('LLM API down');
  });
});
