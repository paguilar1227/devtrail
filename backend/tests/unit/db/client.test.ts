import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';

// Mock pg and pgvector modules. The mock pool is a real EventEmitter so the
// idle-client 'error' regression test below exercises actual emit semantics
// (an EventEmitter with no 'error' listener THROWS on emit — exactly how the
// unhandled pg pool error killed the process).
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const mockPool = Object.assign(new EventEmitter(), {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn(),
  });
  return { default: { Pool: vi.fn(() => mockPool) }, Pool: vi.fn(() => mockPool) };
});

vi.mock('pgvector/pg', () => ({
  default: { registerTypes: vi.fn() },
  registerTypes: vi.fn(),
}));

describe('DbClient', () => {
  it('executes a query via pool', async () => {
    const { createDbClient } = await import('../../../src/db/client.js');
    const db = createDbClient('postgresql://localhost/test');

    const mockResult: QueryResult = {
      rows: [{ id: '1', content: 'test' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    };
    vi.mocked(db.pool.query).mockResolvedValueOnce(mockResult);

    const result = await db.query('SELECT * FROM captures WHERE id = $1', ['1']);
    expect(result.rows).toEqual([{ id: '1', content: 'test' }]);
    expect(db.pool.query).toHaveBeenCalledWith('SELECT * FROM captures WHERE id = $1', ['1']);
  });

  it('executes a transaction with commit on success', async () => {
    const { createDbClient } = await import('../../../src/db/client.js');
    const db = createDbClient('postgresql://localhost/test');

    const client = await db.pool.connect();
    vi.mocked(client.query).mockResolvedValue({
      rows: [{ id: '1' }],
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await db.transaction(async (txClient) => {
      const res = await txClient.query('INSERT INTO captures (content) VALUES ($1) RETURNING id', ['test']);
      return res.rows[0];
    });

    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back transaction on error', async () => {
    const { createDbClient } = await import('../../../src/db/client.js');
    const db = createDbClient('postgresql://localhost/test');

    const client = await db.pool.connect();
    vi.mocked(client.query)
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockRejectedValueOnce(new Error('constraint violation'));

    await expect(
      db.transaction(async (txClient) => {
        await txClient.query('INSERT INTO bad_table VALUES ($1)', ['bad']);
      })
    ).rejects.toThrow('constraint violation');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  // Regression (2026-07-30): idle pooled connections dropping (server restart,
  // TCP reset) emit 'error' on the Pool. Without a listener that becomes an
  // uncaughtException and kills the whole server — it crashed the dev backend
  // twice under e2e load. createDbClient must attach a listener.
  it("survives an idle client 'error' event instead of crashing the process", async () => {
    const { createDbClient } = await import('../../../src/db/client.js');
    const db = createDbClient('postgresql://localhost/test');

    const emitter = db.pool as unknown as import('node:events').EventEmitter;
    expect(emitter.listenerCount('error')).toBeGreaterThan(0);
    // With no listener this emit would throw (EventEmitter 'error' semantics).
    expect(() => emitter.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  });
});
