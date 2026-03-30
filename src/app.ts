// src/app.ts
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { DbClient } from './db/client.js';
import type { EmbeddingProvider, LLMProvider } from './providers/types.js';
import type { BlobStorage } from './storage/blob.js';
import type { Config } from './config.js';
import type { ServiceDeps } from './services/index.js';
import * as capturesSvc from './services/captures.js';
import * as factsSvc from './services/facts.js';
import * as insightsSvc from './services/insights.js';
import * as remindersSvc from './services/reminders.js';
import * as commentsSvc from './services/comments.js';
import * as profileSvc from './services/profile.js';
import * as consolidationSvc from './services/consolidation.js';
import * as tagsSvc from './services/tags.js';
import { mountMcpRoutes } from './mcp/server.js';
import { setupTelegramWebhook } from './telegram/webhook.js';

export interface AppDeps {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;
  consolidationLLM: LLMProvider;
  retrievalLLM: LLMProvider;
  blobStorage: BlobStorage;
  config: Config;
}

/** Strip the embedding field from a row before sending over HTTP (embeddings are large float arrays). */
function stripEmbedding<T extends { embedding?: unknown }>(row: T): Omit<T, 'embedding'> {
  const { embedding: _embedding, ...rest } = row;
  return rest;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  // Build the ServiceDeps object (same shape, but typed for service modules)
  const svcDeps: ServiceDeps = deps;

  // Middleware
  app.use('*', cors());

  // Health check (no auth)
  app.get('/', (c) => c.json({ status: 'ok', service: 'open-brain-v2' }));

  // Auth middleware for /api/* routes
  app.use('/api/*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token || token !== deps.config.apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Rate limiting: 100 requests/minute per key (spec requirement)
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  app.use('/api/*', async (c, next) => {
    const key = c.req.header('Authorization') ?? 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + 60_000 });
    } else if (entry.count >= 100) {
      return c.json({ error: 'Rate limit exceeded (100 req/min)' }, 429);
    } else {
      entry.count++;
    }
    await next();
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Download file_urls provided in the request body into FileInput objects.
   * Used by both POST /api/v1/capture and POST /api/v1/captures.
   */
  async function downloadFileUrls(
    file_urls: unknown,
  ): Promise<{ files: Array<{ data: Buffer; contentType: string; filename: string }>; error?: string }> {
    const files: Array<{ data: Buffer; contentType: string; filename: string }> = [];
    if (file_urls && Array.isArray(file_urls)) {
      for (const url of file_urls) {
        try {
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
          const filename = url.split('/').pop() ?? 'file';
          files.push({ data: buffer, contentType, filename });
        } catch {
          return { files: [], error: `Failed to download file: ${url}` };
        }
      }
    }
    return { files };
  }

  // ─── Capture handler (shared between POST /capture and POST /captures) ───

  async function handleCapturePost(c: Context) {
    const body = await c.req.json();
    const { content, tags: rawTags, file_urls } = body;

    if (!content || typeof content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }

    const { files, error } = await downloadFileUrls(file_urls);
    if (error) return c.json({ error }, 400);

    const result = await capturesSvc.captureThought(svcDeps, content, files, rawTags, ['api']);

    if ('error' in result) {
      return c.json({ error: result.reason }, 409);
    }

    return c.json(
      { captureId: result.captureId, ...(result.warnings?.length && { warnings: result.warnings }) },
      201,
    );
  }

  // ─── Captures ─────────────────────────────────────────────────────────────

  // GET /api/v1/captures — List captures
  app.get('/api/v1/captures', async (c) => {
    const limit = Number(c.req.query('limit') ?? '10');
    const status = c.req.query('status');
    const rows = await capturesSvc.listCaptures(svcDeps, limit, status);
    return c.json(rows.map(stripEmbedding));
  });

  // POST /api/v1/captures — Capture a thought (new canonical path)
  app.post('/api/v1/captures', handleCapturePost);

  // POST /api/v1/capture — Backward-compatible alias
  app.post('/api/v1/capture', handleCapturePost);

  // GET /api/v1/captures/:id — Get a single capture
  app.get('/api/v1/captures/:id', async (c) => {
    const id = c.req.param('id');
    const row = await capturesSvc.getCapture(svcDeps, id);
    if (!row) return c.json({ error: 'Capture not found' }, 404);
    return c.json(stripEmbedding(row));
  });

  // PATCH /api/v1/captures/:id/tags — Update tags on a capture
  app.patch('/api/v1/captures/:id/tags', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    if (!Array.isArray(body.tags)) {
      return c.json({ error: 'tags must be an array' }, 400);
    }
    try {
      const result = await tagsSvc.updateTags(svcDeps, id, 'capture', body.tags);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 400);
    }
  });

  // POST /api/v1/captures/:id/archive — Archive a capture
  app.post('/api/v1/captures/:id/archive', async (c) => {
    const id = c.req.param('id');
    await capturesSvc.archiveCapture(svcDeps, id);
    return c.json({ ok: true });
  });

  // POST /api/v1/captures/:id/unarchive — Unarchive a capture
  app.post('/api/v1/captures/:id/unarchive', async (c) => {
    const id = c.req.param('id');
    await capturesSvc.unarchiveCapture(svcDeps, id);
    return c.json({ ok: true });
  });

  // ─── Facts ────────────────────────────────────────────────────────────────

  // GET /api/v1/facts — List facts
  app.get('/api/v1/facts', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const minConfidence = c.req.query('min_confidence') ? Number(c.req.query('min_confidence')) : undefined;
    const rows = await factsSvc.listFacts(svcDeps, limit, minConfidence);
    return c.json(rows.map(stripEmbedding));
  });

  // GET /api/v1/facts/:id — Get a single fact
  app.get('/api/v1/facts/:id', async (c) => {
    const id = c.req.param('id');
    const row = await factsSvc.getFact(svcDeps, id);
    if (!row) return c.json({ error: 'Fact not found' }, 404);
    return c.json(stripEmbedding(row));
  });

  // PUT /api/v1/facts/:id — Update fact content
  app.put('/api/v1/facts/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }
    try {
      await factsSvc.updateFact(svcDeps, id, body.content);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // PATCH /api/v1/facts/:id/tags — Update tags on a fact
  app.patch('/api/v1/facts/:id/tags', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    if (!Array.isArray(body.tags)) {
      return c.json({ error: 'tags must be an array' }, 400);
    }
    try {
      const result = await tagsSvc.updateTags(svcDeps, id, 'fact', body.tags);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 400);
    }
  });

  // POST /api/v1/facts/:id/archive
  app.post('/api/v1/facts/:id/archive', async (c) => {
    const id = c.req.param('id');
    await factsSvc.archiveFact(svcDeps, id);
    return c.json({ ok: true });
  });

  // POST /api/v1/facts/:id/unarchive
  app.post('/api/v1/facts/:id/unarchive', async (c) => {
    const id = c.req.param('id');
    await factsSvc.unarchiveFact(svcDeps, id);
    return c.json({ ok: true });
  });

  // POST /api/v1/facts/:id/approve
  app.post('/api/v1/facts/:id/approve', async (c) => {
    const id = c.req.param('id');
    try {
      await factsSvc.approveRejectFact(svcDeps, id, 'approve');
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/v1/facts/:id/reject
  app.post('/api/v1/facts/:id/reject', async (c) => {
    const id = c.req.param('id');
    try {
      await factsSvc.approveRejectFact(svcDeps, id, 'reject');
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── Insights ─────────────────────────────────────────────────────────────

  // GET /api/v1/insights — List insights
  app.get('/api/v1/insights', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const rows = await insightsSvc.listInsights(svcDeps, limit);
    return c.json(rows.map(stripEmbedding));
  });

  // GET /api/v1/insights/:id
  app.get('/api/v1/insights/:id', async (c) => {
    const id = c.req.param('id');
    const row = await insightsSvc.getInsight(svcDeps, id);
    if (!row) return c.json({ error: 'Insight not found' }, 404);
    return c.json(stripEmbedding(row));
  });

  // PUT /api/v1/insights/:id
  app.put('/api/v1/insights/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }
    try {
      await insightsSvc.updateInsight(svcDeps, id, body.content);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // PATCH /api/v1/insights/:id/tags
  app.patch('/api/v1/insights/:id/tags', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    if (!Array.isArray(body.tags)) {
      return c.json({ error: 'tags must be an array' }, 400);
    }
    try {
      const result = await tagsSvc.updateTags(svcDeps, id, 'insight', body.tags);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 400);
    }
  });

  // POST /api/v1/insights/:id/archive
  app.post('/api/v1/insights/:id/archive', async (c) => {
    const id = c.req.param('id');
    await insightsSvc.archiveInsight(svcDeps, id);
    return c.json({ ok: true });
  });

  // POST /api/v1/insights/:id/unarchive
  app.post('/api/v1/insights/:id/unarchive', async (c) => {
    const id = c.req.param('id');
    await insightsSvc.unarchiveInsight(svcDeps, id);
    return c.json({ ok: true });
  });

  // POST /api/v1/insights/:id/approve
  app.post('/api/v1/insights/:id/approve', async (c) => {
    const id = c.req.param('id');
    try {
      await insightsSvc.approveRejectInsight(svcDeps, id, 'approve');
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/v1/insights/:id/reject
  app.post('/api/v1/insights/:id/reject', async (c) => {
    const id = c.req.param('id');
    try {
      await insightsSvc.approveRejectInsight(svcDeps, id, 'reject');
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── Reminders ────────────────────────────────────────────────────────────

  // GET /api/v1/reminders — List reminders
  app.get('/api/v1/reminders', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const status = c.req.query('status');
    const project = c.req.query('project');
    const priority = c.req.query('priority');
    const includeDone = c.req.query('include_done') === 'true';
    const topLevelOnly = c.req.query('top_level_only') === 'true';

    const rows = await remindersSvc.listReminders(svcDeps, {
      ...(status && { status }),
      ...(project && { project }),
      ...(priority && { priority }),
      include_done: includeDone,
      top_level_only: topLevelOnly,
      limit,
    });
    return c.json(rows.map(stripEmbedding));
  });

  // POST /api/v1/reminders — Create a reminder
  app.post('/api/v1/reminders', async (c) => {
    const body = await c.req.json();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }
    try {
      const result = await remindersSvc.createReminder(svcDeps, {
        content: body.content,
        project: body.project ?? null,
        section: body.section ?? null,
        parentId: body.parent_id ?? null,
        category: body.category ?? null,
        priority: body.priority ?? null,
        dueDate: body.due_date ? new Date(body.due_date) : null,
        source: 'api',
        sourceContext: body.source_context ?? null,
      });
      return c.json(result, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  // GET /api/v1/reminders/:id — Get reminder detail (includes comments + subtask tree)
  app.get('/api/v1/reminders/:id', async (c) => {
    const id = c.req.param('id');
    const detail = await remindersSvc.getReminderDetail(svcDeps, id);
    if (!detail) return c.json({ error: 'Reminder not found' }, 404);
    // Strip embeddings from the reminder row and all subtasks
    const { embedding: _e, ...rest } = detail as typeof detail & { embedding?: unknown };
    return c.json({
      ...rest,
      subtasks: detail.subtasks.map(stripEmbedding),
    });
  });

  // PATCH /api/v1/reminders/:id — Update reminder fields
  app.patch('/api/v1/reminders/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    try {
      await remindersSvc.updateReminder(svcDeps, id, {
        status: body.status,
        content: body.content,
        dueDate: body.due_date ? new Date(body.due_date) : undefined,
        priority: body.priority,
        project: body.project,
        section: body.section,
      });
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/v1/reminders/:id/complete — Mark done (cascades to subtasks)
  app.post('/api/v1/reminders/:id/complete', async (c) => {
    const id = c.req.param('id');
    const result = await remindersSvc.completeReminder(svcDeps, id);
    return c.json(result);
  });

  // DELETE /api/v1/reminders/:id — Delete a reminder (cascade)
  app.delete('/api/v1/reminders/:id', async (c) => {
    const id = c.req.param('id');
    await remindersSvc.deleteReminder(svcDeps, id);
    return c.json({ ok: true });
  });

  // POST /api/v1/reminders/:id/reparent — Move to a different parent
  app.post('/api/v1/reminders/:id/reparent', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    // parent_id can be null (move to root) or a string UUID
    const newParentId: string | null = body.parent_id ?? null;
    try {
      await remindersSvc.reparentReminder(svcDeps, id, newParentId);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  // ─── Comments ─────────────────────────────────────────────────────────────

  // GET /api/v1/reminders/:id/comments — List comments for a reminder
  app.get('/api/v1/reminders/:id/comments', async (c) => {
    const reminderId = c.req.param('id');
    const comments = await commentsSvc.listComments(svcDeps, reminderId);
    return c.json(comments.map(stripEmbedding));
  });

  // POST /api/v1/reminders/:id/comments — Add a comment
  app.post('/api/v1/reminders/:id/comments', async (c) => {
    const reminderId = c.req.param('id');
    const body = await c.req.json();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }
    try {
      const result = await commentsSvc.addComment(svcDeps, reminderId, body.content, 'api');
      return c.json(result, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // GET /api/v1/comments/:id — Get a single comment
  app.get('/api/v1/comments/:id', async (c) => {
    const id = c.req.param('id');
    const comment = await commentsSvc.getComment(svcDeps, id);
    if (!comment) return c.json({ error: 'Comment not found' }, 404);
    return c.json(stripEmbedding(comment));
  });

  // PUT /api/v1/comments/:id — Update a comment
  app.put('/api/v1/comments/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }
    try {
      await commentsSvc.updateComment(svcDeps, id, body.content);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // DELETE /api/v1/comments/:id — Delete a comment
  app.delete('/api/v1/comments/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const deleted = await commentsSvc.deleteComment(svcDeps, id);
      return c.json(stripEmbedding(deleted));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── Search ───────────────────────────────────────────────────────────────

  // POST /api/v1/search — Semantic search across captures/facts/insights
  app.post('/api/v1/search', async (c) => {
    const body = await c.req.json();
    if (!body.query || typeof body.query !== 'string') {
      return c.json({ error: 'query is required and must be a string' }, 400);
    }
    const threshold = typeof body.threshold === 'number' ? body.threshold : 0.7;
    const limit = typeof body.limit === 'number' ? body.limit : 10;
    const tags = Array.isArray(body.tags) ? body.tags : undefined;
    const results = await capturesSvc.searchThoughts(svcDeps, body.query, threshold, limit, tags);
    return c.json(results);
  });

  // ─── Profile ──────────────────────────────────────────────────────────────

  // GET /api/v1/profile — LLM-synthesized profile summary
  app.get('/api/v1/profile', async (c) => {
    const profile = await profileSvc.getUserProfile(svcDeps);
    return c.json({ profile });
  });

  // GET /api/v1/stats — Brain statistics
  app.get('/api/v1/stats', async (c) => {
    const stats = await profileSvc.getBrainStats(svcDeps);
    return c.json(stats);
  });

  // ─── Review ───────────────────────────────────────────────────────────────

  // GET /api/v1/review/pending — Pending facts and/or insights
  app.get('/api/v1/review/pending', async (c) => {
    const type = c.req.query('type'); // 'fact' | 'insight' | undefined (both)
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;

    const results: { facts?: unknown[]; insights?: unknown[] } = {};

    if (!type || type === 'fact') {
      const facts = await factsSvc.reviewPendingFacts(svcDeps, limit);
      results.facts = facts.map(stripEmbedding);
    }
    if (!type || type === 'insight') {
      const insights = await insightsSvc.reviewPendingInsights(svcDeps, limit);
      results.insights = insights.map(stripEmbedding);
    }

    return c.json(results);
  });

  // ─── Projects ─────────────────────────────────────────────────────────────

  // GET /api/v1/projects — List all projects with task count stats
  app.get('/api/v1/projects', async (c) => {
    const projects = await remindersSvc.listProjects(svcDeps);
    return c.json(projects);
  });

  // ─── Consolidation ────────────────────────────────────────────────────────

  // GET /api/v1/consolidation/logs — View consolidation run history
  app.get('/api/v1/consolidation/logs', async (c) => {
    const limit = Number(c.req.query('limit') ?? '10');
    const logs = await consolidationSvc.getConsolidationLogs(svcDeps, limit);
    return c.json(logs);
  });

  // POST /api/v1/consolidation/trigger — Manually trigger a consolidation run
  app.post('/api/v1/consolidation/trigger', async (c) => {
    try {
      await consolidationSvc.runConsolidation(svcDeps);
      // Fetch the latest log entry to return results
      const result = await deps.db.query(
        `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT 1`,
      );
      return c.json({ status: 'completed', log: result.rows[0] ?? null });
    } catch (err) {
      const result = await deps.db.query(
        `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT 1`,
      );
      return c.json({ status: 'error', error: String(err), log: result.rows[0] ?? null }, 500);
    }
  });

  // POST /api/v1/captures/reset-consolidated — Reset consolidated captures back to pending
  app.post('/api/v1/captures/reset-consolidated', async (c) => {
    const result = await deps.db.query(
      `UPDATE captures SET status = 'pending', updated_at = now()
       WHERE status = 'consolidated' AND archived = false
       RETURNING id`,
    );
    console.log(`[admin] Reset ${result.rows.length} consolidated captures to pending`);
    return c.json({ reset: result.rows.length });
  });

  // GET /api/v1/captures/diagnostics — Check embedding health
  app.get('/api/v1/captures/diagnostics', async (c) => {
    const result = await deps.db.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE embedding IS NULL)::int AS missing_embedding,
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'consolidated')::int AS consolidated,
        count(*) FILTER (WHERE status = 'pending' AND embedding IS NULL)::int AS pending_no_embedding,
        count(*) FILTER (WHERE status = 'pending' AND embedding IS NOT NULL)::int AS pending_with_embedding
      FROM captures WHERE archived = false
    `);
    return c.json(result.rows[0]);
  });

  // MCP routes
  mountMcpRoutes(app, deps);

  // Telegram webhook
  setupTelegramWebhook(app, deps);

  // Error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
