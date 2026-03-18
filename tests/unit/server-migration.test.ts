// tests/unit/server-migration.test.ts — Section 13: Migration logic
// We test the migration logic inline since it's in server.ts. We replicate
// the runMigrations function logic and test it with mocked pool/db.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Replicate the migration logic from server.ts for isolated testing
async function runMigrations(deps: { db: { pool: { query: (...args: any[]) => Promise<any> }; query: (...args: any[]) => Promise<any> } }) {
  const result = await deps.db.pool.query(
    "SELECT count(*) as count FROM pg_tables WHERE schemaname = 'public' AND tablename = 'captures'",
  );
  if (parseInt(result.rows[0].count) > 0) {
    console.log('Database tables already exist, skipping migration.');
    return;
  }

  console.log('Running database migration...');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationPath = join(__dirname, '..', '..', 'migrations', '001_initial_schema.sql');
  const sql = readFileSync(migrationPath, 'utf-8');
  await deps.db.pool.query(sql);
  console.log('Database migration complete.');
}

describe('Section 13: Migration', () => {
  it('13.1 When pg_tables query returns count > 0 → skips migration, logs "already exist"', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const poolQuery = vi.fn().mockResolvedValue({ rows: [{ count: '3' }] });
    const dbQuery = vi.fn();

    const deps = {
      db: { pool: { query: poolQuery }, query: dbQuery },
    };

    await runMigrations(deps);

    expect(poolQuery).toHaveBeenCalledTimes(1); // only the check query
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already exist'));
    // db.query should NOT have been called (migration uses pool.query)
    expect(dbQuery).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('13.2 Migration SQL is executed via pool.query (not db.query which triggers ensureVector)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // check query: no tables
      .mockResolvedValueOnce(undefined); // migration execution
    const dbQuery = vi.fn();

    const deps = {
      db: { pool: { query: poolQuery }, query: dbQuery },
    };

    await runMigrations(deps);

    // pool.query called twice: check + migration SQL
    expect(poolQuery).toHaveBeenCalledTimes(2);
    // db.query NOT called (avoids ensureVector / pgvector registration)
    expect(dbQuery).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('13.3 Full SQL string is passed as single query (not split by semicolons)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce(undefined);

    const deps = {
      db: { pool: { query: poolQuery }, query: vi.fn() },
    };

    await runMigrations(deps);

    // The second call should be the full SQL (a single string, not split)
    const migrationCall = poolQuery.mock.calls[1];
    expect(migrationCall).toHaveLength(1); // just the SQL string, no params
    expect(typeof migrationCall[0]).toBe('string');
    // Should contain multiple CREATE TABLE statements (not split)
    expect(migrationCall[0]).toContain('CREATE');

    consoleSpy.mockRestore();
  });
});
