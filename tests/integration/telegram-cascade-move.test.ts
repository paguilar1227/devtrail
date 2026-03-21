// tests/integration/telegram-cascade-move.test.ts — Cascade done + move/reparent tests
// Split from telegram-pipeline.test.ts to avoid OOM in test runner.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppDeps } from '../../src/app.js';

// ---------------------------------------------------------------------------
// Functional grammy mock (same as telegram-pipeline.test.ts)
// ---------------------------------------------------------------------------

interface TelegramReply {
  chat_id: number;
  text: string;
  reply_markup?: unknown;
}

let telegramReplies: TelegramReply[] = [];
let latestBotInstance: any = null;

vi.mock('grammy', () => {
  type Handler = (ctx: any) => Promise<void>;
  type ErrorHandler = (err: any) => void;

  class MockBot {
    private commandHandlers = new Map<string, Handler>();
    private messageTextHandler: Handler | null = null;
    private callbackQueryHandler: Handler | null = null;
    private errorHandler: ErrorHandler | null = null;
    public api: any;
    public botInfo = { id: 123, is_bot: true, first_name: 'TestBot', username: 'testbot' };

    constructor(_token: string) {
      this.api = { getFile: vi.fn().mockResolvedValue({ file_id: 'test', file_path: 'test/file.jpg' }) };
      latestBotInstance = this;
    }

    command(name: string, handler: Handler) { this.commandHandlers.set(name, handler); }
    on(filter: string, handler: Handler) {
      if (filter === 'message:text') this.messageTextHandler = handler;
      else if (filter === 'callback_query:data') this.callbackQueryHandler = handler;
    }
    catch(handler: ErrorHandler) { this.errorHandler = handler; }
    async init() {}

    async handleUpdate(update: any) {
      if (update.callback_query && this.callbackQueryHandler) {
        const cbq = update.callback_query;
        const chatId = cbq.message?.chat?.id ?? 42;
        const ctx: any = {
          update, callbackQuery: cbq, chat: cbq.message?.chat ?? { id: chatId, type: 'private' },
          answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
          editMessageText: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn(async (text: string, options?: any) => {
            telegramReplies.push({ chat_id: chatId, text, reply_markup: options?.reply_markup });
            return { message_id: telegramReplies.length };
          }),
        };
        try { await this.callbackQueryHandler(ctx); }
        catch (err) { if (this.errorHandler) this.errorHandler({ error: err, ctx }); else throw err; }
        return;
      }
      if (!update.message) return;
      const message = update.message;
      const text = message.text ?? '';
      const chat = message.chat;
      const ctx: any = {
        update, message, chat,
        reply: vi.fn(async (t: string, options?: any) => {
          telegramReplies.push({ chat_id: chat.id, text: t, reply_markup: options?.reply_markup });
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
        if (message.text && this.messageTextHandler) await this.messageTextHandler(ctx);
      } catch (err) { if (this.errorHandler) this.errorHandler({ error: err, ctx }); else throw err; }
    }
  }

  class MockInlineKeyboard {
    text() { return this; }
    row() { return this; }
  }

  return { Bot: MockBot, webhookCallback: vi.fn(), InlineKeyboard: MockInlineKeyboard };
});

const { setupTelegramWebhook } = await import('../../src/telegram/webhook.js');

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
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update),
  });
  await new Promise((r) => setTimeout(r, 200));
  return res;
}

function makeDeps(): AppDeps {
  return {
    db: { pool: {}, query: vi.fn().mockResolvedValue({ rows: [] }), transaction: vi.fn(), close: vi.fn() },
    embeddingProvider: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), dimensions: 3072 },
    metadataLLM: { complete: vi.fn().mockResolvedValue({ content: '{}', tokensUsed: { input: 0, output: 0, total: 0 } }) },
    consolidationLLM: { complete: vi.fn() },
    retrievalLLM: { complete: vi.fn() },
    blobStorage: { upload: vi.fn(), exists: vi.fn(), getUrl: vi.fn() },
    config: {
      apiKey: 'test-key', databaseUrl: 'postgres://localhost/test',
      azureStorageConnectionString: 'test', azureStorageContainer: 'test',
      geminiApiKey: 'test', anthropicApiKey: 'test',
      telegramBotToken: 'test:cascade-token', telegramWebhookSecret: 'test-webhook-secret',
      telegramChatId: '42', port: 3000, nodeEnv: 'test', reviewMode: 'autonomous',
      dailyDigestEnabled: false, timezone: 'America/Chicago', dailyReportTime: '09:00',
    },
  } as unknown as AppDeps;
}

async function createTestApp(deps: AppDeps): Promise<Hono> {
  const app = new Hono();
  setupTelegramWebhook(app, deps);
  await new Promise((r) => setTimeout(r, 50));
  return app;
}

beforeEach(() => {
  telegramReplies = [];
  latestBotInstance = null;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Cascade Done + Move Tests
// ---------------------------------------------------------------------------

describe('Telegram Pipeline — Cascade Done & Move', () => {
  it('T26: /done with subtasks shows subtask count in reply', async () => {
    const remId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const child1Id = 'c1111111-0000-0000-0000-000000000001';
    const child2Id = 'c2222222-0000-0000-0000-000000000002';
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: any[]) => {
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [{ id: remId }] } as any;
      }
      if (typeof sql === 'string' && sql.includes("status = 'done'") && params?.[0] === remId) {
        return { rows: [] } as any;
      }
      if (typeof sql === 'string' && sql.includes('SELECT id, status') && sql.includes('parent_id = $1') && params?.[0] === remId) {
        return { rows: [{ id: child1Id, status: 'not_started' }, { id: child2Id, status: 'in_progress' }] } as any;
      }
      if (typeof sql === 'string' && sql.includes("status = 'done'") && (params?.[0] === child1Id || params?.[0] === child2Id)) {
        return { rows: [] } as any;
      }
      if (typeof sql === 'string' && sql.includes('SELECT id, status') && sql.includes('parent_id = $1')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(4001, `/done ${remId}`));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder completed');
    expect(reply.text).toContain('+ 2 subtasks');
  });

  it('T27: /move <id> root moves task to root level', async () => {
    const taskId = 'rem-move-aabb1122-3344-5566-7788-99aabbccddee';
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [{ id: taskId }] } as any;
      }
      if (typeof sql === 'string' && sql.includes('parent_id = $1') && sql.includes('depth = $2')) {
        return { rows: [] } as any;
      }
      if (typeof sql === 'string' && sql.includes('WHERE parent_id = $1') && !sql.includes('status')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(4002, '/move rem-move root'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Moved');
    expect(reply.text).toContain('root level');
  });

  it('T28: NL "move X under Y" reparents task correctly', async () => {
    const taskId = 'rem-task-aabbccdd-1111-2222-3333-444455556666';
    const parentId = 'rem-parent-11223344-5566-7788-99aa-bbccddeeff00';
    const deps = makeDeps();

    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'move_reminder', taskSearch: 'buy shoes', targetSearch: 'fitness project' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: any[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('archived = false') && !sql.includes('WHERE id') && !sql.includes('parent_id')) {
        return {
          rows: [
            { id: taskId, content: 'Buy shoes', status: 'not_started', priority: null, project: null, section: null, depth: 0, due_date: null, archived: false, parent_id: null, created_at: new Date(), updated_at: new Date() },
            { id: parentId, content: 'Fitness project tasks', status: 'not_started', priority: null, project: 'fitness', section: null, depth: 0, due_date: null, archived: false, parent_id: null, created_at: new Date(), updated_at: new Date() },
          ],
        } as any;
      }
      if (typeof sql === 'string' && sql.includes('WHERE id = $1') && params?.[0] === parentId) {
        return {
          rows: [{ id: parentId, content: 'Fitness project tasks', depth: 0, project: 'fitness', section: null, status: 'not_started', priority: null, parent_id: null, archived: false, created_at: new Date(), updated_at: new Date(), source: 'test', source_context: null, embedding: [], metadata: null, due_date: null }],
        } as any;
      }
      if (typeof sql === 'string' && sql.includes('parent_id = $1') && sql.includes('depth = $2')) {
        return { rows: [] } as any;
      }
      if (typeof sql === 'string' && sql.includes('WHERE parent_id = $1') && !sql.includes('status')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(4003, 'move buy shoes under fitness project'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Moved');
    expect(reply.text).toContain('Buy shoes');
  });
});
