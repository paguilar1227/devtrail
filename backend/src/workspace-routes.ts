import { z } from 'zod';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { SessionCreateSchema, SessionUpdateSchema, SessionSchema, TimelineQuerySchema, TimelineResponseSchema } from '@devtrail/shared';
import type { ServiceDeps } from './services/index.js';
import * as sessions from './services/sessions.js';
import { listProjectTimeline, listSessionTimeline } from './db/timeline.js';

const uuid = z.string().uuid();
export function addWorkspaceRoutes(app: OpenAPIHono, deps: ServiceDeps) {
  app.get('/api/v1/projects/:id/timeline', async c => {
    const id = uuid.parse(c.req.param('id'));
    const query = TimelineQuerySchema.parse({ ...c.req.query(), tags: c.req.queries('tag') ?? [] });
    const project = await deps.db.query('SELECT id FROM projects WHERE id=$1', [id]);
    if (!project.rows.length) return c.json({ error: 'Project not found' }, 404);
    return c.json(await listProjectTimeline(deps.db, id, query));
  });
  app.get('/api/v1/sessions', async c => {
    const scope = z.union([uuid, z.literal('null')]).optional().parse(c.req.query('project_id'));
    return c.json({ sessions: await sessions.listSessions(deps, scope === 'null' ? null : scope) });
  });
  app.post('/api/v1/sessions', async c => c.json({ session: await sessions.createSession(deps, SessionCreateSchema.parse(await c.req.json())) }, 201));
  app.get('/api/v1/sessions/:id', async c => {
    const session = await sessions.getSession(deps, uuid.parse(c.req.param('id')));
    return session ? c.json({ session }) : c.json({ error: 'Session not found' }, 404);
  });
  app.put('/api/v1/sessions/:id', async c => {
    const session = await sessions.updateSession(deps, uuid.parse(c.req.param('id')), SessionUpdateSchema.parse(await c.req.json()));
    return session ? c.json({ session }) : c.json({ error: 'Session not found' }, 404);
  });
  app.delete('/api/v1/sessions/:id', async c => c.json(await sessions.deleteSession(deps, uuid.parse(c.req.param('id')))));
  app.get('/api/v1/sessions/:id/context', async c => {
    const context = await sessions.getSessionContext(deps, uuid.parse(c.req.param('id')));
    return context ? c.json(context) : c.json({ error: 'Session not found' }, 404);
  });
  app.get('/api/v1/sessions/:id/timeline', async c => {
    const id = uuid.parse(c.req.param('id'));
    if (!await sessions.getSession(deps, id)) return c.json({ error: 'Session not found' }, 404);
    const query = TimelineQuerySchema.parse({ ...c.req.query(), tags: c.req.queries('tag') ?? [] });
    return c.json(await listSessionTimeline(deps.db, id, query));
  });

  // Keep the new workspace endpoints in the same authenticated OpenAPI document.
  const json = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
  for (const scope of ['projects', 'sessions']) {
    app.openAPIRegistry.registerPath({
      method: 'get', path: `/api/v1/${scope}/{id}/timeline`, tags: ['Timeline'],
      request: { params: z.object({ id: uuid }), query: TimelineQuerySchema.innerType().extend({ tag: z.array(z.string()).optional() }) },
      responses: { 200: { description: 'Durable timeline, newest first', content: json(TimelineResponseSchema) } },
    });
  }
  for (const method of ['get', 'post'] as const) {
    app.openAPIRegistry.registerPath({
      method, path: '/api/v1/sessions', tags: ['Sessions'],
      ...(method === 'post' ? { request: { body: { content: json(SessionCreateSchema) } } } : {}),
      responses: { [method === 'post' ? 201 : 200]: { description: 'Session workspaces', content: json(method === 'post' ? z.object({ session: SessionSchema }) : z.object({ sessions: z.array(SessionSchema) })) } },
    });
  }
  for (const method of ['get', 'put', 'delete'] as const) {
    app.openAPIRegistry.registerPath({
      method, path: '/api/v1/sessions/{id}', tags: ['Sessions'],
      request: { params: z.object({ id: uuid }), ...(method === 'put' ? { body: { content: json(SessionUpdateSchema) } } : {}) },
      responses: { 200: { description: method === 'delete' ? 'Session deleted; pending_files reports retryable blob cleanup' : 'Session workspace', content: json(method === 'delete' ? z.object({ ok: z.boolean(), pending_files: z.number() }) : z.object({ session: SessionSchema })) } },
    });
  }
  app.openAPIRegistry.registerPath({
    method: 'get', path: '/api/v1/sessions/{id}/context', tags: ['Sessions'], request: { params: z.object({ id: uuid }) },
    responses: { 200: { description: 'Session with its current artifacts and todos', content: json(z.object({ session: SessionSchema, artifacts: z.array(z.unknown()), todos: z.array(z.unknown()) })) } },
  });
}
