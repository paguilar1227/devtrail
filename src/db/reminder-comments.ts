import type { DbClient } from './client.js';

export interface ReminderCommentInsert {
  content: string;
  embedding: number[];
  reminderId: string;
  source: string;
}

export interface ReminderCommentRow {
  id: string;
  content: string;
  embedding: number[];
  reminder_id: string;
  source: string;
  created_at: Date;
}

export async function insertComment(
  db: DbClient,
  comment: ReminderCommentInsert,
): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO reminder_comments (content, embedding, reminder_id, source)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [comment.content, JSON.stringify(comment.embedding), comment.reminderId, comment.source],
  );
  return result.rows[0];
}

export async function findCommentsByReminderId(
  db: DbClient,
  reminderId: string,
): Promise<ReminderCommentRow[]> {
  const result = await db.query(
    `SELECT * FROM reminder_comments WHERE reminder_id = $1 ORDER BY created_at ASC`,
    [reminderId],
  );
  return result.rows;
}

export async function deleteCommentsByReminderId(
  db: DbClient,
  reminderId: string,
): Promise<void> {
  await db.query(
    `DELETE FROM reminder_comments WHERE reminder_id = $1`,
    [reminderId],
  );
}
