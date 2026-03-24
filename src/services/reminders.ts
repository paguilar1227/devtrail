// src/services/reminders.ts
import type { ServiceDeps } from './index.js';
import type { ReminderRow, ReminderDetail, ListRemindersFilters } from '../db/reminders.js';
import {
  insertReminder,
  listReminders as dbListReminders,
  getReminderById,
  getReminderDetail as dbGetReminderDetail,
  updateReminder as dbUpdateReminder,
  completeReminder as dbCompleteReminder,
  deleteReminder as dbDeleteReminder,
  reparentReminder as dbReparentReminder,
  resolveReminderId as dbResolveReminderId,
  listProjects as dbListProjects,
  findActiveReminders as dbFindActiveReminders,
  findAllReminders as dbFindAllReminders,
  findSubtasks as dbFindSubtasks,
  findRemindersDueOnDate as dbFindRemindersDueOnDate,
  findOverdueReminders as dbFindOverdueReminders,
  findRecentlyCompletedReminders as dbFindRecentlyCompletedReminders,
} from '../db/reminders.js';

export type { ReminderRow, ReminderDetail, ListRemindersFilters };

export interface CreateReminderParams {
  content: string;
  project?: string | null;
  section?: string | null;
  parentId?: string | null;
  category?: string | null;
  priority?: string | null;
  dueDate?: Date | null;
  source?: string;
  sourceContext?: string | null;
}

/**
 * Embed content, validate parent depth, insert reminder.
 */
export async function createReminder(
  deps: ServiceDeps,
  params: CreateReminderParams,
): Promise<{ id: string }> {
  let depth = 0;

  if (params.parentId) {
    const parent = await getReminderById(deps.db, params.parentId);
    if (!parent) {
      throw new Error(`Parent reminder ${params.parentId} not found`);
    }
    depth = parent.depth + 1;
    if (depth >= 4) {
      throw new Error('Maximum subtask depth (4 levels) exceeded');
    }
  }

  const embedding = await deps.embeddingProvider.embed(params.content);

  return insertReminder(deps.db, {
    content: params.content,
    embedding,
    category: params.category ?? null,
    project: params.project ?? null,
    section: params.section ?? null,
    parentId: params.parentId ?? null,
    depth,
    priority: params.priority ?? null,
    source: params.source ?? 'api',
    sourceContext: params.sourceContext ?? null,
    dueDate: params.dueDate ?? null,
  });
}

/**
 * List reminders with flexible filtering.
 */
export async function listReminders(
  deps: ServiceDeps,
  filters: ListRemindersFilters,
): Promise<ReminderRow[]> {
  return dbListReminders(deps.db, filters);
}

/**
 * Return a single reminder by ID, or null if not found.
 */
export async function getReminder(
  deps: ServiceDeps,
  id: string,
): Promise<ReminderRow | null> {
  return getReminderById(deps.db, id);
}

/**
 * Return a reminder with its comments and full subtask tree.
 */
export async function getReminderDetail(
  deps: ServiceDeps,
  id: string,
): Promise<ReminderDetail | null> {
  return dbGetReminderDetail(deps.db, id);
}

export interface UpdateReminderFields {
  status?: string;
  content?: string;
  dueDate?: Date | null;
  priority?: string | null;
  project?: string | null;
  section?: string | null;
}

/**
 * Update reminder fields. Re-embeds if content changed.
 */
export async function updateReminder(
  deps: ServiceDeps,
  id: string,
  fields: UpdateReminderFields,
): Promise<void> {
  await dbUpdateReminder(deps.db, id, fields);

  if (fields.content) {
    const embedding = await deps.embeddingProvider.embed(fields.content);
    await deps.db.query(
      `UPDATE reminders SET embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), id],
    );
  }
}

/**
 * Mark a reminder as done, cascading to all subtasks.
 */
export async function completeReminder(
  deps: ServiceDeps,
  id: string,
): Promise<{ completed: string[] }> {
  return dbCompleteReminder(deps.db, id);
}

/**
 * Delete a reminder and cascade-delete all subtasks and comments.
 */
export async function deleteReminder(
  deps: ServiceDeps,
  id: string,
): Promise<void> {
  return dbDeleteReminder(deps.db, id);
}

/**
 * Move a reminder to a different parent (or to top level).
 */
export async function reparentReminder(
  deps: ServiceDeps,
  id: string,
  newParentId: string | null,
): Promise<void> {
  return dbReparentReminder(deps.db, id, newParentId);
}

/**
 * Resolve an 8-char short ID prefix to a full UUID.
 */
export async function resolveReminderId(
  deps: ServiceDeps,
  shortId: string,
): Promise<string | null> {
  return dbResolveReminderId(deps.db, shortId);
}

/**
 * List all distinct projects with task count stats.
 */
export async function listProjects(deps: ServiceDeps): Promise<Array<{
  project: string;
  total: number;
  not_started: number;
  in_progress: number;
  done: number;
  paused: number;
  blocked: number;
  cancelled: number;
}>> {
  return dbListProjects(deps.db);
}

/**
 * Find all active (non-done, non-cancelled) reminders.
 */
export async function findActiveReminders(
  deps: ServiceDeps,
): Promise<ReminderRow[]> {
  return dbFindActiveReminders(deps.db);
}

/**
 * Find all non-archived reminders (any status).
 */
export async function findAllReminders(
  deps: ServiceDeps,
): Promise<ReminderRow[]> {
  return dbFindAllReminders(deps.db);
}

/**
 * Find direct subtasks of a parent reminder.
 */
export async function findSubtasks(
  deps: ServiceDeps,
  parentId: string,
): Promise<ReminderRow[]> {
  return dbFindSubtasks(deps.db, parentId);
}

/**
 * Find reminders due on a specific date in the user's timezone.
 */
export async function findRemindersDueOnDate(
  deps: ServiceDeps,
  date: Date,
  timezone: string,
): Promise<ReminderRow[]> {
  return dbFindRemindersDueOnDate(deps.db, date, timezone);
}

/**
 * Find overdue reminders (due date in the past, not done/cancelled).
 */
export async function findOverdueReminders(
  deps: ServiceDeps,
): Promise<ReminderRow[]> {
  return dbFindOverdueReminders(deps.db);
}

/**
 * Find reminders completed since a given timestamp.
 */
export async function findRecentlyCompletedReminders(
  deps: ServiceDeps,
  since: Date,
): Promise<ReminderRow[]> {
  return dbFindRecentlyCompletedReminders(deps.db, since);
}
