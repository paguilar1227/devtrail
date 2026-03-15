// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { registerProfilerTools } from './profiler-tools.js';
import { registerReminderTools } from './reminder-tools.js';

export function createMcpServer(deps: AppDeps): McpServer {
  const server = new McpServer({
    name: 'open-brain',
    version: '2.0.0',
  });

  registerProfilerTools(server, deps);
  registerReminderTools(server, deps);

  return server;
}

export function mountMcpRoutes(app: Hono, deps: AppDeps): void {
  const server = createMcpServer(deps);

  // MCP auth: x-brain-key header or ?key= query parameter
  app.all('/mcp/*', async (c, next) => {
    const key = c.req.header('x-brain-key') ?? c.req.query('key');
    if (!key || key !== deps.config.apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Streamable HTTP transport endpoint
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
