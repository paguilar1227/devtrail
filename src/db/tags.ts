import type { DbClient } from './client.js';

export interface TagRow {
  name: string;
  total: number;
  by_type: {
    document: number;
    note: number;
    todo: number;
  };
}

export interface ListTagsFilters {
  /** Restrict to tags appearing on items in this project (matches both
   *  content_items.project_ids @> [pid] and todos.project_id = pid). */
  project_id?: string;
}

/**
 * Aggregate tag usage across content_items + todos. Output sorts by total
 * desc then name asc, so the heaviest-used tags surface first.
 *
 * Tags don't have their own table — they're denormalized text[] columns
 * on each row. We unnest both arrays and group, which is fine at the
 * single-user scale we run at. If the corpus ever grew large enough that
 * full-table unnest matters, a materialized tag-counts view would be the
 * upgrade path.
 *
 * Archived rows are excluded — listing tags on dead items would be noise.
 */
export async function listTags(
  db: DbClient,
  filters: ListTagsFilters = {},
): Promise<TagRow[]> {
  const params: unknown[] = [];
  const ciScope = filters.project_id
    ? `AND project_ids @> ARRAY[$1]::uuid[]`
    : '';
  const todoScope = filters.project_id
    ? `AND project_id = $1`
    : '';
  if (filters.project_id) params.push(filters.project_id);

  const result = await db.query(
    `WITH tag_rows AS (
       SELECT unnest(tags) AS name, type AS kind
         FROM content_items
        WHERE archived = false ${ciScope}
       UNION ALL
       SELECT unnest(tags) AS name, 'todo'::text AS kind
         FROM todos
        WHERE archived = false ${todoScope}
     )
     SELECT name,
            count(*)::int AS total,
            count(*) FILTER (WHERE kind = 'document')::int AS doc_count,
            count(*) FILTER (WHERE kind = 'note')::int     AS note_count,
            count(*) FILTER (WHERE kind = 'todo')::int     AS todo_count
       FROM tag_rows
      GROUP BY name
      ORDER BY total DESC, name ASC`,
    params,
  );

  return result.rows.map((r: { name: string; total: number; doc_count: number; note_count: number; todo_count: number }) => ({
    name: r.name,
    total: r.total,
    by_type: {
      document: r.doc_count,
      note: r.note_count,
      todo: r.todo_count,
    },
  }));
}
