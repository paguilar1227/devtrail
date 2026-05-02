/**
 * Integration tests for the MCP endpoint mounted on the Hono app.
 *
 * These exercise the full /mcp request flow including the transport shim.
 * They would have caught the bug where the MCP handler returned empty
 * responses because the Node res shim didn't wait for res.end().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import type { ServiceDeps } from '../../src/services/index.js';

function mockDeps(): ServiceDeps {
  return {
    db: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      pool: {} as any,
      transaction: vi.fn(),
      close: vi.fn(),
    } as any,
    embeddingProvider: {
      embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
      dimensions: 3072,
    },
    metadataLLM: {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ title: 'Auto', topics: [], tags: [], extracted_text: null }),
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

        content: 'answer',

        tokensUsed: { input: 0, output: 0, total: 0 },

      }),

    },

    ragDeepLLM: {

      complete: vi.fn().mockResolvedValue({

        content: "Thorough answer",

        tokensUsed: { input: 0, output: 0, total: 0 },

      }),

    },

    queryDepthLLM: {

      complete: vi.fn().mockResolvedValue({

        content: JSON.stringify({ depth: "fast", reason: "test" }),

        tokensUsed: { input: 0, output: 0, total: 0 },

      }),

    },
    blobStorage: {
      upload: vi.fn().mockResolvedValue('https://blob/url'),
      exists: vi.fn().mockResolvedValue(false),
      getUrl: vi.fn().mockReturnValue('https://blob/url'),
      getReadSasUrl: vi.fn((u: string) => u),
    },
    config: { apiKey: 'test-key' } as any,
  };
}

describe('MCP endpoint via Hono app', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = mockDeps();
    app = createApp(deps);
  });

  it('returns a non-empty body on initialize (regression for res.end shim bug)', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });

    const res = await app.fetch(req);
    const text = await res.text();

    // The bug: empty body with 500 status. Fix: 200 with a proper JSON-RPC response.
    expect(res.status).toBe(200);
    expect(text.length).toBeGreaterThan(0);
    const body = JSON.parse(text);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result?.serverInfo?.name).toBe('open-brain');
    expect(body.result?.capabilities?.tools).toBeDefined();
  });

  it('rejects invalid JSON body with a JSON-RPC parse error, not a crash', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: '{not valid json',
    });

    const res = await app.fetch(req);
    // Either a 400 or a JSON-RPC error — just not a crashed 500 with no body
    expect([400, 200]).toContain(res.status);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('stateless mode: initialize can be called on every request (regression for "already initialized" bug)', async () => {
    // Stateless transport (sessionIdGenerator: undefined) means each request is self-contained.
    // initialize can be called over and over without failing.
    const makeInit = () => new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });

    const r1 = await app.fetch(makeInit());
    const r2 = await app.fetch(makeInit());
    const r3 = await app.fetch(makeInit());

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    // Stateless: no mcp-session-id header issued
    expect(r1.headers.get('mcp-session-id')).toBeNull();
  });

  it('stateless mode: tools/list works without needing a session ID', async () => {
    // In stateless mode, subsequent calls don't need session IDs
    const listReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const res = await app.fetch(listReq);
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.result?.tools).toBeDefined();
    expect(body.result.tools.length).toBe(9);
  });
});

describe('REST API health + auth', () => {
  let deps: ServiceDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = mockDeps();
    app = createApp(deps);
  });

  it('health endpoint returns service info without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: 'open-brain', version: '2.0.0' });
  });

  it('rejects API calls without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/projects'));
    expect(res.status).toBe(401);
  });

  it('accepts API calls with correct API key', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({ rows: [] } as any);
    const res = await app.fetch(new Request('http://localhost/api/v1/projects', {
      headers: { 'Authorization': 'Bearer test-key' },
    }));
    expect(res.status).toBe(200);
  });

  it('accepts API calls with key as query param', async () => {
    vi.mocked(deps.db.query).mockResolvedValueOnce({ rows: [] } as any);
    const res = await app.fetch(new Request('http://localhost/api/v1/projects?key=test-key'));
    expect(res.status).toBe(200);
  });
});
