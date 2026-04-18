const API_BASE = (import.meta as any).env.VITE_API_BASE ?? '';

function getApiKey(): string {
  return localStorage.getItem('ob_api_key') ?? '';
}

export function setApiKey(key: string): void {
  localStorage.setItem('ob_api_key', key);
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${getApiKey()}`);
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// ----- Types -----
export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived' | 'completed';
  created_at: string;
  updated_at: string;
}

export interface ContentItem {
  id: string;
  type: 'document' | 'note';
  title: string;
  title_source: 'user' | 'ai_generated' | 'filename';
  content: string | null;
  blob_url: string | null;
  mime_type: string | null;
  project_ids: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  source_url: string | null;  // set for URL-ingested content
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Todo {
  id: string;
  content: string;
  project_id: string | null;
  section: string | null;
  parent_id: string | null;
  status: 'not_started' | 'in_progress' | 'paused' | 'done';
  priority: 'P1' | 'P2' | 'P3' | null;
  due_date: string | null;
  tags: string[];
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface SearchHit {
  type: 'chunk' | 'todo';
  similarity: number;
  chunk?: {
    id: string;
    content_item_id: string;
    content: string | null;
    chunk_type: string;
    parent_title: string;
    parent_type: string;
    parent_source_url?: string | null;
    metadata: Record<string, unknown>;
  };
  todo?: Todo & { similarity: number };
}

export interface Citation {
  content_item_id?: string;
  title: string;
  type: string;
  chunk_preview: string;
  similarity: number;
  source_url?: string | null;
}

export interface RagResult {
  answer: string;
  citations: Citation[];
  used_chunks: number;
}

// ----- Projects -----
export const listProjects = (status?: string) =>
  request<{ projects: Project[] }>(`/api/v1/projects${status ? `?status=${status}` : ''}`);

export const createProject = (name: string, description?: string) =>
  request<{ project: Project }>('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });

export const getProject = (id: string) =>
  request<{ project: Project }>(`/api/v1/projects/${id}`);

export const updateProject = (id: string, patch: Partial<Project>) =>
  request<{ project: Project }>(`/api/v1/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const archiveProject = (id: string) =>
  request<{ ok: true; mode: 'archived' }>(`/api/v1/projects/${id}`, { method: 'DELETE' });

export const deleteProjectHard = (id: string) =>
  request<{ ok: true; mode: 'hard' }>(`/api/v1/projects/${id}?hard=true`, { method: 'DELETE' });

export const restoreProject = (id: string) =>
  request<{ ok: true }>(`/api/v1/projects/${id}/restore`, { method: 'POST' });

// ----- Content -----
export const listContent = (params: {
  type?: 'document' | 'note';
  project_id?: string;
  tags?: string[];
  limit?: number;
  include_archived?: boolean;
} = {}) => {
  const q = new URLSearchParams();
  if (params.type) q.set('type', params.type);
  if (params.project_id) q.set('project_id', params.project_id);
  if (params.tags?.length) q.set('tags', params.tags.join(','));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.include_archived) q.set('include_archived', 'true');
  return request<{ items: ContentItem[] }>(`/api/v1/content?${q}`);
};

export const createContent = (payload: {
  type: 'document' | 'note';
  content?: string;
  title?: string;
  project_ids?: string[];
  tags?: string[];
}) => request<{ id: string; title: string; chunkCount: number }>('/api/v1/content', {
  method: 'POST',
  body: JSON.stringify(payload),
});

export const uploadFile = async (file: File, type: 'document' | 'note', opts: {
  projectIds?: string[];
  tags?: string[];
  content?: string;
  title?: string;
} = {}) => {
  const form = new FormData();
  form.set('type', type);
  form.set('file', file);
  if (opts.content) form.set('content', opts.content);
  if (opts.title) form.set('title', opts.title);
  if (opts.projectIds?.length) form.set('project_ids', opts.projectIds.join(','));
  if (opts.tags?.length) form.set('tags', opts.tags.join(','));
  const res = await fetch(`${API_BASE}/api/v1/content`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getApiKey()}` },
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ id: string; title: string; chunkCount: number }>;
};

export const getContent = (id: string) =>
  request<{ item: ContentItem }>(`/api/v1/content/${id}`);

export const updateContent = (id: string, patch: Partial<ContentItem>) =>
  request<{ item: ContentItem }>(`/api/v1/content/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const archiveContent = (id: string) =>
  request<{ ok: true; mode: 'archived' }>(`/api/v1/content/${id}`, { method: 'DELETE' });

export const deleteContentHard = (id: string) =>
  request<{ ok: true; mode: 'hard' }>(`/api/v1/content/${id}?hard=true`, { method: 'DELETE' });

export const restoreContent = (id: string) =>
  request<{ ok: true }>(`/api/v1/content/${id}/restore`, { method: 'POST' });

export interface SaveFromUrlResult {
  id: string;
  title: string;
  type: 'document' | 'note';
  source_url: string;
  deduped: boolean;
  chunkCount?: number;
  url_type: 'youtube' | 'x' | 'pdf' | 'image' | 'audio' | 'video' | 'html';
}

export const saveFromUrl = (payload: {
  url: string;
  project_ids?: string[];
  tags?: string[];
  title?: string;
}) => request<SaveFromUrlResult>('/api/v1/content/from-url', {
  method: 'POST',
  body: JSON.stringify(payload),
});

// ----- Todos -----
export const listTodos = (params: {
  project_id?: string | null;
  status?: string;
  include_archived?: boolean;
} = {}) => {
  const q = new URLSearchParams();
  if (params.project_id === null) q.set('project_id', 'null');
  else if (params.project_id) q.set('project_id', params.project_id);
  if (params.status) q.set('status', params.status);
  if (params.include_archived) q.set('include_archived', 'true');
  return request<{ todos: Todo[] }>(`/api/v1/todos?${q}`);
};

export const createTodo = (payload: Partial<Todo> & { content: string }) =>
  request<{ id: string }>('/api/v1/todos', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const updateTodo = (id: string, patch: Partial<Todo>) =>
  request<{ todo: Todo }>(`/api/v1/todos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const archiveTodo = (id: string) =>
  request<{ ok: true; mode: 'archived' }>(`/api/v1/todos/${id}`, { method: 'DELETE' });

export const deleteTodoHard = (id: string) =>
  request<{ ok: true; mode: 'hard' }>(`/api/v1/todos/${id}?hard=true`, { method: 'DELETE' });

export const restoreTodo = (id: string) =>
  request<{ ok: true }>(`/api/v1/todos/${id}/restore`, { method: 'POST' });

// ----- Search + RAG -----
export const search = (payload: {
  query: string;
  project_id?: string;
  entity_types?: Array<'document' | 'note' | 'todo'>;
  tags?: string[];
  limit?: number;
}) => request<{ hits: SearchHit[] }>('/api/v1/search', {
  method: 'POST',
  body: JSON.stringify(payload),
});

export const rag = (payload: {
  question: string;
  project_id?: string;
  tags?: string[];
  entity_types?: Array<'document' | 'note' | 'todo'>;
}) => request<RagResult>('/api/v1/rag', {
  method: 'POST',
  body: JSON.stringify(payload),
});
