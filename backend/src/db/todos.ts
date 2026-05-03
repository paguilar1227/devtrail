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
  pinned_at: Date | null;
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
  pinned?: boolean;                  // true = only pinned, false = only not pinned, undefined = no filter
  include_archived?: boolean;
  limit?: number;
}

export async function insertTodo(db: DbClient, todo: TodoInsert): Promise<TodoRow> {
  const result = await db.query(
    `INSERT INTO todos (content, project_id, section, parent_id, priority, due_date, tags, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
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
  if (filters.pinned === true) conditions.push('pinned_at IS NOT NULL');
  else if (filters.pinned === false) conditions.push('pinned_at IS NULL');

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ? `LIMIT ${filters.limit}` : '';

  // When filtering for pinned items, sort pinned-first by recency.
  const orderBy = filters.pinned === true
    ? 'ORDER BY pinned_at DESC'
    : 'ORDER BY created_at DESC';

  const result = await db.query(
    `SELECT * FROM todos ${where} ${orderBy} ${limit}`,
    params,
  );
  return result.rows;
}

export async function pinTodo(db: DbClient, id: string): Promise<{ found: boolean }> {
  const r = await db.query(
    `UPDATE todos SET pinned_at = now(), updated_at = now() WHERE id = $1 RETURNING id`,
    [id],
  );
  return { found: r.rows.length > 0 };
}

export async function unpinTodo(db: DbClient, id: string): Promise<{ found: boolean }> {
  const r = await db.query(
    `UPDATE todos SET pinned_at = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
    [id],
  );
  return { found: r.rows.length > 0 };
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

export type BulkTodoStatus = 'not_started' | 'in_progress' | 'paused' | 'done';
export type BulkTodoPriority = 'P1' | 'P2' | 'P3' | null;

export interface BulkTodoResult {
  requested: number;
  affected: number;
  missing_ids: string[];
}

/**
 * Bulk operations on todos. Same single-SQL pattern as bulk content ops.
 * Distinct from content-bulk in three ways:
 *   - Todos use single project_id (nullable), not project_ids[]
 *   - Status / priority / due_date are first-class set-by-bulk operations
 *     (UI workflows: "mark all done", "snooze to next week", etc.)
 *   - Sub-task hierarchy is NOT touched in bulk; archiving a parent does
 *     not cascade to children. Caller must include children explicitly if
 *     they want them archived.
 */
export async function bulkArchiveTodos(db: DbClient, ids: string[]): Promise<BulkTodoResult> {
  return runTodoBulk(db, ids,
    `UPDATE todos SET archived = true,  updated_at = now() WHERE id = ANY($1::uuid[]) RETURNING id`);
}

export async function bulkRestoreTodos(db: DbClient, ids: string[]): Promise<BulkTodoResult> {
  return runTodoBulk(db, ids,
    `UPDATE todos SET archived = false, updated_at = now() WHERE id = ANY($1::uuid[]) RETURNING id`);
}

export async function bulkDeleteTodosHard(db: DbClient, ids: string[]): Promise<BulkTodoResult> {
  return runTodoBulk(db, ids,
    `DELETE FROM todos WHERE id = ANY($1::uuid[]) RETURNING id`);
}

export async function bulkAddTagsTodos(
  db: DbClient,
  ids: string[],
  tags: string[],
): Promise<BulkTodoResult> {
  const sql = `
    UPDATE todos
       SET tags = ARRAY(SELECT DISTINCT t FROM UNNEST(tags || $2::text[]) AS t ORDER BY t),
           updated_at = now()
     WHERE id = ANY($1::uuid[])
     RETURNING id`;
  return runTodoBulk(db, ids, sql, [tags]);
}

export async function bulkRemoveTagsTodos(
  db: DbClient,
  ids: string[],
  tags: string[],
): Promise<BulkTodoResult> {
  const sql = `
    UPDATE todos
       SET tags = ARRAY(
             SELECT t FROM UNNEST(tags) AS t
             WHERE t <> ALL($2::text[])
             ORDER BY t),
           updated_at = now()
     WHERE id = ANY($1::uuid[])
     RETURNING id`;
  return runTodoBulk(db, ids, sql, [tags]);
}

export async function bulkSetStatusTodos(
  db: DbClient,
  ids: string[],
  status: BulkTodoStatus,
): Promise<BulkTodoResult> {
  const sql = `
    UPDATE todos
       SET status = $2,
           updated_at = now()
     WHERE id = ANY($1::uuid[])
     RETURNING id`;
  return runTodoBulk(db, ids, sql, [status]);
}

export async function bulkSetPriorityTodos(
  db: DbClient,
  ids: string[],
  priority: BulkTodoPriority,
): Promise<BulkTodoResult> {
  const sql = `
    UPDATE todos
       SET priority = $2,
           updated_at = now()
     WHERE id = ANY($1::uuid[])
     RETURNING id`;
  return runTodoBulk(db, ids, sql, [priority]);
}

export async function bulkSetProjectIdTodos(
  db: DbClient,
  ids: string[],
  projectId: string | null,
): Promise<BulkTodoResult> {
  const sql = `
    UPDATE todos
       SET project_id = $2,
           updated_at = now()
     WHERE id = ANY($1::uuid[])
     RETURNING id`;
  return runTodoBulk(db, ids, sql, [projectId]);
}

export async function bulkSetDueDateTodos(
  db: DbClient,
  ids: string[],
  dueDate: Date | null,
): Promise<BulkTodoResult> {
  const sql = `
    UPDATE todos
       SET due_date = $2,
           updated_at = now()
     WHERE id = ANY($1::uuid[])
     RETURNING id`;
  return runTodoBulk(db, ids, sql, [dueDate]);
}

async function runTodoBulk(
  db: DbClient,
  ids: string[],
  sql: string,
  extraParams: unknown[] = [],
): Promise<BulkTodoResult> {
  if (ids.length === 0) return { requested: 0, affected: 0, missing_ids: [] };
  const result = await db.query(sql, [ids, ...extraParams]);
  const affectedIds = new Set(result.rows.map((r: { id: string }) => r.id));
  const missing = ids.filter((id) => !affectedIds.has(id));
  return { requested: ids.length, affected: affectedIds.size, missing_ids: missing };
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
