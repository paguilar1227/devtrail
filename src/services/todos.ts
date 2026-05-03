import type { ServiceDeps } from './index.js';
import {
  insertTodo, listTodos as dbListTodos, getTodoById,
  updateTodo as dbUpdateTodo,
  archiveTodo, unarchiveTodo, deleteTodoHard,
  findChildTodos, findSimilarTodos,
  bulkArchiveTodos,
  bulkRestoreTodos,
  bulkDeleteTodosHard,
  bulkAddTagsTodos,
  bulkRemoveTagsTodos,
  bulkSetStatusTodos,
  bulkSetPriorityTodos,
  bulkSetProjectIdTodos,
  bulkSetDueDateTodos,
  pinTodo as dbPinTodo,
  unpinTodo as dbUnpinTodo,
  type TodoRow, type TodoInsert, type ListTodosFilters, type TodoSearchResult,
  type BulkTodoStatus, type BulkTodoPriority, type BulkTodoResult,
} from '../db/todos.js';

export async function createTodo(
  deps: ServiceDeps,
  input: {
    content: string;
    projectId?: string | null;
    section?: string | null;
    parentId?: string | null;
    priority?: 'P1' | 'P2' | 'P3' | null;
    dueDate?: Date | null;
    tags?: string[];
  },
): Promise<{ id: string }> {
  const embedding = await deps.embeddingProvider.embed(input.content);
  const todo: TodoInsert = {
    content: input.content,
    projectId: input.projectId ?? null,
    section: input.section ?? null,
    parentId: input.parentId ?? null,
    priority: input.priority ?? null,
    dueDate: input.dueDate ?? null,
    tags: input.tags ?? [],
    embedding,
  };
  return insertTodo(deps.db, todo);
}

export async function listTodos(deps: ServiceDeps, filters: ListTodosFilters = {}): Promise<TodoRow[]> {
  return dbListTodos(deps.db, filters);
}

export async function getTodo(deps: ServiceDeps, id: string): Promise<TodoRow | null> {
  return getTodoById(deps.db, id);
}

export async function updateTodo(
  deps: ServiceDeps,
  id: string,
  patch: {
    content?: string;
    projectId?: string | null;
    section?: string | null;
    parentId?: string | null;
    status?: string;
    priority?: 'P1' | 'P2' | 'P3' | null;
    dueDate?: Date | null;
    tags?: string[];
  },
): Promise<TodoRow | null> {
  let embedding: number[] | null | undefined;
  if (patch.content !== undefined) {
    embedding = await deps.embeddingProvider.embed(patch.content);
  }
  return dbUpdateTodo(deps.db, id, { ...patch, embedding });
}

export async function completeTodo(
  deps: ServiceDeps,
  id: string,
  cascade: boolean = true,
): Promise<void> {
  await dbUpdateTodo(deps.db, id, { status: 'done' });
  if (cascade) {
    const children = await findChildTodos(deps.db, id);
    for (const child of children) {
      await completeTodo(deps, child.id, true);
    }
  }
}

export async function archiveTodoById(deps: ServiceDeps, id: string): Promise<void> {
  await archiveTodo(deps.db, id);
}

export async function unarchiveTodoById(deps: ServiceDeps, id: string): Promise<void> {
  await unarchiveTodo(deps.db, id);
}

/** Hard delete a todo. Subtasks cascade via FK. */
export async function deleteTodoHardById(deps: ServiceDeps, id: string): Promise<void> {
  await deleteTodoHard(deps.db, id);
}

export async function pinTodo(deps: ServiceDeps, id: string): Promise<{ found: boolean }> {
  return dbPinTodo(deps.db, id);
}

export async function unpinTodo(deps: ServiceDeps, id: string): Promise<{ found: boolean }> {
  return dbUnpinTodo(deps.db, id);
}

export async function searchTodos(
  deps: ServiceDeps,
  query: string,
  limit: number = 10,
): Promise<TodoSearchResult[]> {
  const embedding = await deps.embeddingProvider.embed(query);
  return findSimilarTodos(deps.db, embedding, 0.3, limit);
}

export type BulkTodoAction =
  | 'archive'
  | 'restore'
  | 'delete'
  | 'add_tags'
  | 'remove_tags'
  | 'set_status'
  | 'set_priority'
  | 'set_project_id'
  | 'set_due_date';

export interface BulkTodoRequest {
  ids: string[];
  action: BulkTodoAction;
  tags?: string[];
  status?: BulkTodoStatus;
  /** P1/P2/P3 to set, or null to clear. Distinguish "not provided" from "clear". */
  priority?: BulkTodoPriority;
  has_priority?: boolean;
  /** UUID to assign, or null to detach to Inbox. Distinguish "not provided" from "clear". */
  project_id?: string | null;
  has_project_id?: boolean;
  /** ISO 8601 string to set, or null to clear. */
  due_date?: Date | null;
  has_due_date?: boolean;
}

export class BulkTodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkTodoValidationError';
  }
}

export async function bulkTodos(
  deps: ServiceDeps,
  req: BulkTodoRequest,
): Promise<BulkTodoResult> {
  switch (req.action) {
    case 'archive':
      return bulkArchiveTodos(deps.db, req.ids);
    case 'restore':
      return bulkRestoreTodos(deps.db, req.ids);
    case 'delete':
      return bulkDeleteTodosHard(deps.db, req.ids);
    case 'add_tags':
      if (!req.tags || req.tags.length === 0) {
        throw new BulkTodoValidationError('action="add_tags" requires non-empty tags array');
      }
      return bulkAddTagsTodos(deps.db, req.ids, req.tags);
    case 'remove_tags':
      if (!req.tags || req.tags.length === 0) {
        throw new BulkTodoValidationError('action="remove_tags" requires non-empty tags array');
      }
      return bulkRemoveTagsTodos(deps.db, req.ids, req.tags);
    case 'set_status':
      if (!req.status) {
        throw new BulkTodoValidationError('action="set_status" requires a status value');
      }
      return bulkSetStatusTodos(deps.db, req.ids, req.status);
    case 'set_priority':
      if (!req.has_priority) {
        throw new BulkTodoValidationError(
          'action="set_priority" requires a priority field (P1/P2/P3 or null to clear)',
        );
      }
      return bulkSetPriorityTodos(deps.db, req.ids, req.priority ?? null);
    case 'set_project_id':
      if (!req.has_project_id) {
        throw new BulkTodoValidationError(
          'action="set_project_id" requires a project_id field (UUID or null to detach)',
        );
      }
      return bulkSetProjectIdTodos(deps.db, req.ids, req.project_id ?? null);
    case 'set_due_date':
      if (!req.has_due_date) {
        throw new BulkTodoValidationError(
          'action="set_due_date" requires a due_date field (ISO 8601 or null to clear)',
        );
      }
      return bulkSetDueDateTodos(deps.db, req.ids, req.due_date ?? null);
  }
}
