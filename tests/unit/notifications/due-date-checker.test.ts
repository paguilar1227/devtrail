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

  it('sends report when time matches and there are due reminders', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:30Z');

    const reminder = makeReminder({ content: 'Due today task' });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [reminder], command: 'SELECT', rowCount: 1, oid: 0, fields: [] }) // due today
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }); // overdue

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sent = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('bot-token', '12345', expect.stringContaining('Daily Report'));
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

    const reminder = makeReminder({ content: 'Task' });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [reminder], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await checkDailyReport({ db, config, sendMessage }, now);
    const sent2 = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent2).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('returns false when no reminders are due or overdue', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

    const sendMessage = vi.fn();
    const sent = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('includes overdue section when there are overdue reminders', async () => {
    const db = mockDb();
    const config = makeConfig({ timezone: 'UTC', dailyReportTime: '09:00' });
    const now = new Date('2026-03-15T09:00:00Z');

    const overdueReminder = makeReminder({ content: 'Overdue task', due_date: new Date('2026-03-13T10:00:00Z') });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] }) // due today
      .mockResolvedValueOnce({ rows: [overdueReminder], command: 'SELECT', rowCount: 1, oid: 0, fields: [] }); // overdue

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sent = await checkDailyReport({ db, config, sendMessage }, now);

    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'bot-token', '12345',
      expect.stringContaining('Overdue'),
    );
  });
});
