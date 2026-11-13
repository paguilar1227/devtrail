// frontend/tests/e2e/helpers/api.ts
//
// Direct REST helpers used by workflow specs for arrange/teardown — bypassing
// the UI keeps tests fast and avoids cascading UI failures during setup.
// Mirrors a slice of frontend/src/lib/api.ts but uses Node fetch and accepts
// the loose JSON shapes returned by the backend (we don't run Zod here).

const BASE = process.env.DEVTRAIL_BASE_URL ?? 'http://localhost:3001';
const KEY = process.env.DEVTRAIL_API_KEY ?? 'local-dev-key-not-secret';

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived' | 'completed';
  pinned_at: string | null;
}

export interface Todo {
  id: string;
  content: string;
  status: 'not_started' | 'in_progress' | 'paused' | 'done';
  priority: 'p1' | 'p2' | 'p3' | null;
  project_id: string | null;
  parent_id?: string | null;
  due_date?: string | null;
  manual_order?: number | null;
  archived: boolean;
  tags?: string[];
}

/** Fields the PUT /todos/:id endpoint accepts. Kept separate from the row
 *  shape: the API takes priorities in UPPERCASE ('P1') while rows come back
 *  lowercase ('p1'). */
export interface TodoUpdatePatch {
  content?: string;
  status?: Todo['status'];
  priority?: 'P1' | 'P2' | 'P3' | null;
  project_id?: string | null;
  parent_id?: string | null;
  due_date?: string | null;
  tags?: string[];
}

export interface ContentItem {
  id: string;
  type: 'document' | 'note';
  title: string;
  content: string | null;
  project_ids: string[];
  archived: boolean;
  processing_status: 'pending' | 'ready' | 'failed';
  tags?: string[];
}

export async function listProjects(): Promise<Project[]> {
  const data = await api<{ projects: Project[] }>('GET', '/api/v1/projects');
  return data.projects;
}

export async function findProjectByName(name: string): Promise<Project | undefined> {
  const all = await listProjects();
  return all.find((p) => p.name === name);
}

export async function listTodos(query: { project_id?: string; include_archived?: boolean } = {}): Promise<Todo[]> {
  const parts: string[] = [];
  if (query.project_id) parts.push(`project_id=${encodeURIComponent(query.project_id)}`);
  if (query.include_archived) parts.push('include_archived=true');
  const qs = parts.length ? `?${parts.join('&')}` : '';
  const data = await api<{ todos: Todo[] }>('GET', `/api/v1/todos${qs}`);
  return data.todos;
}

export async function listContent(query: { project_id?: string; type?: string; include_archived?: boolean } = {}): Promise<ContentItem[]> {
  const parts: string[] = [];
  if (query.project_id) parts.push(`project_id=${encodeURIComponent(query.project_id)}`);
  if (query.type) parts.push(`type=${encodeURIComponent(query.type)}`);
  if (query.include_archived) parts.push('include_archived=true');
  const qs = parts.length ? `?${parts.join('&')}` : '';
  const data = await api<{ items: ContentItem[] }>('GET', `/api/v1/content${qs}`);
  return data.items;
}

export async function createProject(name: string, description?: string): Promise<Project> {
  const data = await api<{ project: Project }>('POST', '/api/v1/projects', { name, description });
  return data.project;
}

export async function pinProject(id: string): Promise<void> {
  await api('POST', `/api/v1/projects/${id}/pin`);
}

export async function unpinProject(id: string): Promise<void> {
  await api('POST', `/api/v1/projects/${id}/unpin`);
}

export async function createTodo(
  content: string,
  projectId?: string | null,
  extras: { due_date?: string | null; parent_id?: string | null; tags?: string[] } = {},
): Promise<Todo> {
  const body: Record<string, unknown> = { content, project_id: projectId ?? null };
  if (extras.due_date !== undefined) body.due_date = extras.due_date;
  if (extras.parent_id !== undefined) body.parent_id = extras.parent_id;
  if (extras.tags !== undefined) body.tags = extras.tags;
  const data = await api<{ todo: Todo }>('POST', '/api/v1/todos', body);
  return data.todo;
}

export async function createNote(
  title: string,
  content: string,
  opts: { projectIds?: string[]; tags?: string[]; folder?: string } = {},
): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    type: 'note',
    title,
    content,
    project_ids: opts.projectIds ?? [],
    tags: opts.tags ?? [],
  };
  if (opts.folder !== undefined) body.folder = opts.folder;
  return api<{ id: string }>('POST', '/api/v1/content', body);
}

export async function pinContent(id: string): Promise<void> {
  await api('POST', `/api/v1/content/${id}/pin`);
}

/** Poll until an ingested item leaves 'pending'. Hybrid search only returns
 *  processing_status='ready' rows, so specs that SEARCH a just-created
 *  note/doc must gate on this to avoid racing the ingest pipeline. */
export async function waitForContentReady(id: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await api<{ processing_status: string }>('GET', `/api/v1/content/${id}/status`);
    if (s.processing_status === 'ready') return;
    if (s.processing_status === 'failed') throw new Error(`content ${id} failed ingest`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`content ${id} still pending after ${timeoutMs}ms`);
}

/**
 * Personal document (no project) — used by the tag-filtering specs to
 * seed an AC-3 doc fixture so document filtering is asserted alongside
 * todos/notes. Docs require multipart (`POST /api/v1/content` with a
 * `file` part) — there's no inline JSON path for type=document. The
 * Home docs query (`listContent({type:'document', project_id:'null'})`)
 * does NOT filter on processing_status, so the row is filterable
 * immediately after this 202 returns, even while embeddings process
 * in the background.
 */
export async function createDoc(
  title: string,
  content: string,
  opts: { projectIds?: string[]; tags?: string[] } = {},
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('type', 'document');
  form.append('title', title);
  // Multipart handler parses these as comma-separated strings, NOT JSON
  // (see backend/src/app.ts: `body.tags?.split(',').filter(Boolean)`).
  // Sending `JSON.stringify(['a'])` here would result in tags=['["a"]'].
  if (opts.projectIds?.length) form.append('project_ids', opts.projectIds.join(','));
  if (opts.tags?.length) form.append('tags', opts.tags.join(','));
  form.append('file', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
  const res = await fetch(`${BASE}/api/v1/content`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /api/v1/content (multipart) → ${res.status} ${text}`);
  return text ? (JSON.parse(text) as { id: string }) : (undefined as unknown as { id: string });
}

export async function updateTodo(id: string, patch: TodoUpdatePatch): Promise<Todo> {
  const data = await api<{ todo: Todo }>('PUT', `/api/v1/todos/${id}`, patch);
  return data.todo;
}

/** Soft-delete (archive) — the row lands in the Archived view. */
export async function archiveTodo(id: string): Promise<void> {
  await api('DELETE', `/api/v1/todos/${id}`);
}

export async function archiveProject(id: string): Promise<void> {
  await api('DELETE', `/api/v1/projects/${id}`);
}

/** Full content item incl. body — used to snapshot seed rows before a
 *  destructive flow so they can be recreated afterwards. */
export async function getContentItem(id: string): Promise<ContentItem & { content: string | null }> {
  const data = await api<{ item: ContentItem & { content: string | null } }>('GET', `/api/v1/content/${id}`);
  return data.item;
}

/** Soft-delete (archive) content — documents and notes. */
export async function archiveContent(id: string): Promise<void> {
  await api('DELETE', `/api/v1/content/${id}`);
}

export async function deleteProject(id: string): Promise<void> {
  await api('DELETE', `/api/v1/projects/${id}?hard=true`);
}

export async function deleteTodo(id: string): Promise<void> {
  await api('DELETE', `/api/v1/todos/${id}?hard=true`);
}

export async function deleteContent(id: string): Promise<void> {
  await api('DELETE', `/api/v1/content/${id}?hard=true`);
}
