// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { registerProfilerTools } from './profiler-tools.js';
import { registerReminderTools } from './reminder-tools.js';

export function createMcpServer(deps: AppDeps): McpServer {
  const server = new McpServer(
    {
      name: 'open-brain',
      version: '2.0.0',
    },
    {
      instructions: `You are connected to Open Brain — a personal knowledge system that builds a living profile of the user.

ON SESSION START: Call brain_help to learn how to use this system effectively.

PROACTIVE BEHAVIOR:
- After completing a task, making a decision, or noticing a user preference/pattern, capture it via capture_thought in third person (e.g. "[preference] Pedro prefers TypeScript for new projects").
- When the user mentions a commitment, deadline, or action item, suggest creating a reminder (but never add without consent).
- Call get_user_profile at session start to understand who the user is.

NEVER capture purely operational exchanges. Focus on preferences, decisions, skills, goals, habits, and patterns.`,
    },
  );

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
