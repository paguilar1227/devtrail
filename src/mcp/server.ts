import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServiceDeps } from '../services/index.js';
import * as projectsSvc from '../services/projects.js';
import * as contentSvc from '../services/content-items.js';
import * as todosSvc from '../services/todos.js';
import * as commentsSvc from '../services/todo-comments.js';
import * as searchSvc from '../services/search.js';
import * as ragSvc from '../services/rag.js';
import * as tagsSvc from '../services/tags.js';
import * as activitySvc from '../services/activity.js';
import * as urlIngestSvc from '../services/url-ingest.js';

const TODO_STATUSES = ['not_started', 'in_progress', 'paused', 'done'] as const;
const PROJECT_STATUSES = ['active', 'archived', 'completed'] as const;

const INSTRUCTIONS = `# Open Brain — Personal Knowledge Base + Productivity Tool

Open Brain is a single-user personal knowledge system. Think NotebookLM crossed with a task manager. The user organizes knowledge into **projects**, each containing documents, notes, and todos. Semantic search spans everything.

Use these tools actively. The user expects you to save conversation artifacts on their request, surface relevant prior knowledge before making things up, and turn intents into todos.

## Entity model

- **Project** — top-level container. Has name, description, status (active/archived/completed). Most content belongs to 1+ projects.
- **Document** — uploaded reference material (PDFs, images, audio, video, long-form text someone else wrote). Chunked for search.
- **Note** — content the user authored themselves. Can be long-form. Chunked for search.
- **Quick note** — a fast-captured thought. Stored as a note with an AI-generated title. Use this for mid-conversation saves when the user says "jot down…" / "save this idea…".
- **Todo** — actionable item with status, priority (P1/P2/P3), optional due_date, optional parent for subtasks.

## Project membership (asymmetric — important)

- Documents, notes, quick_notes use **\`project_ids\`** (array) — can belong to multiple projects or zero (empty array = personal/global scope).
- Todos use **\`project_id\`** (single string) — belongs to one project or \`null\` (personal Inbox).
- Content with no project membership is "personal" and lives in the Inbox.

## Tags

Flat labels for filtering (e.g. \`reference\`, \`meeting-notes\`, \`reading\`). Optional on all entities. Use lowercase kebab-case.

## When to use which tool

**Retrieval (always try this first when the user asks a question):**
- Any "what did I save / read / note about X" → \`search(query)\`
- In a project context → \`search(query, project_id)\`
- Restrict to one entity type → \`search(query, entity_types: ['document'])\`
- Filter by tag → \`search(query, tags: ['urgent'])\`

**Creation (when the user explicitly wants to save):**
- "Save this idea…" / "remember this…" → \`create(type: 'quick_note', content: …)\`
- "Save this article / meeting notes / writeup…" → \`create(type: 'note' or 'document', content, title?, project_ids?)\`
- "Add a todo / remind me / I need to…" → \`create(type: 'todo', content, project_id?, priority?, due_date?)\`
- "Save this URL / this YouTube video / this article link / this tweet thread…" → \`save_from_url(url, project_ids?, tags?)\` — backend fetches content, preserves URL as source. Prefer this over \`create\` for URL content; avoids approval-size issues on large pages.

**Browse and lookup:**
- "What projects do I have?" → \`list_projects\`
- "Show me todos in project X" → \`list(entity_type: 'todo', project_id: X)\`
- "List my documents" → \`list(entity_type: 'document')\`
- You have a UUID from a previous result → \`get(id)\` (auto-detects project / content / todo)

## Project resolution

If the user mentions a project by name ("save this to my 'Learning Rust' project"):
1. Call \`list_projects()\` to find the ID by matching the name.
2. If no match, offer to create it with \`create_project\` — confirm with the user first.
3. Then use that project_id in your create / search call.

Don't invent project UUIDs. Always get them from \`list_projects\` or a prior search result.

## Concrete examples

**User:** "Save this conversation about Rust async to my Learning Rust project."
→ \`list_projects()\` to find "Learning Rust" ID
→ \`create(type: 'note', title: 'Rust async patterns', content: <summary>, project_ids: [<that ID>])\`

**User:** "Remind me to email John tomorrow."
→ \`create(type: 'todo', content: 'Email John', due_date: '<tomorrow ISO>', priority: 'P2')\`
→ Confirm: "Added to your todos with P2 priority, due tomorrow."

**User:** "What did I save about pgvector?"
→ \`search(query: 'pgvector', limit: 5)\`
→ Summarize the top hits, cite them by title.

**User (in Learning Rust context):** "What have I read about async?"
→ \`search(query: 'async programming', project_id: <Learning Rust ID>)\`

**User:** "Jot down that I hated the last meeting."
→ \`create(type: 'quick_note', content: 'Hated the last meeting')\` — no project, personal scope.

**User:** "Save this YouTube video to my Learning Rust project: https://www.youtube.com/watch?v=..."
→ \`list_projects()\` to find "Learning Rust" ID
→ \`save_from_url(url: 'https://...', project_ids: ['<that ID>'])\`
→ Confirm: "Saved — transcript captured, source URL preserved."

**User:** "Grab this tweet thread: https://x.com/jason/status/..."
→ \`save_from_url(url: 'https://x.com/...')\` — no project, personal scope. Thread fetched via xAI's x_search tool.

## Proactive behavior

- When the user generates something worth keeping ("this is great" / "this is the plan"), offer to save it.
- Before answering from training data, check Open Brain with \`search\` — the user's own notes are authoritative for questions about their work, preferences, decisions.
- Scope to the current project when the conversation is project-specific.
- After creating anything, confirm back with a short summary ("Saved to Learning Rust as 'Rust async patterns'.").

## Anti-patterns

- **Never fabricate UUIDs.** Only \`get(id)\` IDs you got from \`list_projects\`, \`list\`, or \`search\`.
- **Don't create duplicate projects.** Always \`list_projects\` first; match by name.
- **Don't auto-save trivial chatter.** Save only when the user asks or when the artifact clearly has durable value (and they confirm).
- **Don't mix membership models.** \`project_ids\` (array) is for documents/notes/quick_notes. \`project_id\` (string) is for todos. Using the wrong one breaks the call.

## Known limitations

- **Limited write surface via MCP.** Use \`update\` for metadata edits — todo status (mark done) / priority / due date / parent / tags / project, content item title / project_ids / tags, and project name / description / status. Use \`archive\` / \`restore\` for soft delete + undo. Use \`retry\` to re-run a failed ingest. Use \`add_comment\` / \`list_comments\` / \`update_comment\` for todo discussion threads.
- **Body edits are not yet supported.** You can rename and re-tag a note or document through \`update\`, but you cannot rewrite its body text — the existing chunks would go stale. A \`reprocess\` tool that re-chunks and re-embeds is coming.
- **No hard delete via MCP.** Hard deletion is UI-only by design. Use \`archive\` for soft delete (it's reversible via \`restore\`).
- **Documents are body-immutable.** Once a document's text is extracted, the body itself is never re-derived. Title, project membership, and tags can change; the body cannot.
- **URL ingestion — currently supported:** YouTube videos (transcripts), X/Twitter threads (via xAI x_search), PDFs, HTML articles (incl. Reddit, blogs, Substack), direct image/audio links.
- **URL ingestion — not yet supported:** Notion docs, Google Docs, Medium paywalls, Vimeo/Twitch — these need per-site auth or dedicated handlers.`;

export function createMcpServer(deps: ServiceDeps): McpServer {
  const server = new McpServer(
    { name: 'open-brain', version: '2.0.0' },
    { instructions: INSTRUCTIONS },
  );

  // ---------- 1. list_projects ----------
  server.tool(
    'list_projects',
    'List all projects. Returns an array of {id, name, description, status, timestamps}. Call this first whenever the user mentions a project by name — you need the UUID to scope further operations. Match project names case-insensitively.',
    {
      status: z.enum(['active', 'archived', 'completed']).optional()
        .describe('Filter by status. Omit to see all.'),
    },
    async ({ status }) => {
      const projects = await projectsSvc.listProjects(deps, status);
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
    },
  );

  // ---------- 2. create_project ----------
  server.tool(
    'create_project',
    'Create a new project. Only use this after confirming via list_projects that no suitable project exists. Returns the full project record including its id, which you should use for subsequent create/search calls.',
    {
      name: z.string().describe('Short, descriptive project name (e.g., "Learning Rust", "Home Renovation")'),
      description: z.string().optional().describe('Optional longer description of what this project is for'),
    },
    async ({ name, description }) => {
      const project = await projectsSvc.createProject(deps, name, description ?? null);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  // ---------- 3. list (unified) ----------
  server.tool(
    'list',
    'Browse/filter entities by type and optional filters. Use when the user wants a structured view ("show me all my todos in project X" / "list my documents"). For freeform "what did I save about Y" use `search` instead — it does semantic retrieval across content. list is exact-filter-based; search is meaning-based.',
    {
      entity_type: z.enum(['document', 'note', 'todo']).describe('Which entity type to list'),
      project_id: z.string().optional().describe('Scope to a specific project UUID'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND — item must have all listed tags)'),
      status: z.enum(['not_started', 'in_progress', 'paused', 'done']).optional()
        .describe('Todo status filter (ignored for document/note)'),
      limit: z.number().int().positive().default(50).describe('Max items to return'),
    },
    async ({ entity_type, project_id, tags, status, limit }) => {
      let rows: Array<Record<string, unknown>>;
      if (entity_type === 'todo') {
        rows = await todosSvc.listTodos(deps, {
          project_id: project_id ?? undefined,
          status,
          tags,
          limit,
        }) as unknown as Array<Record<string, unknown>>;
      } else {
        rows = await contentSvc.listContentItems(deps, {
          type: entity_type,
          project_id,
          tags,
          limit,
        }) as unknown as Array<Record<string, unknown>>;
      }
      // Strip embeddings (3072-dim vectors) and truncate content bodies.
      // Pre-strip, a list of ~10 PDF documents with whole-item embeddings plus
      // 500KB+ of content each produced JSON large enough to time out.
      // Callers that need the full content should follow up with `get(id)`.
      const stripped = rows.map((row) => {
        const { embedding: _embedding, ...rest } = row;
        if (typeof rest.content === 'string' && rest.content.length > 500) {
          rest.content = `${rest.content.slice(0, 500)}… [truncated — use get(id) for full content]`;
        }
        return rest;
      });
      return { content: [{ type: 'text', text: JSON.stringify(stripped, null, 2) }] };
    },
  );

  // ---------- 4. get ----------
  server.tool(
    'get',
    'Fetch the full record of any entity (project, document, note, or todo) by UUID. Auto-detects the type. Use when you have an ID from a prior list/search and need the full content (e.g., to read a long note or to see all fields on a todo). Returns the raw entity record.',
    { id: z.string().describe('UUID from a previous list/search result — do not invent IDs') },
    async ({ id }) => {
      if (!isValidUuid(id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${id}". Expected a UUID like "550e8400-e29b-41d4-a716-446655440000".` }],
          isError: true,
        };
      }
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

  // ---------- 5. create ----------
  server.tool(
    'create',
    `Create a new entity. Pick a type and supply the relevant fields.

REQUIRED PER TYPE:
- document: content (the extracted text, reference material from outside sources). Optional: title (auto-generated from content if omitted), project_ids, tags.
- note: content (self-authored text, potentially long). Optional: title, project_ids, tags. The user wrote this themselves.
- quick_note: content (a short captured thought). AI auto-generates the title. Optional: project_ids, tags. Use for mid-conversation "jot this down" saves.
- todo: content (the task description, e.g., "Email John"). Optional: project_id (SINGLE, not array), priority (P1/P2/P3), due_date (ISO 8601), tags, parent_id (UUID of an existing todo to make this a subtask), section (free-text label for grouping inside a project, e.g., "Inbox", "Backlog").

NOTES ON MEMBERSHIP:
- document/note/quick_note use project_ids (ARRAY). Empty/omitted = personal/global scope.
- todo uses project_id (SINGLE string). Omitted = personal Inbox.
- Mixing these up will cause the call to fail. Double-check before submitting.

Returns the created entity's id. For documents/notes, also returns chunkCount (how many chunks were generated).`,
    {
      type: z.enum(['document', 'note', 'quick_note', 'todo'])
        .describe('Entity type. Determines which fields are used.'),
      content: z.string()
        .describe('The primary text. For todos: task description. For documents/notes/quick_notes: the body to save.'),
      title: z.string().optional()
        .describe('Optional. Used by document/note only. Auto-generated by an LLM if omitted.'),
      project_id: z.string().optional()
        .describe('TODO ONLY. Single project UUID this todo belongs to. Use null/omit for personal Inbox todos.'),
      project_ids: z.array(z.string()).optional()
        .describe('DOCUMENT/NOTE/QUICK_NOTE ONLY. Array of project UUIDs. Item can belong to multiple projects, or none (personal/global).'),
      tags: z.array(z.string()).optional()
        .describe('Flat organizational labels. Lowercase kebab-case conventional (e.g., "reference", "meeting-notes").'),
      priority: z.enum(['P1', 'P2', 'P3']).optional()
        .describe('TODO ONLY. P1 = urgent, P2 = normal, P3 = low. Omit for unprioritized.'),
      due_date: z.string().optional()
        .describe('TODO ONLY. ISO 8601 timestamp (e.g., "2026-04-20T17:00:00Z").'),
      parent_id: z.string().optional()
        .describe('TODO ONLY. UUID of an existing todo. Set this to make the new todo a subtask of that one. Omit for top-level todos.'),
      section: z.string().optional()
        .describe('TODO ONLY. Free-text section label for grouping todos inside a project (e.g., "Inbox", "Backlog", "Doing"). Omit for unsectioned.'),
    },
    async (input) => {
      const { type } = input;
      if (type === 'todo') {
        const result = await todosSvc.createTodo(deps, {
          content: input.content,
          projectId: input.project_id ?? null,
          parentId: input.parent_id ?? null,
          section: input.section ?? null,
          priority: input.priority,
          dueDate: input.due_date ? new Date(input.due_date) : null,
          tags: input.tags,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ id: result.id, type: 'todo' }, null, 2) }] };
      }

      // document, note, quick_note all flow through content-items
      // quick_note → 'note' under the hood
      const mappedType = type === 'quick_note' ? 'note' : type;
      const started = await contentSvc.createContentItem(deps, {
        type: mappedType,
        content: input.content,
        title: input.title,
        projectIds: input.project_ids,
        tags: input.tags,
      });
      // MCP contract is sync: await the pipeline so callers get the final
      // chunk count and real title, not the placeholder.
      const finished = await started.completion;
      if (finished.status === 'failed') {
        const msg = finished.error || 'Unknown ingest failure';
        return {
          content: [{ type: 'text', text: `Error: ${msg}` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: started.id,
            title: finished.title,
            chunkCount: finished.chunkCount,
            warnings: finished.warnings,
            type: mappedType,
          }, null, 2),
        }],
      };
    },
  );

  // ---------- 5b. update ----------
  server.tool(
    'update',
    `Update an existing entity. Pick a kind and supply only the fields you want to change — omitted fields stay as-is.

REQUIRED:
- kind: 'todo' | 'content' | 'project'
- id: UUID from a prior get/list/search

FIELDS PER KIND:
- todo: status (not_started | in_progress | paused | done), priority (P1 | P2 | P3 | null to clear), due_date (ISO 8601 or null), content (rename the task), parent_id (UUID or null to detach), section (string or null), tags, project_id (single UUID or null)
- content: title, project_ids (array of UUIDs — replaces existing membership), tags
- project: name, description, status (active | archived | completed)

NOT SUPPORTED via this tool:
- Body edits on notes/documents — coming via the \`reprocess\` tool (re-chunks + re-embeds). Title and metadata are fine here; the body itself is not.
- Hard delete — UI only. Use \`archive\` for soft delete.
- Changing a content item's type (document ↔ note) — create a new one if you really want this.

Returns the updated record.`,
    {
      kind: z.enum(['todo', 'content', 'project'])
        .describe('Which kind of entity. Determines which fields are valid.'),
      id: z.string().describe('UUID of the entity. Must match the kind.'),

      // todo fields
      content: z.string().optional()
        .describe('TODO ONLY. New task description.'),
      status: z.enum([...TODO_STATUSES, ...PROJECT_STATUSES]).optional()
        .describe('TODO uses not_started/in_progress/paused/done. PROJECT uses active/archived/completed. Mismatched values return an error.'),
      priority: z.enum(['P1', 'P2', 'P3']).nullable().optional()
        .describe('TODO ONLY. P1 = urgent, P2 = normal, P3 = low. null clears the priority.'),
      due_date: z.string().nullable().optional()
        .describe('TODO ONLY. ISO 8601 timestamp. null clears the due date.'),
      parent_id: z.string().nullable().optional()
        .describe('TODO ONLY. UUID of parent todo, or null to detach into a top-level todo.'),
      section: z.string().nullable().optional()
        .describe('TODO ONLY. Free-text section label, or null to clear.'),
      project_id: z.string().nullable().optional()
        .describe('TODO ONLY (single UUID). Move to a different project, or null for personal Inbox.'),
      tags: z.array(z.string()).optional()
        .describe('TODO and CONTENT. Replaces the existing tag list (does not merge).'),

      // content fields
      title: z.string().optional()
        .describe('CONTENT ONLY. Rename the document/note. (Use `name` for projects.)'),
      project_ids: z.array(z.string()).optional()
        .describe('CONTENT ONLY (array of UUIDs). Replaces the existing project membership.'),

      // project fields
      name: z.string().optional()
        .describe('PROJECT ONLY. Rename the project.'),
      description: z.string().nullable().optional()
        .describe('PROJECT ONLY. New description, or null to clear.'),
    },
    async (input) => {
      if (!isValidUuid(input.id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${input.id}".` }],
          isError: true,
        };
      }

      // Per-kind status enum validation. The unified zod enum accepts both
      // todo and project status values; here we reject the cross-kind ones.
      if (input.status) {
        if (input.kind === 'todo' && !TODO_STATUSES.includes(input.status as typeof TODO_STATUSES[number])) {
          return {
            content: [{ type: 'text', text: `Invalid todo status "${input.status}". Use one of: ${TODO_STATUSES.join(', ')}.` }],
            isError: true,
          };
        }
        if (input.kind === 'project' && !PROJECT_STATUSES.includes(input.status as typeof PROJECT_STATUSES[number])) {
          return {
            content: [{ type: 'text', text: `Invalid project status "${input.status}". Use one of: ${PROJECT_STATUSES.join(', ')}.` }],
            isError: true,
          };
        }
        if (input.kind === 'content') {
          return {
            content: [{ type: 'text', text: `\`status\` is not a content field. Use kind='todo' or kind='project'.` }],
            isError: true,
          };
        }
      }

      if (input.kind === 'todo') {
        const updated = await todosSvc.updateTodo(deps, input.id, {
          content: input.content,
          projectId: input.project_id,
          section: input.section,
          parentId: input.parent_id,
          status: input.status,
          priority: input.priority,
          dueDate: input.due_date === null ? null : (input.due_date ? new Date(input.due_date) : undefined),
          tags: input.tags,
        });
        if (!updated) {
          return { content: [{ type: 'text', text: `No todo found with id ${input.id}` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
      }

      if (input.kind === 'content') {
        // Body edits intentionally not supported here — see #74 reprocess for
        // the re-chunk path. We accept title/project_ids/tags only.
        const updated = await contentSvc.updateContentItem(deps, input.id, {
          title: input.title,
          projectIds: input.project_ids,
          tags: input.tags,
        });
        if (!updated) {
          return { content: [{ type: 'text', text: `No content item found with id ${input.id}` }], isError: true };
        }
        // Strip the embedding for protocol size — clients don't need 3072 floats.
        const { embedding: _embedding, ...rest } = updated;
        return { content: [{ type: 'text', text: JSON.stringify(rest, null, 2) }] };
      }

      // project
      const updated = await projectsSvc.updateProject(deps, input.id, {
        name: input.name,
        description: input.description,
        status: input.status,
      });
      if (!updated) {
        return { content: [{ type: 'text', text: `No project found with id ${input.id}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  );

  // ---------- 5c. add_comment ----------
  server.tool(
    'add_comment',
    `Append a comment to a todo. Use when the user asks you to leave a note on a task ("note on this todo that I'm waiting on Sarah" / "add a comment that we tried approach X and it didn't work") and when leaving an AI-driven triage trail (after running search/analysis on a todo, summarize what you found here so the next session has it).

Comments accumulate; they aren't merged. Returns { id, todo_id }.`,
    {
      todo_id: z.string().describe('UUID of the todo to comment on. Must exist.'),
      content: z.string().min(1).describe('The comment text. Markdown allowed; rendered by the UI.'),
    },
    async ({ todo_id, content }) => {
      if (!isValidUuid(todo_id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${todo_id}".` }],
          isError: true,
        };
      }
      const result = await commentsSvc.createComment(deps, todo_id, content);
      return {
        content: [{ type: 'text', text: JSON.stringify({ id: result.id, todo_id }, null, 2) }],
      };
    },
  );

  // ---------- 5d. list_comments ----------
  server.tool(
    'list_comments',
    `List all comments on a todo, oldest first. Use this BEFORE leaving a new comment so you don't repeat what's already been said, and BEFORE answering "what's the status of X" type questions about a tracked task — comments often hold the latest context that isn't on the todo body itself.`,
    {
      todo_id: z.string().describe('UUID of the todo whose comments you want.'),
    },
    async ({ todo_id }) => {
      if (!isValidUuid(todo_id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${todo_id}".` }],
          isError: true,
        };
      }
      const comments = await commentsSvc.listComments(deps, todo_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(comments, null, 2) }],
      };
    },
  );

  // ---------- 5e. update_comment ----------
  server.tool(
    'update_comment',
    `Edit an existing comment by id. Use sparingly — only when the user explicitly asks to fix a comment they (or you) just wrote. For corrections to an old thread, prefer add_comment with a clarifying note rather than rewriting history.

No delete via MCP — comment removal is UI-only by design.`,
    {
      comment_id: z.string().describe('UUID of the comment to edit. Must come from a prior list_comments result.'),
      content: z.string().min(1).describe('The new comment text. Replaces the existing content entirely.'),
    },
    async ({ comment_id, content }) => {
      if (!isValidUuid(comment_id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${comment_id}".` }],
          isError: true,
        };
      }
      // Service-level updateComment returns void; verify the row exists by
      // reading it back so callers get a real error on unknown ids instead
      // of a silent no-op (the underlying UPDATE would just affect 0 rows).
      const existing = await commentsSvc.getComment(deps, comment_id);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `No comment found with id ${comment_id}` }],
          isError: true,
        };
      }
      await commentsSvc.updateComment(deps, comment_id, content);
      return {
        content: [{ type: 'text', text: JSON.stringify({ id: comment_id, ok: true }, null, 2) }],
      };
    },
  );

  // ---------- 5f. archive ----------
  server.tool(
    'archive',
    `Soft-delete a content item, todo, or project by id. Auto-detects the entity kind via the same lookup probe as \`get\` (content → todo → project). The row is kept (so \`restore\` can undo it); list/search filter it out by default.

Use when the user says "scrap that note", "drop that todo", "archive the X project". For permanent removal, point them at the web UI — hard delete is intentionally not exposed via MCP.

Returns { id, kind, archived: true, already: boolean } where \`already\` is true if the row was already archived (the call was a no-op).`,
    {
      id: z.string().describe('UUID of the entity to archive. Must come from a prior list/search/get result.'),
    },
    async ({ id }) => {
      if (!isValidUuid(id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${id}".` }],
          isError: true,
        };
      }
      const ci = await contentSvc.getContentItem(deps, id);
      if (ci) {
        const already = ci.archived === true;
        if (!already) await contentSvc.archiveContentItemById(deps, id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, kind: 'content', archived: true, already }, null, 2) }],
        };
      }
      const td = await todosSvc.getTodo(deps, id);
      if (td) {
        const already = (td as { archived?: boolean }).archived === true;
        if (!already) await todosSvc.archiveTodoById(deps, id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, kind: 'todo', archived: true, already }, null, 2) }],
        };
      }
      const pr = await projectsSvc.getProject(deps, id);
      if (pr) {
        const already = (pr as { status?: string }).status === 'archived';
        if (!already) await projectsSvc.archiveProject(deps, id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, kind: 'project', archived: true, already }, null, 2) }],
        };
      }
      return {
        content: [{ type: 'text', text: `No entity found with id ${id}` }],
        isError: true,
      };
    },
  );

  // ---------- 5g. restore ----------
  server.tool(
    'restore',
    `Undo a previous \`archive\` — un-archive a content item, todo, or project by id. Auto-detects kind. Idempotent: restoring an already-active row is a no-op.

Returns { id, kind, archived: false, already: boolean } where \`already\` is true if the row was already active (no change made).`,
    {
      id: z.string().describe('UUID of the entity to restore. Must come from a prior list/search/get result (including archived items).'),
    },
    async ({ id }) => {
      if (!isValidUuid(id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${id}".` }],
          isError: true,
        };
      }
      const ci = await contentSvc.getContentItem(deps, id);
      if (ci) {
        const already = ci.archived === false;
        if (!already) await contentSvc.unarchiveContentItemById(deps, id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, kind: 'content', archived: false, already }, null, 2) }],
        };
      }
      const td = await todosSvc.getTodo(deps, id);
      if (td) {
        const already = (td as { archived?: boolean }).archived === false;
        if (!already) await todosSvc.unarchiveTodoById(deps, id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, kind: 'todo', archived: false, already }, null, 2) }],
        };
      }
      const pr = await projectsSvc.getProject(deps, id);
      if (pr) {
        const already = (pr as { status?: string }).status !== 'archived';
        if (!already) await projectsSvc.unarchiveProject(deps, id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, kind: 'project', archived: false, already }, null, 2) }],
        };
      }
      return {
        content: [{ type: 'text', text: `No entity found with id ${id}` }],
        isError: true,
      };
    },
  );

  // ---------- 6. search ----------
  server.tool(
    'search',
    `Primary retrieval tool — hybrid semantic + graph search across the user's documents, notes, and todos.

Vector seed → graph expansion along entity edges → RRF-fused ranking. Each hit includes a retrieval_path explaining why it was returned (vector similarity alone, entity match, or both).

Use this whenever the user asks a question that their existing knowledge might answer. Also use it BEFORE creating new content to check for duplicates.

Scoping:
- Omit project_id for global search.
- Pass a project_id for in-project NotebookLM-style retrieval.
- Narrow with entity_types (e.g., ['document']) or tags when the user specifies.`,
    {
      query: z.string()
        .describe('Natural-language search query. Full sentences work well; no need for keyword-only formatting.'),
      project_id: z.string().optional()
        .describe('Optional. Scope results to a single project. Omit for global search.'),
      entity_types: z.array(z.enum(['document', 'note', 'todo'])).optional()
        .describe('Optional. Restrict result types. Omit to include all types.'),
      tags: z.array(z.string()).optional()
        .describe('Optional. AND-filter: results must have ALL listed tags.'),
      limit: z.number().int().positive().default(10)
        .describe('Max number of hits to return. Default 10.'),
      threshold: z.number().min(0).max(1).optional()
        .describe('Minimum cosine similarity for vector-path hits (0-1). Default 0.65. Graph-expanded hits are not subject to this threshold.'),
      graph: z.boolean().default(true)
        .describe('Enable graph expansion via entity edges. Default true. Set false to get vector-only results.'),
    },
    async ({ query, project_id, entity_types, tags, limit, threshold, graph }) => {
      const hits = await searchSvc.search(deps, query, {
        projectId: project_id,
        entityTypes: entity_types,
        tags,
        limit,
        threshold,
        graph,
      });
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
    },
  );

  // ---------- 6b. find_mentions ----------
  server.tool(
    'find_mentions',
    `Exact entity lookup — returns every chunk that mentions a specific entity by canonical name or alias. Use this when the user wants all references to a specific person, tool, concept, paper, or organization (e.g. "everything I've saved about pgvector", "all mentions of Anthropic"). Unlike search(), this does not do semantic matching — it returns the ground-truth list of mentions.

Returns the resolved entity record (with aliases) plus each mention's parent item, verbatim mention text, and confidence score.

If no entity matches the input name (as canonical or alias), returns { entity: null, mentions: [] }.`,
    {
      entity: z.string().describe('Entity name to look up. Matches canonical names and aliases case-insensitively.'),
      type: z.enum(['person', 'org', 'concept', 'tool', 'paper']).optional()
        .describe('Optional. Restrict the lookup to a specific entity type. Omit to search all types.'),
      project_id: z.string().optional()
        .describe('Optional. Restrict mentions to a single project.'),
      limit: z.number().int().positive().default(20).describe('Max mentions to return. Default 20.'),
    },
    async ({ entity, type, project_id, limit }) => {
      const result = await searchSvc.findMentions(deps, entity, {
        type,
        projectId: project_id,
        limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------- 6e. list_tags ----------
  server.tool(
    'list_tags',
    `List every tag in use across documents, notes, and todos with usage counts. Sorted by total desc.

Use BEFORE applying tags via \`update\` or \`create\` so you pick from the user's existing taxonomy instead of inventing parallel labels (e.g., "meeting-notes" vs "meeting_notes" vs "meetings"). Also useful for "what topics am I tracking" overview questions.

Returns: [{ name, total, by_type: { document, note, todo } }]. Optional project_id scopes to one project's tags only.`,
    {
      project_id: z.string().optional()
        .describe('Optional. Restrict the count to items in a single project. Omit for global tag inventory.'),
    },
    async ({ project_id }) => {
      if (project_id !== undefined && !isValidUuid(project_id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${project_id}".` }],
          isError: true,
        };
      }
      const tags = await tagsSvc.listTags(deps, { project_id });
      return { content: [{ type: 'text', text: JSON.stringify(tags, null, 2) }] };
    },
  );

  // ---------- 6g. list_activity ----------
  server.tool(
    'list_activity',
    `Recent-changes feed across documents, notes, todos, and comments. Sorted by time descending (most recent first). Powers "what did I do today/this week" recaps.

V1 emits three kinds:
- 'ingest'  — a document/note/todo was created in the window
- 'edit'    — an existing item was modified (any post-create change)
- 'comment' — a comment was posted on a todo

Not yet emitted: 'complete' (status transitions to done) and 'archive' — both need a real event log to do well.

Params: since (ISO 8601), until (ISO 8601), kinds (comma-separated), project_id, limit (default 100, capped at 500).

Returns: [{ at, kind, entity_type, entity_id, title, project_ids[] }]`,
    {
      since: z.string().optional()
        .describe('ISO 8601 lower bound (inclusive). Omit for unbounded history.'),
      until: z.string().optional()
        .describe('ISO 8601 upper bound (exclusive). Omit for "up to now".'),
      kinds: z.array(z.enum(['ingest', 'edit', 'comment'])).optional()
        .describe('Restrict to specific event kinds. Omit for all three.'),
      project_id: z.string().optional()
        .describe('Optional. Restrict to events on items in a single project.'),
      limit: z.number().int().positive().optional()
        .describe('Max events to return. Default 100, capped at 500.'),
    },
    async ({ since, until, kinds, project_id, limit }) => {
      if (project_id !== undefined && !isValidUuid(project_id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${project_id}".` }],
          isError: true,
        };
      }
      let sinceDate: Date | undefined;
      let untilDate: Date | undefined;
      if (since) {
        const d = new Date(since);
        if (isNaN(d.getTime())) {
          return { content: [{ type: 'text', text: `Invalid since: "${since}". Expected ISO 8601.` }], isError: true };
        }
        sinceDate = d;
      }
      if (until) {
        const d = new Date(until);
        if (isNaN(d.getTime())) {
          return { content: [{ type: 'text', text: `Invalid until: "${until}". Expected ISO 8601.` }], isError: true };
        }
        untilDate = d;
      }
      const rows = await activitySvc.listActivity(deps, {
        since: sinceDate, until: untilDate, kinds, project_id, limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  // ---------- 6f. rename_tag ----------
  server.tool(
    'rename_tag',
    `Rename a tag across all content items and todos in one transaction. Use when the user wants to consolidate parallel labels (e.g., 'meetings' + 'meeting-notes' → 'meeting-notes') or fix a typo retroactively.

Merge-aware: if a row already had both \`from\` and \`to\`, the result is deduplicated (single \`to\`, not duplicated). Idempotent if from === to (no-op).

Returns { from, to, updated } where \`updated\` is the total count of affected rows. To remove a tag entirely (without renaming), use the web UI — destructive ops stay UI-only.`,
    {
      from: z.string().min(1).describe('The existing tag name to rename. Must match exactly (case-sensitive).'),
      to:   z.string().min(1).describe('The new tag name. Lowercase kebab-case conventional.'),
    },
    async ({ from, to }) => {
      if (from === to) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ from, to, updated: 0, noop: true }, null, 2) }],
        };
      }
      const result = await tagsSvc.renameTag(deps, from, to);
      return {
        content: [{ type: 'text', text: JSON.stringify({ from, to, updated: result.updated }, null, 2) }],
      };
    },
  );

  // ---------- 6d. ask (RAG synthesis) ----------
  server.tool(
    'ask',
    `Answer a question using the user's personal knowledge base. Returns a synthesized answer with inline citations [1], [2], etc., plus the underlying chunks that backed the synthesis.

When to prefer \`ask\` over \`search\`:
- The user wants a thorough cited summary, not raw chunks. \`ask\` runs the full RAG pipeline (vector + graph retrieval → reranked context → GPT synthesis) so you don't have to summarize search hits yourself.
- The question is multi-hop or comparative ("compare X and Y across my notes", "what have I concluded about Z over time"). The thorough path uses gpt-5-4-pro reasoning, which beats on-the-fly synthesis for these.

When to prefer \`search\`:
- You only need the underlying chunks to quote or feed into your own analysis.
- You want to keep the round-trip cheap (search is single-call vector + graph; ask adds an LLM synthesis).

Depth control:
- 'fast' (default) — single GPT-5-4 call, 2-5s. Good for direct lookups.
- 'thorough' — gpt-5-4-pro Responses API, 15-60s. Multi-hop / inferential.
- 'auto' — Haiku classifier picks between fast/thorough based on the question.

Returns: { answer, citations[], used_chunks, meta { depth_used, timings_ms } }`,
    {
      question: z.string().describe('The natural-language question to answer.'),
      project_id: z.string().optional()
        .describe('Optional. Scope retrieval to a single project. Omit for global search across all content.'),
      depth: z.enum(['auto', 'fast', 'thorough']).optional()
        .describe('Synthesis depth. Default fast. Use thorough for multi-hop / comparison queries; auto lets the classifier decide.'),
      max_chunks: z.number().int().positive().optional()
        .describe('Max retrieved chunks to feed the synthesis LLM. Default 6. Higher = more context, slower + more tokens.'),
      tags: z.array(z.string()).optional()
        .describe('Optional. AND-filter retrieval to chunks whose parent has all listed tags.'),
      entity_types: z.array(z.enum(['document', 'note', 'todo'])).optional()
        .describe('Optional. Restrict retrieval to specific entity types.'),
      reasoning_effort: z.enum(['low', 'medium', 'high']).optional()
        .describe('Optional. Override gpt-5-4-pro reasoning effort on the thorough path. Ignored on fast.'),
    },
    async ({ question, project_id, depth, max_chunks, tags, entity_types, reasoning_effort }) => {
      try {
        const result = await ragSvc.ragQuery(deps, question, {
          projectId: project_id,
          tags,
          entityTypes: entity_types,
          maxChunks: max_chunks,
          depth: depth ?? 'fast',
          reasoningEffort: reasoning_effort,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ---------- 6c. retry ----------
  server.tool(
    'retry',
    `Re-run ingest on a content item whose previous ingest failed (processing_status = 'failed'). Same id, same source_url, same blob — preserves dedup and any inbound references. Use this whenever you see a failed item and the user wants to recover it without re-uploading.

State rules:
- failed → ok, retry runs the full pipeline again
- ready → returns an error (the row is healthy; nothing to retry)
- pending → returns an error (the row is still processing; wait it out)

Returns the same shape as create on success: { id, title, chunkCount, type }.`,
    {
      id: z.string().describe('UUID of the content item to retry. Must be a previously failed ingest.'),
    },
    async ({ id }) => {
      if (!isValidUuid(id)) {
        return {
          content: [{ type: 'text', text: `Invalid UUID format: "${id}".` }],
          isError: true,
        };
      }
      try {
        const started = await contentSvc.retryContentIngest(deps, id);
        // Sync MCP contract: await the tail.
        const finished = await started.completion;
        if (finished.status === 'failed') {
          return {
            content: [{ type: 'text', text: `Retry failed: ${finished.error || 'Unknown error'}` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: started.id,
              title: finished.title,
              chunkCount: finished.chunkCount,
              warnings: finished.warnings,
              status: finished.status,
            }, null, 2),
          }],
        };
      } catch (err) {
        if (err instanceof contentSvc.RetryStateError) {
          return {
            content: [{ type: 'text', text: `${err.code}: ${err.message}` }],
            isError: true,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ---------- 7. save_from_url ----------
  server.tool(
    'save_from_url',
    `Fetch a URL and save its content to Open Brain. Handles YouTube videos (transcripts, not the file), X/Twitter threads, PDFs, HTML articles (incl. Reddit/blogs), and direct image/audio links. The original URL is preserved as the item's source and surfaced in search citations.

Use this INSTEAD of \`create\` whenever the user wants to save something they've referenced by URL ("save this article", "save this YouTube video to my project", "grab this tweet thread"). The MCP payload is tiny (just the URL), backend does the fetch — avoids the size/approval-dialog issues with pasting large content through \`create\`.

Dedup: if this URL is already saved, returns the existing item with \`deduped: true\`. Safe to call repeatedly.

Supported URLs:
- YouTube (youtube.com/watch?v=..., youtu.be/..., shorts, embed) → transcript via Supadata
- X/Twitter (x.com/user/status/..., twitter.com/user/status/...) → thread via xAI x_search
- PDF URLs, image URLs, audio URLs → downloaded and run through the file pipeline
- Everything else → treated as HTML, Firecrawl markdown extraction

Returns \`{ id, title, type, source_url, deduped, chunkCount, url_type }\`.`,
    {
      url: z.string().describe('The URL to fetch. Any http(s) URL to YouTube, X, a PDF, an article, a blog post, etc.'),
      project_ids: z.array(z.string()).optional()
        .describe('Multi-project membership (array of project UUIDs). Omit for personal/global scope.'),
      tags: z.array(z.string()).optional()
        .describe('Flat organizational labels. Lowercase kebab-case.'),
      title: z.string().optional()
        .describe('Optional title override. If omitted, uses the page/video title or AI-generated from content.'),
    },
    async ({ url, project_ids, tags, title }) => {
      try {
        const started = await urlIngestSvc.ingestFromUrl(deps, url, {
          projectIds: project_ids,
          tags,
          title,
        });
        // MCP contract is sync: await the background pipeline so the caller
        // receives a fully-ingested item (chunks, graph, ready status).
        const finished = await started.completion;
        if (finished.status === 'failed') {
          const msg = finished.error || 'Unknown ingest failure';
          return {
            content: [{ type: 'text', text: `Error: ${msg}` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: started.id,
              title: finished.title,
              type: started.type,
              source_url: started.source_url,
              deduped: started.deduped,
              chunkCount: finished.chunkCount,
              url_type: started.url_type,
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}
