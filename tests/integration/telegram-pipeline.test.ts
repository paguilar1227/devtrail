// tests/integration/telegram-pipeline.test.ts — Telegram webhook → intent → action → reply pipeline
//
// Tests the full pipeline: POST fake Telegram update JSON → bot processes it → bot replies via
// Telegram API. We mock grammy's Bot to intercept API calls while preserving real handler
// registration and execution. This tests ALL our webhook handler code without touching Telegram.
//
// Sections: Thought Capture (T1-T2), Slash Commands (T3-T7, T6b, T6c), Error Handling (T14-T15)
// See telegram-nl.test.ts for Natural Language (T8-T12), Undo (T13, T13b), Subtasks & Display (T16-T25)
//
// Memory strategy: one app instance shared across the whole file; mocks are reset per test.
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { Hono } from 'hono';
import type { AppDeps } from '../../src/app.js';

// ---------------------------------------------------------------------------
// Functional grammy mock — registers real handlers, intercepts API replies
// ---------------------------------------------------------------------------

interface TelegramReply {
  chat_id: number;
  text: string;
  parse_mode?: string;
  reply_markup?: unknown;
}

// Shared state across all Bot instances in a single test — reset per test
let telegramReplies: TelegramReply[] = [];

vi.mock('grammy', () => {
  type Handler = (ctx: any) => Promise<void>;
  type ErrorHandler = (err: any) => void;

  class MockBot {
    private commandHandlers = new Map<string, Handler>();
    private messageTextHandler: Handler | null = null;
    private photoHandler: Handler | null = null;
    private voiceHandler: Handler | null = null;
    private documentHandler: Handler | null = null;
    private callbackQueryHandler: Handler | null = null;
    private errorHandler: ErrorHandler | null = null;

    public api: any;
    public botInfo = { id: 123, is_bot: true, first_name: 'TestBot', username: 'testbot' };

    constructor(_token: string) {
      this.api = {
        getFile: vi.fn().mockResolvedValue({ file_id: 'test', file_path: 'test/file.jpg' }),
      };
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      if (filter === 'message:text') this.messageTextHandler = handler;
      else if (filter === 'message:photo') this.photoHandler = handler;
      else if (filter === 'message:voice') this.voiceHandler = handler;
      else if (filter === 'message:document') this.documentHandler = handler;
      else if (filter === 'callback_query:data') this.callbackQueryHandler = handler;
    }

    catch(handler: ErrorHandler) {
      this.errorHandler = handler;
    }

    async init() {}

    async handleUpdate(update: any) {
      if (update.callback_query) {
        if (this.callbackQueryHandler) {
          const cbq = update.callback_query;
          const chatId = cbq.message?.chat?.id ?? 42;
          const chat = cbq.message?.chat ?? { id: chatId, type: 'private' };
          const ctx: any = {
            update,
            callbackQuery: cbq,
            chat,
            answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
            editMessageText: vi.fn().mockResolvedValue(undefined),
            reply: vi.fn(async (text: string, options?: any) => {
              telegramReplies.push({ chat_id: chatId, text, reply_markup: options?.reply_markup });
              return { message_id: telegramReplies.length };
            }),
          };
          try {
            await this.callbackQueryHandler(ctx);
          } catch (err) {
            if (this.errorHandler) this.errorHandler({ error: err, ctx });
            else throw err;
          }
        }
        return;
      }

      if (!update.message) return;

      const message = update.message;
      const text = message.text ?? '';
      const chat = message.chat;
      const ctx: any = {
        update,
        message,
        chat,
        reply: vi.fn(async (text: string, options?: any) => {
          telegramReplies.push({ chat_id: chat.id, text, reply_markup: options?.reply_markup });
          return { message_id: telegramReplies.length };
        }),
      };

      try {
        if (text.startsWith('/')) {
          const cmdMatch = text.match(/^\/(\w+)/);
          if (cmdMatch) {
            const handler = this.commandHandlers.get(cmdMatch[1]);
            if (handler) { await handler(ctx); return; }
          }
        }
        if (message.photo && this.photoHandler) await this.photoHandler(ctx);
        else if (message.voice && this.voiceHandler) await this.voiceHandler(ctx);
        else if (message.document && this.documentHandler) await this.documentHandler(ctx);
        else if (message.text && this.messageTextHandler) await this.messageTextHandler(ctx);
      } catch (err) {
        if (this.errorHandler) this.errorHandler({ error: err, ctx });
        else throw err;
      }
    }
  }

  class MockInlineKeyboard {
    text(_label: string, _data: string) { return this; }
    row() { return this; }
  }

  return {
    Bot: MockBot,
    webhookCallback: vi.fn(),
    InlineKeyboard: MockInlineKeyboard,
  };
});

// Import after mock is set up
const { setupTelegramWebhook } = await import('../../src/telegram/webhook.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textUpdate(updateId: number, text: string, chatId = 42) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: chatId, is_bot: false, first_name: 'Tester' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

async function sendWebhookUpdate(app: Hono, update: object, secret = 'test-webhook-secret') {
  const res = await app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  });
  // Give background processing time to complete (bot.handleUpdate is fire-and-forget)
  await new Promise((r) => setTimeout(r, 200));
  return res;
}

function makeDeps(): AppDeps {
  return {
    db: {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
      close: vi.fn(),
    },
    embeddingProvider: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), dimensions: 3072 },
    metadataLLM: {
      complete: vi.fn().mockResolvedValue({ content: '{}', tokensUsed: { input: 0, output: 0, total: 0 } }),
    },
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
      telegramBotToken: 'test:pipeline-token',
      telegramWebhookSecret: 'test-webhook-secret',
      telegramChatId: '42',
      port: 3000,
      nodeEnv: 'test',
      reviewMode: 'autonomous',
      dailyDigestEnabled: false,
      timezone: 'America/Chicago',
      dailyReportTime: '09:00',
    },
  } as unknown as AppDeps;
}

// ---------------------------------------------------------------------------
// Shared app — created once, mocks reset per test to save memory
// ---------------------------------------------------------------------------

let sharedDeps: AppDeps;
let sharedApp: Hono;

beforeAll(async () => {
  sharedDeps = makeDeps();
  sharedApp = new Hono();
  setupTelegramWebhook(sharedApp, sharedDeps);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  telegramReplies = [];
  // Reset mocks but don't clear — the handlers are already registered on sharedApp
  vi.mocked(sharedDeps.db.query).mockReset().mockResolvedValue({ rows: [] } as any);
  vi.mocked(sharedDeps.metadataLLM.complete).mockReset().mockResolvedValue({
    content: '{}',
    tokensUsed: { input: 0, output: 0, total: 0 },
  });
  vi.mocked(sharedDeps.embeddingProvider.embed).mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
});

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

// ─── Thought Capture ────────────────────────────────────────────────────────

describe('Telegram Pipeline — Thought Capture', () => {
  it('T1: Text message "I really enjoy hiking" → bot replies "Captured! (xxxxxxxx)"', async () => {
    vi.mocked(sharedDeps.metadataLLM.complete)
      .mockResolvedValueOnce({
        content: JSON.stringify({ action: 'capture_thought' }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: 'personal', topics: ['hiking'] }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      });

    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) return { rows: [] } as any;
      if (typeof sql === 'string' && sql.includes('INSERT INTO captures')) {
        return { rows: [{ id: 'a1b2c3d4e5f67890' }] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1001, 'I really enjoy hiking'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Captured!');
    expect(reply.text).toContain('a1b2c3d4');
  });

  it('T2: Duplicate text → bot replies "Skipped: Semantic duplicate..."', async () => {
    vi.mocked(sharedDeps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'capture_thought' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) {
        return { rows: [{ id: 'existing-cap', similarity: 0.98 }] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1002, 'I really enjoy hiking'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Skipped');
    expect(reply.text).toMatch(/[Ss]emantic duplicate/i);
  });
});

// ─── Reminders (Slash Commands) ─────────────────────────────────────────────

describe('Telegram Pipeline — Slash Commands', () => {
  it('T3: "/remind Buy running shoes" → bot replies with "Reminder created"', async () => {
    vi.mocked(sharedDeps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ content: 'Buy running shoes', project: null, section: null, priority: null, category: 'personal', dueDate: null }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: 'rem-shoes-12345678' }] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1003, '/remind Buy running shoes'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder created');
    expect(reply.text).toContain('rem-shoe');
  });

  it('T4: "/remind [project:fitness] Sign up for a 5K race P2" → reply with project + priority', async () => {
    vi.mocked(sharedDeps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ content: 'Sign up for a 5K race', project: 'fitness', section: null, priority: 'P2', category: 'health', dueDate: null }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: 'rem-5k-race-1234' }] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1004, '/remind [project:fitness] Sign up for a 5K race P2'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder created');
    expect(reply.text).toContain('fitness');
    expect(reply.text).toContain('P2');
  });

  it('T5: "/todos" → bot replies with formatted reminder list', async () => {
    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('not_started')) {
        return {
          rows: [
            { id: 'rem-1', content: 'Buy running shoes', status: 'not_started', priority: 'P1', project: 'fitness', section: null, depth: 0, due_date: null, archived: false, created_at: new Date(), updated_at: new Date() },
            { id: 'rem-2', content: 'Sign up for 5K race', status: 'not_started', priority: 'P2', project: 'fitness', section: null, depth: 0, due_date: null, archived: false, created_at: new Date(), updated_at: new Date() },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1005, '/todos'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Buy running shoes');
    expect(reply.text).toContain('Sign up for 5K race');
    expect(reply.text).toContain('fitness');
  });

  it('T6: "/done <full-uuid>" → bot replies "Reminder completed!"', async () => {
    // full UUID resolves directly (no LIKE query needed)
    // completeReminder: UPDATE (no rows needed) + SELECT children (empty = no subtasks)
    vi.mocked(sharedDeps.db.query).mockResolvedValue({ rows: [] } as any);

    await sendWebhookUpdate(sharedApp, textUpdate(1006, '/done a1b2c3d4-e5f6-7890-abcd-ef1234567890'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder completed');
  });

  it('T6b: "/done <short-id>" → resolves short ID prefix and completes', async () => {
    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [{ id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }] } as any;
      }
      if (typeof sql === 'string' && sql.includes('status')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1061, '/done a1b2c3d4'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder completed');
    expect(reply.text).toContain('a1b2c3d4');
  });

  it('T6c: "/done <invalid-id>" → replies with error message', async () => {
    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1062, '/done badid123'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('No reminder found');
  });

  it('T7: "/comment <short-id> Found a race" → resolves ID and adds comment', async () => {
    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [{ id: 'rem-11111-2222-3333-444455556666' }] } as any;
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminder_comments')) {
        return { rows: [{ id: 'comment-abc-12345678' }] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(sharedApp, textUpdate(1007, '/comment rem-1111 Found a race'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Comment added');
  });
});

// ─── Error Handling ─────────────────────────────────────────────────────────

describe('Telegram Pipeline — Error Handling', () => {
  it('T14: Webhook with wrong secret → 403 (no bot processing)', async () => {
    const res = await sharedApp.request('/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
      },
      body: JSON.stringify(textUpdate(1015, 'should not process')),
    });

    expect(res.status).toBe(403);
    expect(telegramReplies.length).toBe(0);
  });

  it('T15: Duplicate update_id → second one skipped, still 200', async () => {
    vi.mocked(sharedDeps.metadataLLM.complete)
      .mockResolvedValueOnce({
        content: JSON.stringify({ action: 'capture_thought' }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: 'personal' }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      });

    vi.mocked(sharedDeps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) return { rows: [] } as any;
      if (typeof sql === 'string' && sql.includes('INSERT INTO captures')) {
        return { rows: [{ id: 'cap-dedup-test1234' }] } as any;
      }
      return { rows: [] } as any;
    });

    const update = textUpdate(9999, 'duplicate test message');

    const res1 = await sendWebhookUpdate(sharedApp, update);
    expect(res1.status).toBe(200);

    const repliesAfterFirst = telegramReplies.length;

    const res2 = await sendWebhookUpdate(sharedApp, update);
    expect(res2.status).toBe(200);

    expect(telegramReplies.length).toBe(repliesAfterFirst);
  });
});
