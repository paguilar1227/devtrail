// tests/integration/telegram-nl.test.ts — Natural Language, Undo, Subtasks & Display
//
// Split from telegram-pipeline.test.ts to fix OOM (each test creates a full app instance).
// Sections: Natural Language (T8-T12), Undo (T13, T13b), Subtasks & Display (T16-T25)
// See telegram-pipeline.test.ts for Thought Capture (T1-T2), Slash Commands (T3-T7), Error Handling (T14-T15)
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
      // Handle callback queries (inline keyboard button presses)
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
              telegramReplies.push({
                chat_id: chatId,
                text,
                reply_markup: options?.reply_markup,
              });
              return { message_id: telegramReplies.length };
            }),
          };
          try {
            await this.callbackQueryHandler(ctx);
          } catch (err) {
            if (this.errorHandler) {
              this.errorHandler({ error: err, ctx });
            } else {
              throw err;
            }
          }
        }
        return;
      }

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
      if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('reminders') && sql.includes('archived = false') && !sql.includes('parent_id')) {
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
      if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('reminders') && sql.includes('archived = false') && !sql.includes('parent_id')) {
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

  it('T13b: Create via /remind slash command, then "undo" → deletes the reminder', async () => {
    const deps = makeDeps();
    const insertedId = 'rem-slash-undo-12345678';

    // Mock LLM for /remind parser
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ content: 'Buy shoes', project: null, section: null, priority: null, category: 'personal', dueDate: null }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: insertedId }] } as any;
      }
      if (typeof sql === 'string' && sql.includes('SELECT id FROM reminders WHERE parent_id')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);

    // Step 1: Create via /remind
    await sendWebhookUpdate(app, textUpdate(1080, '/remind Buy shoes', 42));
    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    expect(telegramReplies[telegramReplies.length - 1].text).toContain('Reminder created');

    // Step 2: Undo
    await sendWebhookUpdate(app, textUpdate(1081, 'undo', 42));
    expect(telegramReplies.length).toBeGreaterThanOrEqual(2);
    const undoReply = telegramReplies[telegramReplies.length - 1];
    expect(undoReply.text).toContain('Undone');
    expect(undoReply.text).toContain('deleted the reminder');
  });
});

// ─── Subtasks & Display ──────────────────────────────────────────────────────

describe('Telegram Pipeline — Subtasks & Display', () => {
  it('T16: /subtask command shows reminders with ➕ buttons', async () => {
    const deps = makeDeps();

    // DB returns active top-level reminders when /subtask queries findActiveReminders
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('not_started')) {
        return {
          rows: [
            {
              id: 'rem-work-aabbccdd',
              content: 'Write project proposal',
              status: 'not_started',
              priority: 'P1',
              project: 'work',
              section: null,
              depth: 0,
              due_date: null,
              archived: false,
              parent_id: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(2001, '/subtask'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Select a reminder to add a subtask to');
  });

  it('T17: Pending subtask state — next message creates subtask under parent', async () => {
    const parentId = 'rem-parent-11223344';
    const newSubtaskId = 'rem-sub-aabb1122';
    const deps = makeDeps();

    // Step 1 DB mock — callback_query handler calls getReminderById and findSubtasks
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: any[]) => {
      // insertReminder — must come first because INSERT SQL also contains "parent_id" in column list
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: newSubtaskId }] } as any;
      }
      // findSubtasks — SELECT WHERE parent_id = $1
      if (typeof sql === 'string' && sql.includes('WHERE parent_id')) {
        return { rows: [] } as any;
      }
      // getReminderById — SELECT * FROM reminders WHERE id = $1
      if (typeof sql === 'string' && sql.includes('WHERE id = $1') && params?.[0] === parentId) {
        return {
          rows: [
            {
              id: parentId,
              content: 'Write project proposal',
              status: 'not_started',
              priority: 'P1',
              project: 'work',
              section: 'backend',
              depth: 0,
              due_date: null,
              archived: false,
              parent_id: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);

    // Step 1: Press the ➕ button for the parent (callback_query)
    await sendWebhookUpdate(app, callbackQueryUpdate(2002, `subtask:${parentId}`));

    // Step 2: Type the subtask content (text message)
    await sendWebhookUpdate(app, textUpdate(2003, 'Write unit tests'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Subtask added');

    // Verify insertReminder was called with the correct parent_id
    const insertCall = vi.mocked(deps.db.query).mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO reminders'),
    );
    expect(insertCall).toBeDefined();
    // The INSERT parameters should include the parentId — check the values array
    // insertReminder passes values positionally; parent_id is one of the params
    const insertParams = insertCall![1] as any[];
    expect(insertParams).toContain(parentId);
  });

  it('T18: Creation confirmation shows formatted view with ID and project', async () => {
    const deps = makeDeps();

    // LLM parses the remind command with project and priority
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        content: 'Deploy new API endpoint',
        project: 'work',
        section: 'backend',
        priority: 'P1',
        category: 'work',
        dueDate: null,
      }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: 'rem-deploy-abcdef12' }] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(2004, '/remind [project:work, section:backend] Deploy new API endpoint P1'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    // Formatted confirmation includes: short ID (8 chars), priority tag, project line
    expect(reply.text).toContain('rem-depl'); // first 8 chars of 'rem-deploy-abcdef12'
    expect(reply.text).toContain('P1');
    expect(reply.text).toContain('work');
    expect(reply.text).toContain('Reminder created');
  });

  it('T19: Subtasks inherit project/section from parent', async () => {
    const parentId = 'rem-inherit-99887766';
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: any[]) => {
      // insertReminder — must come first because INSERT SQL also contains "parent_id" in column list
      if (typeof sql === 'string' && sql.includes('INSERT INTO reminders')) {
        return { rows: [{ id: 'rem-inherited-sub-001' }] } as any;
      }
      // findSubtasks — SELECT WHERE parent_id = $1
      if (typeof sql === 'string' && sql.includes('WHERE parent_id')) {
        return { rows: [] } as any;
      }
      // getReminderById — SELECT * FROM reminders WHERE id = $1
      if (typeof sql === 'string' && sql.includes('WHERE id = $1') && params?.[0] === parentId) {
        return {
          rows: [
            {
              id: parentId,
              content: 'Build authentication module',
              status: 'not_started',
              priority: 'P2',
              project: 'work',
              section: 'backend',
              depth: 0,
              due_date: null,
              archived: false,
              parent_id: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);

    // Press ➕ button to select parent
    await sendWebhookUpdate(app, callbackQueryUpdate(2005, `subtask:${parentId}`));

    // Type the subtask
    await sendWebhookUpdate(app, textUpdate(2006, 'Add JWT token validation'));

    // Verify the INSERT call included project='work' and section='backend'
    const insertCall = vi.mocked(deps.db.query).mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO reminders'),
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as any[];
    expect(insertParams).toContain('work');
    expect(insertParams).toContain('backend');
    expect(insertParams).toContain(parentId);
  });

  it('T20: Max depth enforcement — reject subtask at depth >= 3', async () => {
    const deepParentId = 'rem-deep-depth3-aabb';
    const deps = makeDeps();

    // Parent is at depth 3 — should be rejected
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: any[]) => {
      // getReminderById — SELECT * FROM reminders WHERE id = $1
      if (typeof sql === 'string' && sql.includes('WHERE id = $1') && params?.[0] === deepParentId) {
        return {
          rows: [
            {
              id: deepParentId,
              content: 'Deeply nested task',
              status: 'not_started',
              priority: null,
              project: 'work',
              section: null,
              depth: 3,
              due_date: null,
              archived: false,
              parent_id: 'some-grandparent',
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);

    // Attempt to add subtask to a depth-3 parent via callback
    await sendWebhookUpdate(app, callbackQueryUpdate(2007, `subtask:${deepParentId}`));

    // The answerCallbackQuery will have been called with the max-depth error,
    // but since it's on ctx (not ctx.reply), we check that NO reply text
    // was sent (the handler uses answerCallbackQuery, not reply, for this error).
    // The important thing is no subtask state is set — verify via no telegramReplies
    // from the callback handler itself, and that a subsequent text message does NOT
    // get treated as a subtask (it should fall through to the intent classifier).
    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'capture_thought' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('similarity')) return { rows: [] } as any;
      if (typeof sql === 'string' && sql.includes('INSERT INTO captures')) {
        return { rows: [{ id: 'cap-not-subtask-1234' }] } as any;
      }
      return { rows: [] } as any;
    });

    await sendWebhookUpdate(app, textUpdate(2008, 'This should be captured, not a subtask'));

    // The last reply should be a capture confirmation, not a subtask reply
    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const lastReply = telegramReplies[telegramReplies.length - 1];
    expect(lastReply.text).toContain('Captured!');
    expect(lastReply.text).not.toContain('Subtask added');
  });

  it('T21: Cycle button loops through all statuses and back to not_started', async () => {
    const remId = 'rem-cycle-aabb1122';
    const deps = makeDeps();

    // Track current status as it cycles
    let currentStatus = 'not_started';
    const expectedCycle = ['in_progress', 'paused', 'blocked', 'not_started'];

    for (const expectedNext of expectedCycle) {
      vi.mocked(deps.db.query).mockReset();
      vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: any[]) => {
        if (typeof sql === 'string' && sql.includes('WHERE id = $1') && params?.[0] === remId) {
          return {
            rows: [{ id: remId, content: 'Call Nike', status: currentStatus, priority: null, project: null, section: null, depth: 0, due_date: null, archived: false, parent_id: null, created_at: new Date(), updated_at: new Date() }],
          } as any;
        }
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('reminders') && sql.includes('archived = false') && !sql.includes('parent_id')) {
          return {
            rows: [{ id: remId, content: 'Call Nike', status: expectedNext, priority: null, project: null, section: null, depth: 0, due_date: null, archived: false, parent_id: null, created_at: new Date(), updated_at: new Date() }],
          } as any;
        }
        return { rows: [] } as any;
      });

      const app = await createTestApp(deps);
      telegramReplies.length = 0;
      await sendWebhookUpdate(app, callbackQueryUpdate(3000 + expectedCycle.indexOf(expectedNext), `cycle:${remId}`));

      // Verify updateReminder was called with the expected next status
      const updateCall = vi.mocked(deps.db.query).mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE reminders SET') && sql.includes('status'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toContain(expectedNext);

      currentStatus = expectedNext;
    }

    // After full cycle, we're back to not_started
    expect(currentStatus).toBe('not_started');
  });

  it('T22: /edit command updates reminder content', async () => {
    const remId = 'rem-edit-ccdd3344';
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: any[]) => {
      // resolveReminderId — LIKE prefix match
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [{ id: remId }] } as any;
      }
      // getReminderById — for undo state
      if (typeof sql === 'string' && sql.includes('WHERE id = $1') && params?.[0] === remId) {
        return {
          rows: [{ id: remId, content: 'Call Nike', status: 'not_started', priority: null, project: null, section: null, depth: 0, due_date: null, archived: false, parent_id: null, created_at: new Date(), updated_at: new Date() }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(3002, `/edit rem-edit New content here`));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Updated');
    expect(reply.text).toContain('New content here');
  });

  it('T23: NL edit "Change the nike task to Call Adidas" updates content', async () => {
    const remId = 'rem-nl-edit-eeff5566';
    const deps = makeDeps();

    vi.mocked(deps.metadataLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'update_reminder', taskSearch: 'nike', content: 'Call Adidas' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      // findAllReminders
      if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('archived = false') && !sql.includes('parent_id') && !sql.includes('WHERE id')) {
        return {
          rows: [{ id: remId, content: 'Call Nike', status: 'not_started', priority: null, project: null, section: null, depth: 0, due_date: null, archived: false, parent_id: null, created_at: new Date(), updated_at: new Date() }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(3003, 'Change the nike task to Call Adidas'));

    // Verify updateReminder was called with content = 'Call Adidas'
    const updateCall = vi.mocked(deps.db.query).mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE reminders SET') && sql.includes('content'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain('Call Adidas');

    // Also check the embedding update was triggered
    const embeddingUpdate = vi.mocked(deps.db.query).mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE reminders SET embedding'),
    );
    expect(embeddingUpdate).toBeDefined();
  });

  it('T24: /delete command removes reminder and replies with confirmation', async () => {
    const remId = 'rem-delete-ff001122-3344-5566-7788-99aabbccddee';
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      // resolveReminderId — LIKE query
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [{ id: remId }] } as any;
      }
      // getReminderById
      if (typeof sql === 'string' && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: remId, content: 'Task to delete', status: 'not_started' }] } as any;
      }
      // findSubtasks (cascade)
      if (typeof sql === 'string' && sql.includes('parent_id')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1090, '/delete rem-dele'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('Deleted');
    expect(reply.text).toContain('Task to delete');
  });

  it('T25: /delete with invalid ID replies with error', async () => {
    const deps = makeDeps();

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('LIKE')) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const app = await createTestApp(deps);
    await sendWebhookUpdate(app, textUpdate(1091, '/delete nonexistent'));

    expect(telegramReplies.length).toBeGreaterThanOrEqual(1);
    const reply = telegramReplies[telegramReplies.length - 1];
    expect(reply.text).toContain('No reminder found');
  });

  // T26-T28 cascade done + move tests are in telegram-cascade-move.test.ts
  // (split to avoid OOM in test runner)
});
