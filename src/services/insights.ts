// src/services/insights.ts
import type { ServiceDeps } from './index.js';
import type { InsightRow } from '../db/insights.js';
import {
  getInsightById,
  findAllInsights,
  setInsightArchived,
  findPendingReviewInsights,
  setInsightReviewStatus,
} from '../db/insights.js';

export type { InsightRow };

/**
 * Return a single insight by ID, or null if not found.
 */
export async function getInsight(
  deps: ServiceDeps,
  id: string,
): Promise<InsightRow | null> {
  return getInsightById(deps.db, id);
}

/**
 * List all non-archived, non-rejected insights.
 */
export async function listInsights(
  deps: ServiceDeps,
  limit?: number,
): Promise<InsightRow[]> {
  const rows = await findAllInsights(deps.db);
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Edit an insight: sets origin='user_edited', re-embeds.
 */
export async function updateInsight(
  deps: ServiceDeps,
  id: string,
  content: string,
): Promise<void> {
  const existing = await getInsightById(deps.db, id);
  if (!existing) {
    throw new Error(`Insight ${id} not found`);
  }

  // setInsightReviewStatus with content sets origin='user_edited' and clears embedding
  await setInsightReviewStatus(deps.db, id, existing.review_status, content);

  const embedding = await deps.embeddingProvider.embed(content);
  await deps.db.query(
    `UPDATE insights SET embedding = $1 WHERE id = $2`,
    [JSON.stringify(embedding), id],
  );
}

/**
 * Soft-archive an insight.
 */
export async function archiveInsight(
  deps: ServiceDeps,
  id: string,
): Promise<void> {
  await setInsightArchived(deps.db, id, true);
}

/**
 * Restore an archived insight.
 */
export async function unarchiveInsight(
  deps: ServiceDeps,
  id: string,
): Promise<void> {
  await setInsightArchived(deps.db, id, false);
}

/**
 * List insights with pending_review status.
 */
export async function reviewPendingInsights(
  deps: ServiceDeps,
  limit?: number,
): Promise<InsightRow[]> {
  return findPendingReviewInsights(deps.db, limit ?? 20);
}

/**
 * Approve, reject, or edit a pending_review insight.
 * action='edit' requires content to be provided.
 */
export async function approveRejectInsight(
  deps: ServiceDeps,
  id: string,
  action: 'approve' | 'reject' | 'edit',
  content?: string,
): Promise<void> {
  if (action === 'edit' && !content) {
    throw new Error('content is required when action is edit');
  }

  const insight = await getInsightById(deps.db, id);
  if (!insight) {
    throw new Error(`Insight ${id} not found`);
  }

  if (action === 'approve') {
    await setInsightReviewStatus(deps.db, id, 'user_approved');
  } else if (action === 'reject') {
    await setInsightReviewStatus(deps.db, id, 'user_rejected');
  } else {
    // edit: update content + approve
    await setInsightReviewStatus(deps.db, id, 'user_approved', content);
    const embedding = await deps.embeddingProvider.embed(content!);
    await deps.db.query(
      `UPDATE insights SET embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), id],
    );
  }
}
