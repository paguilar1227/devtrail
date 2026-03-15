import type { DbClient } from './client.js';

export interface ReminderInsert {
  content: string;
  embedding: number[];
  category: string | null;
  source: string;
  sourceContext: string | null;
  dueDate: Date | null;
}

export interface ReminderRow {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown> | null;
  category: string;
  status: string;
  source_context: string | null;
  source: string;
  archived: boolean;
  due_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function insertReminder(db: DbClient, reminder: ReminderInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO reminders (content, embedding, category, source, source_context, due_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [reminder.content, JSON.stringify(reminder.embedding), reminder.category,
     reminder.source, reminder.sourceContext, reminder.dueDate],
  );
  return result.rows[0];
}

export async function listReminders(
  db: DbClient,
  filters: { status?: string; category?: string; limit?: number },
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
  updates: { status?: string; content?: string; dueDate?: Date | null },
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

  params.push(id);
  await db.query(
    `UPDATE reminders SET ${sets.join(', ')} WHERE id = $${paramIdx}`,
    params,
  );
}

export async function completeReminder(db: DbClient, id: string): Promise<void> {
  await db.query(
    `UPDATE reminders SET status = 'done', updated_at = now() WHERE id = $1`,
    [id],
  );
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
     WHERE status IN ('not_started', 'in_progress', 'researching')
       AND archived = false
     ORDER BY created_at DESC`,
    [],
  );
  return result.rows;
}

export async function getReminderById(db: DbClient, id: string): Promise<ReminderRow | null> {
  const result = await db.query(`SELECT * FROM reminders WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}
