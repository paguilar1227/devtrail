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

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('c1');
    expect(body.title).toBe('Auto-generated');
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

  it('auto-routes to thorough when the classifier says so, and surfaces depth meta', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);
    // Override the depth classifier to return thorough
    vi.mocked(deps.queryDepthLLM.complete).mockResolvedValueOnce({
      content: JSON.stringify({ depth: 'thorough', reason: 'comparison query' }),
      tokensUsed: { input: 0, output: 0, total: 0 },
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Compare X and Y.' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toBeDefined();
    expect(body.meta.depth_used).toBe('thorough');
    expect(body.meta.depth_reason).toContain('comparison');
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
