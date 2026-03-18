// tests/integration/telegram-webhook.test.ts — Section 15: Webhook
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';

// We do NOT mock setupTelegramWebhook here — we test the actual webhook route
// But we need to mock grammy's Bot so it doesn't make real API calls
vi.mock('grammy', () => {
  const mockHandleUpdate = vi.fn().mockResolvedValue(undefined);
  const MockBot = vi.fn().mockImplementation(() => ({
    command: vi.fn(),
    on: vi.fn(),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    handleUpdate: mockHandleUpdate,
    api: { getFile: vi.fn() },
  }));
  return {
    Bot: MockBot,
    webhookCallback: vi.fn(),
    InlineKeyboard: vi.fn().mockImplementation(() => ({
      text: vi.fn().mockReturnThis(),
      row: vi.fn().mockReturnThis(),
    })),
    __mockHandleUpdate: mockHandleUpdate,
    __MockBot: MockBot,
  };
});

const { __mockHandleUpdate } = await import('grammy') as any;

function makeDeps(): AppDeps {
  return {
    db: { pool: {}, query: vi.fn().mockResolvedValue({ rows: [] }), transaction: vi.fn(), close: vi.fn() },
    embeddingProvider: { embed: vi.fn().mockResolvedValue([0.1]), dimensions: 3072 },
    metadataLLM: { complete: vi.fn() },
    consolidationLLM: { complete: vi.fn() },
    retrievalLLM: { complete: vi.fn() },
    blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
    config: {
      apiKey: 'test-key',
      databaseUrl: 'postgres://localhost/test',
      azureStorageConnectionString: 'test',
      azureStorageContainer: 'test',
      geminiApiKey: 'test',
      anthropicApiKey: 'test',
      telegramBotToken: 'test:bot-token',
      telegramWebhookSecret: 'my-webhook-secret',
      telegramChatId: '12345',
      port: 3000,
      nodeEnv: 'test',
      reviewMode: 'autonomous',
      dailyDigestEnabled: false,
      timezone: 'America/Chicago',
      dailyReportTime: '09:00',
    },
  } as unknown as AppDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Section 15: Telegram Webhook', () => {
  it('15.1 POST /telegram/webhook without secret returns 403', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it('15.2 POST /telegram/webhook with wrong secret returns 403', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it('15.3 POST /telegram/webhook with correct secret + valid body returns 200', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'my-webhook-secret',
      },
      body: JSON.stringify({ update_id: 100, message: { text: 'hello', chat: { id: 123 } } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('15.4 Same update_id sent twice → second one skipped, still returns 200', async () => {
    const app = createApp(makeDeps());
    const headers = {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'my-webhook-secret',
    };
    const payload = JSON.stringify({ update_id: 200, message: { text: 'hello', chat: { id: 123 } } });

    // First request
    await app.request('/telegram/webhook', { method: 'POST', headers, body: payload });

    // Second request with same update_id
    const res2 = await app.request('/telegram/webhook', { method: 'POST', headers, body: payload });
    expect(res2.status).toBe(200);
    // handleUpdate should only be called once (first request)
    expect(__mockHandleUpdate).toHaveBeenCalledTimes(1);
  });

  it('15.5 Valid update processed via bot.handleUpdate (verify it is called)', async () => {
    const app = createApp(makeDeps());
    const updateBody = { update_id: 300, message: { text: 'test message', chat: { id: 456 } } };

    await app.request('/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'my-webhook-secret',
      },
      body: JSON.stringify(updateBody),
    });

    expect(__mockHandleUpdate).toHaveBeenCalledWith(updateBody);
  });
});
