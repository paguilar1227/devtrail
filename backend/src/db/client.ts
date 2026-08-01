import pg from 'pg';
import pgvector from 'pgvector/pg';

const { Pool } = pg;

export interface DbClient {
  pool: pg.Pool;
  query(text: string, params?: unknown[]): Promise<pg.QueryResult>;
  transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDbClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });

  // Idle pooled connections can drop (server restart, network reset, TCP
  // reaper). node-postgres re-emits that as an 'error' on the Pool, and with
  // no listener it becomes an uncaughtException that kills the whole process
  // — this took the dev server down twice under e2e load (2026-07-30). The
  // pool already evicts the broken client; logging is all that's left to do.
  pool.on('error', (err) => {
    console.error('[db] idle client error (pool continues):', err.message);
  });

  // Register pgvector type parser on first connect
  let vectorRegistered = false;
  const ensureVector = async () => {
    if (!vectorRegistered) {
      const client = await pool.connect();
      try {
        await pgvector.registerTypes(client);
        vectorRegistered = true;
      } finally {
        client.release();
      }
    }
  };

  return {
    pool,

    async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
      await ensureVector();
      return pool.query(text, params);
    },

    async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
      await ensureVector();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
