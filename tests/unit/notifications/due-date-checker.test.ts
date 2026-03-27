// tests/unit/notifications/due-date-checker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { Config } from '../../../src/config.js';
import {
  getNowInTimezone,
  formatDueNotification,
  checkDueReminders,
  checkDailyReport,
  _resetLastReportDate,
} from '../../../src/notifications/due-date-checker.js';
import type { ReminderRow } from '../../../src/db/reminders.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgresql://localhost/test',
    apiKey: 'key',
    azureStorageConnectionString: 'conn',
    azureStorageContainer: 'cont',
    geminiApiKey: 'gem',
    anthropicApiKey: 'ant',
    telegramBotToken: 'bot-token',
    telegramWebhookSecret: 'secret',
    telegramChatId: '12345',
    port: 3000,
    nodeEnv: 'test',
    reviewMode: 'hybrid',
    dailyDigestEnabled: true,
    timezone: 'America/Chicago',
    dailyReportTime: '09:00',
    ...overrides,
  };
}

function makeReminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 'rem-001',
    content: 'Test task',
    embedding: [],
    metadata: null,
    category: null,
    project: null,
    section: null,
    parent_id: null,
    depth: 0,
    status: 'not_started',
    priority: null,
    source_context: null,
    source: 'telegram',
    archived: false,
    due_date: new Date('2026-03-15T14:00:00Z'),
    created_at: new Date('2026-03-14T10:00:00Z'),
    updated_at: new Date('2026-03-14T10:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getNowInTimezone
// ---------------------------------------------------------------------------

describe('getNowInTimezone', () => {
  it('returns components for America/Chicago', () => {
    // 2026-03-15T15:30:00Z = 10:30 CDT (UTC-5 during DST)
    const result = getNowInTimezone('America/Chicago', new Date('2026-03-15T15:30:00Z'));
    expect(result.hour).toBe(10);
    expect(result.minute).toBe(30);
    expect(result.year).toBe(2026);
  });

  it('returns components for UTC', () => {
    const result = getNowInTimezone('UTC', new Date('2026-03-15T09:00:00Z'));
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatDueNotification
// ---------------------------------------------------------------------------

describe('formatDueNotification', () => {
  it('formats basic reminder', () => {
    const r = makeReminder({ content: 'Buy groceries' });
    expect(formatDueNotification(r)).toBe('⏰ Reminder due: "Buy groceries"');
  });

  it('includes priority tag', () => {
    const r = makeReminder({ content: 'Fix bug', priority: 'P1' });
    expect(formatDueNotification(r)).toContain('[P1]');
  });

  it('includes project', () => {
    const r = makeReminder({ content: 'Prep meals', project: 'meals' });
    expect(formatDueNotification(r)).toContain('(project: meals)');
  });

  it('includes both priority and project', () => {
    const r = makeReminder({ content: 'Deploy', priority: 'P1', project: 'work' });
    const result = formatDueNotification(r);
    expect(result).toBe('⏰ Reminder due: "Deploy" [P1] (project: work)');
  });
});

// ---------------------------------------------------------------------------
// checkDueReminders
// ---------------------------------------------------------------------------

describe('checkDueReminders', () => {
  it('sends notifications for due reminders and marks them notified', async () => {
    const db = mockDb();
    const reminder = makeReminder({ id: 'rem-due', content: 'Due task' });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [reminder], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();

    const count = await checkDueReminders({ db, config, sendMessage });

    expect(count).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('bot-token', '12345', expect.stringContaining('Due task'));
    // Verify metadata update
    const updateCall = vi.mocked(db.query).mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE reminders SET metadata');
    expect(updateCall[1]?.[0]).toContain('"notified":"true"');
  });

  it('returns 0 when no reminders are due', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

    const sendMessage = vi.fn();
    const count = await checkDueReminders({ db, config: makeConfig(), sendMessage });

    expect(count).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('preserves existing metadata when marking notified', async () => {
    const db = mockDb();
    const reminder = makeReminder({ id: 'rem-meta', metadata: { customField: 'value' } });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [reminder], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDueReminders({ db, config: makeConfig(), sendMessage });

    const updateCall = vi.mocked(db.query).mock.calls[1];
    const metadataStr = updateCall[1]?.[0] as string;
    expect(metadataStr).toContain('"customField":"value"');
    expect(metadataStr).toContain('"notified":"true"');
  });
});

// ---------------------------------------------------------------------------
// checkDailyReport
// ---------------------------------------------------------------------------

describe('checkDailyReport', () => {
  beforeEach(() => {
    _resetLastReportDate();
  });

  // Helper: mock all 9 parallel queries that checkDailyReport runs
  function mockDailyReportQueries(
    db: DbClient,
    opts: {
      dueToday?: ReminderRow[];
      overdue?: ReminderRow[];
      consolidationLogs?: Array<{ status: string }>;
      facts?: Array<{ id: string; content: string; tags: string[] }>;
      insights?: Array<{ id: string; content: string; tags: string[] }>;
      capturesNew?: number;
      capturesArchived?: number;
      pendingFacts?: unknown[];
      pendingInsights?: unknown[];
    } = {},
  ) {
    const emptyResult = { rows: [], command: 'SELECT' as const, rowCount: 0, oid: 0, fields: [] };
    const queryMock = vi.mocked(db.query);
    // The 9 Promise.all queries resolve in parallel, so mock in order:
    // 1. due today, 2. overdue, 3. consolidation logs, 4. facts since,
    // 5. insights since, 6. captures new count, 7. captures archived count,
    // 8. pending facts, 9. pending insights
    queryMock
      .mockResolvedValueOnce({ ...emptyResult, rows: opts.dueToday ?? [] })
      .mockResolvedValueOnce({ ...emptyResult, rows: opts.overdue ?? [] })
      .mockResolvedValueOnce({ ...emptyResult, rows: opts.consolidationLogs ?? [] })
      .mockResolvedValueOnce({ ...emptyResult, rows: opts.facts ?? [] })
      .mockResolvedValueOnce({ ...emptyResult, rows: opts.insights ?? [] })
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ count: opts.capturesNew ?? 0 }] })
      .mockResolvedValueOnce({ ...emptyResult, rows: [{ count: opts.capturesArchived ?? 0 }] })
      .mockResolvedValueOnce({ ...emptyResult, rows: opts.pendingFacts ?? [] })
      .mockResolvedValueOnce({ ...emptyResult, rows: opts.pendingInsights ?? [] });
  }

  it('sends report at configured time with brain activity', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:30Z');

    mockDailyReportQueries(db, {
      dueToday: [makeReminder({ content: 'Due today task' })],
      consolidationLogs: [{ status: 'success' }],
      capturesNew: 3,
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sent = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][2];
    expect(msg).toContain('Daily Report');
    expect(msg).toContain('Brain Activity');
    expect(msg).toContain('1 runs');
    expect(msg).toContain('3 new');
  });

  it('does not send when time does not match', async () => {
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T10:00:00Z');
    const db = mockDb();
    const sendMessage = vi.fn();

    const sent = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send twice on the same day', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db);

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);
    const sent2 = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent2).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('always sends even with no reminders or activity', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db); // all zeros/empty

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sent = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent).toBe(true);
    const msg = sendMessage.mock.calls[0][2];
    expect(msg).toContain('Brain Activity');
    expect(msg).toContain('0 runs');
    expect(msg).toContain('0 new, 0 archived');
    expect(msg).toContain('No reminders due today');
  });

  it('includes overdue section when there are overdue reminders', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db, {
      overdue: [makeReminder({ content: 'Overdue task', due_date: new Date('2026-03-13T10:00:00Z') })],
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sent = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'bot-token', '12345',
      expect.stringContaining('Overdue'),
    );
  });

  it('shows fact and insight summaries in brain activity', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db, {
      facts: [
        { id: 'f1', content: 'Alex prefers TypeScript over JavaScript', tags: ['preference'] },
      ],
      insights: [
        { id: 'i1', content: 'Alex consistently favors tools with first-class TS support', tags: ['pattern'] },
      ],
      consolidationLogs: [{ status: 'success' }, { status: 'no-op' }],
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);

    const msg = sendMessage.mock.calls[0][2];
    expect(msg).toContain('Facts: 1 new');
    expect(msg).toContain('Alex prefers TypeScript');
    expect(msg).toContain('Insights: 1 new');
    expect(msg).toContain('Alex consistently favors');
    expect(msg).toContain('1 success');
    expect(msg).toContain('1 skipped');
  });

  it('shows pending review count', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db, {
      pendingFacts: [{ id: 'pf1' }, { id: 'pf2' }],
      pendingInsights: [{ id: 'pi1' }],
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);

    const msg = sendMessage.mock.calls[0][2];
    expect(msg).toContain('3 items need your review');
  });

  it('truncates fact/insight content longer than 80 characters', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    const longContent = 'Alex has a very specific and detailed preference about how to structure TypeScript projects with monorepos and shared libraries';
    mockDailyReportQueries(db, {
      facts: [{ id: 'f1', content: longContent, tags: ['preference'] }],
      insights: [{ id: 'i1', content: longContent, tags: ['pattern'] }],
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);

    const msg = sendMessage.mock.calls[0][2];
    // Should end with "..." and NOT contain the full 125-char string
    expect(msg).not.toContain(longContent);
    expect(msg).toContain(longContent.slice(0, 77) + '...');
  });

  it('shows correct consolidation breakdown with success, skipped, and failed', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db, {
      consolidationLogs: [
        { status: 'success' },
        { status: 'success' },
        { status: 'no-op' },
        { status: 'failed' },
        { status: 'partial' },
      ],
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);

    const msg = sendMessage.mock.calls[0][2];
    expect(msg).toContain('5 runs');
    expect(msg).toContain('2 success');
    expect(msg).toContain('1 skipped');
    expect(msg).toContain('2 failed'); // failed + partial both count as failed
  });

  it('omits consolidation detail parenthetical when there are 0 runs', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db); // zero consolidation logs

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);

    const msg = sendMessage.mock.calls[0][2];
    // Should say "0 runs" but NOT have a "()" breakdown
    expect(msg).toContain('Consolidations: 0 runs');
    expect(msg).not.toMatch(/0 runs \(/);
  });

  it('omits pending review line when count is 0', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db); // no pending review items

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);

    const msg = sendMessage.mock.calls[0][2];
    expect(msg).not.toContain('items need your review');
  });

  it('shows both due today and overdue sections when both exist', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    mockDailyReportQueries(db, {
      dueToday: [makeReminder({ content: 'Ship feature' })],
      overdue: [makeReminder({ content: 'Pay invoice', due_date: new Date('2026-03-13T10:00:00Z') })],
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await checkDailyReport({ db, config, sendMessage }, now);

    const msg = sendMessage.mock.calls[0][2];
    expect(msg).toContain('Overdue (1)');
    expect(msg).toContain('Due Today (1)');
    // Should NOT show "No reminders due today" when there ARE reminders
    expect(msg).not.toContain('No reminders due today');
  });
});
