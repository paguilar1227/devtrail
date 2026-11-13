// frontend/src/lib/api.ts
//
// Typed fetch client for the DevTrail REST API. All responses are validated
// against shared Zod schemas (`@devtrail/shared`) — bad data fails loud.
//
// Auth: every /api/v1 call carries `Authorization: Bearer <key>`. The key
// comes from the build env in local dev, from the sign-in screen when the
// server runs with AUTH_MODE=api-key (the default), or from the
// /api/auth/token exchange when it runs behind Azure Easy Auth.

import {
  SessionSchema, type Session, SessionCreateSchema, SessionUpdateSchema,
  ActivityListQuerySchema,
  ActivityListResponseSchema,
  ContentGetResponseSchema,
  ContentListQuerySchema,
  ContentListResponseSchema,
  ContentCreateResponseSchema,
  ContentEditBodyRequestSchema,
  ContentUpdateRequestSchema,
  NoteCreateRequestSchema,
  ProjectCountsListResponseSchema,
  ProjectCreateRequestSchema,
  ProjectUpdateRequestSchema,
  ProjectGetResponseSchema,
  ProjectListQuerySchema,
  ProjectListResponseSchema,
  TodoCommentCreateRequestSchema,
  TodoCreateRequestSchema,
  TodoGetResponseSchema,
  TodoUpdateRequestSchema,
  TodoReorderRequestSchema,
  TodoReorderResponseSchema,
  RagRequestSchema,
  RagResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  StatsSchema,
  TagListResponseSchema,
  TagDeleteResponseSchema,
  type TagDeleteResponse,
  TagRenameRequestSchema,
  TagRenameResponseSchema,
  type TagRenameResponse,
  TodoCommentListResponseSchema,
  TodoListQuerySchema,
  TodoListResponseSchema,
  type ActivityEvent,
  type ActivityListQuery,
  type ContentCreateResponse,
  type ContentItem,
  type ContentListQuery,
  type ContentUpdateRequest,
  type NoteCreateRequest,
  type Project,
  type ProjectCounts,
  type ProjectCreateRequest,
  type ProjectUpdateRequest,
  type ProjectListQuery,
  type RagRequest,
  type RagResponse,
  type SearchHit,
  type SearchRequest,
  type TodoCommentCreateRequest,
  type TodoCreateRequest,
  type TodoUpdateRequest,
  type TodoReorderRequest,
  type TodoReorderResponse,
  type Stats,
  type Tag,
  type Todo,
  type TodoComment,
  type TodoListQuery,
  TimelineResponseSchema,
  type TimelineCursor,
  type TimelineResponse,
  type TimelineTagMatch,
} from '@devtrail/shared';
import { z } from 'zod';
import { apiOrigin, clearServerOrigin, fetchCredentials, isNativeApp, saveServerOrigin, storedServerOrigin } from './nativeConfig';

// Web: '' → same-origin relative paths, exactly as before. Native shell:
// the server origin stored by the connect screen (see nativeConfig.ts).
// Derived per request so config changes can never race a module-load
// snapshot — correctness doesn't depend on callers remembering to reload.
const base = (): string => `${apiOrigin()}/api/v1`;
const TOKEN_STORAGE_KEY = 'devtrail.api_key';
const AUTH_MODE_STORAGE_KEY = 'devtrail.auth_mode';
const PRINCIPAL_STORAGE_KEY = 'devtrail.principal_name';

// Who the account row shows: the Entra sign-in name when Easy Auth provided
// one, otherwise the generic owner of an API-key-protected server.
export function signedInAccount(): { name: string; detail: string } {
  let principal = '';
  try { principal = localStorage.getItem(PRINCIPAL_STORAGE_KEY) ?? ''; } catch { /* ignore */ }
  return principal ? { name: principal, detail: 'Microsoft Entra ID' } : { name: 'Owner', detail: 'API key' };
}

// Resolve the Bearer key the UI uses for /api/v1/* calls. Four sources:
//   - Local dev (web): `VITE_DEVTRAIL_API_KEY` from the build env (matches
//     the backend's stub-mode default).
//   - Self-hosted web (AUTH_MODE=api-key): the key the user entered on the
//     sign-in screen. /api/auth/token answers 404 in this mode.
//   - Azure web (AUTH_MODE=easyauth): the `/api/auth/token` exchange, which
//     sits behind Easy Auth — the platform has already validated the user's
//     cookie session by the time that endpoint runs, and the response carries
//     the long-lived Bearer key plus the Entra principal id/name. We cache it
//     in localStorage so the next page load skips the round-trip.
//   - Native shell: ONLY the key stored by the connect screen counts — a
//     dev key baked into the bundle at build time would silently pair the
//     app with the wrong backend.
//
// `bootAuth()` is called once before React mounts (see main.tsx). If the
// session has expired, the fetch comes back as an opaque redirect and we
// hard-navigate to the AAD login URL with `post_login_redirect_uri` set
// to the current page so the user lands back where they were.
let API_KEY: string = resolveInitialApiKey();

function resolveInitialApiKey(): string {
  const stored =
    typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_STORAGE_KEY) ?? '' : '';
  if (isNativeApp()) return stored;
  return import.meta.env.VITE_DEVTRAIL_API_KEY ?? stored;
}


export function listProjectTimeline(projectId: string, search: string, cursor: TimelineCursor | null, signal?: AbortSignal, tags: string[] = [], tagMatch: TimelineTagMatch = 'all'): Promise<TimelineResponse> {
  const params = new URLSearchParams({ search, tag_match: tagMatch });
  if (tags.length) params.set('tags', tags.join(','));
  if (cursor) { params.set('before_at', cursor.at); params.set('before_id', cursor.id); }
  return request(`/projects/${projectId}/timeline?${params}`, TimelineResponseSchema, { signal });
}

// Drop the cached Bearer key and end the session. In prod this kicks
// the user through Easy Auth's /.auth/logout endpoint, which clears the
// Entra cookie and redirects back to the SPA root (where bootAuth will
// re-trigger the AAD login). In dev there's no cookie session — we just
// reload so any in-memory state resets.
export function logout(): void {
  let easyAuth = false;
  try {
    easyAuth = localStorage.getItem(AUTH_MODE_STORAGE_KEY) === 'easyauth';
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(AUTH_MODE_STORAGE_KEY);
    localStorage.removeItem(PRINCIPAL_STORAGE_KEY);
  } catch { /* ignore */ }
  if (isNativeApp()) {
    // Native shell = full disconnect: drop the stored server origin too, so
    // the relaunch lands back on the connect screen.
    clearServerOrigin();
    API_KEY = '';
    window.location.reload();
    return;
  }
  API_KEY = import.meta.env.VITE_DEVTRAIL_API_KEY ?? '';
  if (import.meta.env.DEV || !easyAuth) {
    window.location.assign('/');
    return;
  }
  // post_logout_redirect_uri matters: without it Easy Auth lands on its
  // own /.auth/logout/complete page, which is jarring.
  window.location.assign('/.auth/logout?post_logout_redirect_uri=/');
}

// Thrown by bootAuth on the web when the server has no token exchange
// (AUTH_MODE=api-key) and no key is stored yet. main.tsx renders the sign-in
// screen instead of the app.
export class ApiKeyRequired extends Error {
  constructor() {
    super('Sign in with the server API key');
    this.name = 'ApiKeyRequired';
  }
}

// Thrown by bootAuth when the native shell has no stored server config yet.
// main.tsx catches it and renders the connect screen instead of the app.
export class NativeSetupRequired extends Error {
  constructor() {
    super('Native shell requires server configuration');
    this.name = 'NativeSetupRequired';
  }
}

// Connect-screen preflight: proves the origin hosts an DevTrail backend
// AND that the key is accepted, without touching module state. /stats is the
// cheapest authenticated read — and its body is validated against the shared
// schema so a captive portal or wildcard vhost that 200s everything can't
// pass the probe and get the key persisted.
export async function probeServer(origin: string, key: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v1/stats`, {
      headers: { Authorization: `Bearer ${key}` },
      // Without a deadline an unresponsive host pins the connect screen on
      // "Connecting…" forever; 10s is generous for a /stats read.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server — check the URL');
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(res.status, 'The server rejected the API key');
  }
  if (!res.ok) {
    throw new ApiError(res.status, `Server responded with HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, "That URL responded, but not like an DevTrail server — check it");
  }
  if (!StatsSchema.safeParse(body).success) {
    throw new ApiError(res.status, "That URL responded, but not like an DevTrail server — check it");
  }
}

// Persist the connect-screen pair. Callers reload the page afterwards so the
// app boots cleanly from the stored config (the API prefix itself is derived
// per request and needs no reload).
export function saveApiKey(key: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, key);
}

export function saveNativeServerConfig(origin: string, key: string): void {
  saveServerOrigin(origin);
  localStorage.setItem(TOKEN_STORAGE_KEY, key);
}

export async function bootAuth(): Promise<void> {
  // Native shell: there is no Easy Auth session — the connect screen stores
  // the server origin + API key, and until both exist there is nothing to
  // boot. The reload after saving re-runs this check with storage populated.
  if (isNativeApp()) {
    if (!storedServerOrigin() || !API_KEY) throw new NativeSetupRequired();
    return;
  }

  // If the build supplied a key, we're in local dev — nothing to exchange.
  if (import.meta.env.VITE_DEVTRAIL_API_KEY) return;

  // If we already have a cached token from a prior session, optimistically
  // use it; expired-cookie re-auth will surface as 401 on the next /api/v1
  // call and the React error boundary surfaces it.
  if (API_KEY) return;

  const res = await fetch('/api/auth/token', {
    credentials: 'include',
    redirect: 'manual',
  });

  // `redirect: 'manual'` returns an opaque 0-status response when the
  // platform 302s us to login. Hard-navigate so the browser follows.
  if (res.type === 'opaqueredirect' || res.status === 0) {
    const here = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/.auth/login/aad?post_login_redirect_uri=${here}`);
    // Block React from mounting; the navigation above tears the page down.
    throw new Error('Redirecting to login…');
  }

  if (res.status === 404) throw new ApiKeyRequired();
  if (!res.ok) {
    throw new Error(`bootAuth failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { key: string; principalName?: string | null };
  API_KEY = data.key;
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, data.key);
    localStorage.setItem(AUTH_MODE_STORAGE_KEY, 'easyauth');
    localStorage.setItem(PRINCIPAL_STORAGE_KEY, data.principalName ?? '');
  } catch { /* ignore quota / private-mode errors */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${API_KEY}`);
  if (init.body && !headers.has('Content-Type') && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${base()}${path}`, { ...init, headers, credentials: fetchCredentials() });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      typeof json === 'object' && json && 'error' in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, json);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(res.status, `Response failed validation: ${parsed.error.message}`, json);
  }
  return parsed.data;
}

// For mutations whose response shape we don't need to validate against —
// pin/unpin/restore/delete return `{ok: true}`-ish envelopes that vary slightly
// across endpoints. The frontend only cares whether the call succeeded.
async function fetchOk(path: string, init: RequestInit = {}): Promise<void> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${API_KEY}`);
  if (init.body && !headers.has('Content-Type') && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${base()}${path}`, { ...init, headers, credentials: fetchCredentials() });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      if (typeof j?.error === 'string') msg = j.error;
    } catch { /* leave msg as HTTP code */ }
    throw new ApiError(res.status, msg);
  }
}

function toQueryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v.join(','))}`);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------- Stats ----------------

export async function getStats(projectId?: string): Promise<Stats> {
  const qs = toQueryString({ project_id: projectId });
  return request(`/stats${qs}`, StatsSchema);
}

// ---------------- Projects ----------------

export async function listProjects(query: ProjectListQuery = {}): Promise<Project[]> {
  const parsed = ProjectListQuerySchema.parse(query);
  const qs = toQueryString(parsed);
  const data = await request(`/projects${qs}`, ProjectListResponseSchema);
  return data.projects;
}

export async function listProjectCounts(): Promise<ProjectCounts[]> {
  const data = await request('/projects/counts', ProjectCountsListResponseSchema);
  return data.counts;
}

export async function getProject(id: string): Promise<Project> {
  const data = await request(`/projects/${id}`, ProjectGetResponseSchema);
  return data.project;
}

export async function createProject(req: ProjectCreateRequest): Promise<Project> {
  const body = JSON.stringify(ProjectCreateRequestSchema.parse(req));
  const data = await request('/projects', ProjectGetResponseSchema, { method: 'POST', body });
  return data.project;
}

export async function updateProject(id: string, req: ProjectUpdateRequest): Promise<Project> {
  const body = JSON.stringify(ProjectUpdateRequestSchema.parse(req));
  const data = await request(`/projects/${id}`, ProjectGetResponseSchema, { method: 'PUT', body });
  return data.project;
}
// Soft delete (archive) is `archiveProject` (DELETE with no flag). This is the
// HARD delete — `?hard=true` permanently removes the project and its content.
export async function deleteProject(id: string): Promise<void> {
  await fetchOk(`/projects/${id}?hard=true`, { method: 'DELETE' });
}
export async function archiveProject(id: string): Promise<void> {
  await fetchOk(`/projects/${id}`, { method: 'DELETE' });
}
export async function restoreProject(id: string): Promise<void> {
  await fetchOk(`/projects/${id}/restore`, { method: 'POST' });
}
export async function pinProject(id: string): Promise<void> {
  await fetchOk(`/projects/${id}/pin`, { method: 'POST' });
}
export async function unpinProject(id: string): Promise<void> {
  await fetchOk(`/projects/${id}/unpin`, { method: 'POST' });
}

// ---------------- Todos ----------------

export async function listTodos(query: TodoListQuery = {}): Promise<Todo[]> {
  const parsed = TodoListQuerySchema.parse(query);
  const qs = toQueryString(parsed);
  const data = await request(`/todos${qs}`, TodoListResponseSchema);
  return data.todos;
}

export async function getTodo(id: string): Promise<Todo> {
  const data = await request(`/todos/${id}`, TodoGetResponseSchema);
  return data.todo;
}

export async function createTodo(req: TodoCreateRequest): Promise<Todo> {
  const body = JSON.stringify(TodoCreateRequestSchema.parse(req));
  const data = await request('/todos', TodoGetResponseSchema, { method: 'POST', body });
  return data.todo;
}

export async function updateTodo(id: string, patch: TodoUpdateRequest): Promise<Todo> {
  const body = JSON.stringify(TodoUpdateRequestSchema.parse(patch));
  const data = await request(`/todos/${id}`, TodoGetResponseSchema, { method: 'PUT', body });
  return data.todo;
}

export async function archiveTodo(id: string): Promise<void> {
  await fetchOk(`/todos/${id}`, { method: 'DELETE' });
}
// HARD delete — permanently removes the todo (Trash view).
export async function deleteTodoForever(id: string): Promise<void> {
  await fetchOk(`/todos/${id}?hard=true`, { method: 'DELETE' });
}
export async function restoreTodo(id: string): Promise<void> {
  await fetchOk(`/todos/${id}/restore`, { method: 'POST' });
}
export async function pinTodo(id: string): Promise<void> {
  await fetchOk(`/todos/${id}/pin`, { method: 'POST' });
}
export async function unpinTodo(id: string): Promise<void> {
  await fetchOk(`/todos/${id}/unpin`, { method: 'POST' });
}

// Persist a manual ordering for a sibling group of todos. The `ids`
// array IS the new order — position 1..N becomes manual_order.
export async function reorderTodos(req: TodoReorderRequest): Promise<TodoReorderResponse> {
  return request('/todos/reorder', TodoReorderResponseSchema, {
    method: 'POST',
    body: JSON.stringify(TodoReorderRequestSchema.parse(req)),
  });
}

export async function listTodoComments(todoId: string): Promise<TodoComment[]> {
  const data = await request(`/todos/${todoId}/comments`, TodoCommentListResponseSchema);
  return data.comments;
}

export async function createComment(
  todoId: string,
  req: TodoCommentCreateRequest,
): Promise<void> {
  const body = JSON.stringify(TodoCommentCreateRequestSchema.parse(req));
  await fetchOk(`/todos/${todoId}/comments`, { method: 'POST', body });
}

export async function updateComment(
  todoId: string,
  commentId: string,
  content: string,
): Promise<void> {
  // Reuses the create request schema — backend accepts `{ content }` for
  // both POST and PUT. Validate locally so we send the same shape.
  const body = JSON.stringify(TodoCommentCreateRequestSchema.parse({ content }));
  await fetchOk(`/todos/${todoId}/comments/${commentId}`, { method: 'PUT', body });
}

export async function deleteComment(
  todoId: string,
  commentId: string,
): Promise<void> {
  await fetchOk(`/todos/${todoId}/comments/${commentId}`, { method: 'DELETE' });
}

// ---------------- Content ----------------

export async function getContent(id: string): Promise<ContentItem> {
  const data = await request(`/content/${id}`, ContentGetResponseSchema);
  return data.item;
}

export async function listContent(query: ContentListQuery = {}): Promise<ContentItem[]> {
  const parsed = ContentListQuerySchema.parse(query);
  const qs = toQueryString(parsed);
  const data = await request(`/content${qs}`, ContentListResponseSchema);
  return data.items;
}

export async function createNote(req: NoteCreateRequest): Promise<ContentCreateResponse> {
  const body = JSON.stringify(NoteCreateRequestSchema.parse(req));
  return request('/content', ContentCreateResponseSchema, { method: 'POST', body });
}

// PUT /content/:id handles metadata diffs only (title / projects / tags).
// Body edits go through POST /content/:id/edit-body, which re-chunks +
// re-embeds and is gated by the body-immutability rule for blob-backed rows.
export async function updateContent(id: string, patch: ContentUpdateRequest): Promise<ContentItem> {
  const body = JSON.stringify(ContentUpdateRequestSchema.parse(patch));
  const data = await request(`/content/${id}`, ContentGetResponseSchema, { method: 'PUT', body });
  return data.item;
}

export async function editContentBody(id: string, content: string): Promise<ContentCreateResponse> {
  const body = JSON.stringify(ContentEditBodyRequestSchema.parse({ content }));
  return request(`/content/${id}/edit-body`, ContentCreateResponseSchema, { method: 'POST', body });
}

export async function archiveContent(id: string): Promise<void> {
  await fetchOk(`/content/${id}`, { method: 'DELETE' });
}
// HARD delete — permanently removes the item and its chunks (Trash view).
export async function deleteContentForever(id: string): Promise<void> {
  await fetchOk(`/content/${id}?hard=true`, { method: 'DELETE' });
}
export async function restoreContent(id: string): Promise<void> {
  await fetchOk(`/content/${id}/restore`, { method: 'POST' });
}
export async function pinContent(id: string): Promise<void> {
  await fetchOk(`/content/${id}/pin`, { method: 'POST' });
}
export async function unpinContent(id: string): Promise<void> {
  await fetchOk(`/content/${id}/unpin`, { method: 'POST' });
}
export async function retryContent(id: string): Promise<void> {
  await fetchOk(`/content/${id}/retry`, { method: 'POST' });
}
export async function reprocessContent(id: string): Promise<void> {
  await fetchOk(`/content/${id}/reprocess`, { method: 'POST' });
}

// File upload uses multipart/form-data — the browser sets the boundary itself,
// so we deliberately omit Content-Type. The response shape matches createNote
// (id + processing_status), regardless of whether the row landed sync ready or
// async pending.
export async function uploadFile(opts: {
  file: File;
  sessionId?: string;
  projectIds?: string[];
  tags?: string[];
  title?: string;
}): Promise<ContentCreateResponse> {
  const fd = new FormData();
  fd.set('type', 'document');
  if(opts.sessionId) fd.set('session_id',opts.sessionId);
  fd.set('file', opts.file);
  if (opts.title) fd.set('title', opts.title);
  if (opts.projectIds && opts.projectIds.length > 0) fd.set('project_ids', opts.projectIds.join(','));
  if (opts.tags && opts.tags.length > 0) fd.set('tags', opts.tags.join(','));
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${API_KEY}`);
  const res = await fetch(`${base()}/content`, { method: 'POST', body: fd, headers, credentials: fetchCredentials() });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = typeof json === 'object' && json && 'error' in json
      ? String((json as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, json);
  }
  const parsed = ContentCreateResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(res.status, `Response failed validation: ${parsed.error.message}`, json);
  }
  return parsed.data;
}

export async function saveFromUrl(opts: {
  url: string;
  sessionId?: string;
  projectIds?: string[];
  tags?: string[];
  title?: string;
}): Promise<ContentCreateResponse> {
  const body = JSON.stringify({
    url: opts.url,
    project_ids: opts.projectIds,
    session_id: opts.sessionId,
    tags: opts.tags,
    title: opts.title,
  });
  return request('/content/from-url', ContentCreateResponseSchema, { method: 'POST', body });
}

// ---------------- Search / RAG ----------------

export async function search(req: SearchRequest): Promise<SearchHit[]> {
  const body = JSON.stringify(SearchRequestSchema.parse(req));
  const data = await request('/search', SearchResponseSchema, { method: 'POST', body });
  return data.hits;
}

export async function rag(req: RagRequest): Promise<RagResponse> {
  const body = JSON.stringify(RagRequestSchema.parse(req));
  return request('/rag', RagResponseSchema, { method: 'POST', body });
}

// ---------------- Tags ----------------

export async function listTags(opts: { project_id?: string; scope?: 'personal' | 'all' } = {}): Promise<Tag[]> {
  const qs = toQueryString(opts);
  const data = await request(`/tags${qs}`, TagListResponseSchema);
  return data.tags;
}

// Rename a tag corpus-wide. The backend implicitly merges if `to`
// already exists on a row; the response carries the affected row
// count. Empty / unchanged `to` short-circuits to noop on the server.
export async function renameTag(from: string, to: string): Promise<TagRenameResponse> {
  const body = JSON.stringify(TagRenameRequestSchema.parse({ to }));
  return request(`/tags/${encodeURIComponent(from)}`, TagRenameResponseSchema, {
    method: 'PUT',
    body,
  });
}

// Delete a tag corpus-wide — strips it from every entity that carries it.
export async function deleteTag(name: string): Promise<TagDeleteResponse> {
  return request(`/tags/${encodeURIComponent(name)}`, TagDeleteResponseSchema, {
    method: 'DELETE',
  });
}

// ---------------- Activity ----------------

export async function listActivity(query: ActivityListQuery = {}): Promise<ActivityEvent[]> {
  const parsed = ActivityListQuerySchema.parse(query);
  const qs = toQueryString(parsed);
  const data = await request(`/activity${qs}`, ActivityListResponseSchema);
  return data.events;
}

export async function listSessions(projectId?: string | null): Promise<Session[]> {
  const query=projectId===undefined?'':`?project_id=${projectId??'null'}`;
  return (await request(`/sessions${query}`,z.object({sessions:z.array(SessionSchema)}))).sessions;
}
export async function getSession(id: string): Promise<Session> {
  return (await request(`/sessions/${id}`,z.object({session:SessionSchema}))).session;
}
export async function createSession(input: z.infer<typeof SessionCreateSchema>): Promise<Session> {
  return (await request('/sessions',z.object({session:SessionSchema}),{method:'POST',body:JSON.stringify(SessionCreateSchema.parse(input))})).session;
}
export async function updateSession(id:string,input:z.infer<typeof SessionUpdateSchema>):Promise<Session> {
  return (await request(`/sessions/${id}`,z.object({session:SessionSchema}),{method:'PUT',body:JSON.stringify(SessionUpdateSchema.parse(input))})).session;
}
export async function deleteSession(id:string):Promise<{ok:boolean;pending_files:number}> {
  return request(`/sessions/${id}`,z.object({ok:z.boolean(),pending_files:z.number()}),{method:'DELETE'});
}
export function listSessionTimeline(sessionId:string,search:string,cursor:TimelineCursor|null,signal?:AbortSignal,tags:string[]=[],tagMatch:TimelineTagMatch='all'):Promise<TimelineResponse> {
  const params=new URLSearchParams({search,tag_match:tagMatch});if(tags.length)params.set('tags',tags.join(','));
  if(cursor){params.set('before_at',cursor.at);params.set('before_id',cursor.id);}
  return request(`/sessions/${sessionId}/timeline?${params}`,TimelineResponseSchema,{signal});
}
