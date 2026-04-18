/**
 * Integration tests for URL ingestion — dispatcher, per-type handlers,
 * dedup, and source_url surfacing.
 *
 * Mocks:
 *   - the YouTube transcript provider
 *   - xAI and Firecrawl providers (mocked at module level via vi.mock)
 *   - fetch (for HEAD content-type detection + binary downloads)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock providers BEFORE importing anything that uses them
vi.mock('../../src/providers/youtube-transcript.js', () => ({
  fetchYouTubeTranscript: vi.fn(),
}));

vi.mock('../../src/providers/xai.js', () => ({
  XaiClient: vi.fn().mockImplementation(() => ({
    fetchXThread: vi.fn(),
  })),
}));

vi.mock('../../src/providers/firecrawl.js', () => ({
  FirecrawlClient: vi.fn().mockImplementation(() => ({
    scrape: vi.fn(),
  })),
}));

import { createApp } from '../../src/app.js';
import type { ServiceDeps } from '../../src/services/index.js';
import { fetchYouTubeTranscript } from '../../src/providers/youtube-transcript.js';
import { XaiClient } from '../../src/providers/xai.js';
import { FirecrawlClient } from '../../src/providers/firecrawl.js';

function mockDeps(): ServiceDeps {
  return {
    db: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      pool: {} as any,
      transaction: vi.fn().mockImplementation(async (fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
      close: vi.fn(),
    } as any,
    embeddingProvider: {
      embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
      dimensions: 3072,
    },
    metadataLLM: {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ title: 'Auto-generated title', topics: [], tags: [], extracted_text: null }),
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    ragLLM: {
      complete: vi.fn().mockResolvedValue({
        content: 'ok',
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    blobStorage: {
      upload: vi.fn().mockResolvedValue('https://blob/file'),
      exists: vi.fn().mockResolvedValue(false),
      getUrl: vi.fn().mockReturnValue('https://blob/file'),
    },
    config: {
      apiKey: 'test-key',
      xaiApiKey: 'xai-test',
      firecrawlApiKey: 'fc-test',
    } as any,
  };
}

const AUTH = { 'Authorization': 'Bearer test-key', 'Content-Type': 'application/json' };

describe('POST /api/v1/content/from-url', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = mockDeps();
    app = createApp(deps);
  });

  it('rejects missing url', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/content/from-url', {
      method: 'POST', headers: AUTH, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'url is required' });
  });

  it('dedups — returns existing item when source_url already saved', async () => {
    // First DB call is findByUrl — return an existing row
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('source_url = $1')) {
        return {
          rows: [{
            id: 'existing-1',
            type: 'document',
            title: 'Already saved',
            source_url: 'https://youtu.be/dQw4w9WgXcQ',
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content/from-url', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ' }),
    }));

    expect(res.status).toBe(200); // 200 on dedup (no creation), 201 on new
    const body = await res.json();
    expect(body.deduped).toBe(true);
    expect(body.id).toBe('existing-1');
    expect(body.title).toBe('Already saved');
    // YouTube transcript should NOT be fetched on dedup path
    expect(fetchYouTubeTranscript).not.toHaveBeenCalled();
  });

  it('ingests YouTube — calls transcript provider, creates item with source_url', async () => {
    vi.mocked(fetchYouTubeTranscript).mockResolvedValue([
      { text: 'We are' },
      { text: 'no strangers to love' },
    ]);
    // Mocks for the createContentItem DB calls (insert chunks, insert content_item)
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO content_items')) return { rows: [{ id: 'new-ci' }] } as any;
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content/from-url', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('new-ci');
    expect(body.source_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(body.url_type).toBe('youtube');
    expect(body.deduped).toBe(false);

    // Verify transcript provider was called with the right video ID
    expect(fetchYouTubeTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ');

    // Verify source_url was passed through to insertContentItem
    const insertCall = vi.mocked(deps.db.query).mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO content_items'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as any[];
    // source_url is the last ($12) param per the insertContentItem column order
    expect(params[params.length - 1]).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('ingests X thread — calls xAI primary', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ title: 'First tweet…', content: '@user: hello world\n@other: reply' });
    vi.mocked(XaiClient).mockImplementation(() => ({ fetchXThread: mockFetch }) as any);

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO content_items')) return { rows: [{ id: 'x-ci' }] } as any;
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content/from-url', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ url: 'https://x.com/user/status/1234567890' }),
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url_type).toBe('x');
    expect(body.source_url).toBe('https://x.com/user/status/1234567890');
    expect(mockFetch).toHaveBeenCalledWith('https://x.com/user/status/1234567890');
  });

  it('ingests X thread — falls back to Firecrawl when xAI fails', async () => {
    const xaiFail = vi.fn().mockRejectedValue(new Error('xAI down'));
    const firecrawlScrape = vi.fn().mockResolvedValue({ title: 'thread title', markdown: 'thread body' });
    vi.mocked(XaiClient).mockImplementation(() => ({ fetchXThread: xaiFail }) as any);
    vi.mocked(FirecrawlClient).mockImplementation(() => ({ scrape: firecrawlScrape }) as any);

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO content_items')) return { rows: [{ id: 'x-fb' }] } as any;
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/content/from-url', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ url: 'https://x.com/user/status/999' }),
    }));

    expect(res.status).toBe(201);
    expect(xaiFail).toHaveBeenCalled();
    expect(firecrawlScrape).toHaveBeenCalledWith('https://x.com/user/status/999', { stealth: true });
  });

  it('ingests HTML — uses Firecrawl markdown', async () => {
    const firecrawlScrape = vi.fn().mockResolvedValue({ title: 'Blog Post', markdown: '# Blog Post\nContent here.' });
    vi.mocked(FirecrawlClient).mockImplementation(() => ({ scrape: firecrawlScrape }) as any);

    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO content_items')) return { rows: [{ id: 'html-ci' }] } as any;
      return { rows: [] } as any;
    });

    // Stub global fetch for the HEAD content-type check (return text/html)
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );

    const res = await app.fetch(new Request('http://localhost/api/v1/content/from-url', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ url: 'https://example.com/article' }),
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url_type).toBe('html');
    expect(firecrawlScrape).toHaveBeenCalledWith('https://example.com/article');

    globalFetch.mockRestore();
  });

  it('returns 400 with clear error when YouTube transcript fails', async () => {
    vi.mocked(fetchYouTubeTranscript).mockRejectedValue(new Error('No captions available'));

    const res = await app.fetch(new Request('http://localhost/api/v1/content/from-url', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ url: 'https://youtu.be/xxxxxxxxxxx' }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('transcript');
  });
});

describe('source_url surfacing in search', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = mockDeps();
    app = createApp(deps);
  });

  it('chunk search SQL selects ci.source_url AS parent_source_url', async () => {
    vi.mocked(deps.db.query).mockResolvedValue({ rows: [] } as any);
    await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ query: 'test' }),
    }));

    const calls = vi.mocked(deps.db.query).mock.calls;
    const chunkQ = calls.find((c) => typeof c[0] === 'string' && c[0].includes('FROM chunks'));
    expect(chunkQ).toBeDefined();
    expect(chunkQ![0]).toContain('ci.source_url AS parent_source_url');
  });

  it('search hit exposes parent_source_url when the parent item has one', async () => {
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM chunks')) {
        return {
          rows: [{
            id: 'chunk-1', content_item_id: 'ci-1', chunk_index: 0, chunk_type: 'text',
            content: 'Rickrolled', metadata: {}, created_at: new Date(),
            similarity: 0.9,
            parent_type: 'document', parent_title: 'Rick Astley',
            parent_project_ids: [], parent_tags: [],
            parent_source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/search', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ query: 'rick' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits[0].chunk.parent_source_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('RAG citation includes source_url when present', async () => {
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM chunks')) {
        return {
          rows: [{
            id: 'chunk-1', content_item_id: 'ci-1', chunk_index: 0, chunk_type: 'text',
            content: 'some content', metadata: {}, created_at: new Date(),
            similarity: 0.9,
            parent_type: 'document', parent_title: 'Source doc',
            parent_project_ids: [], parent_tags: [],
            parent_source_url: 'https://example.com/source',
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const res = await app.fetch(new Request('http://localhost/api/v1/rag', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ question: 'what?' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].source_url).toBe('https://example.com/source');
  });
});
