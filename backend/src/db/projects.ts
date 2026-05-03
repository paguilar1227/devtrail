import type { DbClient } from './client.js';

export interface ProjectInsert {
  name: string;
  description: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived' | 'completed';
  pinned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function insertProject(db: DbClient, project: ProjectInsert): Promise<ProjectRow> {
  const result = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING *`,
    [project.name, project.description],
  );
  return result.rows[0];
}

export async function listProjects(
  db: DbClient,
  status?: string,
  pinned?: boolean,
): Promise<ProjectRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (status) { conditions.push(`status = $${i++}`); params.push(status); }
  if (pinned === true) conditions.push('pinned_at IS NOT NULL');
  else if (pinned === false) conditions.push('pinned_at IS NULL');

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = pinned === true
    ? 'ORDER BY pinned_at DESC'
    : 'ORDER BY created_at DESC';
  const result = await db.query(
    `SELECT * FROM projects ${where} ${orderBy}`,
    params,
  );
  return result.rows;
}

export async function pinProject(db: DbClient, id: string): Promise<{ found: boolean }> {
  const r = await db.query(
    `UPDATE projects SET pinned_at = now(), updated_at = now() WHERE id = $1 RETURNING id`,
    [id],
  );
  return { found: r.rows.length > 0 };
}

export async function unpinProject(db: DbClient, id: string): Promise<{ found: boolean }> {
  const r = await db.query(
    `UPDATE projects SET pinned_at = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
    [id],
  );
  return { found: r.rows.length > 0 };
}

export async function getProjectById(db: DbClient, id: string): Promise<ProjectRow | null> {
  const result = await db.query(`SELECT * FROM projects WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function updateProject(
  db: DbClient,
  id: string,
  patch: Partial<ProjectInsert> & { status?: string },
): Promise<ProjectRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); params.push(patch.name); }
  if (patch.description !== undefined) { sets.push(`description = $${i++}`); params.push(patch.description); }
  if (patch.status !== undefined) { sets.push(`status = $${i++}`); params.push(patch.status); }
  if (sets.length === 0) return getProjectById(db, id);
  sets.push(`updated_at = now()`);
  params.push(id);
  const result = await db.query(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function archiveProject(db: DbClient, id: string): Promise<void> {
  await db.query(
    `UPDATE projects SET status = 'archived', updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function unarchiveProject(db: DbClient, id: string): Promise<void> {
  await db.query(
    `UPDATE projects SET status = 'active', updated_at = now() WHERE id = $1`,
    [id],
  );
}

/**
 * Hard delete: removes project UUID from every content_items.project_ids[],
 * then deletes the project row. todos.project_id auto-nulls via FK cascade.
 * Run both statements in a single transaction so there's no window where
 * the project is deleted but stale UUIDs remain in arrays.
 */
export async function deleteProjectHard(db: DbClient, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE content_items
       SET project_ids = array_remove(project_ids, $1::uuid),
           updated_at = now()
       WHERE project_ids @> ARRAY[$1]::uuid[]`,
      [id],
    );
    await tx.query(`DELETE FROM projects WHERE id = $1`, [id]);
  });
}
