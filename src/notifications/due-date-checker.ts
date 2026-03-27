// src/notifications/due-date-checker.ts
import type { DbClient } from '../db/client.js';
import type { Config } from '../config.js';
import type { ReminderRow } from '../db/reminders.js';
import { formatRemindersMarkdown } from './format-reminders.js';
import { getConsolidationLogsSince } from '../db/consolidation-log.js';
import { findFactsCreatedSince } from '../db/facts.js';
import { findInsightsCreatedSince } from '../db/insights.js';
import { countCapturesCreatedSince, countCapturesArchivedSince } from '../db/captures.js';
import { findPendingReviewFacts } from '../db/facts.js';
import { findPendingReviewInsights } from '../db/insights.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

/**
 * Get current Date components in a given IANA timezone.
 */
export function getNowInTimezone(timezone: string, now?: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const d = now ?? new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/**
 * Get start and end of a day in a given timezone, as UTC Date objects.
 */
export function getDayBoundsInTimezone(timezone: string, now?: Date): { start: Date; end: Date } {
  const { year, month, day } = getNowInTimezone(timezone, now);
  // Create dates using the timezone offset
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Use Intl to figure out the offset for start-of-day
  const startLocal = new Date(`${dateStr}T00:00:00`);
  const endLocal = new Date(`${dateStr}T23:59:59.999`);

  // Convert from timezone-local to UTC by calculating the offset
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const formatted = formatter.format(startLocal);
  // Extract offset like "GMT-5" or "GMT+5:30"
  const offsetMatch = formatted.match(/GMT([+-]\d{1,2}(?::?\d{2})?)/);
  let offsetMinutes = 0;
  if (offsetMatch) {
    const offsetStr = offsetMatch[1];
    const [hours, mins] = offsetStr.split(':').map(Number);
    offsetMinutes = (hours ?? 0) * 60 + (Math.sign(hours ?? 0) * (mins ?? 0));
  }

  const start = new Date(startLocal.getTime() - offsetMinutes * 60_000);
  const end = new Date(endLocal.getTime() - offsetMinutes * 60_000);
  return { start, end };
}

/**
 * Format a due notification line for a single reminder.
 */
export function formatDueNotification(reminder: ReminderRow): string {
  const priority = reminder.priority ? ` [${reminder.priority}]` : '';
  const project = reminder.project ? ` (project: ${reminder.project})` : '';
  return `⏰ Reminder due: "${reminder.content}"${priority}${project}`;
}

// ---------------------------------------------------------------------------
// Due Date Checker — notifies on individual due reminders
// ---------------------------------------------------------------------------

export interface DueDateCheckerDeps {
  db: DbClient;
  config: Config;
  sendMessage?: (botToken: string, chatId: string, text: string) => Promise<void>;
}

export async function checkDueReminders(deps: DueDateCheckerDeps): Promise<number> {
  const { db, config } = deps;
  const send = deps.sendMessage ?? sendTelegramMessage;

  const result = await db.query(
    `SELECT * FROM reminders
     WHERE due_date IS NOT NULL
       AND due_date <= now()
       AND status NOT IN ('done', 'cancelled')
       AND archived = false
       AND (metadata->>'notified' IS NULL OR metadata->>'notified' != 'true')`,
    [],
  );

  const reminders: ReminderRow[] = result.rows;
  console.log(`[due-date-checker] Checking... found ${reminders.length} due reminder${reminders.length === 1 ? '' : 's'}`);

  if (reminders.length === 0) {
    return 0;
  }

  for (const reminder of reminders) {
    const message = formatDueNotification(reminder);
    console.log(`[due-date-checker] Sending notification for reminder ${reminder.id}: "${reminder.content}"`);
    await send(config.telegramBotToken, config.telegramChatId, message);

    // Mark as notified
    const metadata = reminder.metadata ?? {};
    metadata.notified = 'true';
    await db.query(
      `UPDATE reminders SET metadata = $1, updated_at = now() WHERE id = $2`,
      [JSON.stringify(metadata), reminder.id],
    );
  }

  return reminders.length;
}

export function startDueDateChecker(deps: DueDateCheckerDeps): NodeJS.Timeout {
  return setInterval(() => {
    checkDueReminders(deps).catch((err) => {
      console.error('Due date checker error:', err);
    });
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Daily Report — sends a "due today" digest at a configured time
// ---------------------------------------------------------------------------

export interface DailyReportDeps {
  db: DbClient;
  config: Config;
  sendMessage?: (botToken: string, chatId: string, text: string) => Promise<void>;
}

let lastReportDate: string | null = null;

/** Exposed for testing — reset the internal last-report-date tracker. */
export function _resetLastReportDate(): void {
  lastReportDate = null;
}

export async function checkDailyReport(deps: DailyReportDeps, now?: Date): Promise<boolean> {
  const { db, config } = deps;
  const send = deps.sendMessage ?? sendTelegramMessage;

  const { year, month, day, hour, minute } = getNowInTimezone(config.timezone, now);
  const [targetHour, targetMinute] = config.dailyReportTime.split(':').map(Number);

  if (hour !== targetHour || minute !== targetMinute) {
    return false;
  }

  const todayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (lastReportDate === todayStr) {
    return false; // Already sent today
  }

  const { start, end } = getDayBoundsInTimezone(config.timezone, now);
  const since = new Date((now ?? new Date()).getTime() - 24 * 60 * 60 * 1000);

  // Run all queries in parallel
  const [
    dueToday,
    overdue,
    consolidationLogs,
    newFacts,
    newInsights,
    capturesNew,
    capturesArchived,
    pendingFacts,
    pendingInsights,
  ] = await Promise.all([
    db.query(
      `SELECT * FROM reminders
       WHERE due_date IS NOT NULL
         AND due_date >= $1 AND due_date <= $2
         AND status NOT IN ('done', 'cancelled')
         AND archived = false
       ORDER BY due_date ASC`,
      [start, end],
    ),
    db.query(
      `SELECT * FROM reminders
       WHERE due_date IS NOT NULL
         AND due_date < $1
         AND status NOT IN ('done', 'cancelled')
         AND archived = false
       ORDER BY due_date ASC`,
      [start],
    ),
    getConsolidationLogsSince(db, since),
    findFactsCreatedSince(db, since),
    findInsightsCreatedSince(db, since),
    countCapturesCreatedSince(db, since),
    countCapturesArchivedSince(db, since),
    findPendingReviewFacts(db, 100),
    findPendingReviewInsights(db, 100),
  ]);

  const dueTodayReminders: ReminderRow[] = dueToday.rows;
  const overdueReminders: ReminderRow[] = overdue.rows;
  const pendingReview = pendingFacts.length + pendingInsights.length;

  const lines: string[] = ['📋 *Daily Report*', ''];

  // Brain activity section (always shown)
  const successCount = consolidationLogs.filter(l => l.status === 'success').length;
  const noOpCount = consolidationLogs.filter(l => l.status === 'no-op').length;
  const failedCount = consolidationLogs.filter(l => l.status === 'failed' || l.status === 'partial').length;

  lines.push('🧠 *Brain Activity (last 24h)*');

  const consolidationParts = [`${consolidationLogs.length} runs`];
  if (consolidationLogs.length > 0) {
    const details: string[] = [];
    if (successCount > 0) details.push(`${successCount} success`);
    if (noOpCount > 0) details.push(`${noOpCount} skipped`);
    if (failedCount > 0) details.push(`${failedCount} failed`);
    consolidationParts.push(`(${details.join(', ')})`);
  }
  lines.push(`  Consolidations: ${consolidationParts.join(' ')}`);
  lines.push(`  Captures: ${capturesNew} new, ${capturesArchived} archived`);

  lines.push(`  Facts: ${newFacts.length} new`);
  for (const f of newFacts) {
    // Truncate long facts to keep the report readable
    const summary = f.content.length > 80 ? f.content.slice(0, 77) + '...' : f.content;
    lines.push(`    • ${summary}`);
  }

  lines.push(`  Insights: ${newInsights.length} new`);
  for (const i of newInsights) {
    const summary = i.content.length > 80 ? i.content.slice(0, 77) + '...' : i.content;
    lines.push(`    • ${summary}`);
  }

  if (pendingReview > 0) {
    lines.push(`  ⚡ ${pendingReview} items need your review`);
  }

  lines.push('');

  // Reminders section
  if (overdueReminders.length > 0) {
    lines.push(`🔴 *Overdue (${overdueReminders.length})*`);
    lines.push(formatRemindersMarkdown(overdueReminders));
    lines.push('');
  }

  if (dueTodayReminders.length > 0) {
    lines.push(`📅 *Due Today (${dueTodayReminders.length})*`);
    lines.push(formatRemindersMarkdown(dueTodayReminders));
    lines.push('');
  }

  if (overdueReminders.length === 0 && dueTodayReminders.length === 0) {
    lines.push('📅 No reminders due today');
    lines.push('');
  }

  lines.push(`_${todayStr} | ${config.timezone}_`);

  await send(config.telegramBotToken, config.telegramChatId, lines.join('\n'));
  lastReportDate = todayStr;
  return true;
}

export function startDailyReport(deps: DailyReportDeps): NodeJS.Timeout {
  return setInterval(() => {
    checkDailyReport(deps).catch((err) => {
      console.error('Daily report error:', err);
    });
  }, 60_000);
}
