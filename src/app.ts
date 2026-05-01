import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ServiceDeps } from './services/index.js';
import type { BlobStorage } from './storage/blob.js';
import { createMcpServer } from './mcp/server.js';
import { resolveUploadMime } from './capture/mime-utils.js';
import * as projectsSvc from './services/projects.js';
import * as contentSvc from './services/content-items.js';
import * as todosSvc from './services/todos.js';
import * as commentsSvc from './services/todo-comments.js';
import * as searchSvc from './services/search.js';
import * as ragSvc from './services/rag.js';
import { classifyQueryDepth } from './services/query-depth.js';
import * as urlIngestSvc from './services/url-ingest.js';

export function createApp(deps: ServiceDeps) {
  const app = new Hono();

  app.use('*', cors({ origin: '*' }));

  // ----- auth -----
  app.use('/api/*', async (c, next) => {
    const key = c.req.header('Authorization')?.replace('Bearer ', '') ?? c.req.query('key');
    if (key !== deps.config.apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // ----- health -----
  app.get('/health', (c) => c.json({ ok: true, service: 'open-brain', version: '2.0.0' }));

  // ==========================================================================
  // PROJECTS
  // ==========================================================================
  app.get('/api/v1/projects', async (c) => {
    const status = c.req.query('status') ?? undefined;
    const projects = await projectsSvc.listProjects(deps, status);
    return c.json({ projects });
  });

  app.post('/api/v1/projects', async (c) => {
    const body = await c.req.json<{ name: string; description?: string }>();
    if (!body.name) return c.json({ error: 'name is required' }, 400);
    const project = await projectsSvc.createProject(deps, body.name, body.description ?? null);
    return c.json({ project }, 201);
  });

  app.get('/api/v1/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidUuid(id)) return c.json({ error: `Invalid UUID format: "${id}"` }, 400);
    const project = await projectsSvc.getProject(deps, id);
    if (!project) return c.json({ error: 'Not found' }, 404);
    return c.json({ project });
  });

  app.put('/api/v1/projects/:id', async (c) => {
    const body = await c.req.json<{ name?: string; description?: string; status?: string }>();
    const project = await projectsSvc.updateProject(deps, c.req.param('id'), body);
    if (!project) return c.json({ error: 'Not found' }, 404);
    return c.json({ project });
  });

  app.delete('/api/v1/projects/:id', async (c) => {
    const hard = c.req.query('hard') === 'true';
    if (hard) {
      await projectsSvc.deleteProjectHard(deps, c.req.param('id'));
      return c.json({ ok: true, mode: 'hard' });
    }
    await projectsSvc.archiveProject(deps, c.req.param('id'));
    return c.json({ ok: true, mode: 'archived' });
  });

  app.post('/api/v1/projects/:id/restore', async (c) => {
    await projectsSvc.unarchiveProject(deps, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ==========================================================================
  // CONTENT ITEMS (documents + notes)
  // ==========================================================================
  app.get('/api/v1/content', async (c) => {
    const type = c.req.query('type') as 'document' | 'note' | undefined;
    const project_id = c.req.query('project_id') ?? undefined;
    const tags = c.req.query('tags')?.split(',').filter(Boolean);
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;
    const include_archived = c.req.query('include_archived') === 'true';
    const items = await contentSvc.listContentItems(deps, { type, project_id, tags, limit, include_archived });
    return c.json({ items: items.map((it) => stripAndSignContent(deps.blobStorage, it)) });
  });

  app.post('/api/v1/content', async (c) => {
    // Accepts either JSON or multipart/form-data
    const contentType = c.req.header('Content-Type') ?? '';
    let type: 'document' | 'note';
    let content: string | undefined;
    let title: string | undefined;
    let projectIds: string[] | undefined;
    let tags: string[] | undefined;
    let file: { data: Buffer; mimeType: string; filename: string } | undefined;

    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      // Read type as-is and let the shared validator below catch missing/invalid.
      // Older code silently defaulted to 'note', which masked client mistakes
      // (a UI that forgot to send the form field would save documents as notes).
      type = body.type as 'document' | 'note';
      content = typeof body.content === 'string' ? body.content : undefined;
      title = typeof body.title === 'string' ? body.title : undefined;
      const pids = typeof body.project_ids === 'string' ? body.project_ids : undefined;
      projectIds = pids ? pids.split(',').filter(Boolean) : undefined;
      const tgs = typeof body.tags === 'string' ? body.tags : undefined;
      tags = tgs ? tgs.split(',').filter(Boolean) : undefined;
      const uploaded = body.file as File | undefined;
      if (uploaded && uploaded.size > 0) {
        file = {
          data: Buffer.from(await uploaded.arrayBuffer()),
          mimeType: resolveUploadMime(uploaded.type, uploaded.name),
          filename: uploaded.name,
        };
      }
    } else {
      const body = await c.req.json<{
        type: 'document' | 'note';
        content?: string;
        title?: string;
        project_ids?: string[];
        tags?: string[];
      }>();
      type = body.type;
      content = body.content;
      title = body.title;
      projectIds = body.project_ids;
      tags = body.tags;
    }

    if (!type || (type !== 'document' && type !== 'note')) {
      return c.json({ error: 'type must be "document" or "note"' }, 400);
    }
    if (!content && !file) {
      return c.json({ error: 'Must provide content or file' }, 400);
    }

    const started = await contentSvc.createContentItem(deps, {
      type, content, title, projectIds, tags, file,
    });
    // Async contract: return id + status immediately. Background pipeline
    // updates the row (and flips processing_status to 'ready' or 'failed')
    // when it lands. Text-only notes typically reach 'ready' before the
    // client even receives the response, so we re-fetch and report the
    // current status to keep dedup hits and trivial cases honest.
    return c.json({
      id: started.id,
      status: started.status,
    }, started.status === 'ready' ? 200 : 202);
  });

  // Ingest from URL — fetches & chunks a URL (YouTube, X, PDF, HTML, media)
  // Lives before /content/:id so routing doesn't treat "from-url" as an id.
  app.post('/api/v1/content/from-url', async (c) => {
    const body = await c.req.json<{
      url: string;
      project_ids?: string[];
      tags?: string[];
      title?: string;
    }>();
    if (!body.url) return c.json({ error: 'url is required' }, 400);
    try {
      const result = await urlIngestSvc.ingestFromUrl(deps, body.url, {
        projectIds: body.project_ids,
        tags: body.tags,
        title: body.title,
      });
      // Async contract: return id immediately. The completion promise runs
      // in the background. Status code:
      //   200 — dedup hit OR row already 'ready' (text-only that finished fast)
      //   202 — accepted, processing in background
      const httpStatus = result.deduped || result.status === 'ready' ? 200 : 202;
      return c.json({
        id: result.id,
        title: result.title,
        type: result.type,
        source_url: result.source_url,
        deduped: result.deduped,
        url_type: result.url_type,
        status: result.status,
      }, httpStatus);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get('/api/v1/content/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidUuid(id)) return c.json({ error: `Invalid UUID format: "${id}"` }, 400);
    const item = await contentSvc.getContentItem(deps, id);
    if (!item) return c.json({ error: 'Not found' }, 404);
    return c.json({ item: stripAndSignContent(deps.blobStorage, item) });
  });

  app.put('/api/v1/content/:id', async (c) => {
    const body = await c.req.json<{
      title?: string;
      content?: string;
      project_ids?: string[];
      tags?: string[];
    }>();
    const item = await contentSvc.updateContentItem(deps, c.req.param('id'), {
      title: body.title,
      content: body.content,
      projectIds: body.project_ids,
      tags: body.tags,
    });
    if (!item) return c.json({ error: 'Not found' }, 404);
    return c.json({ item: stripAndSignContent(deps.blobStorage, item) });
  });

  app.delete('/api/v1/content/:id', async (c) => {
    const hard = c.req.query('hard') === 'true';
    if (hard) {
      await contentSvc.deleteContentItemHardById(deps, c.req.param('id'));
      return c.json({ ok: true, mode: 'hard' });
    }
    await contentSvc.archiveContentItemById(deps, c.req.param('id'));
    return c.json({ ok: true, mode: 'archived' });
  });

  app.post('/api/v1/content/:id/restore', async (c) => {
    await contentSvc.unarchiveContentItemById(deps, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ==========================================================================
  // TODOS
  // ==========================================================================
  app.get('/api/v1/todos', async (c) => {
    const projectId = c.req.query('project_id');
    const status = c.req.query('status');
    const priority = c.req.query('priority');
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;
    const include_archived = c.req.query('include_archived') === 'true';

    const todos = await todosSvc.listTodos(deps, {
      project_id: projectId === 'null' ? null : projectId ?? undefined,
      status: status ?? undefined,
      priority: priority ?? undefined,
      limit,
      include_archived,
    });
    return c.json({ todos: todos.map(stripEmbedding) });
  });

  app.post('/api/v1/todos', async (c) => {
    const body = await c.req.json<{
      content: string;
      project_id?: string;
      section?: string;
      parent_id?: string;
      priority?: 'P1' | 'P2' | 'P3';
      due_date?: string;
      tags?: string[];
    }>();
    if (!body.content) return c.json({ error: 'content is required' }, 400);
    const result = await todosSvc.createTodo(deps, {
      content: body.content,
      projectId: body.project_id ?? null,
      section: body.section ?? null,
      parentId: body.parent_id ?? null,
      priority: body.priority ?? null,
      dueDate: body.due_date ? new Date(body.due_date) : null,
      tags: body.tags,
    });
    return c.json(result, 201);
  });

  app.get('/api/v1/todos/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidUuid(id)) return c.json({ error: `Invalid UUID format: "${id}"` }, 400);
    const todo = await todosSvc.getTodo(deps, id);
    if (!todo) return c.json({ error: 'Not found' }, 404);
    return c.json({ todo: stripEmbedding(todo) });
  });

  app.put('/api/v1/todos/:id', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const todo = await todosSvc.updateTodo(deps, c.req.param('id'), {
      content: body.content as string | undefined,
      projectId: body.project_id === null ? null : (body.project_id as string | undefined),
      section: body.section as string | undefined,
      parentId: body.parent_id === null ? null : (body.parent_id as string | undefined),
      status: body.status as string | undefined,
      priority: body.priority as 'P1' | 'P2' | 'P3' | null | undefined,
      dueDate: body.due_date ? new Date(body.due_date as string) : undefined,
      tags: body.tags as string[] | undefined,
    });
    if (!todo) return c.json({ error: 'Not found' }, 404);
    return c.json({ todo: stripEmbedding(todo) });
  });

  app.delete('/api/v1/todos/:id', async (c) => {
    const hard = c.req.query('hard') === 'true';
    if (hard) {
      await todosSvc.deleteTodoHardById(deps, c.req.param('id'));
      return c.json({ ok: true, mode: 'hard' });
    }
    await todosSvc.archiveTodoById(deps, c.req.param('id'));
    return c.json({ ok: true, mode: 'archived' });
  });

  app.post('/api/v1/todos/:id/restore', async (c) => {
    await todosSvc.unarchiveTodoById(deps, c.req.param('id'));
    return c.json({ ok: true });
  });

  // Todo comments
  app.get('/api/v1/todos/:id/comments', async (c) => {
    const comments = await commentsSvc.listComments(deps, c.req.param('id'));
    return c.json({ comments });
  });

  app.post('/api/v1/todos/:id/comments', async (c) => {
    const body = await c.req.json<{ content: string }>();
    const result = await commentsSvc.createComment(deps, c.req.param('id'), body.content);
    return c.json(result, 201);
  });

  app.put('/api/v1/todos/:id/comments/:cid', async (c) => {
    const body = await c.req.json<{ content: string }>();
    await commentsSvc.updateComment(deps, c.req.param('cid'), body.content);
    return c.json({ ok: true });
  });

  app.delete('/api/v1/todos/:id/comments/:cid', async (c) => {
    await commentsSvc.deleteComment(deps, c.req.param('cid'));
    return c.json({ ok: true });
  });

  // ==========================================================================
  // SEARCH + RAG
  // ==========================================================================
  app.post('/api/v1/search', async (c) => {
    const body = await c.req.json<{
      query: string;
      project_id?: string;
      entity_types?: Array<'document' | 'note' | 'todo'>;
      tags?: string[];
      limit?: number;
      threshold?: number;
      graph?: boolean;
    }>();
    if (!body.query) return c.json({ error: 'query is required' }, 400);

    // Default graph:true. When on, extract named entities from the query
    // via the same classifier the RAG path uses, so expansion can seed
    // from the question itself (not just from entities of the vector-seed
    // chunks). Cheap (~300ms Haiku call) and meaningful for entity-heavy
    // queries where the vector hits don't already include the entity-bearing
    // chunks. RAG already does this; mirror it on REST search for parity.
    const graphEnabled = body.graph !== false;
    let queryEntities: Array<{ name: string; type: 'person' | 'org' | 'concept' | 'tool' | 'paper' }> = [];
    if (graphEnabled) {
      const classification = await classifyQueryDepth(deps, body.query);
      queryEntities = classification.entities;
    }

    const hits = await searchSvc.search(deps, body.query, {
      projectId: body.project_id,
      entityTypes: body.entity_types,
      tags: body.tags,
      limit: body.limit ?? 10,
      threshold: body.threshold,
      graph: body.graph,
      queryEntities,
    });
    return c.json({ hits });
  });

  app.post('/api/v1/find-mentions', async (c) => {
    const body = await c.req.json<{
      entity: string;
      type?: 'person' | 'org' | 'concept' | 'tool' | 'paper';
      project_id?: string;
      limit?: number;
    }>();
    if (!body.entity) return c.json({ error: 'entity is required' }, 400);
    const result = await searchSvc.findMentions(deps, body.entity, {
      type: body.type,
      projectId: body.project_id,
      limit: body.limit ?? 20,
    });
    return c.json(result);
  });

  app.post('/api/v1/rag', async (c) => {
    const body = await c.req.json<{
      question: string;
      project_id?: string;
      tags?: string[];
      entity_types?: Array<'document' | 'note' | 'todo'>;
      max_chunks?: number;
      depth?: 'auto' | 'fast' | 'thorough';
      reasoning_effort?: 'low' | 'medium' | 'high';
    }>();
    if (!body.question) return c.json({ error: 'question is required' }, 400);
    const result = await ragSvc.ragQuery(deps, body.question, {
      projectId: body.project_id,
      tags: body.tags,
      entityTypes: body.entity_types,
      maxChunks: body.max_chunks ?? 6,
      // Default 'fast' — see ragQuery() and docs/profiles/2026-04-25-rag-effort-baseline.md.
      // Caller can opt into 'auto' or 'thorough' explicitly.
      depth: body.depth ?? 'fast',
      reasoningEffort: body.reasoning_effort,
    });
    return c.json(result);
  });

  // ==========================================================================
  // Diagnostics — read-only introspection of the entity graph layer.
  // Useful for triaging "why didn't this content show up in find_mentions"
  // type questions when direct DB access isn't available.
  // ==========================================================================

  // GET /api/v1/diagnostics/entities — all entities with edge counts
  app.get('/api/v1/diagnostics/entities', async (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    const result = await deps.db.query(
      `SELECT e.id, e.canonical_name, e.type, e.aliases,
              array_length(e.aliases, 1) AS alias_count,
              (SELECT count(*)::int FROM chunk_entities ce WHERE ce.entity_id = e.id) AS edge_count,
              (SELECT count(DISTINCT c.content_item_id)::int
                 FROM chunk_entities ce
                 JOIN chunks c ON c.id = ce.chunk_id
                WHERE ce.entity_id = e.id) AS doc_count
         FROM entities e
        ORDER BY edge_count DESC, e.canonical_name ASC
        LIMIT $1`,
      [limit],
    );
    return c.json({ entities: result.rows });
  });

  // POST /api/v1/diagnostics/backfill-entities — re-run entity extraction
  // for a single content item or for all items. Idempotent: edges that
  // already exist (chunk_id, entity_id PK) are skipped on conflict.
  // Body: { content_item_id?: string }   omit = backfill the whole corpus
  app.post('/api/v1/diagnostics/backfill-entities', async (c) => {
    const { buildGraphEdges } = await import('./services/entities.js');
    const { getChunksByContentItem } = await import('./db/chunks.js');

    let body: { content_item_id?: string } = {};
    try { body = await c.req.json(); } catch { /* empty body OK */ }

    const targetId = body.content_item_id;
    const itemQuery = targetId
      ? `SELECT id, title, content FROM content_items WHERE id = $1 AND archived = false`
      : `SELECT id, title, content FROM content_items WHERE archived = false AND content IS NOT NULL ORDER BY created_at ASC`;
    const items = await deps.db.query(itemQuery, targetId ? [targetId] : []);

    const results: Array<{ id: string; title: string; entity_count: number; edge_count: number; error?: string }> = [];
    for (const row of items.rows) {
      try {
        const chunks = await getChunksByContentItem(deps.db, row.id);
        if (chunks.length === 0) {
          results.push({ id: row.id, title: row.title, entity_count: 0, edge_count: 0, error: 'no chunks' });
          continue;
        }
        const r = await buildGraphEdges(deps, row.content ?? '', chunks);
        results.push({ id: row.id, title: row.title, entity_count: r.entityCount, edge_count: r.edgeCount });
      } catch (err) {
        results.push({
          id: row.id, title: row.title, entity_count: 0, edge_count: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return c.json({ processed: results.length, results });
  });

  // GET /api/v1/diagnostics/content/:id/edges — all chunk_entities for one content item
  app.get('/api/v1/diagnostics/content/:id/edges', async (c) => {
    const id = c.req.param('id');
    if (!isValidUuid(id)) return c.json({ error: `Invalid UUID format: "${id}"` }, 400);
    const result = await deps.db.query(
      `SELECT c.id AS chunk_id, c.chunk_index,
              e.id AS entity_id, e.canonical_name, e.type,
              ce.confidence, ce.mention_text
         FROM chunks c
         JOIN chunk_entities ce ON ce.chunk_id = c.id
         JOIN entities e ON e.id = ce.entity_id
        WHERE c.content_item_id = $1
        ORDER BY c.chunk_index ASC, ce.confidence DESC`,
      [id],
    );
    return c.json({
      content_item_id: id,
      edge_count: result.rows.length,
      edges: result.rows,
    });
  });

  // ==========================================================================
  // MCP endpoint — stateless mode (sessionIdGenerator: undefined).
  // Each request gets a fresh server + transport. No session persistence,
  // no "server already initialized" issues, no session-id header dance.
  // Correct for simple per-request tool calls like what Claude.ai MCP uses.
  // ==========================================================================
  app.all('/mcp', async (c) => {
    console.log(`[mcp] ${c.req.method} incoming`);
    try {
      const server = createMcpServer(deps);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,   // stateless: no session tracking
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      console.log(`[mcp] responding with status ${response.status}`);
      return response;
    } catch (err) {
      console.error(`[mcp] handler crashed:`, err);
      return c.json({ error: 'MCP handler error', detail: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ==========================================================================
  // Static web UI (served last, after API + MCP so they take precedence)
  // ==========================================================================
  app.use('/*', serveStatic({ root: './web/dist' }));
  app.get('*', serveStatic({ path: './web/dist/index.html' }));

  return app;
}

function stripEmbedding<T extends { embedding?: unknown }>(obj: T): Omit<T, 'embedding'> {
  const { embedding, ...rest } = obj;
  return rest;
}

/**
 * Like stripEmbedding, but also rewrites blob_url to a SAS-signed URL the
 * client can actually fetch. Used for content_items responses; todos don't
 * have blob_url so they keep using stripEmbedding directly.
 */
function stripAndSignContent<T extends { embedding?: unknown; blob_url?: string | null }>(
  blobStorage: BlobStorage,
  obj: T,
): Omit<T, 'embedding'> {
  const stripped = stripEmbedding(obj) as Omit<T, 'embedding'> & { blob_url?: string | null };
  if (stripped.blob_url) {
    stripped.blob_url = blobStorage.getReadSasUrl(stripped.blob_url);
  }
  return stripped;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}
