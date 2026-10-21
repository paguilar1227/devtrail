import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionCreateSchema, SessionUpdateSchema, TimelineQuerySchema } from '@open-brain/shared';
import type { ServiceDeps } from '../services/index.js';
import * as sessions from '../services/sessions.js';
import { listProjectTimeline, listSessionTimeline } from '../db/timeline.js';

const uuid = z.string().uuid();
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
export function registerSessionTools(server: McpServer, deps: ServiceDeps) {
  server.tool('list_sessions', 'List session workspaces. Omit project_id for all; null for standalone sessions.', { project_id: uuid.nullable().optional() },
    async ({ project_id }) => result(await sessions.listSessions(deps, project_id)));
  server.tool('create_session', 'Create or resume an owning session workspace. Reuse a stable session_key for idempotent retries. Omit project_id for standalone.', SessionCreateSchema.shape,
    async input => result(await sessions.createSession(deps, input)));
  server.tool('update_session', 'Rename a session or move it and all its owned artifacts, todos, and timeline to another project (null for standalone).', { session_id: uuid, ...SessionUpdateSchema.shape },
    async ({ session_id, ...input }) => {
      const session = await sessions.updateSession(deps, session_id, input);
      if (!session) throw new Error('Session not found');
      return result(session);
    });
  server.tool('get_session_context', 'Load a session handoff and its current artifacts and todos.', { session_id: uuid },
    async ({ session_id }) => {
      const context = await sessions.getSessionContext(deps, session_id);
      if (!context) throw new Error('Session not found');
      return result(context);
    });
  server.tool('get_project_context', 'Load the project, its session handoffs, and open todos.', { project_id: uuid },
    async ({ project_id }) => {
      const project = (await deps.db.query('SELECT * FROM projects WHERE id=$1', [project_id])).rows[0];
      if (!project) throw new Error('Project not found');
      const open = await deps.db.query("SELECT id,content,status,priority,due_date,parent_id FROM todos WHERE project_id=$1 AND archived=false AND status<>'done' ORDER BY created_at", [project_id]);
      return result({ project, sessions: await sessions.listSessions(deps, project_id), open_todos: open.rows });
    });
  server.tool('save_session', 'Save factual progress, explicit decisions and next steps to an existing session. Or use project_id and a stable session_key to create/resume a handoff. The source note is durable before asynchronous indexing.', {
    session_id: uuid.optional(), project_id: uuid.optional(), session_key: z.string().min(1),
    summary: z.string().min(1), decisions: z.array(z.string()).default([]), next_steps: z.array(z.string()).default([]),
  }, async ({ session_id, project_id, session_key, ...handoff }) => {
    const session = session_id ? await sessions.getSession(deps, session_id)
      : await sessions.createSession(deps, { name: `Session ${session_key}`, project_id, session_key });
    if (!session) throw new Error('Session not found');
    return result(await sessions.saveSessionHandoff(deps, session.id, handoff));
  });
  server.tool('session_timeline', 'Read durable session events, newest first. Search titles, actions and tags. Selected tags use AND by default; tag_match=any uses OR. Empty tags shows all events.', {
    session_id: uuid, ...TimelineQuerySchema.innerType().shape,
  }, async ({ session_id, ...query }) => {
    if (!await sessions.getSession(deps, session_id)) throw new Error('Session not found');
    return result(await listSessionTimeline(deps.db, session_id, TimelineQuerySchema.parse(query)));
  });
  server.tool('project_timeline', 'Read project history including every child session. Selected tags use AND by default; tag_match=any uses OR. Empty tags shows all events.', {
    project_id: uuid, ...TimelineQuerySchema.innerType().shape,
  }, async ({ project_id, ...query }) => {
    if (!(await deps.db.query('SELECT id FROM projects WHERE id=$1', [project_id])).rows.length) throw new Error('Project not found');
    return result(await listProjectTimeline(deps.db, project_id, TimelineQuerySchema.parse(query)));
  });
  server.tool('delete_session', 'Permanently delete a session and all owned content, files, todos, comments and timeline. Inspect first and obtain explicit user confirmation; repeat its exact name.', {
    session_id: uuid, confirm_name: z.string().min(1),
  }, { destructiveHint: true, readOnlyHint: false }, async ({ session_id, confirm_name }) => {
    const session = await sessions.getSession(deps, session_id);
    if (!session) throw new Error('Session not found');
    if (confirm_name !== session.name) throw new Error('Deletion confirmation does not match the session name. Nothing was deleted.');
    return result(await sessions.deleteSession(deps, session_id));
  });
  server.tool('retry_session_cleanup', 'Retry queued uploaded-file cleanup after deletion returned pending_files. Cannot delete a live session. Repeat the deleted session UUID as confirm_id.', {
    session_id: uuid, confirm_id: uuid,
  }, { destructiveHint: true, readOnlyHint: false }, async ({ session_id, confirm_id }) => {
    if (session_id !== confirm_id) throw new Error('Deletion confirmation does not match the target.');
    if (await sessions.getSession(deps, session_id)) throw new Error('Session still exists.');
    return result(await sessions.deleteSession(deps, session_id));
  });
}
