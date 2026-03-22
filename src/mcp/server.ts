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

ON SESSION START: Call brain_help to learn how to use this system effectively. Call get_user_profile to understand who the user is.

PROACTIVE BEHAVIOR:
- After completing a task, making a decision, or noticing a user preference/pattern, capture it via capture_thought in third person (e.g. "Pedro prefers TypeScript for new projects").
- When the user mentions a commitment, deadline, or action item, suggest creating a reminder (but never add without consent).

TAG SYSTEM:
Every capture, fact, and insight is classified with semantic tags. 14 allowed tags:
preference, decision, problem-solution, pattern, goal, opinion, skill, relationship, resource, idea, interest, health, dislike, milestone

When calling capture_thought, provide tags if you are confident about the type:
- capture_thought({ content: "Pedro avoids YAML configs", tags: ["dislike"] })
- capture_thought({ content: "Fixed Telegram retry loop by responding 200 immediately", tags: ["problem-solution"] })
- If unsure, omit tags — the pipeline auto-classifies.
- Multiple tags are fine: tags: ["decision", "health"]

SEARCHING WITH TAGS:
Combine a semantic query with a tag filter for precise retrieval:
- search_thoughts("coding preferences", { tags: ["preference"] })
- search_thoughts("health issues", { tags: ["health"] })
- Tags use AND semantics — all provided tags must match.

NEVER capture purely operational exchanges. Capture preferences, decisions, skills, goals, patterns, opinions, and milestones.`,
    },
  );

  registerProfilerTools(server, deps);
  registerReminderTools(server, deps);

  return server;
}

export function mountMcpRoutes(app: Hono, deps: AppDeps): void {
  // MCP auth: x-brain-key header or ?key= query parameter
  app.all('/mcp/*', async (c, next) => {
    const key = c.req.header('x-brain-key') ?? c.req.query('key');
    if (!key || key !== deps.config.apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Streamable HTTP transport endpoint — new server per request (stateless)
  app.all('/mcp', async (c) => {
    const server = createMcpServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
