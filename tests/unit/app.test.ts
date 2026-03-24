// tests/unit/app.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import * as capturesSvc from '../../src/services/captures.js';

// Mock the service layer (app.ts routes through services now)
vi.mock('../../src/services/captures.js', () => ({
  captureThought: vi.fn(),
  searchThoughts: vi.fn(),
  getCapture: vi.fn(),
  listCaptures: vi.fn(),
  archiveCapture: vi.fn(),
  unarchiveCapture: vi.fn(),
}));
vi.mock('../../src/services/facts.js', () => ({ getFact: vi.fn(), listFacts: vi.fn(), updateFact: vi.fn(), archiveFact: vi.fn(), unarchiveFact: vi.fn(), reviewPendingFacts: vi.fn(), approveRejectFact: vi.fn() }));
vi.mock('../../src/services/insights.js', () => ({ getInsight: vi.fn(), listInsights: vi.fn(), updateInsight: vi.fn(), archiveInsight: vi.fn(), unarchiveInsight: vi.fn(), reviewPendingInsights: vi.fn(), approveRejectInsight: vi.fn() }));
vi.mock('../../src/services/reminders.js', () => ({ createReminder: vi.fn(), listReminders: vi.fn(), getReminder: vi.fn(), getReminderDetail: vi.fn(), updateReminder: vi.fn(), completeReminder: vi.fn(), deleteReminder: vi.fn(), reparentReminder: vi.fn(), listProjects: vi.fn(), findActiveReminders: vi.fn(), findAllReminders: vi.fn(), findSubtasks: vi.fn(), findRemindersDueOnDate: vi.fn(), findOverdueReminders: vi.fn(), findRecentlyCompletedReminders: vi.fn(), resolveReminderId: vi.fn() }));
vi.mock('../../src/services/comments.js', () => ({ addComment: vi.fn(), listComments: vi.fn(), getComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn() }));
vi.mock('../../src/services/profile.js', () => ({ getUserProfile: vi.fn(), getBrainStats: vi.fn() }));
vi.mock('../../src/services/consolidation.js', () => ({ runConsolidation: vi.fn(), getConsolidationLogs: vi.fn() }));
vi.mock('../../src/services/tags.js', () => ({ updateTags: vi.fn(), getAllowedTags: vi.fn() }));

vi.mock('../../src/telegram/webhook.js', () => ({
  setupTelegramWebhook: vi.fn(),
}));

const mockCaptureThought = vi.mocked(capturesSvc.captureThought);

beforeEach(() => {
  vi.clearAllMocks();
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
    mockCaptureThought.mockResolvedValueOnce({ captureId: 'cap-1' });

    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn().mockResolvedValue([]), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      consolidationLLM: { complete: vi.fn() },
      retrievalLLM: { complete: vi.fn() },
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
      body: JSON.stringify({ content: 'I love TypeScript' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.captureId).toBe('cap-1');
    // Source is hardcoded to ['api']
    expect(mockCaptureThought).toHaveBeenCalledWith(
      expect.anything(),
      'I love TypeScript',
      [],
      undefined,
      ['api'],
    );
  });

  it('accepts optional tags and passes them through to the service', async () => {
    mockCaptureThought.mockResolvedValueOnce({ captureId: 'cap-2' });

    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn().mockResolvedValue([]), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      consolidationLLM: { complete: vi.fn() },
      retrievalLLM: { complete: vi.fn() },
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
      body: JSON.stringify({ content: 'I prefer TypeScript', tags: ['preference', 'invalid-tag'] }),
    });

    expect(res.status).toBe(201);
    // Raw tags are passed to the service (validation happens inside captureThought)
    expect(mockCaptureThought).toHaveBeenCalledWith(
      expect.anything(),
      'I prefer TypeScript',
      [],
      ['preference', 'invalid-tag'],
      ['api'],
    );
  });

  it('returns 409 for duplicate captures', async () => {
    mockCaptureThought.mockResolvedValueOnce({
      error: true,
      reason: 'Semantic duplicate detected',
    });

    const deps = {
      db: { pool: {}, query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
      embeddingProvider: { embed: vi.fn().mockResolvedValue([]), dimensions: 3072 },
      metadataLLM: { complete: vi.fn() },
      consolidationLLM: { complete: vi.fn() },
      retrievalLLM: { complete: vi.fn() },
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
      body: JSON.stringify({ content: 'duplicate' }),
    });

    expect(res.status).toBe(409);
  });

  it('returns health check on GET /', async () => {
    const app = createApp({} as any);
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });
});
