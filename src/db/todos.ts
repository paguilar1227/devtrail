import type { DbClient } from './client.js';

export interface TodoInsert {
  content: string;
  projectId: string | null;
  section: string | null;
  parentId: string | null;
  priority: 'P1' | 'P2' | 'P3' | null;
  dueDate: Date | null;
  tags: string[];
  embedding: number[] | null;
}

export interface TodoRow {
  id: string;
  content: string;
  project_id: string | null;
  section: string | null;
  parent_id: string | null;
  status: 'not_started' | 'in_progress' | 'paused' | 'done';
  priority: 'P1' | 'P2' | 'P3' | null;
  due_date: Date | null;
  tags: string[];
  embedding: number[] | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ListTodosFilters {
  project_id?: string | null;       // null explicitly = personal (Inbox); undefined = no filter
  status?: string;
  priority?: string;
  parent_id?: string | null;         // null = top-level; undefined = any
  tags?: string[];
  due_before?: Date;
  due_after?: Date;
  include_archived?: boolean;
  limit?: number;
}

export async function insertTodo(db: DbClient, todo: TodoInsert): Promise<{ id: string }> {
  const result = await db.query(
    `INSERT INTO todos (content, project_id, section, parent_id, priority, due_date, tags, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      todo.content, todo.projectId, todo.section, todo.parentId,
      todo.priority, todo.dueDate, todo.tags,
      todo.embedding ? JSON.stringify(todo.embedding) : null,
    ],
  );
  return result.rows[0];
}

export async function listTodos(
  db: DbClient,
  filters: ListTodosFilters = {},
): Promise<TodoRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (!filters.include_archived) conditions.push('archived = false');

  if (filters.project_id === null) {
    conditions.push('project_id IS NULL');
  } else if (filters.project_id !== undefined) {
    conditions.push(`project_id = $${i++}`);
    params.push(filters.project_id);
  }

  if (filters.status) {
    conditions.push(`status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.priority) {
    conditions.push(`priority = $${i++}`);
    params.push(filters.priority);
  }
  if (filters.parent_id === null) {
    conditions.push('parent_id IS NULL');
  } else if (filters.parent_id !== undefined) {
    conditions.push(`parent_id = $${i++}`);
    params.push(filters.parent_id);
  }
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(`tags @> $${i++}`);
    params.push(filters.tags);
  }
  if (filters.due_before) {
    conditions.push(`due_date <= $${i++}`);
    params.push(filters.due_before);
  }
  if (filters.due_after) {
    conditions.push(`due_date >= $${i++}`);
    params.push(filters.due_after);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ? `LIMIT ${filters.limit}` : '';

  const result = await db.query(
    `SELECT * FROM todos ${where} ORDER BY created_at DESC ${limit}`,
    params,
  );
  return result.rows;
}

export async function getTodoById(db: DbClient, id: string): Promise<TodoRow | null> {
  const result = await db.query(`SELECT * FROM todos WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function updateTodo(
  db: DbClient,
  id: string,
  patch: Partial<Omit<TodoInsert, 'embedding'>> & { status?: string; embedding?: number[] | null },
): Promise<TodoRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.content !== undefined) { sets.push(`content = $${i++}`); params.push(patch.content); }
  if (patch.projectId !== undefined) { sets.push(`project_id = $${i++}`); params.push(patch.projectId); }
  if (patch.section !== undefined) { sets.push(`section = $${i++}`); params.push(patch.section); }
  if (patch.parentId !== undefined) { sets.push(`parent_id = $${i++}`); params.push(patch.parentId); }
  if (patch.priority !== undefined) { sets.push(`priority = $${i++}`); params.push(patch.priority); }
  if (patch.dueDate !== undefined) { sets.push(`due_date = $${i++}`); params.push(patch.dueDate); }
  if (patch.tags !== undefined) { sets.push(`tags = $${i++}`); params.push(patch.tags); }
  if (patch.status !== undefined) { sets.push(`status = $${i++}`); params.push(patch.status); }
  if (patch.embedding !== undefined) {
    sets.push(`embedding = $${i++}`);
    params.push(patch.embedding ? JSON.stringify(patch.embedding) : null);
  }

  if (sets.length === 0) return getTodoById(db, id);

  sets.push(`updated_at = now()`);
  params.push(id);

  const result = await db.query(
    `UPDATE todos SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function archiveTodo(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE todos SET archived = true, updated_at = now() WHERE id = $1`, [id]);
}

export async function unarchiveTodo(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE todos SET archived = false, updated_at = now() WHERE id = $1`, [id]);
}

export async function deleteTodoHard(db: DbClient, id: string): Promise<void> {
  await db.query(`DELETE FROM todos WHERE id = $1`, [id]);
}

export async function findChildTodos(db: DbClient, parentId: string): Promise<TodoRow[]> {
  const result = await db.query(
    `SELECT * FROM todos WHERE parent_id = $1 AND archived = false ORDER BY created_at ASC`,
    [parentId],
  );
  return result.rows;
}

/**
 * Semantic todo search result. Omits the raw embedding vector to keep
 * response payloads small (3072-dim floats × N hits is expensive).
 */
export type TodoSearchResult = Omit<TodoRow, 'embedding'> & { similarity: number };

export async function findSimilarTodos(
  db: DbClient,
  embedding: number[],
  threshold: number,
  limit: number = 10,
): Promise<TodoSearchResult[]> {
  // Explicit column list — must NOT include the embedding vector.
  const result = await db.query(
    `SELECT id, content, project_id, section, parent_id, status, priority,
            due_date, tags, archived, created_at, updated_at,
            1 - (embedding <=> $1::vector) AS similarity
     FROM todos
     WHERE archived = false AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
     ORDER BY similarity DESC
     LIMIT $3`,
    [JSON.stringify(embedding), threshold, limit],
  );
  return result.rows;
}
