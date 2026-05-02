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
