// tests/unit/telegram/intent-classification.test.ts — Section 18: Intent classification
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, type AppDeps } from '../../../src/app.js';

// Mock grammy to intercept bot handlers
let registeredHandlers: Map<string, Function> = new Map();
let registeredOnHandlers: Map<string, Function> = new Map();

vi.mock('grammy', () => {
  const MockBot = vi.fn().mockImplementation(() => ({
    command: vi.fn((name: string, handler: Function) => {
      registeredHandlers.set(name, handler);
    }),
    on: vi.fn((filter: string, handler: Function) => {
      registeredOnHandlers.set(filter, handler);
    }),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    handleUpdate: vi.fn().mockResolvedValue(undefined),
    api: { getFile: vi.fn() },
  }));
  return {
    Bot: MockBot,
    webhookCallback: vi.fn(),
    InlineKeyboard: vi.fn().mockImplementation(() => ({
      text: vi.fn().mockReturnThis(),
      row: vi.fn().mockReturnThis(),
    })),
  };
});

// Mock capture pipeline
vi.mock('../../../src/capture/pipeline.js', () => ({
  runCapturePipeline: vi.fn().mockResolvedValue({ success: true, captureId: 'cap-test' }),
}));

import { runCapturePipeline } from '../../../src/capture/pipeline.js';

const mockRunCapturePipeline = vi.mocked(runCapturePipeline);

function makeDeps(): AppDeps {
  return {
    db: {
      pool: {},
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
      close: vi.fn(),
    },
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
      telegramWebhookSecret: 'secret',
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

function makeCtx(text: string) {
  return {
    message: { text, chat: { id: 999 } },
    chat: { id: 999 },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  registeredHandlers = new Map();
  registeredOnHandlers = new Map();
  vi.clearAllMocks();
});

describe('Section 18: Intent Classification', () => {
  it('18.1 LLM returns {action: "create_reminder"} → reminder is created', async () => {
    const deps = makeDeps();
    (deps.metadataLLM.complete as any).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'create_reminder', content: 'Buy milk', project: null, priority: null, category: 'personal', dueDate: null }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    // Mock insertReminder
    (deps.db.query as any).mockResolvedValue({ rows: [{ id: 'rem-new' }] });

    createApp(deps);
    const handler = registeredOnHandlers.get('message:text');
    expect(handler).toBeDefined();

    const ctx = makeCtx('I need to buy milk');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('reminder'));
  });

  it('18.2 LLM returns {action: "list_reminders"} → reminders are listed', async () => {
    const deps = makeDeps();
    (deps.metadataLLM.complete as any).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'list_reminders', project: null, status: null, dueFilter: null }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    // Mock findActiveReminders returning empty
    (deps.db.query as any).mockResolvedValue({ rows: [] });

    createApp(deps);
    const handler = registeredOnHandlers.get('message:text');

    const ctx = makeCtx('What are my todos?');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No active reminders'));
  });

  it('18.3 LLM returns {action: "complete_reminder"} → reminder is completed', async () => {
    const deps = makeDeps();
    (deps.metadataLLM.complete as any).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'complete_reminder', taskSearch: 'buy milk' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    // Mock findActiveReminders returning a matching reminder
    (deps.db.query as any)
      .mockResolvedValueOnce({
        rows: [{ id: 'rem-1', content: 'Buy milk', status: 'not_started', depth: 0, project: null, priority: null, section: null, parent_id: null, archived: false, due_date: null, created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValue({ rows: [] }); // completeReminder update

    createApp(deps);
    const handler = registeredOnHandlers.get('message:text');

    const ctx = makeCtx('I finished buying milk');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Done'));
  });

  it('18.4 LLM returns {action: "capture_thought"} → capture pipeline is called', async () => {
    const deps = makeDeps();
    (deps.metadataLLM.complete as any).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'capture_thought' }),
      tokensUsed: { input: 10, output: 10, total: 20 },
    });

    mockRunCapturePipeline.mockResolvedValueOnce({ success: true, captureId: 'cap-thought' });

    createApp(deps);
    const handler = registeredOnHandlers.get('message:text');

    const ctx = makeCtx('I love pizza');
    await handler!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Captured'));
  });

  it('18.5 "undo" text → fast path, no LLM call', async () => {
    const deps = makeDeps();

    createApp(deps);
    const handler = registeredOnHandlers.get('message:text');

    const ctx = makeCtx('undo');
    await handler!(ctx);

    // LLM should NOT have been called
    expect(deps.metadataLLM.complete).not.toHaveBeenCalled();
    // Should reply about nothing to undo
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Nothing to undo'));
  });

  it('18.6 LLM throws → defaults to capture_thought (not crash)', async () => {
    const deps = makeDeps();
    (deps.metadataLLM.complete as any).mockRejectedValueOnce(new Error('LLM API timeout'));

    mockRunCapturePipeline.mockResolvedValueOnce({ success: true, captureId: 'cap-fallback' });

    createApp(deps);
    const handler = registeredOnHandlers.get('message:text');

    const ctx = makeCtx('Some random text');
    await handler!(ctx);

    // Should have fallen back to capture
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Captured'));
  });
});
