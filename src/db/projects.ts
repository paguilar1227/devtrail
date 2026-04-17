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

export async function listProjects(db: DbClient, status?: string): Promise<ProjectRow[]> {
  const where = status ? `WHERE status = $1` : '';
  const params = status ? [status] : [];
  const result = await db.query(
    `SELECT * FROM projects ${where} ORDER BY created_at DESC`,
    params,
  );
  return result.rows;
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
