// src/services/comments.ts
import type { ServiceDeps } from './index.js';
import type { ReminderCommentRow } from '../db/reminder-comments.js';
import {
  insertComment,
  findCommentsByReminderId,
  getCommentById,
  updateComment as dbUpdateComment,
  deleteComment as dbDeleteComment,
} from '../db/reminder-comments.js';
import { getReminderById } from '../db/reminders.js';

export type { ReminderCommentRow };

/**
 * Validate reminder exists, embed content, insert comment.
 */
export async function addComment(
  deps: ServiceDeps,
  reminderId: string,
  content: string,
  source: string,
): Promise<{ id: string }> {
  const reminder = await getReminderById(deps.db, reminderId);
  if (!reminder) {
    throw new Error(`Reminder ${reminderId} not found`);
  }

  const embedding = await deps.embeddingProvider.embed(content);
  return insertComment(deps.db, { content, embedding, reminderId, source });
}

/**
 * Return comments for a reminder in ascending chronological order.
 */
export async function listComments(
  deps: ServiceDeps,
  reminderId: string,
): Promise<ReminderCommentRow[]> {
  return findCommentsByReminderId(deps.db, reminderId);
}

/**
 * Return a single comment by ID, or null if not found.
 */
export async function getComment(
  deps: ServiceDeps,
  id: string,
): Promise<ReminderCommentRow | null> {
  return getCommentById(deps.db, id);
}

/**
 * Validate comment exists, embed new content, update.
 */
export async function updateComment(
  deps: ServiceDeps,
  id: string,
  content: string,
): Promise<void> {
  const existing = await getCommentById(deps.db, id);
  if (!existing) {
    throw new Error(`Comment ${id} not found`);
  }

  const embedding = await deps.embeddingProvider.embed(content);
  await dbUpdateComment(deps.db, id, content, embedding);
}

/**
 * Fetch comment first (for return value), then delete.
 * Throws if comment does not exist.
 */
export async function deleteComment(
  deps: ServiceDeps,
  id: string,
): Promise<ReminderCommentRow> {
  const comment = await getCommentById(deps.db, id);
  if (!comment) {
    throw new Error(`Comment ${id} not found`);
  }

  await dbDeleteComment(deps.db, id);
  return comment;
}
