// src/app.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DbClient } from './db/client.js';
import type { EmbeddingProvider, LLMProvider } from './providers/types.js';
import type { BlobStorage } from './storage/blob.js';
import type { Config } from './config.js';
import { runCapturePipeline } from './capture/pipeline.js';
import { runConsolidation } from './consolidation/runner.js';
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

export function createApp(deps: AppDeps) {
  const app = new Hono();

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

  // GET /api/v1/captures — List recent captures (for debugging/admin)
  app.get('/api/v1/captures', async (c) => {
    const limit = Number(c.req.query('limit') ?? '10');
    const result = await deps.db.query(
      `SELECT id, content, content_types, file_urls, source, status, created_at
       FROM captures ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return c.json(result.rows);
  });

  // GET /api/v1/facts — List facts
  app.get('/api/v1/facts', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const result = await deps.db.query(
      `SELECT id, content, category, confidence, origin, review_status, source_capture_ids, created_at, updated_at
       FROM facts WHERE archived = false ORDER BY confidence DESC, created_at DESC LIMIT $1`,
      [limit],
    );
    return c.json(result.rows);
  });

  // GET /api/v1/insights — List insights
  app.get('/api/v1/insights', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const result = await deps.db.query(
      `SELECT id, content, category, confidence, origin, review_status, source_fact_ids, generated_at, updated_at
       FROM insights WHERE archived = false ORDER BY confidence DESC, generated_at DESC LIMIT $1`,
      [limit],
    );
    return c.json(result.rows);
  });

  // GET /api/v1/consolidation/logs — View consolidation run history
  app.get('/api/v1/consolidation/logs', async (c) => {
    const limit = Number(c.req.query('limit') ?? '10');
    const result = await deps.db.query(
      `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT $1`,
      [limit],
    );
    return c.json(result.rows);
  });

  // POST /api/v1/consolidation/trigger — Manually trigger a consolidation run
  app.post('/api/v1/consolidation/trigger', async (c) => {
    try {
      await runConsolidation({
        db: deps.db,
        consolidationLLM: deps.consolidationLLM,
        embeddingProvider: deps.embeddingProvider,
        reviewMode: deps.config.reviewMode,
      });
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

  // GET /api/v1/reminders — List reminders
  app.get('/api/v1/reminders', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const status = c.req.query('status');
    const project = c.req.query('project');
    let query = `SELECT id, content, category, project, section, status, priority, depth, parent_id, due_date, created_at
       FROM reminders WHERE archived = false`;
    const params: unknown[] = [];
    let paramIdx = 1;
    if (status) { query += ` AND status = $${paramIdx++}`; params.push(status); }
    if (project) { query += ` AND project = $${paramIdx++}`; params.push(project); }
    query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(limit);
    const result = await deps.db.query(query, params);
    return c.json(result.rows);
  });

  // POST /api/v1/capture — Universal ingest endpoint
  app.post('/api/v1/capture', async (c) => {
    const body = await c.req.json();
    const { content, source = 'api', file_urls } = body;

    if (!content || typeof content !== 'string') {
      return c.json({ error: 'content is required and must be a string' }, 400);
    }

    // Download files from URLs if provided (MCP file handling)
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
          return c.json({ error: `Failed to download file: ${url}` }, 400);
        }
      }
    }

    const result = await runCapturePipeline({
      db: deps.db,
      embeddingProvider: deps.embeddingProvider,
      metadataLLM: deps.metadataLLM,
      blobStorage: deps.blobStorage,
      content,
      files,
      source,
    });

    if (!result.success) {
      return c.json({ error: result.reason }, 409);
    }

    return c.json({ captureId: result.captureId }, 201);
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
