import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ServiceDeps } from './services/index.js';
import { createMcpServer } from './mcp/server.js';
import * as projectsSvc from './services/projects.js';
import * as contentSvc from './services/content-items.js';
import * as todosSvc from './services/todos.js';
import * as commentsSvc from './services/todo-comments.js';
import * as searchSvc from './services/search.js';
import * as ragSvc from './services/rag.js';

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
    const project = await projectsSvc.getProject(deps, c.req.param('id'));
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
    return c.json({ items: items.map(stripEmbedding) });
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
      type = (body.type as string) === 'document' ? 'document' : 'note';
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
          mimeType: uploaded.type || 'application/octet-stream',
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

    const result = await contentSvc.createContentItem(deps, {
      type, content, title, projectIds, tags, file,
    });
    return c.json(result, 201);
  });

  app.get('/api/v1/content/:id', async (c) => {
    const item = await contentSvc.getContentItem(deps, c.req.param('id'));
    if (!item) return c.json({ error: 'Not found' }, 404);
    return c.json({ item: stripEmbedding(item) });
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
    return c.json({ item: stripEmbedding(item) });
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
    const todo = await todosSvc.getTodo(deps, c.req.param('id'));
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
    }>();
    if (!body.query) return c.json({ error: 'query is required' }, 400);
    const hits = await searchSvc.search(deps, body.query, {
      projectId: body.project_id,
      entityTypes: body.entity_types,
      tags: body.tags,
      limit: body.limit ?? 10,
    });
    return c.json({ hits });
  });

  app.post('/api/v1/rag', async (c) => {
    const body = await c.req.json<{
      question: string;
      project_id?: string;
      tags?: string[];
      entity_types?: Array<'document' | 'note' | 'todo'>;
      max_chunks?: number;
    }>();
    if (!body.question) return c.json({ error: 'question is required' }, 400);
    const result = await ragSvc.ragQuery(deps, body.question, {
      projectId: body.project_id,
      tags: body.tags,
      entityTypes: body.entity_types,
      maxChunks: body.max_chunks ?? 6,
    });
    return c.json(result);
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
