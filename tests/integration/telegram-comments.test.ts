// tests/integration/telegram-comments.test.ts — Comment view/edit/delete feature (Phase 4b)
//
// Tests:
//   TC1: action-comments callback — lists comments with edit/delete buttons per comment + add button
//   TC2: cedit callback → sets pending comment-edit state, prompts user
//   TC3: comment-edit pending state → user types new text → comment updated
//   TC4: cdel callback — instantly deletes comment, replies with confirmation
//   TC5: cdel on non-existent comment — replies with error via answerCallbackQuery
//   TC6: cadd callback — sets pending 'comment' state, prompts user
//   TC7: undo delete-comment — restores the deleted comment
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppDeps } from '../../src/app.js';

// ---------------------------------------------------------------------------
// Functional grammy mock — same pattern as the other telegram test files
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
      } catch (err) {
        if (this.errorHandler) this.errorHandler({ error: err, ctx }); else throw err;
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

// Import after mock
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

function callbackQueryUpdate(updateId: number, data: string, chatId = 42) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: chatId, is_bot: false, first_name: 'Tester' },
      message: {
        message_id: updateId,
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Select a reminder',
      },
      data,
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
      telegramBotToken: 'test:comments-token',
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

async function createTestApp(deps: AppDeps): Promise<Hono> {
  const app = new Hono();
  setupTelegramWebhook(app, deps);
  await new Promise((r) => setTimeout(r, 50));
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const REMINDER_ID = 'rem-aaaabbbb-cccc-dddd-eeee-ffff00001234';
const COMMENT_ID_1 = 'cmt-11111111-2222-3333-4444-555566667777';
const COMMENT_ID_2 = 'cmt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeee9999';

const mockReminder = {
  id: REMINDER_ID,
  content: 'Buy running shoes',
  status: 'not_started',
  priority: 'P1',
  project: 'fitness',
  section: null,
  depth: 0,
  due_date: null,
  archived: false,
  parent_id: null,
  metadata: null,
  category: null,
  source: 'telegram',
  source_context: null,
  embedding: [],
  created_at: new Date('2026-03-01T10:00:00Z'),
  updated_at: new Date('2026-03-01T10:00:00Z'),
};

const mockComments = [
  {
    id: COMMENT_ID_1,
    content: 'Checked Nike store, out of size 10',
    embedding: [],
    reminder_id: REMINDER_ID,
    source: 'telegram',
    created_at: new Date('2026-03-10T09:00:00Z'),
  },
  {
    id: COMMENT_ID_2,
    content: 'Found them online for $120',
    embedding: [],
    reminder_id: REMINDER_ID,
    source: 'telegram',
    created_at: new Date('2026-03-11T15:30:00Z'),
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  telegramReplies = [];
  latestBotInstance = null;
  vi.clearAllMocks();
});

describe('Telegram Comments — View', () => {
  it('TC1: action-comments → lists comments with numbered edit/delete buttons and add button', async () => {
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      // listComments: SELECT FROM reminder_comments WHERE reminder_id
      if (typeof sql === 'string' && sql.includes('reminder_comments') && sql.includes('reminder_id')) {
        return { rows: mockComments } as any;
      }
      // getReminder: SELECT FROM reminders WHERE id
      if (typeof sql === 'string' && sql.includes('reminders') && sql.includes('WHERE id')) {
        return { rows: [mockReminder] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3001, `action-comments:${REMINDER_ID}`));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Comments on');
    expect(reply.text).toContain('Buy running shoes');
    expect(reply.text).toContain('Checked Nike store');
    expect(reply.text).toContain('Found them online');
    expect(reply.text).toContain('1.');
    expect(reply.text).toContain('2.');
  });

  it('TC1b: action-comments on reminder with no comments → shows "No comments yet"', async () => {
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('reminder_comments') && sql.includes('reminder_id')) {
        return { rows: [] } as any;
      }
      if (typeof sql === 'string' && sql.includes('reminders') && sql.includes('WHERE id')) {
        return { rows: [mockReminder] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3002, `action-comments:${REMINDER_ID}`));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('No comments yet');
  });
});

describe('Telegram Comments — Edit', () => {
  it('TC2: cedit callback → sets pending comment-edit state, prompts user with existing content', async () => {
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      // getComment: SELECT FROM reminder_comments WHERE id
      if (typeof sql === 'string' && sql.includes('reminder_comments') && sql.includes('WHERE id')) {
        return { rows: [mockComments[0]] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3003, `cedit:${COMMENT_ID_1}`));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Editing comment');
    expect(reply.text).toContain('Checked Nike store');
    expect(reply.text).toContain('Type the new text');
  });

  it('TC3: comment-edit pending state → user types new text → updateComment called, replies "Comment updated"', async () => {
    const deps = makeDeps();

    // First: cedit callback to set pending state
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('reminder_comments') && sql.includes('WHERE id')) {
        return { rows: [mockComments[0]] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3004, `cedit:${COMMENT_ID_1}`));

    // Reset mocks for the update step — updateComment calls getCommentById first
    vi.mocked(deps.db.query).mockReset().mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('reminder_comments') && sql.includes('WHERE id')) {
        return { rows: [mockComments[0]] } as any;
      }
      return { rows: [] } as any;
    });
    vi.mocked(deps.embeddingProvider.embed).mockReset().mockResolvedValue([0.1, 0.2, 0.3]);

    // Second: user types the new text
    telegramReplies = [];
    await sendWebhookUpdate(app, textUpdate(3005, 'They had them at Fleet Feet for $95'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Comment updated');

    // updateComment should have triggered an embed + UPDATE query
    expect(vi.mocked(deps.embeddingProvider.embed)).toHaveBeenCalledWith('They had them at Fleet Feet for $95');
  });

  it('TC2b: cedit with unknown comment ID → answerCallbackQuery with error, no reply sent', async () => {
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3006, `cedit:nonexistent-id`));

    // No ctx.reply should have been sent (only answerCallbackQuery with error text)
    expect(telegramReplies.length).toBe(0);
  });
});

describe('Telegram Comments — Delete', () => {
  it('TC4: cdel callback → deletes comment, replies with confirmation', async () => {
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      // getCommentById for the delete fetch-first step
      if (typeof sql === 'string' && sql.includes('reminder_comments') && sql.includes('WHERE id')) {
        return { rows: [mockComments[0]] } as any;
      }
      // DELETE itself
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3007, `cdel:${COMMENT_ID_1}`));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Comment deleted');
    expect(reply.text).toContain('Checked Nike store');
  });

  it('TC5: cdel with unknown comment ID → answerCallbackQuery error, no reply', async () => {
    const deps = makeDeps();
    // getCommentById returns nothing → deleteComment throws
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3008, `cdel:ghost-id`));

    expect(telegramReplies.length).toBe(0);
  });
});

describe('Telegram Comments — Add via cadd', () => {
  it('TC6: cadd callback → sets pending comment state, replies "Type your comment"', async () => {
    const deps = makeDeps();
    const app = await createTestApp(deps);

    await sendWebhookUpdate(app, callbackQueryUpdate(3009, `cadd:${REMINDER_ID}`));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Type your comment');
  });
});

describe('Telegram Comments — Undo delete-comment', () => {
  it('TC7: undo after cdel → re-creates the deleted comment', async () => {
    const deps = makeDeps();

    // First: cdel to delete comment and set lastAction
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('reminder_comments') && sql.includes('WHERE id')) {
        return { rows: [mockComments[1]] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, callbackQueryUpdate(3010, `cdel:${COMMENT_ID_2}`));

    // Now mock intent classifier for the 'undo' text message
    vi.mocked(deps.db.query).mockReset().mockImplementation(async (sql: string) => {
      // getReminderById check inside addComment → reminder exists
      if (typeof sql === 'string' && sql.includes('reminders') && sql.includes('WHERE id')) {
        return { rows: [mockReminder] } as any;
      }
      // INSERT INTO reminder_comments
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminder_comments')) {
        return { rows: [{ id: 'restored-comment-id' }] } as any;
      }
      return { rows: [] } as any;
    });
    vi.mocked(deps.embeddingProvider.embed).mockResolvedValue([0.1, 0.2, 0.3]);

    telegramReplies = [];
    await sendWebhookUpdate(app, textUpdate(3011, 'undo'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Undone');
    expect(reply.text).toContain('restored comment');
  });
});
