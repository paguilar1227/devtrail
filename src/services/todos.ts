import type { ServiceDeps } from './index.js';
import {
  insertTodo, listTodos as dbListTodos, getTodoById,
  updateTodo as dbUpdateTodo, archiveTodo, deleteTodoHard,
  findChildTodos, findSimilarTodos,
  type TodoRow, type TodoInsert, type ListTodosFilters,
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

export async function deleteTodo(deps: ServiceDeps, id: string): Promise<void> {
  await deleteTodoHard(deps.db, id);
}

export async function searchTodos(
  deps: ServiceDeps,
  query: string,
  limit: number = 10,
): Promise<Array<TodoRow & { similarity: number }>> {
  const embedding = await deps.embeddingProvider.embed(query);
  return findSimilarTodos(deps.db, embedding, 0.3, limit);
}
