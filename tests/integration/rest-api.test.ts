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
    ragLLM: {
      complete: vi.fn().mockResolvedValue({
        content: 'Answer with context [1].',
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

  it('returns 404 for missing project', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({ rows: [] } as any);
    const res = await app.fetch(new Request('http://localhost/api/v1/projects/missing', { headers: AUTH }));
    expect(res.status).toBe(404);
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
});
