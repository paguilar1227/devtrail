import type { DbClient } from './client.js';

export interface ReminderInsert {
  content: string;
  embedding: number[];
  category: string | null;
  project: string | null;
  section: string | null;
  parentId: string | null;
  depth: number;
  priority: string | null;
  source: string;
  sourceContext: string | null;
  dueDate: Date | null;
}

export interface ReminderRow {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown> | null;
  category: string | null;
  project: string | null;
  section: string | null;
  parent_id: string | null;
  depth: number;
  status: string;
  priority: string | null;
  source_context: string | null;
  source: string;
  archived: boolean;
  due_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReminderDetail extends ReminderRow {
  comments: import('./reminder-comments.js').ReminderCommentRow[];
  subtasks: ReminderRow[];
}

export interface ListRemindersFilters {
  status?: string;
  category?: string;
  project?: string;
  section?: string;
  priority?: string;
  due_before?: Date;
  due_after?: Date;
  include_done?: boolean;
  top_level_only?: boolean;
  limit?: number;
}

export async function insertReminder(db: DbClient, reminder: ReminderInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO reminders (content, embedding, category, project, section, parent_id, depth, priority, source, source_context, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [reminder.content, JSON.stringify(reminder.embedding), reminder.category,
     reminder.project, reminder.section, reminder.parentId, reminder.depth,
     reminder.priority, reminder.source, reminder.sourceContext, reminder.dueDate],
  );
  return result.rows[0];
}

export async function listReminders(
  db: DbClient,
  filters: ListRemindersFilters,
): Promise<ReminderRow[]> {
  const conditions = ['archived = false'];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters.category) {
    conditions.push(`category = $${paramIdx++}`);
    params.push(filters.category);
  }
  if (filters.project) {
    conditions.push(`project = $${paramIdx++}`);
    params.push(filters.project);
  }
  if (filters.section) {
    conditions.push(`section = $${paramIdx++}`);
    params.push(filters.section);
  }
  if (filters.priority) {
    conditions.push(`priority = $${paramIdx++}`);
    params.push(filters.priority);
  }
  if (filters.due_before) {
    conditions.push(`due_date <= $${paramIdx++}`);
    params.push(filters.due_before);
  }
  if (filters.due_after) {
    conditions.push(`due_date >= $${paramIdx++}`);
    params.push(filters.due_after);
  }
  if (!filters.include_done) {
    conditions.push(`status != 'done'`);
    conditions.push(`status != 'cancelled'`);
  }
  // top_level_only defaults to true — only return depth=0 unless explicitly false
  if (filters.top_level_only !== false) {
    conditions.push(`depth = 0`);
  }

  const limit = filters.limit ?? 20;

  const result = await db.query(
    `SELECT * FROM reminders WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${paramIdx}`,
    [...params, limit],
  );
  return result.rows;
}

export async function updateReminder(
  db: DbClient,
  id: string,
  updates: {
    status?: string;
    content?: string;
    dueDate?: Date | null;
    priority?: string | null;
    project?: string | null;
    section?: string | null;
  },
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.status !== undefined) {
    sets.push(`status = $${paramIdx++}`);
    params.push(updates.status);
  }
  if (updates.content !== undefined) {
    sets.push(`content = $${paramIdx++}`, `embedding = NULL`);
    params.push(updates.content);
  }
  if (updates.dueDate !== undefined) {
    sets.push(`due_date = $${paramIdx++}`);
    params.push(updates.dueDate);
  }
  if (updates.priority !== undefined) {
    sets.push(`priority = $${paramIdx++}`);
    params.push(updates.priority);
  }
  if (updates.project !== undefined) {
    sets.push(`project = $${paramIdx++}`);
    params.push(updates.project);
  }
  if (updates.section !== undefined) {
    sets.push(`section = $${paramIdx++}`);
    params.push(updates.section);
  }

  params.push(id);
  await db.query(
    `UPDATE reminders SET ${sets.join(', ')} WHERE id = $${paramIdx}`,
    params,
  );
}

export async function completeReminder(db: DbClient, id: string): Promise<void> {
  // Does NOT cascade to subtasks — each is completed independently per spec
  await db.query(
    `UPDATE reminders SET status = 'done', updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function deleteReminder(db: DbClient, id: string): Promise<void> {
  // Cascade-delete all subtasks (and their comments) first, then this reminder and its comments.
  // We collect all descendant IDs recursively, then delete comments for all, then delete all reminders.
  const allIds = await collectDescendantIds(db, id);
  allIds.push(id);

  // Delete comments for all affected reminders
  for (const remId of allIds) {
    await db.query(`DELETE FROM reminder_comments WHERE reminder_id = $1`, [remId]);
  }

  // Delete subtasks before parent (to avoid FK issues if constraints exist in future)
  // Delete in reverse order (deepest first)
  const descendantIds = allIds.slice(0, -1); // all except the root
  if (descendantIds.length > 0) {
    await db.query(
      `DELETE FROM reminders WHERE id = ANY($1::uuid[])`,
      [descendantIds],
    );
  }
  await db.query(`DELETE FROM reminders WHERE id = $1`, [id]);
}

async function collectDescendantIds(db: DbClient, parentId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT id FROM reminders WHERE parent_id = $1`,
    [parentId],
  );
  const ids: string[] = [];
  for (const row of result.rows) {
    ids.push(row.id);
    const childIds = await collectDescendantIds(db, row.id);
    ids.push(...childIds);
  }
  return ids;
}

export async function findSubtasks(db: DbClient, parentId: string): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders WHERE parent_id = $1 AND archived = false ORDER BY created_at ASC`,
    [parentId],
  );
  return result.rows;
}

export async function getReminderDetail(db: DbClient, id: string): Promise<ReminderDetail | null> {
  const { findCommentsByReminderId } = await import('./reminder-comments.js');

  const result = await db.query(`SELECT * FROM reminders WHERE id = $1`, [id]);
  const reminder = result.rows[0] ?? null;
  if (!reminder) return null;

  const comments = await findCommentsByReminderId(db, id);
  const subtasks = await findSubtasksRecursive(db, id);

  return { ...reminder, comments, subtasks };
}

async function findSubtasksRecursive(db: DbClient, parentId: string): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders WHERE parent_id = $1 AND archived = false ORDER BY created_at ASC`,
    [parentId],
  );
  const subtasks: ReminderRow[] = [];
  for (const row of result.rows) {
    subtasks.push(row);
    const children = await findSubtasksRecursive(db, row.id);
    subtasks.push(...children);
  }
  return subtasks;
}

export async function findRecentlyCompletedReminders(
  db: DbClient, since: Date,
): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders
     WHERE status = 'done' AND updated_at >= $1 AND archived = false
     ORDER BY updated_at DESC`,
    [since],
  );
  return result.rows;
}

export async function findActiveReminders(db: DbClient): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders
     WHERE status IN ('not_started', 'in_progress', 'researching', 'paused', 'blocked')
       AND archived = false
     ORDER BY created_at DESC`,
    [],
  );
  return result.rows;
}

/** Find all non-archived reminders (any status) for search-by-description flows */
export async function findAllReminders(db: DbClient): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders WHERE archived = false ORDER BY created_at DESC`,
    [],
  );
  return result.rows;
}

export async function findRemindersDueOnDate(
  db: DbClient,
  date: Date,
  timezone: string,
): Promise<ReminderRow[]> {
  // Calculate start and end of the given day in the user's timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;

  // Get timezone offset for this date to create UTC bounds
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const formatted = formatter.format(date);
  const offsetMatch = formatted.match(/GMT([+-]\d{1,2}(?::?\d{2})?)/);
  let offsetMinutes = 0;
  if (offsetMatch) {
    const offsetStr = offsetMatch[1];
    const [hours, mins] = offsetStr.split(':').map(Number);
    offsetMinutes = (hours ?? 0) * 60 + (Math.sign(hours ?? 0) * (mins ?? 0));
  }

  const startLocal = new Date(`${dateStr}T00:00:00`);
  const endLocal = new Date(`${dateStr}T23:59:59.999`);
  const start = new Date(startLocal.getTime() - offsetMinutes * 60_000);
  const end = new Date(endLocal.getTime() - offsetMinutes * 60_000);

  const result = await db.query(
    `SELECT * FROM reminders
     WHERE due_date IS NOT NULL
       AND due_date >= $1 AND due_date <= $2
       AND status NOT IN ('done', 'cancelled')
       AND archived = false
     ORDER BY due_date ASC`,
    [start, end],
  );
  return result.rows;
}

export async function findOverdueReminders(db: DbClient): Promise<ReminderRow[]> {
  const result = await db.query(
    `SELECT * FROM reminders
     WHERE due_date IS NOT NULL
       AND due_date < now()
       AND status NOT IN ('done', 'cancelled')
       AND archived = false
     ORDER BY due_date ASC`,
    [],
  );
  return result.rows;
}

export async function getReminderById(db: DbClient, id: string): Promise<ReminderRow | null> {
  const result = await db.query(`SELECT * FROM reminders WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** Resolve a short ID prefix (e.g. "4e0bd1b2") to a full UUID. Returns null if no match or ambiguous. */
export async function resolveReminderId(db: DbClient, shortId: string): Promise<string | null> {
  // If it's already a full UUID, use it directly
  if (shortId.length === 36 && shortId.includes('-')) {
    return shortId;
  }
  const result = await db.query(
    `SELECT id FROM reminders WHERE id::text LIKE $1 || '%' LIMIT 2`,
    [shortId],
  );
  if (result.rows.length === 1) return result.rows[0].id;
  return null; // No match or ambiguous (multiple matches)
}

export async function listProjects(db: DbClient): Promise<Array<{
  project: string;
  total: number;
  not_started: number;
  in_progress: number;
  done: number;
  paused: number;
  blocked: number;
  cancelled: number;
}>> {
  const result = await db.query(
    `SELECT
       project,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'not_started')::int AS not_started,
       COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
       COUNT(*) FILTER (WHERE status = 'done')::int AS done,
       COUNT(*) FILTER (WHERE status = 'paused')::int AS paused,
       COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
     FROM reminders
     WHERE project IS NOT NULL AND archived = false
     GROUP BY project
     ORDER BY project`,
    [],
  );
  return result.rows;
}
