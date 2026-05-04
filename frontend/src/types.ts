export type ProjectAccent = 'magenta' | 'violet' | 'indigo' | 'cyan' | 'neutral';
export type ProjectStatus = 'active' | 'archived' | 'completed';

export interface Project {
  id: string;
  name: string;
  desc: string;
  status: ProjectStatus;
  pinned: boolean;
  accent: ProjectAccent;
  created_at: string;
  updated_at: string;
  counts: { docs: number; notes: number; todos: number; done: number };
}

export type ProcessingStatus = 'pending' | 'ready' | 'failed';
export type DocumentType = 'binary' | 'url' | 'note-as-doc';

export interface DocumentItem {
  id: string;
  title: string;
  type: DocumentType;
  mime: string;
  blob_url: string | null;
  source_url: string | null;
  size: string;
  tags: string[];
  processing_status: ProcessingStatus;
  processing_error?: string;
  project_ids: string[];
  pinned: boolean;
  published_at: string | null;
  created_at: string;
  file_hash: string | null;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  processing_status: ProcessingStatus;
  project_ids: string[];
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export type TodoStatus = 'not_started' | 'in_progress' | 'paused' | 'done';
export type TodoPriority = 'p1' | 'p2' | 'p3';

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  priority: TodoPriority;
  parent_id: string | null;
  project_id: string | null;
  tags: string[];
  pinned: boolean;
  due_at: string | null;
  created_at: string;
  comments: number;
}

export interface TodoComment {
  id: string;
  todo_id: string;
  content: string;
  at: string;
}

export interface TagRow {
  name: string;
  total: number;
  by_type: { document: number; note: number; todo: number };
}

export type ActivityKind = 'ingest' | 'edit' | 'comment';
export type ActivityEntityKind = 'document' | 'note' | 'todo';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  entity_kind: ActivityEntityKind;
  entity_id: string;
  title: string;
  project: string;
  project_id: string;
  at: string;
}

export interface Stats {
  counts: { projects: number; documents: number; notes: number; todos: number; done: number };
  freshness: { last_ingest_ms: number; last_edit_ms: number };
  processing: { pending: number; ready: number; failed: number };
  top_tags: { name: string; count: number }[];
}

export type RetrievalPath = 'vector' | 'graph' | 'fts';

export interface SearchHit {
  id: string;
  entity_kind: ActivityEntityKind;
  entity_id: string;
  title: string;
  project: string;
  excerpt: string;
  retrieval_path: RetrievalPath[];
  score: number;
}

export interface ChatCitation {
  id: string;
  num: number;
  title: string;
  path: string;
  chunk: string;
  score: number;
}

export interface ChatMessageT {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citations?: ChatCitation[];
  timing?: { retrieval_ms: number; generation_ms: number; chunks: number };
}

export type Theme = 'dark' | 'light';
export type Density = 'regular' | 'compact';
export type SidebarMode = 'expanded' | 'collapsed' | 'hidden';
export type TodoMode = 'hierarchy' | 'flat';

export type Route =
  | { route: 'home' }
  | { route: 'projects'; action?: 'new' }
  | { route: 'project'; project: string }
  | { route: 'inbox' }
  | { route: 'tags' }
  | { route: 'activity' }
  | { route: 'search' }
  | { route: 'mentions' }
  | { route: 'trash' };

export type RouteName = Route['route'];

export type ModalKind =
  | { kind: 'upload'; payload: Project | null }
  | { kind: 'note-edit'; payload: Note | null; projectId?: string }
  | { kind: 'doc-read'; payload: DocumentItem }
  | { kind: 'todo-detail'; payload: Todo }
  | { kind: 'bulk-confirm'; payload: { kind: string; count: number } }
  | { kind: 'confirm-rename'; payload: TagRow }
  | { kind: 'new-project' };

export type ActionDispatch = (modal: ModalKind) => void;
