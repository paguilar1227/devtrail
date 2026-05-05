// frontend/tests/e2e/helpers/api.ts
//
// Direct REST helpers used by workflow specs for arrange/teardown — bypassing
// the UI keeps tests fast and avoids cascading UI failures during setup.
// Mirrors a slice of frontend/src/lib/api.ts but uses Node fetch and accepts
// the loose JSON shapes returned by the backend (we don't run Zod here).

const BASE = process.env.OPEN_BRAIN_BASE_URL ?? 'http://localhost:3001';
const KEY = process.env.OPEN_BRAIN_API_KEY ?? 'local-dev-key-not-secret';

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
  archived: boolean;
}

export interface ContentItem {
  id: string;
  type: 'document' | 'note';
  title: string;
  content: string | null;
  project_ids: string[];
  archived: boolean;
  processing_status: 'pending' | 'ready' | 'failed';
}

export async function listProjects(): Promise<Project[]> {
  const data = await api<{ projects: Project[] }>('GET', '/api/v1/projects');
  return data.projects;
}

export async function findProjectByName(name: string): Promise<Project | undefined> {
  const all = await listProjects();
  return all.find((p) => p.name === name);
}

export async function listTodos(query: { project_id?: string } = {}): Promise<Todo[]> {
  const qs = query.project_id ? `?project_id=${encodeURIComponent(query.project_id)}` : '';
  const data = await api<{ todos: Todo[] }>('GET', `/api/v1/todos${qs}`);
  return data.todos;
}

export async function listContent(query: { project_id?: string; type?: string } = {}): Promise<ContentItem[]> {
  const parts: string[] = [];
  if (query.project_id) parts.push(`project_id=${encodeURIComponent(query.project_id)}`);
  if (query.type) parts.push(`type=${encodeURIComponent(query.type)}`);
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

export async function createTodo(content: string, projectId?: string | null): Promise<Todo> {
  const data = await api<{ todo: Todo }>('POST', '/api/v1/todos', { content, project_id: projectId ?? null });
  return data.todo;
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
