import type { DbClient } from '../db/client.js';
import type { EmbeddingProvider } from '../providers/types.js';

export interface Phase3Options {
  sendNotification?: (message: string) => Promise<void>;
  digestEnabled?: boolean;
}

export interface Phase3Result {
  itemsEmbedded: number;
}

export async function runPhase3(
  db: DbClient,
  embeddingProvider: EmbeddingProvider,
  options?: Phase3Options,
): Promise<Phase3Result> {
  let itemsEmbedded = 0;

  // Find facts needing embeddings
  const factsNeedingEmbed = await db.query(
    `SELECT id, content FROM facts WHERE embedding IS NULL AND archived = false`,
  );

  // Find insights needing embeddings
  const insightsNeedingEmbed = await db.query(
    `SELECT id, content FROM insights WHERE embedding IS NULL AND archived = false`,
  );

  // Embed and update facts
  for (const fact of factsNeedingEmbed.rows) {
    const embedding = await embeddingProvider.embed(fact.content);
    await db.query(
      `UPDATE facts SET embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), fact.id],
    );
    itemsEmbedded++;
  }

  // Embed and update insights
  for (const insight of insightsNeedingEmbed.rows) {
    const embedding = await embeddingProvider.embed(insight.content);
    await db.query(
      `UPDATE insights SET embedding = $1 WHERE id = $2`,
      [JSON.stringify(embedding), insight.id],
    );
    itemsEmbedded++;
  }

  // Dispatch notification if items are pending review
  if (options?.sendNotification) {
    try {
      const { getPendingReviewCount } = await import('../notifications/review.js');
      const pending = await getPendingReviewCount(db);
      if (pending.total > 0) {
        await options.sendNotification(
          `Open Brain: ${pending.total} items need your review (${pending.facts} facts, ${pending.insights} insights). Use /review to see them.`,
        );
      }
    } catch {
      // notifications/review module not yet available — skip notification
    }
  }

  return { itemsEmbedded };
}
