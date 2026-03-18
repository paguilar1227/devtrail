// tests/integration/telegram-pipeline.test.ts — Telegram webhook → intent → action → reply pipeline
//
// Tests the full pipeline: POST fake Telegram update JSON → bot processes it → bot replies via
// Telegram API. We mock grammy's Bot to intercept API calls while preserving real handler
// registration and execution. This tests ALL our webhook handler code without touching Telegram.
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Store a reference to the latest Bot instance so tests can access handleUpdate
let latestBotInstance: any = null;

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
      latestBotInstance = this;
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

    async init() {
      // No-op — botInfo is already set in constructor
    }

    async handleUpdate(update: any) {
      if (!update.message) return;

      const message = update.message;
      const text = message.text ?? '';

      // Build a context object that mimics grammy's Context
      const ctx = this._buildContext(update, message);

      try {
        // Check for command handlers first
        if (text.startsWith('/')) {
          const cmdMatch = text.match(/^\/(\w+)/);
          if (cmdMatch) {
            const cmdName = cmdMatch[1];
            const handler = this.commandHandlers.get(cmdName);
            if (handler) {
              await handler(ctx);
              return;
            }
          }
        }

        // Message type handlers
        if (message.photo && this.photoHandler) {
          await this.photoHandler(ctx);
        } else if (message.voice && this.voiceHandler) {
          await this.voiceHandler(ctx);
        } else if (message.document && this.documentHandler) {
          await this.documentHandler(ctx);
        } else if (message.text && this.messageTextHandler) {
          await this.messageTextHandler(ctx);
        }
      } catch (err) {
        if (this.errorHandler) {
          this.errorHandler({ error: err, ctx });
        } else {
          throw err;
        }
      }
    }

    private _buildContext(update: any, message: any) {
      const chat = message.chat;
      const ctx: any = {
        update,
        message,
        chat,
        reply: vi.fn(async (text: string, options?: any) => {
          telegramReplies.push({
            chat_id: chat.id,
            text,
            reply_markup: options?.reply_markup,
          });
          return { message_id: telegramReplies.length };
        }),
      };
      return ctx;
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

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
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
    ...overrides,
  } as unknown as AppDeps;
}

async function createTestApp(deps: AppDeps): Promise<Hono> {
  const app = new Hono();
  setupTelegramWebhook(app, deps);
  // bot.init() is fire-and-forget — give it a moment
  await new Promise((r) => setTimeout(r, 50));
  return app;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  telegramReplies = [];
  latestBotInstance = null;
  vi.clearAllMocks();
});

// ─── Thought Capture ────────────────────────────────────────────────────────

describe('Telegram Pipeline — Thought Capture', () => {
  it('T1: Text message "I really enjoy hiking" → bot replies "Captured! (xxxxxxxx)"', async () => {
    const deps = makeDeps();
    // Intent classifier → capture_thought
    vi.mocked(deps.metadataLLM.complete)
      .mockResolvedValueOnce({
        content: JSON.stringify({ action: 'capture_thought' }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      })
      // extractMetadata call in capture pipeline
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: 'personal', topics: ['hiking'] }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) {
        return { rows: [] } as any; // no semantic duplicates
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO captures')) {
        return { rows: [{ id: 'a1b2c3d4e5f67890' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1001, 'I really enjoy hiking'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Captured!');
    expect(reply.text).toContain('a1b2c3d4');
  });

  it('T2: Duplicate text → bot replies "Skipped: Semantic duplicate..."', async () => {
    const deps = makeDeps();
    // Intent classifier → capture_thought
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'capture_thought' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    // Semantic dedup check finds a duplicate (the SQL uses `1 - (embedding <=> ...) AS similarity`)
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) {
        return { rows: [{ id: 'existing-cap', similarity: 0.98 }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1002, 'I really enjoy hiking'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Skipped');
    expect(reply.text).toMatch(/[Ss]emantic duplicate/i);
  });
});

// ─── Reminders (Slash Commands) ─────────────────────────────────────────────

describe('Telegram Pipeline — Slash Commands', () => {
  it('T3: "/remind Buy running shoes" → bot replies with "Reminder created"', async () => {
    const deps = makeDeps();
    // LLM parser returns structured fields
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ content: 'Buy running shoes', project: null, section: null, priority: null, category: 'personal', dueDate: null }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: 'rem-shoes-12345678' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1003, '/remind Buy running shoes'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder created');
    expect(reply.text).toContain('rem-shoe');
  });

  it('T4: "/remind [project:fitness] Sign up for a 5K race P2" → reply with project + priority', async () => {
    const deps = makeDeps();
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ content: 'Sign up for a 5K race', project: 'fitness', section: null, priority: 'P2', category: 'health', dueDate: null }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: 'rem-5k-race-1234' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1004, '/remind [project:fitness] Sign up for a 5K race P2'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder created');
    expect(reply.text).toContain('fitness');
    expect(reply.text).toContain('P2');
  });

  it('T5: "/todos" → bot replies with formatted reminder list', async () => {
    const deps = makeDeps();
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
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

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1005, '/todos'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Buy running shoes');
    expect(reply.text).toContain('Sign up for 5K race');
    expect(reply.text).toContain('fitness');
  });

  it('T6: "/done <id>" → bot replies "Reminder completed!"', async () => {
    const deps = makeDeps();
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1006, '/done rem-1'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Reminder completed!');
  });

  it('T7: "/comment <id> Found a race" → bot replies "Comment added..."', async () => {
    const deps = makeDeps();
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('reminders') && sql.includes('id = $1')) {
        return { rows: [{ id: 'rem-1', content: 'Buy shoes', status: 'not_started' }] } as any;
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminder_comments')) {
        return { rows: [{ id: 'comment-abc-12345678' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1007, '/comment rem-1 Found a race'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Comment added');
  });
});

// ─── Natural Language Intent Classification ─────────────────────────────────

describe('Telegram Pipeline — Natural Language', () => {
  it('T8: "Add research protein powder to my fitness project" → NL create reminder with project', async () => {
    const deps = makeDeps();
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'create_reminder', content: 'research protein powder', project: 'fitness' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: 'rem-protein-12345678' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1008, 'Add research protein powder to my fitness project'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Interpreted as');
    expect(reply.text).toContain('new reminder');
    expect(reply.text).toContain('fitness');
    expect(reply.text).toContain('research protein powder');
  });

  it('T9: "What are my todos?" → NL list reminders', async () => {
    const deps = makeDeps();
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'list_reminders' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('not_started')) {
        return {
          rows: [
            { id: 'rem-1', content: 'Buy running shoes', status: 'not_started', priority: 'P1', project: null, section: null, depth: 0, due_date: null, archived: false, created_at: new Date(), updated_at: new Date() },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1009, 'What are my todos?'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Buy running shoes');
  });

  it('T10: "The running shoes task is done" → NL complete reminder', async () => {
    const deps = makeDeps();
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'complete_reminder', taskSearch: 'running shoes' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('not_started')) {
        return {
          rows: [
            { id: 'rem-shoes-aa112233', content: 'Buy running shoes', status: 'not_started', priority: 'P1', project: 'fitness', section: null, depth: 0, due_date: null, archived: false, created_at: new Date(), updated_at: new Date() },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1010, 'The running shoes task is done'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Interpreted as');
    expect(reply.text).toContain('task completion');
    expect(reply.text).toContain('Buy running shoes');
  });

  it('T11: "Pause the 5K race task" → NL update reminder status', async () => {
    const deps = makeDeps();
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'update_reminder', taskSearch: '5K race', status: 'paused' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('not_started')) {
        return {
          rows: [
            { id: 'rem-5k-bb112233', content: 'Sign up for a 5K race', status: 'not_started', priority: 'P2', project: 'fitness', section: null, depth: 0, due_date: null, archived: false, created_at: new Date(), updated_at: new Date() },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1011, 'Pause the 5K race task'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Interpreted as');
    expect(reply.text).toContain('task update');
    expect(reply.text).toContain('paused');
  });

  it('T12: "I think running is great for mental health" → NL capture thought', async () => {
    const deps = makeDeps();
    vi.mocked(deps.metadataLLM.complete)
      .mockResolvedValueOnce({
        content: JSON.stringify({ action: 'capture_thought' }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: 'health', topics: ['running', 'mental health'] }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) {
        return { rows: [] } as any;
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO captures')) {
        return { rows: [{ id: 'cap-running-12345678' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1012, 'I think running is great for mental health'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Captured!');
  });
});

// ─── Undo ───────────────────────────────────────────────────────────────────

describe('Telegram Pipeline — Undo', () => {
  it('T13: Create a reminder via NL, then "undo" → bot replies "Undone: deleted the reminder"', async () => {
    const deps = makeDeps();

    // First message: intent classifier → create_reminder
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'create_reminder', content: 'Buy protein bars' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    const insertedReminderId = 'rem-protein-undo1234';

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: insertedReminderId }] } as any;
      }
      if (typeof sql === 'string' && sql.includes('SELECT id FROM reminders WHERE parent_id')) {
        return { rows: [] } as any; // no children for deleteReminder cascade
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);

    // Step 1: Create the reminder via NL
    await sendWebhookUpdate(app, textUpdate(1013, 'Buy protein bars', 42));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    expect(telegramReplies[telegramReplies.length - 1].text).toContain('Interpreted as');

    // Step 2: Undo (fast-path — no LLM call)
    await sendWebhookUpdate(app, textUpdate(1014, 'undo', 42));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(2);
    const undoReply = telegramReplies[telegramReplies.length - 1];
    expect(undoReply.text).toContain('Undone');
    expect(undoReply.text).toContain('deleted the reminder');
  });
});

// ─── Error Handling ─────────────────────────────────────────────────────────

describe('Telegram Pipeline — Error Handling', () => {
  it('T14: Webhook with wrong secret → 403 (no bot processing)', async () => {
    const deps = makeDeps();
    const app = await createTestApp(deps);

    const res = await app.request('/telegram/webhook', {
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
    const deps = makeDeps();
    vi.mocked(deps.metadataLLM.complete)
      .mockResolvedValueOnce({
        content: JSON.stringify({ action: 'capture_thought' }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: 'personal' }),
        tokensUsed: { input: 10, output: 10, total: 20 },
      });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) {
        return { rows: [] } as any;
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO captures')) {
        return { rows: [{ id: 'cap-dedup-test1234' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    const update = textUpdate(9999, 'duplicate test message');

    // First request
    const res1 = await sendWebhookUpdate(app, update);
    expect(res1.status).toBe(200);

    const repliesAfterFirst = telegramReplies.length;

    // Second request with same update_id
    const res2 = await sendWebhookUpdate(app, update);
    expect(res2.status).toBe(200);

    // No additional replies for the duplicate
    expect(telegramReplies.length).toBe(repliesAfterFirst);
  });
});
