// src/app.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DbClient } from './db/client.js';
import type { EmbeddingProvider, LLMProvider } from './providers/types.js';
import type { BlobStorage } from './storage/blob.js';
import type { Config } from './config.js';
import { runCapturePipeline } from './capture/pipeline.js';
import { mountMcpRoutes } from './mcp/server.js';

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

  // Error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
