# Open Brain v2 — Architecture

This document is the authoritative reference for the Open Brain v2 codebase. It is written for AI agents: precise, complete, and factual. If this document and the design spec disagree, this document reflects what is actually built.

---

## 1. Purpose & Philosophy

Open Brain is a **bonding layer between human and AI** — a personal knowledge system that maintains a living profile of the user and supports their daily workflow. It exists so that any AI tool can call Open Brain and instantly understand who the user is *right now*: preferences, identity, habits, skills, relationships, opinions.

Its secondary purpose is a personal productivity layer (reminders, todos) that feeds back into the profile. What someone reminds themselves about reveals interests, priorities, and active projects.

**Core design principle: living profile, not a journal.** Facts and insights always reflect present-tense, current state. Raw captures preserve history implicitly (they are immutable). The `previous_versions` field on facts passively tracks how the profile has evolved, but this data is never surfaced in default retrieval.

**Why this exists:** The user's Claude usage is infrequent and topic-diverse. Consecutive sessions are often completely unrelated. Chronological recency is meaningless — the system needs to answer "who is this person?" not "what did they do last."

---

## 2. System Overview

```
                              Internet
                                 |
                  +--------------+--------------+
                  |              |              |
             Telegram       MCP Clients     REST API
             Webhook        (Claude, etc)   Clients
                  |              |              |
                  +--------------+--------------+
                                 |
                    Azure Container App (always-on)
                    +---------------------------------+
                    |  Hono HTTP Server (:3000)       |
                    |                                 |
                    |  /api/v1/*    REST endpoints    |
                    |  /mcp         MCP server        |
                    |  /telegram/*  Webhook handler   |
                    |  /           Health check       |
                    |                                 |
                    |  Background:                    |
                    |    Due date checker (60s poll)   |
                    |    Daily report (60s poll)       |
                    +---------------------------------+
                         |              |          |
              +----------+    +---------+    +-----+------+
              |               |              |            |
         PostgreSQL      Azure Blob     Gemini API   Anthropic API
         + pgvector      Storage
                                       Embedding 2   Claude Opus 4.6
                                       Flash 2.5

                    Azure Function App (timer trigger)
                    +---------------------------------+
                    |  Consolidation pipeline          |
                    |  CRON: 0 */30 * * * * (default)  |
                    |  Calls same code as manual trigger|
                    +---------------------------------+
```

### Architecture Pattern

Open Brain uses a **hexagonal architecture** (ports and adapters). All business logic lives in `src/services/`. The three entry-point surfaces — REST API, MCP server, and Telegram bot — are thin adapters: they parse inputs, call service functions, and format responses. No business logic lives in adapters.

### Components

| Component | Azure Service | Purpose |
|-----------|---------------|---------|
| API + MCP + Telegram | Container App (minReplicas: 1) | HTTP server hosting all three surfaces |
| Consolidation | Function App (timer trigger) | Scheduled capture-to-fact-to-insight pipeline |
| Database | PostgreSQL Flexible Server (B1ms) + pgvector | All data, vector search |
| File Storage | Blob Storage | Multimodal files (images, audio, video, PDFs) |
| Secrets | Key Vault | All API keys and connection strings |
| Monitoring | App Insights + Log Analytics | Telemetry, dependency tracking |
| Container Registry | ACR (shared, existing in shared-rg) | Docker images |

### AI Models

| Task | Model | Provider | Model ID | Why |
|------|-------|----------|----------|-----|
| Embeddings (multimodal) | Gemini Embedding 2 | Google | `gemini-embedding-2-preview` | Only model with native text+image+audio+video embedding in a single vector space |
| Metadata extraction | Gemini 2.5 Flash | Google | `gemini-2.5-flash` | Fast, cheap, structured output for pipeline hot path |
| Intent classification | Gemini 2.5 Flash | Google | `gemini-2.5-flash` | Real-time NL parsing in Telegram |
| Retrieval synthesis | Gemini 2.5 Flash | Google | `gemini-2.5-flash` | Speed+quality balance for on-demand `get_user_profile` |
| Consolidation | Claude Opus 4.6 | Anthropic | `claude-opus-4-6` | Best reasoning + nuance preservation for profile synthesis |

---

## 3. Data Architecture

### Three-Tier Model

Data flows through three tiers: raw captures -> synthesized facts -> cross-cutting insights. Each tier is independently searchable via vector embeddings. Relationships are many-to-many at both promotion boundaries.

```
captures (Tier 1)                     facts (Tier 2)                     insights (Tier 3)
+-----------------------+             +-----------------------+          +-----------------------+
| Raw, immutable inputs |  ---------> | Synthesized profile   | -------> | Cross-cutting patterns|
| status: pending ->    |  many:many  | knowledge. Mutable.   | many:many| from multiple facts.  |
|   consolidated        |  via        | Carries previous_     | via      | Highest value tier.   |
| Never deleted.        |  source_    | versions for history. | source_  |                       |
+-----------------------+  capture_   +-----------------------+ fact_    +-----------------------+
                           ids[]                                ids[]

reminders                             reminder_comments
+-----------------------+             +-----------------------+
| Tasks with hierarchy  | 1:many ---> | Chronological progress|
| (Project > Section >  | via         | log entries per task  |
|  Task > Subtask)      | reminder_id |                       |
+-----------------------+             +-----------------------+

consolidation_log
+-----------------------+
| Audit trail for every |
| consolidation run     |
+-----------------------+
```

### Tables

| Table | Purpose | Row Count Growth |
|-------|---------|-----------------|
| `captures` | Tier 1 raw inputs. Immutable once written. Marked `consolidated` after processing. | Grows with usage |
| `facts` | Tier 2 synthesized profile knowledge. Mutable by consolidation and user edits. | Tens to low hundreds |
| `insights` | Tier 3 cross-cutting patterns derived from 2+ facts. | Tens |
| `reminders` | Tasks with Project/Section/Task hierarchy, subtask nesting via `parent_id`. | Grows with usage |
| `reminder_comments` | Chronological progress log entries per task. | Grows with usage |
| `consolidation_log` | One row per consolidation run with metrics. | One per run |

### Extensibility Conventions

Every content table shares a **core table shape**:

```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
content         text NOT NULL
embedding       vector(3072)
metadata        jsonb
source          text[]          -- array: ['telegram'], ['mcp'], ['api'], or union for promoted tiers
tags            text[]          -- semantic tags from the 14-tag allowlist (see Tag System section)
archived        boolean DEFAULT false
created_at      timestamptz DEFAULT now()
updated_at      timestamptz DEFAULT now()
```

Rules:
1. **Everything gets an embedding** — enables cross-type semantic search.
2. **Type-specific columns** are added alongside the core shape, not instead of it. Use `metadata` JSONB for exploratory/infrequent attributes.
3. **All embeddings are 3072 dimensions** (Gemini Embedding 2 maximum, explicitly requested).
4. **New data types feeding profile signal** should add a reader in the consolidation pipeline.
5. **Source is an array** — captures have single-element source arrays; facts and insights inherit the union of all contributing captures' sources.
6. **Tags are arrays** — multiple tags per item are valid. Tags are validated against the 14-tag allowlist.

### Tag System

Every capture, fact, and insight is semantically classified with tags. Tags enable filtered retrieval: `search_thoughts("coding style", { tags: ["preference"] })` returns only preference-type results about coding, not all coding-related entries.

**14 allowed tags:**

| Tag | What it captures |
|-----|-----------------|
| `preference` | How the user likes things done |
| `decision` | A choice made with rationale |
| `problem-solution` | A problem encountered and how it was resolved |
| `pattern` | A recurring behavior or habit observed over time |
| `goal` | An aspiration, target, or planned direction |
| `opinion` | A stance or belief with reasoning |
| `skill` | A capability or expertise level |
| `relationship` | Knowledge about a specific person |
| `resource` | A tool, link, article, or reference worth recalling |
| `idea` | An uncommitted exploration or possibility |
| `interest` | A hobby, passion, or thing enjoyed |
| `health` | Medical, fitness, dietary, or wellness information |
| `dislike` | Something to avoid or never suggest |
| `milestone` | A significant achievement or turning point |

**Tag assignment:**
- **Telegram and REST API captures:** auto-classified by Gemini Flash during metadata extraction (piggybacked on the existing metadata prompt — no extra LLM call).
- **MCP captures:** AI caller may provide tags upfront via `capture_thought({ tags: [...] })`; if omitted or invalid, pipeline auto-classifies.
- **Facts:** start as the union of all contributing captures' tags; consolidation LLM may refine (add/remove).
- **Insights:** start as the union of all contributing facts' tags; consolidation LLM may refine.
- `update_tags` MCP tool allows manual tag correction on any tier item.

**Expanding the allowlist:** Add the new tag to `ALLOWED_TAGS` in `src/capture/tags.ts` and `TAG_DESCRIPTIONS`. No migration needed — the allowlist is a code-only constant. Run `npx vitest run` to verify unit tests still pass.

---

## 4. Capture Pipeline

**Entry point:** All entry points (Telegram, MCP, REST) converge on `POST /api/v1/capture`.

**Implementation:** `src/capture/pipeline.ts`

### Pipeline Steps

```
1. Compute file hashes (SHA-256)
       |
2. File hash check (exact match)
   - ALL files already exist? -> BLOCK as duplicate
   - Some match? -> reuse URLs for those, upload the rest
       |
3. Convert files for embedding (src/capture/media-convert.ts)
   - sharp for images (HEIC->JPEG, WebP->PNG, etc.)
   - ffmpeg for audio (OGG->WAV) and video (->MP4)
   - Conversion happens AFTER hash check (hash the original bytes)
   - Original file (not converted) is uploaded to blob storage
       |
4. Generate embedding (Gemini Embedding 2, text + file bytes together)
       |
5. Semantic dedup check (cosine similarity > 0.95 -> BLOCK)
   - Checks against ALL captures, not just recent
       |
6. Upload files to Blob Storage  }  (parallel)
7. Extract metadata via LLM      }  (parallel)
       |
8. INSERT into captures table (status = 'pending')
```

**Key design decisions:**
- File hash check is a **storage optimization**. Same image with different text context is a different thought — the semantic check handles that.
- Files are only uploaded AFTER passing both dedup checks.
- The `convertForEmbedding` function returns an empty buffer if ffmpeg is unavailable, allowing graceful degradation (file stored but not embedded).
- Metadata extraction uses Gemini Flash with `responseFormat: 'json'` and `maxTokens: 1024`. Fallback returns empty arrays on parse failure.

**Supported MIME types for embedding:** `image/png`, `image/jpeg`, `audio/mpeg`, `audio/wav`, `video/mp4`, `video/quicktime`, `application/pdf`. Others are converted or skipped.

---

## 5. Consolidation Pipeline

**Implementation:** `src/consolidation/runner.ts`, `phase1.ts`, `phase2.ts`, `phase3.ts`, `clustering.ts`

### Schedule

Configurable via `CONSOLIDATION_SCHEDULE` environment variable. Default: `0 */30 * * * *` (every 30 minutes). Also manually triggerable via `POST /api/v1/consolidation/trigger` or the `run_consolidation` MCP tool.

### Guard Rails

- **Skip if nothing to do:** No pending captures AND no completed reminders AND no facts updated since last run -> log `no-op` and exit.
- **Token budgets:** Phase 1: 80,000 tokens. Phase 2: 50,000 tokens. If Phase 1 exhausts its budget, remaining captures stay `pending` for next run.
- **user_edited protection:** Facts with `origin = 'user_edited'` are never overwritten. Contradicting evidence creates a new `pending_review` fact instead.
- **Partial commit:** Phase 1 commits per-cluster (each cluster is its own transaction). Phase 2 commits atomically (all-or-nothing).

### Phase 1: Capture -> Fact Promotion

1. Load all pending captures + recently completed reminders (profile signal).
2. Load all active facts (confidence >= 0.0 for context).
3. **DBSCAN clustering** on embedding vectors (cosine distance, `eps=0.3`, `minSamples=2`). Noise points become individual single-item clusters.
4. For each cluster, send to Claude Opus with existing facts as context. LLM returns actions:
   - `create_fact` — new profile fact with category and confidence
   - `update_fact` — update existing fact, store previous version
   - `flag_review` — flag for user review
   - `merge_facts` — merge semantic duplicates, archive the weaker one
   - `discard` — noise (must meet ALL 7 noise criteria)
5. Mark processed captures as `status = 'consolidated'`.

**Noise criteria:** A capture is only discarded if ALL of these are true: no preference/opinion/value judgment, no person/relationship info, no habit/routine/pattern, no skill/tool/tech, no goal/aspiration/plan, no emotional response, and is purely transactional. Default: **create a fact with low confidence (0.3-0.4)**.

**Review mode logic (hybrid):**
- Auto-approved: categories `preference`, `habit`, `skill`, `history`
- Flagged for review: categories `personality`, `opinion`, `relationship`; confidence shifts > 0.15; contradictions to `user_edited` facts

### Phase 2: Fact -> Insight Generation

1. Load all active facts (confidence >= 0.3, not rejected).
2. Load existing insights.
3. Requires minimum 2 facts to run.
4. Send to Claude Opus. LLM returns:
   - `insights` — new cross-cutting patterns (must cite 2+ source facts)
   - `updates` — existing insights updated due to fact changes
   - `invalidations` — insights contradicted by new evidence (archived)
5. All new insights default to `review_status = 'pending_review'`.
6. All Phase 2 writes are atomic (single transaction).

### Phase 3: Re-embed + Notify

1. Find all facts and insights with `embedding IS NULL` (newly created or updated).
2. Generate embeddings for each via Gemini Embedding 2.
3. If items are pending review and notifications enabled, send Telegram notification.

### Consolidation Log

Every run writes to `consolidation_log` with status (`success`, `partial`, `failed`, `no-op`), counts, token usage, and duration. App Insights metrics are also tracked.

---

## 6. Retrieval

**Implementation:** `src/retrieval/profile.ts`, `src/retrieval/search.ts`

### get_user_profile (session bootstrap)

Answers "who is this person?" Called at the start of an AI session.

1. Load all approved insights (`review_status IN ('auto_approved', 'user_approved')`)
2. Load high-confidence facts (>= 0.7) not already covered by any insight's `source_fact_ids`
3. Load active reminders (not_started, in_progress, researching) — shows current focus
4. Synthesize into a coherent profile summary via Gemini Flash (third person, organized by category)

If no data exists, returns: `"No profile data yet. Start capturing thoughts to build your profile."`

### search_thoughts (mid-session query)

Answers "what does this person think about X?" Tiered search with conditional evidence.

1. Embed query via Gemini Embedding 2
2. **Tier 1:** Search insights. If matches found, return them.
3. **Tier 2:** Search facts. If matches found, return them. If confidence < 0.7, append source captures as evidence.
4. **Tier 3:** Fall back to raw captures.

Response includes `tier`, `confidence`, `content`, `category`, and optionally `note` and `evidence` array for low-confidence results.

---

## 7. Service Layer

**Implementation:** `src/services/`

Open Brain uses a **hexagonal architecture** (ports and adapters pattern). All business logic lives in the service layer. The three adapter surfaces — REST API, MCP server, and Telegram bot — are thin wrappers that translate their input format, call the appropriate service function, and format the response. No business logic belongs in adapters.

### Design Principles

- **Adapters are thin:** REST routes, MCP tool handlers, and Telegram command handlers should contain no business logic — only argument parsing, service calls, and response formatting.
- **Services own the logic:** validation, embedding, cross-table coordination, and error checking all happen in `src/services/`.
- **Dependencies are injected:** every service function takes a `ServiceDeps` object as its first argument. This makes unit testing trivial — pass mocks.
- **No circular imports:** adapters import services; services import DB modules and providers. Services never import adapters.

### Service Modules

| Module | Responsibility |
|--------|---------------|
| `captures.ts` | `captureThought` (full pipeline), `searchThoughts`, `listCaptures`, `getCapture`, `archiveCapture`, `unarchiveCapture` |
| `comments.ts` | `addComment`, `listComments`, `getComment`, `updateComment`, `deleteComment` — owns comment validation and re-embedding |
| `consolidation.ts` | `runConsolidation` (delegates to pipeline), `getConsolidationLogs` |
| `facts.ts` | `getFact`, `listFacts`, `updateFact` (re-embeds, sets `user_edited`), `archiveFact`, `unarchiveFact`, `reviewPendingFacts`, `approveRejectFact` |
| `insights.ts` | `getInsight`, `listInsights`, `updateInsight`, `archiveInsight`, `unarchiveInsight`, `reviewPendingInsights`, `approveRejectInsight` |
| `profile.ts` | `getUserProfile` (LLM synthesis), `getBrainStats` (dashboard counts) |
| `reminders.ts` | Full CRUD + `createReminder` (validates depth, embeds), `completeReminder` (cascade), `deleteReminder` (cascade), `reparentReminder`, `resolveReminderId`, `listProjects`, notification-support queries |
| `tags.ts` | `updateTags` (validates allowlist, routes to correct DB table), `getAllowedTags` |
| `index.ts` | `ServiceDeps` interface — the dependency injection contract |

### Adding to the Service Layer

When a new feature needs business logic:
1. Add the function to the appropriate `src/services/*.ts` module (or create a new module).
2. Call it from the adapter (REST route, MCP tool, or Telegram handler) — do not duplicate logic across adapters.
3. Test the service function directly in unit tests; test the adapter integration in integration/E2E tests.

---

## 8. Reminders System

**Implementation:** `src/services/reminders.ts`, `src/services/comments.ts`, `src/db/reminders.ts`, `src/db/reminder-comments.ts`, `src/notifications/format-reminders.ts`, `src/notifications/due-date-checker.ts`

### Hierarchy

```
Project (string, implicit creation)
  Section (string, implicit creation)
    Task (with status, priority, due date)
      Subtask (recursive via parent_id, up to 4 levels: depth 0-3)
      Comment (timestamped progress log entry)
```

Projects and sections are lightweight string identifiers — no separate tables. Creating a project is implicit when a new project name is used.

### Statuses

`not_started` | `in_progress` | `researching` | `paused` | `done` | `blocked` | `cancelled`

### Priorities

`P1` | `P2` | `P3` | `null` (no priority)

### Categories

Auto-determined from content: `work` | `personal` | `health` | `learning` | `finance` | `social`

### Subtask Behavior

- **Creating:** `parent_id` references parent. Validates depth < 4.
- **Completing (cascade done):** Completing a parent auto-completes all descendant subtasks recursively. `completeReminder()` marks the parent as done, then walks the subtask tree and marks every non-done, non-cancelled child as done. Returns `{ completed: string[] }` with all affected IDs.
- **Deleting (cascade delete):** `deleteReminder()` cascade-deletes all descendant subtasks and their comments. Collects all descendant IDs recursively, deletes comments for all, then deletes reminders deepest-first.
- **Moving (reparent):** `reparentReminder()` moves a task under a new parent (or to root with `null`). Updates depth, project, and section to match the new parent. Recursively updates all children depths and project/section to stay consistent.
- **resolveReminderId:** Accepts short ID prefixes (e.g., "4e0bd1b2") and resolves to full UUID via `LIKE` prefix match. Returns `null` if no match or ambiguous (multiple matches). Full UUIDs are passed through directly.

### Due Date Notifications

- **Due date checker** (`startDueDateChecker`): Polls every 60 seconds. Finds reminders where `due_date <= now()` and not yet notified. Sends individual Telegram notifications. Marks as notified via `metadata.notified = 'true'`.
- **Daily report** (`startDailyReport`): Polls every 60 seconds. At the configured time (default `09:00` in `TIMEZONE`), sends a summary of overdue + due-today reminders. Sends at most once per day.

### Profile Integration

Completed reminders are treated as profile signal during consolidation. The runner reads recently completed reminders alongside pending captures, prefixing their content with `[Completed reminder]`. Cancelled and blocked reminders are also informative signal (per spec) but the current implementation only reads `done` status.

---

## 9. Telegram Bot

**Implementation:** Split across multiple modules for testability:
- `src/telegram/webhook.ts` — Bot setup, webhook route, shared state initialization
- `src/telegram/command-handlers.ts` — All slash commands + callback_query handler (inline buttons + action menu)
- `src/telegram/nl-router.ts` — Natural language intent classifier + NL handlers + media handlers
- `src/telegram/handlers.ts` — Pure handler functions (testable without bot instance): text, photo, voice, document
- `src/telegram/prompts.ts` — Intent classifier and reminder parser system prompts (date-aware, timezone-aware)
- `src/telegram/llm-parse.ts` — `llmJsonParse<T>()` retry helper (3 attempts, returns null on failure)
- `src/telegram/state.ts` — Shared state types (LastActionEntry, PendingSubtaskEntry, PendingActionEntry, StateRefs)
- `src/telegram/mime-utils.ts` — Extension-to-MIME map (25 types), `resolveMimeType()`, `getSummarizationRoute()`

**Framework:** grammY

### Webhook Architecture

1. Webhook POST arrives at `/telegram/webhook`.
2. **Verify secret** — `X-Telegram-Bot-Api-Secret-Token` header must match `TELEGRAM_WEBHOOK_SECRET`.
3. **Dedup guard** — Track `update_id` in a Set (max 1000 entries, FIFO eviction). Skip if already processed.
4. **Respond 200 immediately** — Prevents Telegram retry loops (Telegram retries after ~60s timeout).
5. **Process in background** — `bot.handleUpdate(body)` runs asynchronously. Bot handlers send replies directly via Telegram API.

### Natural Language Intent Classifier

Every plain text message (not a slash command) goes through Gemini Flash intent classification with retry (3 attempts via `llmJsonParse`). Before hitting the LLM, two fast-paths are checked:

1. **Pending subtask** — if the chat has a `pendingSubtask` entry, the message is treated as subtask content (parsed through the reminder LLM parser for priority/due date). Cleared after creation.
2. **Pending action** — if the chat has a `pendingAction` entry (from the action menu), the message is treated as the argument for that action (edit text, comment text, or move target ID). Cleared after execution.
3. **Undo** — if the message is literally "undo" (case-insensitive), it bypasses the LLM entirely.

Otherwise, the classifier returns one of:

| Intent | Action |
|--------|--------|
| `create_reminder` | Creates a new reminder with parsed project/section/priority/due date |
| `list_reminders` | Shows active reminders, optionally filtered (today, overdue, this_week) |
| `complete_reminder` | Finds and completes a task by description match |
| `update_reminder` | Updates status/priority/project/content of a task |
| `add_comment` | Adds a progress comment to a matched task |
| `move_reminder` | Moves a task under another task or to root level by description match |
| `undo` | Reverses the last action for this chat |
| `capture_thought` | Default fallback — captures as a thought |

Each classified action shows `"Interpreted as [type]"` prefix and an `"undo"` hint.

### Slash Commands

| Command | Action |
|---------|--------|
| `/remind <text>` | Create reminder (parsed via LLM for project/priority/due date) |
| `/todos` | List active reminders with inline keyboard buttons |
| `/done <id>` | Mark a reminder complete (supports short IDs, cascade-completes subtasks) |
| `/delete <id>` | Delete a reminder and all subtasks/comments (supports short IDs) |
| `/edit <id> <new text>` | Edit a reminder's content (re-embeds, stores previous state for undo) |
| `/move <id> <parent-id\|root>` | Move a task under another task or to root level |
| `/comment <id> <text>` | Add a progress comment |
| `/subtask` | Select a reminder and add a subtask (inline keyboard flow) |
| `/review` | Placeholder — not yet implemented |

### Inline Keyboard Buttons

`/todos` renders numbered tasks with three buttons per task:

- `done:{id}` (checkmark + number) — marks task complete (cascade to subtasks), re-renders the full list
- `cycle:{id}` (status icon + number) — cycles status: not_started -> in_progress -> paused -> blocked -> not_started (done excluded from cycle)
- `actions:{id}` (gear + number) — opens the action menu for that task

### Action Menu

Triggered by the gear button on any task. Sends a new message with five action buttons:

| Button | Callback Data | Behavior |
|--------|---------------|----------|
| Edit | `action-edit:{id}` | Sets `pendingAction` to `edit`, prompts for new text |
| Comments | `action-comments:{id}` | Lists existing comments with edit/delete buttons per comment |
| Move | `action-move:{id}` | Sets `pendingAction` to `move`, prompts for target ID or "root" |
| Delete | `action-delete:{id}` | Immediately deletes the task + subtasks + comments |
| Subtask | `action-subtask:{id}` | Enters subtask creation flow (same as `subtask:{id}`) |
| Add Comment | `action-comment:{id}` | Sets `pendingAction` to `comment`, prompts for comment text |

### Comment Management (Telegram)

The Comments view (`action-comments:{id}`) shows each existing comment numbered, with a timestamp, and two buttons per comment: ✏ Edit (`action-edit-comment:{commentId}`) and 🗑 Delete (`action-delete-comment:{commentId}`).

- **Edit comment:** `action-edit-comment:{commentId}` — sets `pendingAction` to `comment-edit` (storing both `reminderId` and `commentId`), prompts user for new text. Next plain text message calls `commentsSvc.updateComment()`.
- **Delete comment:** `action-delete-comment:{commentId}` — immediately calls `commentsSvc.deleteComment()`, replies with confirmation.

### Pending State Machines

Two state machines maintain conversational context per chat (keyed by `chatId`):

**`pendingSubtask`** — When a user clicks a subtask button, the chat enters a pending state. The next plain text message is treated as subtask content (parsed through the reminder LLM parser for priority/due date). The state stores: `parentId`, `parentContent`, `parentProject`, `parentSection`, `depth`. Cleared after creation.

**`pendingAction`** — When a user clicks an action menu button (edit/comment/move/comment-edit), the chat enters a pending state. The next plain text message is treated as the argument for that action. For `move`, if the target is invalid, the pending state is re-set so the user can try again. Stores: `action` ('edit' | 'comment' | 'move' | 'comment-edit'), `reminderId`, and optionally `commentId` (for `comment-edit` flow).

### Undo Support

Per-chat state tracking (`lastActions` Map). Stores the last action type, reminder ID, and previous state. Supports undoing:

| Action | Undo Behavior |
|--------|---------------|
| `create` | Deletes the created reminder |
| `complete` | Restores previous status (default: not_started) |
| `update` | Restores previous content, status, priority, project |
| `comment` | Deletes the comment |

### Media Handlers

| Message Type | Content | File Handling |
|-------------|---------|---------------|
| Text | Message text | None — intent classified or captured |
| Photo | Caption or "Photo capture" | Downloads largest resolution via Bot API |
| Voice | AI transcription + summary (Gemini Flash) | Downloads .ogg via Bot API |
| Document | AI summary (Gemini Flash) | Downloads via Bot API, MIME resolved from extension |

**MIME type inference** (`src/telegram/mime-utils.ts`): When Telegram reports `application/octet-stream`, the extension-to-MIME map resolves the actual type. Covers 25 common extensions (pdf, png, jpg, gif, webp, mp4, mp3, wav, ogg, txt, csv, json, doc, docx, html, htm, xml, md, rtf, xls, xlsx, ppt, pptx, zip).

**Summarization routing** (`getSummarizationRoute()`): Three paths based on MIME type:
- `inline_data` — binary sent to Gemini (PDF, images, audio, video)
- `text_extraction` — read as UTF-8 (max 30K chars), summarize as text (HTML, CSV, JSON, RTF, XML, Markdown, plain text)
- `unsupported` — stored but not summarized, user warned with the unsupported MIME type

---

## 10. MCP Server

**Implementation:** `src/mcp/server.ts`, `src/mcp/profiler-tools.ts`, `src/mcp/reminder-tools.ts`

**Transport:** Streamable HTTP (`WebStandardStreamableHTTPServerTransport`, stateless).

**Auth:** `x-brain-key` header or `?key=` query parameter on `/mcp` endpoint.

### AI Client Setup — Two Mechanisms

Open Brain uses two complementary mechanisms to teach AI clients how to use it:

1. **Server instructions (automatic):** The `McpServer` is created with an `instructions` field in its options. MCP-compliant clients (Claude, etc.) receive this string on connection and apply it automatically — no user configuration needed. The instructions tell the AI to call `brain_help` at session start, call `get_user_profile` to bootstrap context, proactively capture via `capture_thought`, and suggest reminders when commitments are mentioned.

2. **`get_user_prompt` tool (portable):** For non-MCP clients (ChatGPT, raw API usage, etc.), the `get_user_prompt` tool returns the same behavioral instructions as a copyable system prompt. Users paste it into their AI client's custom instructions or system prompt field once, and any AI client gains the same proactive behavior.

### Tools (23 total)

**Profiler tools (13):**

| # | Tool | Description |
|---|------|-------------|
| 1 | `brain_help` | Returns AI usage guide — when/how to capture, third-person format, 14-tag system |
| 2 | `get_user_prompt` | Returns a portable system prompt to paste into any AI client (Claude, ChatGPT, etc.) |
| 3 | `get_user_profile` | Session bootstrap — synthesized profile summary |
| 4 | `search_thoughts` | Tiered semantic search: insights -> facts -> captures. Optional `tags` filter (AND semantics). |
| 5 | `capture_thought` | Capture text + optional file URLs. Optional `tags` array; if omitted, auto-classified. |
| 6 | `brain_stats` | Dashboard — counts by type, facts/insights by tag, captures by source |
| 7 | `archive_thought` | Soft-delete (no cascade recalculation) |
| 8 | `unarchive_thought` | Restore archived item |
| 9 | `update_fact` | Direct user edit — sets origin to `user_edited`, confidence to 1.0 |
| 10 | `review_pending` | List items with `pending_review` status |
| 11 | `approve_reject` | Approve, reject, or edit pending review items (looks up by UUID across facts and insights) |
| 12 | `run_consolidation` | Manually trigger consolidation pipeline |
| 13 | `update_tags` | Replace tags on any tier item (capture, fact, insight) by UUID. Validates against allowlist. |

**Reminder tools (10):**

| # | Tool | Description |
|---|------|-------------|
| 14 | `create_reminder` | Create a task or subtask (with project, section, priority, due date) |
| 15 | `list_reminders` | List reminders with flexible filtering (project, status, priority, due range) |
| 16 | `get_reminder_detail` | Single task with all comments and full subtask tree |
| 17 | `update_reminder` | Change status, priority, content, due date, move project/section |
| 18 | `complete_reminder` | Mark done (cascades to all subtasks) |
| 19 | `delete_reminder` | Delete with cascade (all subtasks and comments) |
| 20 | `add_reminder_comment` | Add a timestamped progress comment |
| 21 | `list_projects` | All projects with task count stats by status |
| 22 | `edit_comment` | Edit the text of an existing comment (re-embeds content) |
| 23 | `delete_comment` | Delete a comment by ID; returns the deleted comment content |

### brain_help

The `brain_help` tool returns a detailed guide for AI clients on when to capture, what format to use (third person, one signal per capture, 14-tag system), when to provide tags vs let auto-classify, and how to use tag-filtered search. It encourages **proactive capture** — AI clients should capture observations without waiting for explicit user requests.

---

## 11. REST API

**Framework:** Hono (`src/app.ts`)

**Port:** 3000 (configurable via `PORT`)

The REST API provides comprehensive CRUD coverage for all resources. All adapters (MCP, Telegram) call the service layer directly — the REST API is a separate adapter, not a pass-through.

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | None | Health check — returns `{"status":"ok","service":"open-brain-v2"}` |
| GET | `/api/v1/captures` | Bearer | List captures (`?limit=N`, `?status=`) |
| POST | `/api/v1/captures` | Bearer | Capture a thought (canonical path) |
| POST | `/api/v1/capture` | Bearer | Capture a thought (backward-compatible alias) |
| GET | `/api/v1/captures/:id` | Bearer | Get a single capture |
| PATCH | `/api/v1/captures/:id/tags` | Bearer | Replace tags on a capture |
| POST | `/api/v1/captures/:id/archive` | Bearer | Archive a capture |
| POST | `/api/v1/captures/:id/unarchive` | Bearer | Restore a capture |
| GET | `/api/v1/facts` | Bearer | List facts (`?limit=N`, `?min_confidence=`) |
| GET | `/api/v1/facts/:id` | Bearer | Get a single fact |
| PUT | `/api/v1/facts/:id` | Bearer | Update fact content (re-embeds, sets `user_edited`) |
| PATCH | `/api/v1/facts/:id/tags` | Bearer | Replace tags on a fact |
| POST | `/api/v1/facts/:id/archive` | Bearer | Archive a fact |
| POST | `/api/v1/facts/:id/unarchive` | Bearer | Restore a fact |
| POST | `/api/v1/facts/:id/approve` | Bearer | Approve a pending-review fact |
| POST | `/api/v1/facts/:id/reject` | Bearer | Reject a pending-review fact |
| GET | `/api/v1/insights` | Bearer | List insights (`?limit=N`) |
| GET | `/api/v1/insights/:id` | Bearer | Get a single insight |
| PUT | `/api/v1/insights/:id` | Bearer | Update insight content |
| PATCH | `/api/v1/insights/:id/tags` | Bearer | Replace tags on an insight |
| POST | `/api/v1/insights/:id/archive` | Bearer | Archive an insight |
| POST | `/api/v1/insights/:id/unarchive` | Bearer | Restore an insight |
| POST | `/api/v1/insights/:id/approve` | Bearer | Approve a pending-review insight |
| POST | `/api/v1/insights/:id/reject` | Bearer | Reject a pending-review insight |
| GET | `/api/v1/reminders` | Bearer | List reminders (`?status=`, `?project=`, `?priority=`, `?include_done=`, `?top_level_only=`, `?limit=`) |
| POST | `/api/v1/reminders` | Bearer | Create a reminder |
| GET | `/api/v1/reminders/:id` | Bearer | Get reminder detail (includes comments + subtask tree) |
| PATCH | `/api/v1/reminders/:id` | Bearer | Update reminder fields |
| POST | `/api/v1/reminders/:id/complete` | Bearer | Mark done (cascades to subtasks) |
| DELETE | `/api/v1/reminders/:id` | Bearer | Delete reminder (cascade) |
| POST | `/api/v1/reminders/:id/reparent` | Bearer | Move to a different parent (or root) |
| GET | `/api/v1/reminders/:id/comments` | Bearer | List comments for a reminder |
| POST | `/api/v1/reminders/:id/comments` | Bearer | Add a comment to a reminder |
| GET | `/api/v1/comments/:id` | Bearer | Get a single comment |
| PUT | `/api/v1/comments/:id` | Bearer | Update a comment (re-embeds content) |
| DELETE | `/api/v1/comments/:id` | Bearer | Delete a comment |
| POST | `/api/v1/search` | Bearer | Semantic search across captures/facts/insights |
| GET | `/api/v1/profile` | Bearer | LLM-synthesized profile summary |
| GET | `/api/v1/stats` | Bearer | Brain statistics dashboard |
| GET | `/api/v1/review/pending` | Bearer | Pending facts and/or insights (`?type=fact\|insight`) |
| GET | `/api/v1/projects` | Bearer | List all projects with task count stats |
| GET | `/api/v1/consolidation/logs` | Bearer | Consolidation run history |
| POST | `/api/v1/consolidation/trigger` | Bearer | Manually trigger consolidation |
| ALL | `/mcp` | x-brain-key | MCP streamable HTTP transport |
| POST | `/telegram/webhook` | Telegram secret | Telegram webhook handler |

### Auth

- **REST API (`/api/v1/*`):** Bearer token via `Authorization: Bearer <OPEN_BRAIN_API_KEY>`
- **MCP (`/mcp`):** `x-brain-key` header or `?key=<OPEN_BRAIN_API_KEY>` query parameter
- **Telegram (`/telegram/webhook`):** `X-Telegram-Bot-Api-Secret-Token` header must match `TELEGRAM_WEBHOOK_SECRET`

### Rate Limiting

100 requests per minute per Authorization header value. In-memory Map, resets after 60 seconds. Applied to `/api/*` routes only.

---

## 12. Provider Abstraction

**Implementation:** `src/providers/types.ts`, `src/providers/gemini-embedding.ts`, `src/providers/gemini-llm.ts`, `src/providers/anthropic-llm.ts`

### Interfaces

```typescript
interface EmbeddingProvider {
  embed(content: string, files?: Array<{ data: Buffer; mimeType: string }>): Promise<number[]>;
  readonly dimensions: number;  // 3072
}

interface LLMProvider {
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

// LLMMessage.content can be string OR LLMContentPart[] (multimodal)
// LLMResponse includes tokensUsed: { input, output, total }
```

### Current Implementations

| Provider | Class | Default Model | Used For |
|----------|-------|---------------|----------|
| Gemini Embedding 2 | `GeminiEmbeddingProvider` | `gemini-embedding-2-preview` | All embeddings (3072 dims, multimodal) |
| Gemini 2.5 Flash | `GeminiLLMProvider` | `gemini-2.5-flash` | Metadata extraction, intent classification, retrieval synthesis, voice transcription, document summarization |
| Claude Opus 4.6 | `AnthropicLLMProvider` | `claude-opus-4-6` | Consolidation (Phase 1 + Phase 2). Default max tokens: 8192 |

### extractJson Workaround

**Problem:** Gemini 2.5 Flash often wraps JSON responses in markdown code blocks (`` ```json ... ``` ``) even when `responseMimeType: 'application/json'` is set.

**Solution:** `extractJson()` in `src/providers/gemini-llm.ts` strips markdown wrapping. It tries, in order:
1. Is the trimmed text already valid JSON (starts with `{` or `[`)?
2. Extract from `` ```json ... ``` `` code blocks.
3. Find first `{` or `[` and extract to matching closing bracket.
4. Give up and return original text.

### llmJsonParse Retry Helper

**Problem:** Gemini's JSON output is non-deterministic — the same prompt can produce valid JSON, markdown-wrapped JSON, or occasionally malformed output.

**Solution:** `llmJsonParse<T>()` in `src/telegram/llm-parse.ts` wraps LLM calls with 3 retry attempts. On each attempt it calls `llm.complete()` and `JSON.parse()`. Returns `null` after all retries fail.

---

## 13. Infrastructure

**Implementation:** `infra/main.bicep` and `infra/modules/*.bicep`

### Azure Resources

| Resource | Bicep Module | Details |
|----------|-------------|---------|
| Container App | `modules/container-app.bicep` | Hosts API + MCP + Telegram. **minReplicas: 1** (always-on, no cold starts). Managed identity for ACR pull. |
| Function App | `modules/function-app.bicep` | Timer trigger for consolidation. Consumption plan. |
| PostgreSQL Flexible Server | `modules/postgresql.bicep` | B1ms tier. pgvector extension. |
| Blob Storage | `modules/storage.bicep` | File uploads (images, audio, video, PDFs). |
| Key Vault | `modules/keyvault.bicep` | All secrets (API keys, connection strings, tokens). |
| Log Analytics + App Insights | `modules/monitoring.bicep` | Telemetry and logging. |

### IaC Notes

- Bicep uses managed identities (no stored credentials at runtime).
- Secrets are passed via CLI parameters at deploy time, not in `parameters.json`.
- ACR role assignment (AcrPull) must be done via CLI because the ACR is in a different resource group (`shared-rg`) than the Container App (`openbrain-rg`). Cross-resource-group role assignments cannot be expressed in Bicep at resource group scope.

### CI/CD

**CI** (`.github/workflows/ci.yml`): Runs on PR and push to main. Steps: `npm ci`, `tsc --noEmit`, `npm test` (unit tests with `GEMINI_API_KEY` secret), `npm run test:e2e` (E2E tests against PostgreSQL service container). The CI uses a `pgvector/pgvector:pg16` service container for E2E tests.

**CD** (`.github/workflows/deploy.yml`): Runs on push to main. OIDC auth to Azure. Steps: build Docker image with git SHA tag, push to ACR, update Container App revision, deploy Function App.

### Auto-Migration

On startup, `src/server.ts` checks if the `captures` table exists by querying `pg_tables`. If not, it reads `migrations/001_initial_schema.sql` and runs it. Uses `pool.query` (raw pool) instead of the pgvector-typed client to avoid a chicken-and-egg problem: pgvector type registration requires the `vector` extension to exist, but the extension is created by the migration itself.

### Docker

Multi-stage build (`Dockerfile`):
1. **Builder stage:** `node:20-alpine`, `npm ci`, `npm run build` (TypeScript compilation).
2. **Runner stage:** `node:20-alpine`, installs `ffmpeg` (for audio/video conversion), `npm ci --omit=dev`, copies compiled JS and migrations.

### Container App Configuration

- **minReplicas: 1** — Always-on. Eliminates cold start latency for Telegram webhooks.
- **Image tags must be unique** (git SHA). Azure Container Apps only creates a new revision when the image reference changes. Pushing under the same `latest` tag does not trigger redeployment.
- **Platform: linux/amd64** — Required when building on Apple Silicon.

### HNSW Indexes

Deferred. The B1ms PostgreSQL tier does not have enough memory to build HNSW indexes for 3072-dimension vectors. PostgreSQL requires the entire index to fit in `maintenance_work_mem` during build. Sequential scans (`ORDER BY embedding <=> $1`) work correctly at single-user scale. The index creation SQL is commented out in the migration file.

---

## 14. Known Limitations & Gotchas

### Gemini 2.5 Flash

- **maxTokens must be >= 1024:** Gemini 2.5 Flash's thinking tokens consume the output token budget. If maxTokens is too low, the model may exhaust the budget on thinking before producing any output. All calls use at least `maxTokens: 1024`.
- **`responseFormat: 'json'` is unreliable:** Setting `responseMimeType: 'application/json'` does not guarantee clean JSON. The `extractJson()` function strips markdown wrapping as a post-processing step.
- **Non-deterministic JSON output:** The same prompt can produce different JSON structures across calls. The `llmJsonParse` retry helper (3 attempts) mitigates this for critical paths.

### PostgreSQL

- **HNSW indexes cannot be created on B1ms tier:** Not enough memory for 3072-dimension vectors. Sequential scans are used instead.
- **pgvector chicken-and-egg:** Auto-migration uses `pool.query` (raw) instead of the pgvector-typed client because the `vector` extension does not exist until the migration creates it.

### Azure

- **ACR role assignment must be CLI:** Cross-resource-group scope (ACR in `shared-rg`, Container App in `openbrain-rg`) cannot be expressed in Bicep.
- **Container App revisions require unique image tags:** Pushing a new image under the `latest` tag does not trigger a new revision. Always use git SHA tags.
- **Docker image must be pushed before first Bicep deploy:** The Container App references an image at deploy time. If it does not exist, Bicep fails.

### Telegram

- **Document handler needs try/catch:** All media handlers wrap processing in try/catch to guarantee a reply to the user even on error. Without this, the user sees no response and Telegram retries.
- **Media groups not yet supported:** Telegram sends media groups as separate messages with the same `media_group_id`. Requires stateful message buffering with a short timeout. Deferred.
- **Webhook timeout prevention:** The webhook responds 200 immediately and processes in the background. Without this, Telegram retries after ~60 seconds, causing duplicate processing.

### Dedup

- **File hash = exact match** (SHA-256 of original bytes). Same image with different text is a different capture.
- **Semantic dedup = content similarity** (cosine similarity > 0.95 on embedding). This is the actual dedup gate.
- **Conversion happens after hash check:** Files are hashed in their original form, then converted for embedding. The original file is uploaded to blob storage.

### Consolidation

- **Completed reminders as signal:** Only `done` status is read. The spec mentions cancelled and blocked as signal, but the current implementation filters on `status = 'done'` only.
- **Subtask project cascade on update:** `updateReminder()` only updates the specified reminder's project/section. However, `reparentReminder()` does cascade project/section to all children.

### Testing

- **OOM with default pool:** Integration tests that create many full app instances can exceed default Node heap. Fixed with `pool: 'forks'` and `--max-old-space-size=4096` in vitest config.
- **Test file splitting:** Some test files were split (e.g., `reminders.test.ts` + `reminders-features.test.ts`) to avoid OOM within a single fork.

---

## 15. Testing

**Framework:** Vitest

**345 tests across 44 files.** Test suite uses `pool: 'forks'` with `--max-old-space-size=4096` to avoid OOM when integration tests create many full app instances.

### Test Categories

**Unit tests (36 files):**
- DB modules: captures, facts, insights, reminders, reminders-features, reminder-comments, consolidation-log, client
- Providers: gemini-embedding, gemini-llm, anthropic-llm, provider-errors
- Capture pipeline: dedup, metadata, media-convert, pipeline, pipeline-regression
- Consolidation: clustering, phase1, phase2, phase3
- Retrieval: profile, search
- Notifications: digest, due-date-checker, format-reminders, review
- MCP: profiler-tools, reminder-tools
- Telegram: handlers, intent-classification, mime-types
- Other: app, config, server-migration, blob storage

**Integration tests (7 files):**
- `api.test.ts` — REST API endpoint tests
- `mcp-auth.test.ts` — MCP authentication tests
- `nl-reminder-parsing.test.ts` — Real Gemini Flash calls for NL parsing quality (20 tests, retry-tolerant)
- `telegram-pipeline.test.ts` — Full webhook -> intent -> action -> reply with mocked bot, real handlers
- `telegram-webhook.test.ts` — Webhook handler integration tests
- `telegram-nl.test.ts` — NL router integration tests
- `telegram-cascade-move.test.ts` — Cascade done and reparent/move integration tests

**E2E tests (1 file):**
- `api-e2e.test.ts` — Full cycle E2E tests against real PostgreSQL (requires docker compose)

### Test Configuration

| Config File | Scope | Pool | Notes |
|-------------|-------|------|-------|
| `vitest.config.ts` | Unit + integration tests | `forks` | `execArgv: ['--max-old-space-size=4096']` to avoid OOM |
| `vitest.e2e.config.ts` | E2E tests | default | 30s timeout, requires `E2E_DATABASE_URL` |

### Running Tests

```bash
npm test                    # Unit + integration tests (no external deps except GEMINI_API_KEY for LLM tests)
npm run test:e2e            # E2E tests (requires docker compose PostgreSQL on port 5434)
npm run test:integration    # Integration tests only
```

### CI

`.github/workflows/ci.yml` runs on PR and push to main:
1. `npm ci` + `tsc --noEmit` (type check)
2. `npm test` (unit tests, passes `GEMINI_API_KEY` secret for LLM integration tests)
3. `npm run test:e2e` (E2E tests against PostgreSQL service container on port 5432)

The CI workflow uses a `pgvector/pgvector:pg16` service container for E2E tests.

### Test Helpers

`tests/helpers/mocks.ts` — Shared mock factories for DbClient, EmbeddingProvider, LLMProvider, BlobStorage, and Config.

---

## 16. File Map

```
open-brain-v2/
  src/
    server.ts                         Entry point. App Insights init, migrations, starts HTTP server + background checkers.
    app.ts                            Hono app. Routes, middleware (CORS, auth, rate limiting), error handler.
    config.ts                         Zod-validated environment config with defaults.

    capture/
      pipeline.ts                     Universal ingest pipeline (hash -> embed -> dedup -> upload+metadata -> insert).
      dedup.ts                        File hash check (SHA-256) + semantic dedup (cosine > 0.95).
      metadata.ts                     LLM metadata extraction (people, topics, action_items, dates, type).
      media-convert.ts                Convert files to Gemini-supported MIME types (sharp for images, ffmpeg for audio/video).

    consolidation/
      runner.ts                       Orchestrator: guard rails, Phase 1/2/3 sequencing, token budget tracking, logging.
      phase1.ts                       Capture -> Fact promotion. LLM prompt with noise criteria, per-cluster transactions.
      phase2.ts                       Fact -> Insight generation. Cross-cutting patterns, min 2 source facts, atomic commit.
      phase3.ts                       Re-embed facts/insights with NULL embeddings, dispatch review notifications.
      clustering.ts                   DBSCAN on embedding vectors (cosine distance). Noise points -> individual clusters.

    retrieval/
      profile.ts                      get_user_profile: insights + uncovered facts + active reminders -> Gemini Flash synthesis.
      search.ts                       search_thoughts: tiered search (insights -> facts -> captures) with conditional evidence.

    services/
      index.ts                        ServiceDeps interface — dependency injection contract for all service modules.
      captures.ts                     captureThought (pipeline), searchThoughts, listCaptures, getCapture, archive/unarchive.
      comments.ts                     addComment, listComments, getComment, updateComment, deleteComment (owns embedding).
      consolidation.ts                runConsolidation (delegates to pipeline runner), getConsolidationLogs.
      facts.ts                        getFact, listFacts, updateFact (re-embeds), archiveFact, reviewPendingFacts, approveRejectFact.
      insights.ts                     getInsight, listInsights, updateInsight, archiveInsight, reviewPendingInsights, approveRejectInsight.
      profile.ts                      getUserProfile (LLM synthesis), getBrainStats (dashboard counts).
      reminders.ts                    Full CRUD + createReminder (validates depth, embeds), completeReminder (cascade), reparentReminder.
      tags.ts                         updateTags (validates allowlist, routes to correct DB table), getAllowedTags.

    db/
      client.ts                       PostgreSQL pool + pgvector type registration + transaction helper.
      captures.ts                     CRUD for captures table. Similarity search, hash lookup, status updates.
      facts.ts                        CRUD for facts table. User edit, version tracking, similarity search, review status.
      insights.ts                     CRUD for insights table. Similarity search, review status, archival.
      reminders.ts                    CRUD for reminders. Hierarchy (subtasks), filtering, project stats, due date queries.
      reminder-comments.ts            CRUD for reminder_comments. getCommentById, updateComment, deleteComment.
      consolidation-log.ts            Insert + query consolidation run logs.

    providers/
      types.ts                        EmbeddingProvider and LLMProvider interfaces. LLMMessage, LLMOptions, LLMResponse types.
      gemini-embedding.ts             Gemini Embedding 2 (gemini-embedding-2-preview, 3072 dims, multimodal).
      gemini-llm.ts                   Gemini 2.5 Flash (gemini-2.5-flash). Includes extractJson() workaround.
      anthropic-llm.ts                Claude Opus 4.6 (claude-opus-4-6, default max 8192 tokens).

    mcp/
      server.ts                       MCP server setup (McpServer + streamable HTTP transport + auth middleware).
      profiler-tools.ts               13 profiler tools including brain_help, get_user_profile, capture, search, review.
      reminder-tools.ts               10 reminder tools: CRUD, comments (add/edit/delete), projects.

    telegram/
      webhook.ts                      Bot setup, webhook route, shared state initialization, dedup guard, registers handler modules.
      command-handlers.ts             All /slash command handlers + callback_query handler (inline buttons, action menu, status cycle).
      nl-router.ts                    NL intent classifier + NL action handlers + pending state machines + media handlers.
      handlers.ts                     Pure handler functions (testable without bot instance): text, photo, voice, document.
      prompts.ts                      Intent classifier and reminder parser system prompts (date-aware, timezone-aware).
      llm-parse.ts                    llmJsonParse<T>() retry helper (3 attempts, returns null on failure).
      state.ts                        Shared state types: LastActionEntry, PendingSubtaskEntry, PendingActionEntry, StateRefs.
      mime-utils.ts                   Extension-to-MIME map (25 types), resolveMimeType(), getSummarizationRoute().

    notifications/
      format-reminders.ts             Reminder display formatting. Groups by project/section, subtask indentation, status icons.
      review.ts                       getPendingReviewCount (facts + insights).
      digest.ts                       Daily digest message formatter + Telegram sender.
      due-date-checker.ts             Due date polling (60s), daily report at configured time, timezone-aware date math.

    storage/
      blob.ts                         Azure Blob Storage wrapper (upload, exists, getUrl).

  migrations/
    001_initial_schema.sql            Full schema: 6 tables, pgvector extension, B-tree + GIN indexes (HNSW commented out).

  infra/
    main.bicep                        Top-level Bicep template. Orchestrates all modules.
    parameters.json                   Non-secret parameters (environment, ACR name, schedule).
    modules/
      container-app.bicep             Container App (minReplicas: 1, managed identity).
      function-app.bicep              Function App (consumption plan, timer trigger).
      keyvault.bicep                  Key Vault with all secrets.
      monitoring.bicep                Log Analytics + App Insights.
      postgresql.bicep                PostgreSQL Flexible Server (B1ms, pgvector).
      storage.bicep                   Blob Storage account + container.

  functions/
    consolidation-trigger/
      function.json                   Timer trigger binding config.
      index.ts                        Azure Function entry point for consolidation.

  scripts/
    deploy.sh                         Manual deploy script.
    migrate-azure.sh                  Manual migration script for Azure PostgreSQL.

  tests/
    helpers/
      mocks.ts                        Shared mock factories for all dependencies.
    unit/                             36 test files covering all source modules.
    integration/                      7 test files (API, MCP auth, NL parsing, Telegram pipeline/webhook/NL/cascade-move).
    e2e/
      api-e2e.test.ts                 Full cycle E2E tests against real PostgreSQL.

  .github/workflows/
    ci.yml                            CI: typecheck + unit tests on PR/push.
    deploy.yml                        CD: build, push, deploy on push to main (OIDC).

  docker-compose.yml                  Local PostgreSQL + pgvector for development.
  Dockerfile                          Multi-stage build (node:20-alpine, ffmpeg).
  package.json                        Dependencies and scripts.
  tsconfig.json                       TypeScript config.
  vitest.config.ts                    Vitest config (unit + integration, forks pool, 4GB heap).
  vitest.e2e.config.ts                Vitest config (E2E tests, 30s timeout).
  README.md                           Project overview and local dev setup.
  SETUP.md                            First-time Azure deployment guide with gotchas.
```

---

## Appendix: Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `OPEN_BRAIN_API_KEY` | Yes | — | API key for REST and MCP auth |
| `AZURE_STORAGE_CONNECTION_STRING` | Yes | — | Blob Storage connection string |
| `AZURE_STORAGE_CONTAINER` | Yes | — | Blob container name |
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram Bot API token |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | — | Verifies Telegram webhook calls |
| `TELEGRAM_CHAT_ID` | Yes | — | User's Telegram chat ID (for notifications) |
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `REVIEW_MODE` | No | `hybrid` | `autonomous` / `hybrid` / `ask` |
| `DAILY_DIGEST_ENABLED` | No | `true` | Enable daily digest Telegram message |
| `TIMEZONE` | No | `America/Chicago` | IANA timezone for due date calculations and daily report |
| `DAILY_REPORT_TIME` | No | `09:00` | Time (HH:MM) to send the daily report |
| `CONSOLIDATION_SCHEDULE` | No | `0 */30 * * * *` | Azure Functions CRON (6 fields, seconds first) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | No | — | App Insights (auto-set by Azure) |
