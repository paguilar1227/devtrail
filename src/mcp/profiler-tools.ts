// src/mcp/profiler-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import { getCaptureById, setCaptureArchived } from '../db/captures.js';
import { getFactById, setFactArchived, setFactReviewStatus, userEditFact, findPendingReviewFacts } from '../db/facts.js';
import { getInsightById, setInsightArchived, setInsightReviewStatus, findPendingReviewInsights } from '../db/insights.js';
import { runCapturePipeline } from '../capture/pipeline.js';

export function registerProfilerTools(server: McpServer, deps: AppDeps): void {
  // 1. get_user_profile — session bootstrap
  server.tool(
    'get_user_profile',
    'Session bootstrap — returns a synthesized profile summary of who this person is right now',
    {},
    async () => {
      // Delegates to retrieval/profile.ts (implemented in Task 27)
      const { getUserProfile } = await import('../retrieval/profile.js');
      const profile = await getUserProfile(deps.db, deps.retrievalLLM);
      return { content: [{ type: 'text' as const, text: profile }] };
    },
  );

  // 2. search_thoughts — tiered semantic search
  server.tool(
    'search_thoughts',
    'Tiered semantic search: insights → facts → captures, with conditional evidence on low confidence',
    {
      query: z.string().describe('Search query'),
      threshold: z.number().min(0).max(1).default(0.5).describe('Similarity threshold (0-1)'),
      limit: z.number().int().positive().default(10).describe('Max results'),
    },
    async ({ query, threshold, limit }) => {
      const { searchThoughts } = await import('../retrieval/search.js');
      const results = await searchThoughts(deps.db, deps.embeddingProvider, query, threshold, limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // 3. capture_thought — capture from any MCP client
  server.tool(
    'capture_thought',
    'Capture a thought from any MCP client',
    {
      content: z.string().describe('Text content of the thought'),
      file_urls: z.array(z.string()).optional().describe('Array of accessible URLs to download files from'),
    },
    async ({ content, file_urls }) => {
      const files: Array<{ data: Buffer; contentType: string; filename: string }> = [];
      if (file_urls) {
        for (const url of file_urls) {
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
          files.push({ data: buffer, contentType, filename: url.split('/').pop() ?? 'file' });
        }
      }

      const result = await runCapturePipeline({
        db: deps.db,
        embeddingProvider: deps.embeddingProvider,
        metadataLLM: deps.metadataLLM,
        blobStorage: deps.blobStorage,
        content,
        files,
        source: 'mcp',
      });

      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Skipped: ${result.reason}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `Captured! ID: ${result.captureId}` }] };
    },
  );

  // 4. brain_stats — dashboard
  server.tool(
    'brain_stats',
    'Dashboard — counts, types, topics, confidence distribution',
    {},
    async () => {
      const stats = await deps.db.query(`
        SELECT
          (SELECT count(*) FROM captures WHERE archived = false) AS captures_count,
          (SELECT count(*) FROM facts WHERE archived = false) AS facts_count,
          (SELECT count(*) FROM insights WHERE archived = false) AS insights_count,
          (SELECT count(*) FROM reminders WHERE archived = false) AS reminders_count,
          (SELECT count(*) FROM facts WHERE review_status = 'pending_review') AS facts_pending,
          (SELECT count(*) FROM insights WHERE review_status = 'pending_review') AS insights_pending
      `);

      const categories = await deps.db.query(`
        SELECT category, count(*) as count FROM facts
        WHERE archived = false AND review_status != 'user_rejected'
        GROUP BY category ORDER BY count DESC
      `);

      const row = stats.rows[0];
      const result = {
        captures: parseInt(row.captures_count),
        facts: parseInt(row.facts_count),
        insights: parseInt(row.insights_count),
        reminders: parseInt(row.reminders_count),
        pendingReview: parseInt(row.facts_pending) + parseInt(row.insights_pending),
        factsByCategory: categories.rows,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // 5. archive_thought — soft isolation
  server.tool(
    'archive_thought',
    'Soft-delete an item (no cascade recalculation)',
    {
      id: z.string().uuid().describe('UUID of the item to archive'),
      type: z.enum(['capture', 'fact', 'insight']).describe('Which table'),
    },
    async ({ id, type }) => {
      if (type === 'capture') await setCaptureArchived(deps.db, id, true);
      else if (type === 'fact') await setFactArchived(deps.db, id, true);
      else await setInsightArchived(deps.db, id, true);
      return { content: [{ type: 'text' as const, text: `Archived ${type} ${id}` }] };
    },
  );

  // 6. unarchive_thought — restore
  server.tool(
    'unarchive_thought',
    'Restore an archived item',
    {
      id: z.string().uuid().describe('UUID of the item to restore'),
      type: z.enum(['capture', 'fact', 'insight']).describe('Which table'),
    },
    async ({ id, type }) => {
      if (type === 'capture') await setCaptureArchived(deps.db, id, false);
      else if (type === 'fact') await setFactArchived(deps.db, id, false);
      else await setInsightArchived(deps.db, id, false);
      return { content: [{ type: 'text' as const, text: `Unarchived ${type} ${id}` }] };
    },
  );

  // 7. update_fact — direct user edit
  server.tool(
    'update_fact',
    'Edit a fact directly. Sets origin to user_edited, confidence to 1.0, preserves source links.',
    {
      id: z.string().uuid().describe('Fact UUID'),
      content: z.string().describe('New content for the fact'),
    },
    async ({ id, content }) => {
      const existing = await getFactById(deps.db, id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `No fact found with id ${id}` }], isError: true };
      }
      await userEditFact(deps.db, id, content);
      // Re-embed the updated fact
      const embedding = await deps.embeddingProvider.embed(content);
      await deps.db.query(
        `UPDATE facts SET embedding = $1 WHERE id = $2`,
        [JSON.stringify(embedding), id],
      );
      return { content: [{ type: 'text' as const, text: `Fact ${id} updated. Origin set to user_edited, confidence set to 1.0.` }] };
    },
  );

  // 8. review_pending — list pending review items
  server.tool(
    'review_pending',
    'List items with pending_review status',
    {
      limit: z.number().int().positive().default(20).describe('Max items to return'),
      type: z.enum(['fact', 'insight']).optional().describe('Filter by type, defaults to both'),
    },
    async ({ limit, type }) => {
      const items: Array<{ id: string; type: string; content: string; category: string; confidence: number }> = [];

      if (!type || type === 'fact') {
        const facts = await findPendingReviewFacts(deps.db, limit);
        for (const f of facts) {
          items.push({ id: f.id, type: 'fact', content: f.content, category: f.category, confidence: f.confidence });
        }
      }

      if (!type || type === 'insight') {
        const insights = await findPendingReviewInsights(deps.db, limit);
        for (const i of insights) {
          items.push({ id: i.id, type: 'insight', content: i.content, category: i.category, confidence: i.confidence });
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
    },
  );

  // 9. approve_reject — act on pending_review items
  server.tool(
    'approve_reject',
    'Approve, reject, or edit a pending_review item. Looks up by UUID across facts and insights.',
    {
      id: z.string().uuid().describe('UUID of the item'),
      action: z.enum(['approve', 'reject', 'edit']).describe('Action to take'),
      content: z.string().optional().describe('New content (required if action is edit)'),
    },
    async ({ id, action, content }) => {
      if (action === 'edit' && !content) {
        return { content: [{ type: 'text' as const, text: 'content is required when action is edit' }], isError: true };
      }

      // Try facts first, then insights (UUIDs are globally unique)
      const fact = await getFactById(deps.db, id);
      if (fact) {
        if (fact.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Fact ${id} is not in pending_review status. Use update_fact to edit approved facts.` }], isError: true };
        }
        if (action === 'approve') {
          await setFactReviewStatus(deps.db, id, 'user_approved');
        } else if (action === 'reject') {
          await setFactReviewStatus(deps.db, id, 'user_rejected');
        } else {
          await userEditFact(deps.db, id, content!);
          await setFactReviewStatus(deps.db, id, 'user_approved');
          const embedding = await deps.embeddingProvider.embed(content!);
          await deps.db.query(`UPDATE facts SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
        }
        return { content: [{ type: 'text' as const, text: `Fact ${id}: ${action}d` }] };
      }

      const insight = await getInsightById(deps.db, id);
      if (insight) {
        if (insight.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Insight ${id} is not in pending_review status.` }], isError: true };
        }
        if (action === 'approve') {
          await setInsightReviewStatus(deps.db, id, 'user_approved');
        } else if (action === 'reject') {
          await setInsightReviewStatus(deps.db, id, 'user_rejected');
        } else {
          await setInsightReviewStatus(deps.db, id, 'user_approved', content);
          const embedding = await deps.embeddingProvider.embed(content!);
          await deps.db.query(`UPDATE insights SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
        }
        return { content: [{ type: 'text' as const, text: `Insight ${id}: ${action}d` }] };
      }

      return { content: [{ type: 'text' as const, text: `No fact or insight found with id ${id}` }], isError: true };
    },
  );
}
