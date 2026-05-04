// frontend/src/lib/api.ts
//
// Typed fetch client for the Open Brain REST API. All responses are validated
// against shared Zod schemas (`@open-brain/shared`) — bad data fails loud.
//
// Auth: dual-mode.
//   - Local dev: VITE_OPEN_BRAIN_API_KEY → Bearer header; matches the
//     backend's stub-mode key out of the box.
//   - Production: same Bearer header is sent (with the placeholder fallback,
//     which the backend rejects), but the request also carries the Easy
//     Auth session cookie (`credentials: 'include'`). The backend's
//     `/api/*` middleware accepts EITHER signal, so the placeholder Bearer
//     is harmless and the cookie+principal-header path is what actually
//     authenticates browser calls in prod.

import {
  ActivityListQuerySchema,
  ActivityListResponseSchema,
  ContentGetResponseSchema,
  ContentListQuerySchema,
  ContentListResponseSchema,
  ContentCreateResponseSchema,
  NoteCreateRequestSchema,
  ProjectCountsListResponseSchema,
  ProjectCreateRequestSchema,
  ProjectGetResponseSchema,
  ProjectListQuerySchema,
  ProjectListResponseSchema,
  TodoCommentCreateRequestSchema,
  TodoCreateRequestSchema,
  TodoGetResponseSchema,
  TodoUpdateRequestSchema,
  RagRequestSchema,
  RagResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  StatsSchema,
  TagListResponseSchema,
  TodoCommentListResponseSchema,
  TodoListQuerySchema,
  TodoListResponseSchema,
  type ActivityEvent,
  type ActivityListQuery,
  type ContentCreateResponse,
  type ContentItem,
  type ContentListQuery,
  type NoteCreateRequest,
  type Project,
  type ProjectCounts,
  type ProjectCreateRequest,
  type ProjectListQuery,
  type RagRequest,
  type RagResponse,
  type SearchHit,
  type SearchRequest,
  type TodoCommentCreateRequest,
  type TodoCreateRequest,
  type TodoUpdateRequest,
  type Stats,
  type Tag,
  type Todo,
  type TodoComment,
  type TodoListQuery,
} from '@open-brain/shared';
import { z } from 'zod';

const BASE = '/api/v1';
const TOKEN_STORAGE_KEY = 'ob.api_key';

// Resolve the Bearer key the UI uses for /api/v1/* calls. Two sources:
//   - Local dev: `VITE_OPEN_BRAIN_API_KEY` from the build env (matches the
//     backend's stub-mode default).
//   - Production: the `/api/auth/token` exchange, which sits behind Easy
//     Auth — the platform has already validated the user's cookie session
//     by the time that endpoint runs, and the response carries the long-
//     lived Bearer key plus the Entra principal id/name. We cache it in
//     localStorage so the next page load skips the round-trip.
//
// `bootAuth()` is called once before React mounts (see main.tsx). If the
// session has expired, the fetch comes back as an opaque redirect and we
// hard-navigate to the AAD login URL with `post_login_redirect_uri` set
// to the current page so the user lands back where they were.
let API_KEY: string =
  import.meta.env.VITE_OPEN_BRAIN_API_KEY ??
  (typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_STORAGE_KEY) ?? '' : '') ??
  '';

export async function bootAuth(): Promise<void> {
  // If the build supplied a key, we're in local dev — nothing to exchange.
  if (import.meta.env.VITE_OPEN_BRAIN_API_KEY) return;

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

  if (!res.ok) {
    throw new Error(`bootAuth failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { key: string };
  API_KEY = data.key;
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, data.key);
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
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });
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
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });
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
export async function restoreTodo(id: string): Promise<void> {
  await fetchOk(`/todos/${id}/restore`, { method: 'POST' });
}
export async function pinTodo(id: string): Promise<void> {
  await fetchOk(`/todos/${id}/pin`, { method: 'POST' });
}
export async function unpinTodo(id: string): Promise<void> {
  await fetchOk(`/todos/${id}/unpin`, { method: 'POST' });
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

export async function archiveContent(id: string): Promise<void> {
  await fetchOk(`/content/${id}`, { method: 'DELETE' });
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
  projectIds?: string[];
  tags?: string[];
  title?: string;
}): Promise<ContentCreateResponse> {
  const fd = new FormData();
  fd.set('type', 'document');
  fd.set('file', opts.file);
  if (opts.title) fd.set('title', opts.title);
  if (opts.projectIds && opts.projectIds.length > 0) fd.set('project_ids', opts.projectIds.join(','));
  if (opts.tags && opts.tags.length > 0) fd.set('tags', opts.tags.join(','));
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${API_KEY}`);
  const res = await fetch(`${BASE}/content`, { method: 'POST', body: fd, headers, credentials: 'include' });
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
  projectIds?: string[];
  tags?: string[];
  title?: string;
}): Promise<ContentCreateResponse> {
  const body = JSON.stringify({
    url: opts.url,
    project_ids: opts.projectIds,
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

export async function listTags(projectId?: string): Promise<Tag[]> {
  const qs = toQueryString({ project_id: projectId });
  const data = await request(`/tags${qs}`, TagListResponseSchema);
  return data.tags;
}

// ---------------- Activity ----------------

export async function listActivity(query: ActivityListQuery = {}): Promise<ActivityEvent[]> {
  const parsed = ActivityListQuerySchema.parse(query);
  const qs = toQueryString(parsed);
  const data = await request(`/activity${qs}`, ActivityListResponseSchema);
  return data.events;
}
