// src/services/facts.ts
import type { ServiceDeps } from './index.js';
import type { FactRow } from '../db/facts.js';
import {
  getFactById,
  findActiveFacts,
  userEditFact,
  setFactArchived,
  findPendingReviewFacts,
  setFactReviewStatus,
} from '../db/facts.js';

export type { FactRow };

/**
 * Return a single fact by ID, or null if not found.
 */
export async function getFact(
  deps: ServiceDeps,
  id: string,
): Promise<FactRow | null> {
  return getFactById(deps.db, id);
}

/**
 * List active (non-archived, non-rejected) facts above minConfidence.
 */
export async function listFacts(
  deps: ServiceDeps,
  limit?: number,
  minConfidence?: number,
): Promise<FactRow[]> {
  const rows = await findActiveFacts(deps.db, minConfidence ?? 0.0);
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Edit a fact: sets origin='user_edited', confidence=1.0, re-embeds.
 */
export async function updateFact(
  deps: ServiceDeps,
  id: string,
  content: string,
): Promise<void> {
  const existing = await getFactById(deps.db, id);
  if (!existing) {
    throw new Error(`Fact ${id} not found`);
  }

  await userEditFact(deps.db, id, content);

  const embedding = await deps.embeddingProvider.embed(content);
  await deps.db.query(
    `UPDATE facts SET embedding = $1 WHERE id = $2`,
    [JSON.stringify(embedding), id],
  );
}

/**
 * Soft-archive a fact.
 */
export async function archiveFact(
  deps: ServiceDeps,
  id: string,
): Promise<void> {
  await setFactArchived(deps.db, id, true);
}

/**
 * Restore an archived fact.
 */
export async function unarchiveFact(
  deps: ServiceDeps,
  id: string,
): Promise<void> {
  await setFactArchived(deps.db, id, false);
}

/**
 * List facts with pending_review status.
 */
export async function reviewPendingFacts(
  deps: ServiceDeps,
  limit?: number,
): Promise<FactRow[]> {
  return findPendingReviewFacts(deps.db, limit ?? 20);
}

/**
 * Approve, reject, or edit a pending_review fact.
 * action='edit' requires content to be provided.
 */
export async function approveRejectFact(
  deps: ServiceDeps,
  id: string,
  action: 'approve' | 'reject' | 'edit',
  content?: string,
): Promise<void> {
  if (action === 'edit' && !content) {
    throw new Error('content is required when action is edit');
  }

  const fact = await getFactById(deps.db, id);
  if (!fact) {
    throw new Error(`Fact ${id} not found`);
  }

  if (action === 'approve') {
    await setFactReviewStatus(deps.db, id, 'user_approved');
  } else if (action === 'reject') {
    await setFactReviewStatus(deps.db, id, 'user_rejected');
  } else {
    // edit
    await userEditFact(deps.db, id, content!);
    await setFactReviewStatus(deps.db, id, 'user_approved');
    const embedding = await deps.embeddingProvider.embed(content!);
    await deps.db.query(
      `UPDATE facts SET embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), id],
    );
  }
}
