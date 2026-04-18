import { describe, it, expect, vi } from 'vitest';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { ServiceDeps } from '../../../src/services/index.js';

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
    ragLLM: {
      complete: vi.fn().mockResolvedValue({
        content: 'answer',
        tokensUsed: { input: 0, output: 0, total: 0 },
      }),
    },
    blobStorage: {
      upload: vi.fn().mockResolvedValue('https://blob/url'),
      exists: vi.fn().mockResolvedValue(false),
      getUrl: vi.fn().mockReturnValue('https://blob/url'),
    },
    config: { apiKey: 'test' } as any,
  };
}

async function callMcp(
  deps: ServiceDeps,
  body: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => 'test-session',
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });

  const res = await transport.handleRequest(req);
  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: text ? JSON.parse(text) : null,
  };
}

describe('MCP server', () => {
  it('responds to initialize with protocol version and server info', async () => {
    const deps = mockDeps();
    const result = await callMcp(deps, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });

    expect(result.status).toBe(200);
    expect(result.body.result.serverInfo.name).toBe('open-brain');
    expect(result.body.result.serverInfo.version).toBe('2.0.0');
    expect(result.body.result.instructions).toContain('Personal Knowledge Base');
    expect(result.body.result.capabilities.tools).toBeDefined();
  });

  it('lists all 7 tools on tools/list', async () => {
    const deps = mockDeps();

    // MCP requires initialize before other calls; use stateful session flow
    const server = createMcpServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => 'test-session',
      enableJsonResponse: true,
    });
    await server.connect(transport);

    // Step 1: initialize (grab session id from headers)
    const initReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    const initRes = await transport.handleRequest(initReq);
    const sessionId = initRes.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();

    // Step 2: list tools
    const listReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listRes = await transport.handleRequest(listReq);
    expect(listRes.status).toBe(200);
    const listBody = JSON.parse(await listRes.text());
    const toolNames = listBody.result.tools.map((t: any) => t.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'list_projects',
      'create_project',
      'list',
      'get',
      'create',
      'search',
      'save_from_url',
    ]));
    expect(toolNames).toHaveLength(7);
  });

  it('calls create_project and returns the created project', async () => {
    const deps = mockDeps();
    vi.mocked(deps.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO projects')) {
        return {
          rows: [{
            id: 'proj-1', name: 'Test', description: null,
            status: 'active', created_at: new Date(), updated_at: new Date(),
          }],
        } as any;
      }
      return { rows: [] } as any;
    });

    const server = createMcpServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => 'test-session',
      enableJsonResponse: true,
    });
    await server.connect(transport);

    const initReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    const initRes = await transport.handleRequest(initReq);
    const sessionId = initRes.headers.get('mcp-session-id')!;

    const callReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'create_project', arguments: { name: 'Test' } },
      }),
    });
    const callRes = await transport.handleRequest(callReq);
    expect(callRes.status).toBe(200);
    const callBody = JSON.parse(await callRes.text());
    const text = callBody.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.id).toBe('proj-1');
    expect(parsed.name).toBe('Test');
  });
});
