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

export async function deleteProject(db: DbClient, id: string): Promise<void> {
  await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
}
