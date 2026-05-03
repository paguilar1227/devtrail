/**
 * Integration tests for the REST API endpoints.
 * Exercise the full Hono handler flow with mocked service deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import type { ServiceDeps } from '../../src/services/index.js';

function mockDeps(): ServiceDeps {
  return {
    db: {
      query: vi.fn(),
      pool: {} as any,
      transaction: vi.fn().mockImplementation(async (fn: any) => fn({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      })),
      close: vi.fn(),
    } as any,
    embeddingProvider: {
      embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
      dimensions: 3072,
    },
    metadataLLM: {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ title: 'Auto-generated', topics: [], tags: [], extracted_text: null }),
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    mediaMetadataLLM: {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ title: 'Auto-generated', topics: [], tags: [], extracted_text: null }),
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    ragFastLLM: {
      complete: vi.fn().mockResolvedValue({
        content: 'Answer with context [1].',
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    ragDeepLLM: {
      complete: vi.fn().mockResolvedValue({
        content: 'Thorough answer with context [1].',
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    queryDepthLLM: {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ depth: 'fast', reason: 'test' }),
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    blobStorage: {
      upload: vi.fn().mockResolvedValue('https://blob/file'),
      exists: vi.fn().mockResolvedValue(false),
      getUrl: vi.fn().mockReturnValue('https://blob/file'),
      download: vi.fn().mockResolvedValue(Buffer.from('mock-bytes')),
      getReadSasUrl: vi.fn((u: string) => u),
    },
    config: { apiKey: 'test-key' } as any,
  };
}

const AUTH = { 'Authorization': 'Bearer test-key' };

describe('Projects API', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = mockDeps();
    app = createApp(deps);
  });

  it('creates a project', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'Test', description: 'desc', status: 'active', created_at: new Date(), updated_at: new Date() }],
    } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/projects', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', description: 'desc' }),
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.id).toBe('p1');
    expect(body.project.name).toBe('Test');
  });

  it('rejects project creation without name', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/projects', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'no name' }),
    }));
    expect(res.status).toBe(400);
  });

  it('lists projects', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [
        { id: 'p1', name: 'A', status: 'active', created_at: new Date(), updated_at: new Date() },
        { id: 'p2', name: 'B', status: 'active', created_at: new Date(), updated_at: new Date() },
      ],
    } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/projects', { headers: AUTH }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(2);
  });

  it('returns 404 for well-formed UUID that does not exist', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({ rows: [] } as any);
    // Use a well-formed UUID so it passes UUID validation and hits the DB lookup.
    const res = await app.fetch(new Request('http://localhost/api/v1/projects/00000000-0000-4000-8000-000000000000', { headers: AUTH }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed UUID (not a raw Postgres error)', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/projects/not-a-uuid', { headers: AUTH }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid UUID');
  });
});

describe('Content items API', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = mockDeps();
    app = createApp(deps);
  });

  it('creates a note via JSON (no file)', async () => {
    // Sequence of DB calls for the content-items service:
    // 1. insertContentItem returns the new id
    // 2. insertChunks (via transaction) — handled by transaction mock
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO content_items')) {
        return { rows: [{ id: 'c1' }] } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'note',
        content: 'Some note content',
        project_ids: ['proj-1'],
      }),
    }));

    // Async ingest contract: 202 + {id, status}. Title surfaces later via
    // GET /content/:id once processing_status flips to 'ready'.
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBe('c1');
    expect(body.status).toBe('pending');
  });

  it('background tail flips processing_status to ready after POST returns', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes('INSERT INTO content_items')) return { rows: [{ id: 'c-async-1' }] } as any;
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', content: 'Background tail test' }),
    }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('pending');

    // Let the background completion microtasks settle.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // The tail must have fired UPDATE … SET processing_status = 'ready'.
    const readyUpdate = queries.find(
      (q) => /UPDATE\s+content_items/i.test(q.sql)
        && /processing_status\s*=\s*\$1/.test(q.sql)
        && q.params[0] === 'ready',
    );
    expect(readyUpdate).toBeDefined();
  });

  it('background tail flips processing_status to failed when the pipeline throws', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes('INSERT INTO content_items')) return { rows: [{ id: 'c-fail-1' }] } as any;
      return { rows: [] } as any;
    });
    // Force chunk embedding to blow up. extractMetadata swallows LLM errors
    // (returns FALLBACK), but the embedding provider's failure does propagate
    // up through runIngestTail's catch.
    vi.mocked(deps.embeddingProvider.embed).mockRejectedValue(new Error('embedding service down'));

    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', content: 'Failure path test' }),
    }));
    expect(res.status).toBe(202);

    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const failedUpdate = queries.find(
      (q) => /UPDATE\s+content_items/i.test(q.sql)
        && /processing_status\s*=\s*\$1/.test(q.sql)
        && q.params[0] === 'failed',
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.params[1]).toContain('embedding service down');
  });

  it('GET /content/:id/status returns the slim polling shape for a known id', async () => {
    const fakeId = '11111111-1111-1111-1111-111111111111';
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      // The status query joins chunks for chunk_count. Match by SELECT shape
      // so a future addition of more columns doesn't silently break the test.
      if (/FROM\s+content_items\s+ci/i.test(sql) && /chunk_count/i.test(sql)) {
        return {
          rows: [{
            id: fakeId,
            type: 'document',
            title: 'Polling fixture',
            processing_status: 'ready',
            processing_error: null,
            ingest_started_at: new Date('2026-04-30T12:00:00Z'),
            ingest_completed_at: new Date('2026-04-30T12:00:08Z'),
            chunk_count: 3,
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(`http://localhost/api/v1/content/${fakeId}/status`, {
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: fakeId,
      type: 'document',
      title: 'Polling fixture',
      processing_status: 'ready',
      processing_error: null,
      ingest_started_at: '2026-04-30T12:00:00.000Z',
      ingest_completed_at: '2026-04-30T12:00:08.000Z',
      chunk_count: 3,
    });
    // Slim contract: explicitly NO content body / metadata / blob_url /
    // embedding. Adding any of those silently would defeat the bandwidth
    // win that motivates this endpoint.
    expect(body).not.toHaveProperty('content');
    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('embedding');
    expect(body).not.toHaveProperty('blob_url');
  });

  it('GET /content/:id/status returns 404 for an unknown id', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);
    const res = await app.fetch(new Request(
      'http://localhost/api/v1/content/22222222-2222-2222-2222-222222222222/status',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(404);
  });

  it('GET /content/:id/status returns 400 for a non-UUID id', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/content/not-a-uuid/status', {
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(400);
  });

  it('POST /content/:id/retry resets a failed row and returns 202 + pending', async () => {
    const fakeId = '33333333-3333-3333-3333-333333333333';
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      // The row lookup. Mark as failed so retry is allowed.
      if (/SELECT \* FROM content_items WHERE id = \$1/i.test(sql)) {
        return {
          rows: [{
            id: fakeId,
            type: 'note',
            title: 'Previously failed',
            content: 'Original text body that survived prelude.',
            blob_url: null,
            mime_type: null,
            file_hash: null,
            project_ids: [],
            tags: [],
            embedding: null,
            metadata: { ingest_trace: {} },
            source_url: null,
            published_at: null,
            archived: false,
            processing_status: 'failed',
            processing_error: 'embedding service down',
            ingest_completed_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(`http://localhost/api/v1/content/${fakeId}/retry`, {
      method: 'POST',
      headers: { ...AUTH },
    }));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ id: fakeId, status: 'pending' });

    // Side effects we care about: chunks deleted + status reset to 'pending'
    // BEFORE the tail re-runs. (The tail then UPDATEs to 'ready' or 'failed',
    // but that's racey w.r.t. the response — we only assert the synchronous
    // pre-tail work here.)
    const chunksDeleted = queries.find(
      (q) => /DELETE\s+FROM\s+chunks/i.test(q.sql) && q.params[0] === fakeId,
    );
    expect(chunksDeleted).toBeDefined();

    const statusReset = queries.find(
      (q) => /UPDATE\s+content_items/i.test(q.sql)
        && /processing_status\s*=\s*\$1/.test(q.sql)
        && q.params[0] === 'pending'
        && q.params[2] === fakeId,
    );
    expect(statusReset).toBeDefined();
  });

  it('POST /content/:id/retry returns 409 when the row is already ready', async () => {
    const fakeId = '44444444-4444-4444-4444-444444444444';
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM content_items WHERE id = \$1/i.test(sql)) {
        return {
          rows: [{
            id: fakeId, type: 'note', title: 'Healthy', content: 'fine',
            blob_url: null, mime_type: null, file_hash: null,
            project_ids: [], tags: [], embedding: null, metadata: {},
            source_url: null, published_at: null, archived: false,
            processing_status: 'ready', processing_error: null,
            ingest_completed_at: new Date(),
            created_at: new Date(), updated_at: new Date(),
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(`http://localhost/api/v1/content/${fakeId}/retry`, {
      method: 'POST',
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ALREADY_READY');
  });

  it('POST /content/:id/retry returns 409 when the row is still pending (in-flight)', async () => {
    const fakeId = '55555555-5555-5555-5555-555555555555';
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM content_items WHERE id = \$1/i.test(sql)) {
        return {
          rows: [{
            id: fakeId, type: 'note', title: 'Processing…', content: null,
            blob_url: null, mime_type: null, file_hash: null,
            project_ids: [], tags: [], embedding: null, metadata: {},
            source_url: null, published_at: null, archived: false,
            processing_status: 'pending', processing_error: null,
            ingest_completed_at: null,
            created_at: new Date(), updated_at: new Date(),
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(`http://localhost/api/v1/content/${fakeId}/retry`, {
      method: 'POST',
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('IN_FLIGHT');
  });

  it('POST /content/:id/retry returns 404 for an unknown id', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);
    const res = await app.fetch(new Request(
      'http://localhost/api/v1/content/66666666-6666-6666-6666-666666666666/retry',
      { method: 'POST', headers: { ...AUTH } },
    ));
    expect(res.status).toBe(404);
  });

  it('POST /content/:id/retry returns 400 for a non-UUID id', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/content/not-a-uuid/retry', {
      method: 'POST',
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(400);
  });

  it('GET /content?processing_status=failed forwards a single status filter to the DB', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(
      'http://localhost/api/v1/content?processing_status=failed',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(200);

    const listQ = queries.find((q) => /SELECT \* FROM content_items/i.test(q.sql));
    expect(listQ).toBeDefined();
    expect(listQ!.sql).toMatch(/processing_status\s*=\s*ANY/i);
    expect(listQ!.params).toContainEqual(['failed']);
  });

  it('GET /content?processing_status=pending,failed forwards both statuses', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(
      'http://localhost/api/v1/content?processing_status=pending,failed',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(200);

    const listQ = queries.find((q) => /SELECT \* FROM content_items/i.test(q.sql));
    expect(listQ!.params).toContainEqual(['pending', 'failed']);
  });

  it('GET /tags aggregates tag rows with by_type counts', async () => {
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (/WITH\s+tag_rows/i.test(sql)) {
        return {
          rows: [
            { name: 'reference', total: 5, doc_count: 3, note_count: 2, todo_count: 0 },
            { name: 'urgent',    total: 2, doc_count: 0, note_count: 0, todo_count: 2 },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/tags', {
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toHaveLength(2);
    expect(body.tags[0]).toEqual({
      name: 'reference',
      total: 5,
      by_type: { document: 3, note: 2, todo: 0 },
    });
    expect(body.tags[1].name).toBe('urgent');
    expect(body.tags[1].by_type.todo).toBe(2);
  });

  it('GET /tags?project_id=<uuid> scopes the SQL via project filter', async () => {
    const projId = '12345678-1234-1234-1234-123456789012';
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(
      `http://localhost/api/v1/tags?project_id=${projId}`,
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(200);

    const tagsQ = queries.find((q) => /WITH\s+tag_rows/i.test(q.sql));
    expect(tagsQ).toBeDefined();
    // Both content_items and todos branches need to filter by project_id when scoped.
    expect(tagsQ!.sql).toMatch(/project_ids\s*@>/i);
    expect(tagsQ!.sql).toMatch(/project_id\s*=\s*\$1/i);
    expect(tagsQ!.params).toContain(projId);
  });

  it('PUT /tags/:name renames across content_items + todos in one transaction', async () => {
    const txQueries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.transaction).mockImplementation(async (fn: any) => {
      const txClient = {
        query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
          txQueries.push({ sql, params: params ?? [] });
          return { rows: [], rowCount: 3 };
        }),
      };
      return fn(txClient);
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/tags/old-tag', {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'new-tag' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ from: 'old-tag', to: 'new-tag', updated: 6 });

    // Both tables must be hit. Catches a regression where someone forgets
    // one of the two UPDATEs and tags drift between content_items and todos.
    expect(txQueries.find((q) => /UPDATE\s+content_items/i.test(q.sql))).toBeDefined();
    expect(txQueries.find((q) => /UPDATE\s+todos/i.test(q.sql))).toBeDefined();
    // Both UPDATEs must include the dedup CASE so a row with both `from`
    // and `to` ends up with single `to` instead of [to, to].
    expect(txQueries.every((q) => /array_agg\(DISTINCT/i.test(q.sql))).toBe(true);
  });

  it('PUT /tags/:name with from === to is a no-op (no transaction)', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/tags/foo', {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'foo' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.noop).toBe(true);
    expect(body.updated).toBe(0);
    // Critical: the no-op must NOT thrash the DB.
    expect(deps.db.transaction).not.toHaveBeenCalled();
  });

  it('PUT /tags/:name with missing `to` returns 400', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/tags/old', {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  it('DELETE /tags/:name strips the tag from both tables', async () => {
    const txQueries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.transaction).mockImplementation(async (fn: any) => {
      const txClient = {
        query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
          txQueries.push({ sql, params: params ?? [] });
          return { rows: [], rowCount: 2 };
        }),
      };
      return fn(txClient);
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/tags/dead-tag', {
      method: 'DELETE',
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ name: 'dead-tag', updated: 4 });

    // Both UPDATEs must use array_remove (NOT array_replace or DELETE FROM).
    // A regression where someone deletes rows instead of stripping the tag
    // would surface here.
    expect(txQueries.every((q) => /array_remove/i.test(q.sql))).toBe(true);
    expect(txQueries.every((q) => /DELETE\s+FROM/i.test(q.sql))).toBe(false);
  });

  it('GET /activity returns chronologically-ordered events with all three kinds', async () => {
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (/WITH\s+activity/i.test(sql)) {
        return {
          rows: [
            { at: new Date('2026-05-03T10:00:00Z'), kind: 'comment', entity_type: 'todo_comment', entity_id: 'c1', title: 'Email John', project_ids: [] },
            { at: new Date('2026-05-03T09:30:00Z'), kind: 'edit',    entity_type: 'note',         entity_id: 'n1', title: 'Renamed note', project_ids: ['p1'] },
            { at: new Date('2026-05-03T09:00:00Z'), kind: 'ingest',  entity_type: 'document',     entity_id: 'd1', title: 'New doc',      project_ids: ['p1'] },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/activity', {
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activity).toHaveLength(3);
    expect(body.activity[0].kind).toBe('comment');
    expect(body.activity[2].kind).toBe('ingest');
  });

  it('GET /activity?since=&until= forwards bounds as timestamptz params', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(
      'http://localhost/api/v1/activity?since=2026-05-01T00:00:00Z&until=2026-05-04T00:00:00Z',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(200);

    const aQ = queries.find((q) => /WITH\s+activity/i.test(q.sql));
    expect(aQ).toBeDefined();
    expect(aQ!.params[0]).toBeInstanceOf(Date);
    expect(aQ!.params[1]).toBeInstanceOf(Date);
    expect((aQ!.params[0] as Date).toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect((aQ!.params[1] as Date).toISOString()).toBe('2026-05-04T00:00:00.000Z');
  });

  it('GET /activity?kinds=ingest,edit narrows the SQL to those branches only', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request(
      'http://localhost/api/v1/activity?kinds=ingest,edit',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(200);

    const aQ = queries.find((q) => /WITH\s+activity/i.test(q.sql));
    expect(aQ).toBeDefined();
    // Both branches should be present, comment branch should NOT.
    // Filtering matters because each UNION ALL branch is a full table scan;
    // emitting unwanted ones inflates cost.
    expect(/'ingest'::text AS kind/.test(aQ!.sql)).toBe(true);
    expect(/'edit'::text AS kind/.test(aQ!.sql)).toBe(true);
    expect(/'comment'::text AS kind/.test(aQ!.sql)).toBe(false);
  });

  it('GET /activity rejects invalid kind values with a 400 listing the allowed set', async () => {
    const res = await app.fetch(new Request(
      'http://localhost/api/v1/activity?kinds=ingest,whatever',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/whatever/);
    expect(body.error).toMatch(/ingest,\s*edit,\s*comment/);
  });

  it('GET /activity rejects malformed since/until with 400', async () => {
    const res = await app.fetch(new Request(
      'http://localhost/api/v1/activity?since=not-a-date',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(400);
  });

  it('GET /stats returns the full inventory snapshot in a single round-trip', async () => {
    let queryCount = 0;
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (/content_counts/i.test(sql) && /todo_counts/i.test(sql) && /project_counts/i.test(sql)) {
        queryCount++;
        return {
          rows: [{
            documents: '12', notes: '8',
            pending: '1', ready: '18', failed: '1',
            last_ingest_at: new Date('2026-05-03T10:00:00Z'),
            last_edit_at: new Date('2026-05-03T11:00:00Z'),
            todos_total: '5', todos_not_started: '2', todos_in_progress: '2', todos_done: '1',
            projects_total: '3', projects_active: '2', projects_archived: '0', projects_completed: '1',
            comments: '4',
            last_comment_at: new Date('2026-05-02T22:00:00Z'),
            chunks: '120',
            top_tags: [{ name: 'reading', count: 5 }, { name: 'work', count: 3 }],
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/stats', { headers: { ...AUTH } }));
    expect(res.status).toBe(200);
    expect(queryCount).toBe(1); // single multi-CTE query
    const body = await res.json();
    expect(body.counts.documents).toBe(12);
    expect(body.counts.notes).toBe(8);
    expect(body.counts.todos).toEqual({ total: 5, not_started: 2, in_progress: 2, done: 1 });
    expect(body.counts.projects).toEqual({ total: 3, active: 2, archived: 0, completed: 1 });
    expect(body.counts.comments).toBe(4);
    expect(body.counts.chunks).toBe(120);
    expect(body.processing).toEqual({ pending: 1, ready: 18, failed: 1 });
    expect(body.freshness.last_ingest_at).toBe('2026-05-03T10:00:00.000Z');
    expect(body.freshness.last_edit_at).toBe('2026-05-03T11:00:00.000Z');
    expect(body.freshness.last_comment_at).toBe('2026-05-02T22:00:00.000Z');
    expect(body.top_tags).toEqual([{ name: 'reading', count: 5 }, { name: 'work', count: 3 }]);
  });

  it('GET /stats?project_id=<uuid> scopes counts via project_ids array containment', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [{}] } as any;
    });

    const pid = '11111111-1111-4111-8111-111111111111';
    const res = await app.fetch(new Request(
      `http://localhost/api/v1/stats?project_id=${pid}`,
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(200);

    const sQ = queries.find((q) => /content_counts/i.test(q.sql));
    expect(sQ).toBeDefined();
    expect(sQ!.params).toEqual([pid]);
    // Content/todos/comments/chunks all scoped; projects count is not scoped.
    expect(/project_ids @> ARRAY\[\$1\]::uuid\[\]/.test(sQ!.sql)).toBe(true);
    expect(/project_id = \$1/.test(sQ!.sql)).toBe(true);
  });

  it('GET /stats?project_id=not-a-uuid returns 400', async () => {
    const res = await app.fetch(new Request(
      'http://localhost/api/v1/stats?project_id=not-a-uuid',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(400);
  });

  it('GET /stats handles an empty workspace (zeros, nulls, no NaN)', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [{
        documents: null, notes: null,
        pending: null, ready: null, failed: null,
        last_ingest_at: null, last_edit_at: null,
        todos_total: null, todos_not_started: null, todos_in_progress: null, todos_done: null,
        projects_total: null, projects_active: null, projects_archived: null, projects_completed: null,
        comments: null, last_comment_at: null,
        chunks: null,
        top_tags: [],
      }],
    } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/stats', { headers: { ...AUTH } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Empty workspace must coerce to 0 / null cleanly — UI dashboards crash on NaN.
    expect(body.counts.documents).toBe(0);
    expect(body.counts.todos.total).toBe(0);
    expect(body.freshness.last_ingest_at).toBeNull();
    expect(body.top_tags).toEqual([]);
  });

  it('POST /content/bulk archive: single SQL, returns counts and missing_ids', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] } as any;
    });

    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const res = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'archive' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      requested: 2,
      affected: 1,
      missing_ids: ['22222222-2222-4222-8222-222222222222'],
    });

    // One round-trip — bulk ops MUST NOT loop per-id (the whole point of the endpoint).
    expect(queries).toHaveLength(1);
    expect(/UPDATE content_items/i.test(queries[0].sql)).toBe(true);
    expect(/archived = true/.test(queries[0].sql)).toBe(true);
    expect(/id = ANY\(\$1::uuid\[\]\)/.test(queries[0].sql)).toBe(true);
    expect(/RETURNING id/.test(queries[0].sql)).toBe(true);
  });

  it('POST /content/bulk add_tags uses set semantics (DISTINCT on UNION)', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'add_tags',
        tags: ['urgent', 'reading'],
      }),
    }));
    expect(res.status).toBe(200);

    expect(queries).toHaveLength(1);
    expect(queries[0].params[1]).toEqual(['urgent', 'reading']);
    // DISTINCT prevents accumulating duplicates if the tag is already present.
    expect(/SELECT DISTINCT/i.test(queries[0].sql)).toBe(true);
    expect(/UNNEST\(tags \|\| \$2::text\[\]\)/.test(queries[0].sql)).toBe(true);
  });

  it('POST /content/bulk remove_tags filters via WHERE NOT IN', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'remove_tags',
        tags: ['stale'],
      }),
    }));
    expect(res.status).toBe(200);
    expect(/<>\s*ALL\(\$2::text\[\]\)/.test(queries[0].sql)).toBe(true);
  });

  it('POST /content/bulk set_project_ids accepts empty array (detach)', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    // Detaching content from all projects is a legitimate UI action — the user
    // wants the items in the global Inbox. Empty array must be allowed.
    const res = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'set_project_ids',
        project_ids: [],
      }),
    }));
    expect(res.status).toBe(200);
    expect(queries[0].params[1]).toEqual([]);
  });

  it('POST /content/bulk rejects unknown action with the allowed set listed', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'evaporate',
      }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/evaporate/);
    expect(body.error).toMatch(/archive/);
    expect(body.error).toMatch(/set_project_ids/);
  });

  it('POST /content/bulk rejects empty ids, oversize batch, and bad UUIDs', async () => {
    const empty = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [], action: 'archive' }),
    }));
    expect(empty.status).toBe(400);

    const tooMany = Array.from({ length: 101 }, () => '11111111-1111-4111-8111-111111111111');
    const big = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: tooMany, action: 'archive' }),
    }));
    expect(big.status).toBe(400);

    const bad = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['not-a-uuid'], action: 'archive' }),
    }));
    expect(bad.status).toBe(400);
  });

  it('POST /content/bulk add_tags without tags returns 400', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/content/bulk', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'add_tags',
      }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty tags/);
  });

  it('GET /tags?project_id=not-a-uuid returns 400', async () => {
    const res = await app.fetch(new Request(
      'http://localhost/api/v1/tags?project_id=not-a-uuid',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(400);
  });

  it('GET /content?processing_status=junk returns 400 with a helpful error', async () => {
    const res = await app.fetch(new Request(
      'http://localhost/api/v1/content?processing_status=junk',
      { headers: { ...AUTH } },
    ));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/junk/);
    expect(body.error).toMatch(/pending,\s*ready,\s*failed/);
  });

  it('GET /content with no processing_status param does NOT add the filter', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      headers: { ...AUTH },
    }));
    expect(res.status).toBe(200);

    const listQ = queries.find((q) => /SELECT \* FROM content_items/i.test(q.sql));
    // Default = browse everything (so a "currently processing" view is opt-in).
    // Regression here would mean we silently started filtering and breaking
    // the browse-all default the UI relies on.
    expect(listQ!.sql).not.toMatch(/processing_status\s*=\s*ANY/i);
  });

  it('rejects content creation without content or file', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note' }),
    }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid type', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'invalid', content: 'x' }),
    }));
    expect(res.status).toBe(400);
  });

  it('multipart upload rejects missing type instead of silently defaulting (E2E #2)', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }), 'sample.pdf');
    // intentionally omit `type` — old behavior silently defaulted to 'note'
    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      method: 'POST',
      headers: AUTH,
      body: form,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/type/i);
  });

  it('multipart upload rejects garbage type with 400 (E2E #2)', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }), 'sample.pdf');
    form.append('type', 'definitely-not-a-real-type');
    const res = await app.fetch(new Request('http://localhost/api/v1/content', {
      method: 'POST',
      headers: AUTH,
      body: form,
    }));
    expect(res.status).toBe(400);
  });
});

describe('Todos API', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = mockDeps();
    app = createApp(deps);
  });

  it('creates a todo', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({ rows: [{ id: 't1' }] } as any);
    const res = await app.fetch(new Request('http://localhost/api/v1/todos', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Do the thing', priority: 'P1' }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('t1');
  });

  it('rejects todo without content', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/todos', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'P1' }),
    }));
    expect(res.status).toBe(400);
  });

  it('lists todos', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [{ id: 't1', content: 'Thing', status: 'not_started', tags: [], embedding: null, archived: false, created_at: new Date(), updated_at: new Date() }],
    } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/todos', { headers: AUTH }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.todos).toHaveLength(1);
    // embedding should be stripped
    expect(body.todos[0].embedding).toBeUndefined();
  });

  it('POST /todos/bulk set_status: single SQL with status param', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'set_status',
        status: 'done',
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requested).toBe(1);
    expect(body.affected).toBe(1);

    expect(queries).toHaveLength(1);
    expect(/UPDATE todos/i.test(queries[0].sql)).toBe(true);
    expect(/status\s*=\s*\$2/.test(queries[0].sql)).toBe(true);
    expect(queries[0].params[1]).toBe('done');
  });

  it('POST /todos/bulk set_priority null clears the priority', async () => {
    // Distinguish "not provided" from "null". Both must work, but null
    // means "clear" — which is what `has_priority: true` + priority=null
    // signals through to the service layer.
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'set_priority',
        priority: null,
      }),
    }));
    expect(res.status).toBe(200);
    expect(queries[0].params[1]).toBeNull();
  });

  it('POST /todos/bulk set_project_id null detaches to Inbox', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'set_project_id',
        project_id: null,
      }),
    }));
    expect(res.status).toBe(200);
    expect(queries[0].params[1]).toBeNull();
  });

  it('POST /todos/bulk set_due_date accepts ISO 8601 and forwards as Date', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(deps.db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'set_due_date',
        due_date: '2026-06-01T00:00:00Z',
      }),
    }));
    expect(res.status).toBe(200);
    expect(queries[0].params[1]).toBeInstanceOf(Date);
    expect((queries[0].params[1] as Date).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('POST /todos/bulk rejects bogus status / priority / due_date with 400', async () => {
    const id = '11111111-1111-4111-8111-111111111111';

    const badStatus = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], action: 'set_status', status: 'imploded' }),
    }));
    expect(badStatus.status).toBe(400);
    expect((await badStatus.json()).error).toMatch(/imploded/);

    const badPriority = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], action: 'set_priority', priority: 'P9' }),
    }));
    expect(badPriority.status).toBe(400);

    const badDate = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], action: 'set_due_date', due_date: 'tomorrow' }),
    }));
    expect(badDate.status).toBe(400);
  });

  it('POST /todos/bulk set_priority without priority field returns 400', async () => {
    // Forgetting the priority field is a real mistake — the API distinguishes
    // "missing" from "null" so the service can refuse rather than silently
    // null-out everyone's priority.
    const res = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['11111111-1111-4111-8111-111111111111'],
        action: 'set_priority',
      }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/priority/);
  });

  it('POST /todos/bulk archive uses set semantics for ids and returns missing_ids', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({
      rows: [{ id: '11111111-1111-4111-8111-111111111111' }],
    } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/todos/bulk', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
        action: 'archive',
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.affected).toBe(1);
    expect(body.missing_ids).toEqual(['22222222-2222-4222-8222-222222222222']);
  });
});

describe('Search API', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = mockDeps();
    app = createApp(deps);
  });

  it('rejects search without query', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  it('search SQL does NOT use SELECT * or project embedding as a column (payload-size regression)', async () => {
    // Previously findSimilarChunks used SELECT c.*, which included c.embedding
    // (a 3072-dim float array). Ten hits = ~400KB of noise in the response.
    // This test enforces explicit column lists and no wildcard SELECTs.
    // (c.embedding still appears in the cosine-distance expression — that's fine;
    // only the projected result column list matters for payload size.)
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    }));

    const calls = vi.mocked(deps.db.query).mock.calls;
    const chunkQuery = calls.find((c) => typeof c[0] === 'string' && c[0].includes('FROM chunks'));
    const todoQuery = calls.find((c) => typeof c[0] === 'string' && c[0].includes('FROM todos'));
    expect(chunkQuery).toBeDefined();
    expect(todoQuery).toBeDefined();

    // No wildcard SELECTs (which would pull in embedding)
    expect(chunkQuery![0]).not.toMatch(/SELECT\s+c\.\*/);
    expect(todoQuery![0]).not.toMatch(/SELECT\s+\*/);

    // Explicit column list should be present (proof the refactor happened, not reverted)
    expect(chunkQuery![0]).toMatch(/SELECT\s+c\.id,\s*c\.content_item_id/);
  });

  it('search response hits do not contain embedding fields', async () => {
    // Mock DB returns a chunk row WITHOUT embedding (matching what the real query returns now).
    // If someone later regresses to SELECT *, the DB mock return type would re-include embedding
    // and the test below would fail. This is the consumer-facing side of the contract.
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM chunks')) {
        return {
          rows: [{
            id: 'ch1', content_item_id: 'ci1', chunk_index: 0, chunk_type: 'text',
            content: 'some chunk text', metadata: {}, created_at: new Date(),
            similarity: 0.7,
            parent_type: 'note', parent_title: 'Test Note',
            parent_project_ids: [], parent_tags: [],
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits.length).toBeGreaterThan(0);

    // No hit should contain an 'embedding' field anywhere (chunk or todo subobject)
    for (const hit of body.hits) {
      if (hit.chunk) expect(hit.chunk).not.toHaveProperty('embedding');
      if (hit.todo) expect(hit.todo).not.toHaveProperty('embedding');
    }

    // Stringifying the whole response should not contain the word 'embedding'
    expect(JSON.stringify(body)).not.toContain('embedding');
  });

  it('runs a semantic search and returns hits', async () => {
    // search returns chunks + todos (both empty in this mock)
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('extracts query entities via the depth classifier when graph is on (F1)', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);
    vi.mocked(deps.queryDepthLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        depth: 'fast', reason: 'definitional',
        entities: [{ name: 'pgvector', type: 'tool' }],
      }),
      tokensUsed: { input: 0, output: 0, total: 0 },
    });

    await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'what about pgvector' }),
    }));

    // Classifier was called once for entity extraction
    expect(deps.queryDepthLLM.complete).toHaveBeenCalledOnce();
  });

  it('skips the classifier when graph is explicitly disabled (F1)', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', graph: false }),
    }));

    expect(deps.queryDepthLLM.complete).not.toHaveBeenCalled();
  });
});

describe('RAG API', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = mockDeps();
    app = createApp(deps);
  });

  it('rejects RAG without question', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  it('returns an answer with empty citations when there are no chunks', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What?' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBeTruthy();
    expect(body.citations).toEqual([]);
    expect(body.used_chunks).toBe(0);
  });

  it('auto-routes to thorough when caller opts in via depth=auto and the classifier says so', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);
    // Override the depth classifier to return thorough
    vi.mocked(deps.queryDepthLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ depth: 'thorough', reason: 'comparison query' }),
      tokensUsed: { input: 0, output: 0, total: 0 },
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      // depth: 'auto' opts into the classifier path. Default is now 'fast'
      // so without this the test would route to fast and bypass the classifier.
      body: JSON.stringify({ question: 'Compare X and Y.', depth: 'auto' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toBeDefined();
    expect(body.meta.depth_used).toBe('thorough');
    expect(body.meta.depth_reason).toContain('comparison');
  });

  it('defaults to fast when depth is not specified (post-baseline-2026-04-25)', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Anything' }),  // no depth field
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.depth_used).toBe('fast');
    // With default 'fast', the classifier is skipped (no entity extraction
    // either — that's tied to the auto/thorough paths).
    expect(deps.queryDepthLLM.complete).not.toHaveBeenCalled();
  });

  it('honors caller force of depth=fast and skips the classifier', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Anything', depth: 'fast' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.depth_used).toBe('fast');
    expect(body.meta.depth_reason).toContain('caller forced');
    // Classifier should not have been called when depth is explicitly set
    expect(deps.queryDepthLLM.complete).not.toHaveBeenCalled();
  });

  it('honors caller force of depth=thorough', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);

    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Anything', depth: 'thorough' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.depth_used).toBe('thorough');
    expect(body.meta.depth_reason).toContain('caller forced');
  });
});
