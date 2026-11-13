import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  ErrorResponseSchema,
  IdParamSchema,
  SessionCreateSchema,
  SessionSchema,
  SessionUpdateSchema,
  TimelineQuerySchema,
  TimelineResponseSchema,
  UuidSchema,
} from '@devtrail/shared';
import type { ServiceDeps } from './services/index.js';
import * as sessions from './services/sessions.js';
import { listProjectTimeline, listSessionTimeline } from './db/timeline.js';

const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  400: json('Invalid request', ErrorResponseSchema),
  401: json('Unauthorized', ErrorResponseSchema),
};
const notFound = { 404: json('Not found', ErrorResponseSchema) };

const TimelineRequestQuerySchema = TimelineQuerySchema.innerType().omit({ tags: true }).extend({
  tags: z.string().optional().describe('Comma-separated tag names, like the other list endpoints'),
});
const SessionListQuerySchema = z.object({
  project_id: z.union([UuidSchema, z.literal('null')]).optional()
    .describe('Project id, or "null" for sessions without a project'),
});
const SessionEnvelopeSchema = z.object({ session: SessionSchema });
const SessionContextSchema = z.object({
  session: SessionSchema,
  artifacts: z.array(z.unknown()),
  todos: z.array(z.unknown()),
});
const SessionDeleteResponseSchema = z.object({ ok: z.boolean(), pending_files: z.number() });

function timelineQuery(query: z.infer<typeof TimelineRequestQuerySchema>) {
  const tags = query.tags?.split(',').map(tag => tag.trim()).filter(Boolean) ?? [];
  return TimelineQuerySchema.parse({ ...query, tags });
}

export function addWorkspaceRoutes(app: OpenAPIHono, deps: ServiceDeps) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/projects/{id}/timeline',
      tags: ['Timeline'],
      summary: 'Project timeline, newest first',
      request: { params: IdParamSchema, query: TimelineRequestQuerySchema },
      responses: { 200: json('Durable timeline, newest first', TimelineResponseSchema), ...errors, ...notFound },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const query = timelineQuery(c.req.valid('query'));
      const project = await deps.db.query('SELECT id FROM projects WHERE id=$1', [id]);
      if (!project.rows.length) return c.json({ error: 'Project not found' }, 404);
      return c.json(await listProjectTimeline(deps.db, id, query), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sessions',
      tags: ['Sessions'],
      summary: 'List sessions',
      request: { query: SessionListQuerySchema },
      responses: { 200: json('Session workspaces', z.object({ sessions: z.array(SessionSchema) })), ...errors },
    }),
    async (c) => {
      const { project_id } = c.req.valid('query');
      return c.json({ sessions: await sessions.listSessions(deps, project_id === 'null' ? null : project_id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sessions',
      tags: ['Sessions'],
      summary: 'Create or resume a session',
      request: { body: { content: { 'application/json': { schema: SessionCreateSchema } } } },
      responses: { 201: json('Session workspace', SessionEnvelopeSchema), ...errors },
    }),
    async (c) => c.json({ session: await sessions.createSession(deps, c.req.valid('json')) }, 201),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sessions/{id}',
      tags: ['Sessions'],
      summary: 'Get a session',
      request: { params: IdParamSchema },
      responses: { 200: json('Session workspace', SessionEnvelopeSchema), ...errors, ...notFound },
    }),
    async (c) => {
      const session = await sessions.getSession(deps, c.req.valid('param').id);
      return session ? c.json({ session }, 200) : c.json({ error: 'Session not found' }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/sessions/{id}',
      tags: ['Sessions'],
      summary: 'Update a session',
      request: {
        params: IdParamSchema,
        body: { content: { 'application/json': { schema: SessionUpdateSchema } } },
      },
      responses: { 200: json('Session workspace', SessionEnvelopeSchema), ...errors, ...notFound },
    }),
    async (c) => {
      const session = await sessions.updateSession(deps, c.req.valid('param').id, c.req.valid('json'));
      return session ? c.json({ session }, 200) : c.json({ error: 'Session not found' }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/sessions/{id}',
      tags: ['Sessions'],
      summary: 'Delete a session and everything it owns',
      request: { params: IdParamSchema },
      responses: {
        200: json('Session deleted; pending_files counts blob cleanup that a repeated DELETE retries', SessionDeleteResponseSchema),
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.deleteSession(deps, c.req.valid('param').id), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sessions/{id}/context',
      tags: ['Sessions'],
      summary: 'Session with its current artifacts and todos',
      request: { params: IdParamSchema },
      responses: { 200: json('Session context', SessionContextSchema), ...errors, ...notFound },
    }),
    async (c) => {
      const context = await sessions.getSessionContext(deps, c.req.valid('param').id);
      return context ? c.json(context, 200) : c.json({ error: 'Session not found' }, 404);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sessions/{id}/timeline',
      tags: ['Timeline'],
      summary: 'Session timeline, newest first',
      request: { params: IdParamSchema, query: TimelineRequestQuerySchema },
      responses: { 200: json('Durable timeline, newest first', TimelineResponseSchema), ...errors, ...notFound },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const query = timelineQuery(c.req.valid('query'));
      if (!await sessions.getSession(deps, id)) return c.json({ error: 'Session not found' }, 404);
      return c.json(await listSessionTimeline(deps.db, id, query), 200);
    },
  );
}
