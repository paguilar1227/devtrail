import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServiceDeps } from '../services/index.js';
import * as projectsSvc from '../services/projects.js';
import * as contentSvc from '../services/content-items.js';
import * as todosSvc from '../services/todos.js';
import * as searchSvc from '../services/search.js';

const INSTRUCTIONS = `You are connected to Open Brain — a project-scoped personal knowledge base and productivity tool.

The user organizes content into **projects** that contain documents, notes, and todos. Documents and notes can belong to multiple projects; todos belong to at most one project.

When the user asks you to find something, use \`search\` to do semantic retrieval. You can scope to a specific project, filter by entity types, or search globally.

When the user wants to save something mid-conversation ("save this to my Open Brain" / "add a todo for this" / "store this audio in my project"), use \`create\`:
- Type 'document' for external reference material (PDFs, articles)
- Type 'note' for structured self-authored content
- Type 'quick_note' for fast thoughts and captures
- Type 'todo' for actionable items

Projects are top-level. Use \`create_project\` to make one and \`list_projects\` to see what exists.

The user's ID system uses UUIDs — use \`get(id)\` to fetch any entity's full content by its UUID.`;

export function createMcpServer(deps: ServiceDeps): McpServer {
  const server = new McpServer(
    { name: 'open-brain', version: '2.0.0' },
    { instructions: INSTRUCTIONS },
  );

  // ---------- 1. list_projects ----------
  server.tool(
    'list_projects',
    'List all projects in Open Brain.',
    {
      status: z.enum(['active', 'archived', 'completed']).optional()
        .describe('Filter by status. Defaults to showing all.'),
    },
    async ({ status }) => {
      const projects = await projectsSvc.listProjects(deps, status);
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
    },
  );

  // ---------- 2. create_project ----------
  server.tool(
    'create_project',
    'Create a new project.',
    {
      name: z.string().describe('Project name'),
      description: z.string().optional().describe('Optional description'),
    },
    async ({ name, description }) => {
      const project = await projectsSvc.createProject(deps, name, description ?? null);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  // ---------- 3. list (unified) ----------
  server.tool(
    'list',
    'List content items (documents, notes) or todos, with optional filters.',
    {
      entity_type: z.enum(['document', 'note', 'todo']).describe('Which entity type to list'),
      project_id: z.string().optional().describe('Scope to a specific project'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND semantics)'),
      status: z.enum(['not_started', 'in_progress', 'paused', 'done']).optional()
        .describe('Filter by status (todos only)'),
      limit: z.number().int().positive().default(50),
    },
    async ({ entity_type, project_id, tags, status, limit }) => {
      let data: unknown;
      if (entity_type === 'todo') {
        data = await todosSvc.listTodos(deps, {
          project_id: project_id ?? undefined,
          status,
          tags,
          limit,
        });
      } else {
        data = await contentSvc.listContentItems(deps, {
          type: entity_type,
          project_id,
          tags,
          limit,
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ---------- 4. get ----------
  server.tool(
    'get',
    'Fetch any entity by its UUID. Auto-detects whether it is a content item or todo.',
    { id: z.string().describe('Entity UUID') },
    async ({ id }) => {
      // Try content item first, then todo
      const ci = await contentSvc.getContentItem(deps, id);
      if (ci) return { content: [{ type: 'text', text: JSON.stringify(ci, null, 2) }] };
      const td = await todosSvc.getTodo(deps, id);
      if (td) return { content: [{ type: 'text', text: JSON.stringify(td, null, 2) }] };
      const pr = await projectsSvc.getProject(deps, id);
      if (pr) return { content: [{ type: 'text', text: JSON.stringify(pr, null, 2) }] };
      return { content: [{ type: 'text', text: `No entity found with id ${id}` }] };
    },
  );

  // ---------- 5. create (typed union via enum + optional fields) ----------
  server.tool(
    'create',
    `Create a new entity. Pick a type and supply the relevant fields.

- type="document" or "note": creates chunked content. Requires 'content'. Optional 'title' (auto-generated if missing), 'project_ids' (multi), 'tags'.
- type="quick_note": creates a lightweight captured thought. Stored as a note with AI-generated title. Requires 'content'.
- type="todo": creates an actionable item. Requires 'content'. Optional 'project_id' (single), 'priority' (P1/P2/P3), 'due_date' (ISO 8601), 'tags'.`,
    {
      type: z.enum(['document', 'note', 'quick_note', 'todo']),
      content: z.string().describe('Content text. For todos: the task description.'),
      title: z.string().optional().describe('Optional title. Only for document/note types. Auto-generated if omitted.'),
      project_id: z.string().optional().describe('For todos only: single project this belongs to.'),
      project_ids: z.array(z.string()).optional().describe('For document/note/quick_note: multi-project membership.'),
      tags: z.array(z.string()).optional(),
      priority: z.enum(['P1', 'P2', 'P3']).optional().describe('For todos only.'),
      due_date: z.string().optional().describe('For todos only. ISO 8601 timestamp.'),
    },
    async (input) => {
      const { type } = input;
      if (type === 'todo') {
        const result = await todosSvc.createTodo(deps, {
          content: input.content,
          projectId: input.project_id ?? null,
          priority: input.priority,
          dueDate: input.due_date ? new Date(input.due_date) : null,
          tags: input.tags,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ id: result.id, type: 'todo' }, null, 2) }] };
      }

      // document, note, quick_note all flow through content-items
      // quick_note → 'note' under the hood
      const mappedType = type === 'quick_note' ? 'note' : type;
      const result = await contentSvc.createContentItem(deps, {
        type: mappedType,
        content: input.content,
        title: input.title,
        projectIds: input.project_ids,
        tags: input.tags,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, type: mappedType }, null, 2) }] };
    },
  );

  // ---------- 6. search ----------
  server.tool(
    'search',
    'Semantic search across content items and todos. Returns ranked matches with scores.',
    {
      query: z.string().describe('Natural language search query'),
      project_id: z.string().optional().describe('Scope search to a specific project'),
      entity_types: z.array(z.enum(['document', 'note', 'todo'])).optional()
        .describe('Filter to specific entity types. Defaults to all.'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND)'),
      limit: z.number().int().positive().default(10),
    },
    async ({ query, project_id, entity_types, tags, limit }) => {
      const hits = await searchSvc.search(deps, query, {
        projectId: project_id,
        entityTypes: entity_types,
        tags,
        limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
    },
  );

  return server;
}
