import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServiceDeps } from '../services/index.js';
import * as projectsSvc from '../services/projects.js';
import * as contentSvc from '../services/content-items.js';
import * as todosSvc from '../services/todos.js';
import * as searchSvc from '../services/search.js';
import * as urlIngestSvc from '../services/url-ingest.js';

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

**Note on X/Twitter threads:** save_from_url will currently return an error for x.com / twitter.com URLs. This is a known limitation — explain it to the user rather than retrying. They can manually copy the thread text and use \`create(type: 'note', ...)\` as a workaround.

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

- **No update or delete via MCP.** You cannot mark a todo done, edit a note, archive a document, or rename a project through these tools. The web UI handles those. If the user asks to edit, say so and point them to the app.
- **Documents are immutable after creation.** Chunks are generated at create time and not re-chunked on update.
- **URL ingestion — currently supported:** YouTube videos (transcripts), PDFs, HTML articles (incl. Reddit, blogs, Substack), direct image/audio links.
- **URL ingestion — currently NOT supported:** X/Twitter threads (scraping providers don't support x.com and xAI's live_search API was deprecated — will be revisited). Notion docs, Google Docs, Medium paywalls, Vimeo/Twitch — these need per-site auth or dedicated handlers.`;

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
    'Fetch the full record of any entity (project, document, note, or todo) by UUID. Auto-detects the type. Use when you have an ID from a prior list/search and need the full content (e.g., to read a long note or to see all fields on a todo). Returns the raw entity record.',
    { id: z.string().describe('UUID from a previous list/search result — do not invent IDs') },
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

  // ---------- 5. create ----------
  server.tool(
    'create',
    `Create a new entity. Pick a type and supply the relevant fields.

REQUIRED PER TYPE:
- document: content (the extracted text, reference material from outside sources). Optional: title (auto-generated from content if omitted), project_ids, tags.
- note: content (self-authored text, potentially long). Optional: title, project_ids, tags. The user wrote this themselves.
- quick_note: content (a short captured thought). AI auto-generates the title. Optional: project_ids, tags. Use for mid-conversation "jot this down" saves.
- todo: content (the task description, e.g., "Email John"). Optional: project_id (SINGLE, not array), priority (P1/P2/P3), due_date (ISO 8601), tags.

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
    `Primary retrieval tool — semantic (meaning-based) search across the user's documents, notes, and todos.

Use this whenever the user asks a question that their existing knowledge might answer ("what did I save about X", "have I read anything on Y", "when did I last mention Z"). Also use it BEFORE creating new content to check for duplicates.

Returns ranked hits with similarity scores. For documents/notes, hits are at the chunk level (a relevant passage within the full item) — the result includes parent title, type, and content_item_id. For todos, the hit is the whole todo.

Scoping:
- Omit project_id for global search across all content.
- Pass a project_id for in-project search (NotebookLM-style: "answer only from this project's content").
- Narrow with entity_types when the user specifies (e.g., ['document'] to avoid todos polluting results).
- Narrow with tags when appropriate.`,
    {
      query: z.string()
        .describe('Natural-language search query. Full sentences work well; no need for keyword-only formatting.'),
      project_id: z.string().optional()
        .describe('Optional. Scope results to a single project. Omit for global search across everything.'),
      entity_types: z.array(z.enum(['document', 'note', 'todo'])).optional()
        .describe('Optional. Restrict result types. Omit to include all types.'),
      tags: z.array(z.string()).optional()
        .describe('Optional. AND-filter: results must have ALL listed tags.'),
      limit: z.number().int().positive().default(10)
        .describe('Max number of hits to return. Default 10.'),
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

  // ---------- 7. save_from_url ----------
  server.tool(
    'save_from_url',
    `Fetch a URL and save its content to Open Brain. Handles YouTube videos (transcripts, not the file), X/Twitter threads, PDFs, HTML articles (incl. Reddit/blogs), and direct image/audio links. The original URL is preserved as the item's source and surfaced in search citations.

Use this INSTEAD of \`create\` whenever the user wants to save something they've referenced by URL ("save this article", "save this YouTube video to my project", "grab this tweet thread"). The MCP payload is tiny (just the URL), backend does the fetch — avoids the size/approval-dialog issues with pasting large content through \`create\`.

Dedup: if this URL is already saved, returns the existing item with \`deduped: true\`. Safe to call repeatedly.

Supported URLs:
- YouTube (youtube.com/watch?v=..., youtu.be/...) → transcript via youtube-transcript
- X/Twitter (x.com/user/status/..., twitter.com/user/status/...) → thread via xAI live-search, Firecrawl fallback
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
        const result = await urlIngestSvc.ingestFromUrl(deps, url, {
          projectIds: project_ids,
          tags,
          title,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
