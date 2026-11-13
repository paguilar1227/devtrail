# DevTrail 2.0 — Design Specification

## Vision

DevTrail is a **bonding layer between human and AI** — a personal knowledge system that maintains a living profile of the user and supports their daily workflow. Its primary purpose is to help AI tools quickly understand who the user is *right now* — preferences, identity, habits, skills, relationships, opinions — so they can tailor responses and pull relevant context. Its secondary purpose is to serve as a personal productivity layer (reminders, todos) that feeds back into the profile. It is not a journal or historical record, though it passively preserves change history for future use.

DevTrail 2.0 transforms the original thought-capture tool into a **personal search engine** powered by three layered improvements: write-time consolidation, retrieval-time synthesis, and multimodal embeddings.

## Core Design Principle

**Living profile, not a journal.** Facts and insights always reflect present-tense, current state. Raw captures preserve history implicitly (they're immutable). The `previous_versions` field on facts passively tracks how the profile has evolved, but this data is never surfaced in default retrieval.

## System Architecture

### Hosting: Azure

- **API Layer:** Azure Container App (consumption plan, scales to zero)
  - REST API (universal ingest endpoint)
  - MCP Server (JSON-RPC 2.0)
  - Telegram Bot webhook handler
  - Provider abstraction layer (embedding + LLM interfaces)
- **Consolidation:** Azure Function (timer trigger, daily)
  - Capture → Fact promotion
  - Fact refinement
  - Insight generation / regeneration
  - Dedup detection
  - Notification dispatch
- **Database:** Azure Database for PostgreSQL (Flexible Server, pgvector extension)
- **File Storage:** Azure Blob Storage (multimodal files: images, audio, video, PDFs)

### AI Models

All AI calls go through a **provider abstraction layer** — embedding and LLM providers are pluggable interfaces, swappable without code changes.

| Task | Model | Provider | Rationale |
|------|-------|----------|-----------|
| Embeddings (multimodal) | Gemini Embedding 2 | Google Gemini API | Only model with native text+image+audio+video embedding in a single vector space |
| Metadata extraction | Gemini Flash | Google Gemini API | Fast, cheap, structured output — reasoning not required |
| Consolidation | Claude Opus 4.6 | Anthropic API | Best reasoning + nuance preservation for profile synthesis, runs async |
| Retrieval synthesis | Gemini Flash | Google Gemini API | Good balance of speed + quality for on-demand use |

### Estimated Monthly Cost (single user)

| Component | Cost |
|-----------|------|
| Azure PostgreSQL (Flexible Server B1ms) | ~$13 |
| Azure Container App (consumption) | ~$1-2 |
| Azure Function (consumption) | ~$0 (free tier) |
| Azure Blob Storage | ~$0.50 |
| Gemini API (embeddings + metadata + retrieval synthesis) | ~$0.40 |
| Anthropic API (consolidation) | ~$0.50-1 |
| **Total** | **~$16-18/mo** |

Azure credits ($150/mo) cover Azure services. Google Cloud credits ($100/mo) cover Gemini API. Anthropic costs are out-of-pocket at ~$1/mo.

## Data Model

### Three-Tier Architecture

Data flows through three tiers: raw captures → synthesized facts → cross-cutting insights. Each tier is independently searchable via vector embeddings. Relationships are many-to-many at both promotion boundaries (one capture can produce multiple facts; one fact can inform multiple insights).

### Table: captures

Tier 1 — raw, immutable inputs. Never deleted, never modified. Marked `consolidated` after processing but remain in the table as an audit trail.

```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
content         text NOT NULL
content_types   text[]          -- 'text' | 'image' | 'audio' | 'video' | 'pdf' (per file)
file_urls       text[]          -- Azure Blob Storage URLs (null for text-only)
file_hashes     text[]          -- SHA-256 of file bytes (null for text-only)
embedding       vector(3072)    -- Gemini Embedding 2 output (must request 3072 dims explicitly)
metadata        jsonb           -- {people, topics, action_items, dates, type}
source          text[]          -- ['telegram'] | ['mcp'] | ['api'] (single-element array per capture)
tags            text[]          -- semantic tags from 14-tag allowlist (see Tag System below)
status          varchar DEFAULT 'pending'  -- 'pending' | 'consolidated' | 'failed'
archived        boolean DEFAULT false
created_at      timestamptz DEFAULT now()
updated_at      timestamptz DEFAULT now()  -- tracks status changes

-- Indexes
HNSW ON embedding (cosine distance)
GIN ON tags
GIN ON source
B-tree ON status
B-tree ON archived
B-tree ON created_at DESC
```

### Table: facts

Tier 2 — synthesized, mutable profile knowledge. Represents the living profile. Carries `previous_versions` for passive history tracking.

```sql
id                  uuid PRIMARY KEY DEFAULT gen_random_uuid()
content             text NOT NULL
tags                text[]      -- semantic tags from 14-tag allowlist (replaces category)
source              text[]      -- union of contributing captures' source arrays
embedding           vector(3072)
confidence          float       -- 0.0 to 1.0
source_capture_ids  uuid[]      -- which captures produced this fact
origin              varchar     -- 'consolidation' | 'user_edited' | 'user_created'
review_status       varchar DEFAULT 'auto_approved'
                                -- 'pending_review' | 'auto_approved'
                                -- | 'user_approved' | 'user_rejected'
previous_versions   jsonb DEFAULT '[]'
                                -- [{content, confidence, changed_at, reason}]
archived            boolean DEFAULT false
created_at          timestamptz DEFAULT now()
updated_at          timestamptz DEFAULT now()
edited_at           timestamptz -- set when user directly edits

-- Indexes
HNSW ON embedding (cosine distance)
GIN ON source_capture_ids      -- reverse provenance lookups
GIN ON tags
GIN ON source
B-tree ON confidence
B-tree ON review_status
B-tree ON archived
```

### Table: insights

Tier 3 — cross-cutting patterns derived from multiple facts. Highest value tier. Always flagged for user review in hybrid mode.

```sql
id                uuid PRIMARY KEY DEFAULT gen_random_uuid()
content           text NOT NULL
tags              text[]      -- semantic tags from 14-tag allowlist (replaces category)
source            text[]      -- union of contributing facts' source arrays
embedding         vector(3072)
confidence        float       -- 0.0 to 1.0
source_fact_ids   uuid[]      -- which facts produced this insight
origin            varchar     -- 'consolidation' | 'user_edited'
review_status     varchar DEFAULT 'pending_review'
archived          boolean DEFAULT false
generated_at      timestamptz DEFAULT now()
updated_at        timestamptz DEFAULT now()
edited_at         timestamptz -- set when user edits via approve_reject

-- Indexes
HNSW ON embedding (cosine distance)
GIN ON source_fact_ids          -- reverse provenance lookups
GIN ON tags
GIN ON source
B-tree ON review_status
B-tree ON archived
```

### Table: consolidation_log

Audit trail for consolidation runs. Provides observability into system health.

```sql
id                      uuid PRIMARY KEY DEFAULT gen_random_uuid()
run_at                  timestamptz DEFAULT now()
status                  varchar     -- 'success' | 'partial' | 'failed' | 'no-op'
                                    -- success: both phases completed
                                    -- partial: Phase 1 completed (fully or partially), Phase 2 failed or skipped
                                    -- failed: Phase 1 failed entirely (no clusters committed)
                                    -- no-op: nothing to process
captures_processed      int
facts_created           int
facts_updated           int
insights_created        int
insights_regenerated    int
duplicates_detected     int
items_flagged           int     -- sent for user review
model_used              varchar -- 'claude-opus-4-6'
tokens_used             int     -- total tokens consumed
duration_ms             int     -- how long the run took
error_message           text    -- null on success, error details on failure
```

### Relationships

```
captures  ──[many-to-many via source_capture_ids[]]──→ facts
facts     ──[many-to-many via source_fact_ids[]]──→ insights
reminders ──[self-referential via parent_id]──→ reminders (subtasks)
reminders ──[one-to-many via reminder_id]──→ reminder_comments
```

No join tables — arrays store references for profiler relationships. A single capture can feed multiple facts. A single fact can feed multiple insights. Reminders use `parent_id` for subtask hierarchy and a foreign key for comments.

## Tag System

Every capture, fact, and insight carries a `tags text[]` column for semantic classification. Tags replaced the old `category varchar` field — they are multi-valued, apply to all three tiers, and use a curated allowlist.

### 14 Allowed Tags

| Tag | Retrieval question answered | Example |
|-----|-----------------------------|---------|
| `preference` | How do I like X done? | "Pedro prefers Hono over Express for TypeScript APIs" |
| `decision` | What did I decide and why? | "Chose JWT sessions over server-side, prioritizing simplicity" |
| `problem-solution` | Have I dealt with this before? | "Fixed Telegram retry loop by responding 200 immediately" |
| `pattern` | What are my tendencies? | "Tends to defer tests until after first bugs appear" |
| `goal` | What am I working toward? | "Training for a half marathon in October" |
| `opinion` | What do I think/believe about X? | "Believes monorepos are right for tightly coupled services" |
| `skill` | What can I do / what's my level? | "Deep TypeScript expertise, new to React" |
| `relationship` | What do I know about person X? | "Sarah prefers async communication, birthday June 12" |
| `resource` | What was that reference/tool/link? | "pgvector HNSW needs 2x working memory — see PostgreSQL wiki" |
| `idea` | What have I been mulling over? | "Might convert the garage into a workshop" |
| `interest` | What am I into? | "Really enjoying bouldering lately" |
| `health` | What's relevant to my body/wellness? | "Allergic to penicillin, left knee flares when running downhill" |
| `dislike` | What should I avoid / never suggest? | "Hates writing YAML configuration files" |
| `milestone` | What have I accomplished? | "Launched DevTrail on March 21, 2026" |

### Tag Assignment Flow

- **Telegram and REST API:** pipeline auto-classifies tags via Gemini Flash during metadata extraction (one combined LLM call — no extra cost).
- **MCP `capture_thought`:** AI caller may provide `tags` upfront. If valid tags provided, used as-is. If omitted or invalid, pipeline auto-classifies.
- **Facts:** initialized as the union of all contributing captures' tags; consolidation LLM (Claude Opus) refines.
- **Insights:** initialized as the union of all contributing facts' tags; consolidation LLM refines.
- **Manual correction:** `update_tags` MCP tool replaces tags on any item by UUID.

### Source Arrays

`source` became a `text[]` column (was `varchar`). Captures have single-element sources: `['telegram']`, `['mcp']`, `['api']`. Facts and insights inherit the union of all contributing sources — a fact derived from both Telegram and MCP captures has `source: ['telegram', 'mcp']`.

## Capture Flow

### Universal Ingest Pipeline

All entry points (Telegram, MCP, future clients) converge on a single REST endpoint: `POST /api/v1/capture`.

```
Request body:
{
  "content": "string",        // required: text content or description
  "files": [File],            // optional: multipart file uploads
  "source": "telegram"        // which entry point
}
```

### Pipeline Steps

1. **Receive request** (text + optional file bytes)
2. **File hash check** (if files attached):
   - Compute SHA-256 hash for each file
   - Check hashes against existing captures
   - If match found: reuse existing `file_url`, skip re-upload (storage optimization, NOT a dedup gate)
   - If no match: mark file as "needs upload"
3. **Generate embedding** (Gemini Embedding 2, from text + file bytes together — NOT from a stored URL)
4. **Semantic dedup check**:
   - Compare embedding against ALL captures (not just recent — HNSW index is fast at any scale)
   - Similarity > 0.95 → duplicate, stop and return warning
   - Similarity ≤ 0.95 → proceed
5. **Upload files** (parallel with step 6):
   - Files marked "needs upload" → Azure Blob Storage → get URL
   - Files already stored → reuse existing URL
6. **Extract metadata** (Gemini Flash, parallel with step 5):
   - people, topics, action_items, dates, type
7. **Insert into `captures` table** (status = 'pending')
8. **Return confirmation** to caller

### Telegram-Specific Handling

| Message Type | content | content_types | File Handling |
|-------------|---------|-------------|--------------|
| Text | message text | text | none |
| Photo | caption or AI description | image | download via Bot API |
| Voice message | AI transcription + summary | audio | download .ogg via Bot API |
| Document/PDF | AI summary | pdf | download via Bot API |
| Media group | combined captions | mixed | download all files |

### Multi-File Support

Gemini Embedding 2 supports up to 6 images per request. Telegram supports media groups. The pipeline handles arrays:
- `file_urls[]`, `file_hashes[]`, `content_types[]` are all arrays
- File hash check loops over all files
- Single embedding generated from text + all file bytes together

## Consolidation Pipeline

Runs as an Azure Function on a daily timer trigger. Uses Claude Opus 4.6 for all reasoning tasks.

### Phase 1: Capture → Fact Promotion

1. Query all captures WHERE `status = 'pending'`
2. If none found AND no facts updated since last run → exit (no-op)
3. Group pending captures by topic similarity (cluster embeddings)
4. For each cluster, send to Opus with existing facts as context:
   - **Update existing fact?** → return fact ID + updated content + adjusted confidence. Store previous version in `previous_versions` array.
   - **Create new fact?** → return content + category + initial confidence + source capture IDs
   - **Not profile-relevant?** → mark captures as `consolidated`, no fact created

**Noise criteria** — only discard a capture if ALL of these are true:
- Contains no preference, opinion, or value judgment
- Contains no information about a person or relationship
- Contains no habit, routine, or behavioral pattern
- Contains no skill, tool, or technology association
- Contains no goal, aspiration, or plan
- Contains no emotional response or reaction
- Is purely transactional with no recurring significance

**When in doubt, create a fact with low confidence (0.3-0.4)** rather than discarding.

5. Mark all processed captures as `status = 'consolidated'`

### Phase 2: Fact → Insight Generation

1. Load all active facts (not rejected, confidence > 0.3)
2. Load existing insights
3. Send to Opus:
   - Identify cross-cutting patterns not obvious from any single fact
   - Update existing insights if underlying facts changed
   - Invalidate insights contradicted by new evidence
   - Do NOT generate insights that merely restate a single fact
4. New insights default to `review_status = 'pending_review'`

### Phase 3: Embed, Store & Notify

1. Generate embeddings for all new/updated facts and insights (Gemini Embedding 2)
2. Write Phase 2 results (new/updated insights) in a single database transaction (Phase 1 clusters already committed individually in Phase 1)
3. Write `consolidation_log` entry
4. If items flagged for review AND notifications enabled → send Telegram message

### Guard Rails

- **Skip if nothing to do:** no pending captures AND no facts updated since last run → exit immediately
- **Don't touch user_edited facts:** facts with `origin = 'user_edited'` are never overwritten. New contradicting evidence is flagged for user review instead.
- **Transaction safety:** all DB writes in a single transaction
- **Token budget:** separate budgets for Phase 1 (80K) and Phase 2 (50K). Counts both input and output tokens cumulatively across all LLM calls within each phase. Tracked via tokenizer estimate before each call — if the next call would exceed the budget, stop processing. Phase 1 has priority since it processes new data. If Phase 1 exhausts its budget, remaining captures stay `pending` for next run. If Phase 2 exceeds its budget, insight generation is deferred.
- **Partial commit support:** Phase 1 commits per-cluster (each cluster is its own transaction). If cluster 7 fails, clusters 1-6 are already committed. Phase 2 commits atomically (all-or-nothing) since it needs the full fact set for coherent insights.
- **Consolidation-time dedup:** during Phase 1, if Opus identifies that two existing facts are semantically identical (can happen when similar captures were processed in separate runs), it merges them — keeping the higher-confidence version, combining source_capture_ids, and archiving the duplicate.

### Clustering Algorithm

Phase 1 groups pending captures using **DBSCAN** (Density-Based Spatial Clustering) on embedding vectors:
- Does not require a pre-set number of clusters (unlike k-means)
- Handles noise naturally — unclustered captures are processed individually
- Parameters: `eps` (distance threshold) and `min_samples` (minimum cluster size) — tuned empirically, starting with `eps=0.3`, `min_samples=2`

## Retrieval Flow

### Path 1: get_user_profile (session bootstrap)

Called at the start of a session — answers "who is this person?"

1. Load all approved insights (`review_status IN ('auto_approved', 'user_approved')`)
2. Load high-confidence facts not already covered by an insight (`confidence >= 0.7 AND id NOT IN any insight's source_fact_ids`)
3. Synthesize into a coherent profile summary (Gemini Flash), organized by category
4. Return single coherent profile summary

### Path 2: search_thoughts (mid-session query)

Called when the AI needs specific information — answers "what does this person think about X?"

1. Embed query (Gemini Embedding 2)
2. **Tiered search:** search insights first → if match found, return insight. If not, search facts → if match found, return fact(s). If not, fall back to raw captures.
3. **Conditional evidence:** check confidence of returned items:
   - Confidence ≥ 0.7 → return as-is
   - Confidence < 0.7 → append source items from lower tier with note: "Moderate confidence — based on mixed evidence"

### Response Format

```json
{
  "tier": "insight | fact | capture",
  "confidence": 0.88,
  "content": "...",
  "tags": ["pattern", "preference"],
  "note": null,
  "evidence": null
}
```

Low-confidence response includes `evidence` array with source items and a `note` explaining the uncertainty.

## Service Layer Architecture

DevTrail uses a **hexagonal architecture** (ports and adapters pattern). All business logic lives in `src/services/`. The three adapter surfaces — REST API, MCP server, and Telegram bot — are thin wrappers that parse inputs, call service functions, and format responses.

### Service Modules

| Module | Key Functions |
|--------|--------------|
| `captures.ts` | `captureThought`, `searchThoughts`, `listCaptures`, `getCapture`, `archiveCapture` |
| `comments.ts` | `addComment`, `listComments`, `getComment`, `updateComment`, `deleteComment` |
| `consolidation.ts` | `runConsolidation`, `getConsolidationLogs` |
| `facts.ts` | `getFact`, `listFacts`, `updateFact`, `approveRejectFact`, `reviewPendingFacts` |
| `insights.ts` | `getInsight`, `listInsights`, `updateInsight`, `approveRejectInsight` |
| `profile.ts` | `getUserProfile`, `getBrainStats` |
| `reminders.ts` | `createReminder`, `listReminders`, `getReminderDetail`, `updateReminder`, `completeReminder`, `deleteReminder`, `reparentReminder`, `resolveReminderId`, `listProjects` |
| `tags.ts` | `updateTags`, `getAllowedTags` |

**Rule:** No business logic in adapters. All three surfaces (REST, MCP, Telegram) call service functions. Services import DB modules and providers. Adapters never import each other.

---

## MCP Tool Surface

23 tools exposed via JSON-RPC 2.0 (13 profiler + 10 reminders):

### AI Client Setup

Two mechanisms teach AI clients how to use DevTrail:

- **Server instructions (automatic):** The MCP server sends an `instructions` string on connection. MCP-compliant clients (Claude, etc.) apply it automatically — no user configuration needed.
- **`get_user_prompt` (portable):** For non-MCP clients (ChatGPT, etc.), this tool returns the same behavioral instructions as a copyable system prompt users paste into custom instructions once.

### Profiler Tools

| Tool | Purpose | Parameters |
|------|---------|-----------|
| `brain_help` | Returns AI usage guide — when/how to capture, 14-tag system, tag-filtered search | none |
| `get_user_prompt` | Returns a portable system prompt to paste into any AI client | none |
| `get_user_profile` | Session bootstrap — synthesized profile summary | none |
| `search_thoughts` | Tiered semantic search: insights → facts → captures, with conditional evidence on low confidence (see Retrieval Flow Path 2) | `query` (required), `threshold` (0-1, default 0.5), `limit` (default 10), `tags` (optional array — AND filter) |
| `capture_thought` | Capture from any MCP client. Tags are optional — provide when confident of type, otherwise auto-classified. | `content` (required), `file_urls` (optional), `tags` (optional array from 14-tag allowlist) |
| `brain_stats` | Dashboard — counts by tier, facts/insights/captures by tag, captures by source | none |
| `archive_thought` | Soft-delete (soft isolation, no cascade recalculation) | `id` (required), `type` ('capture' \| 'fact' \| 'insight') |
| `unarchive_thought` | Restore archived item | `id` (required), `type` ('capture' \| 'fact' \| 'insight') |
| `update_fact` | Edit/refine a fact directly (marks as `user_edited`, confidence → 1.0, preserves source links) | `id` (required), `content` (required) |
| `review_pending` | List items with `review_status = 'pending_review'` | `limit` (optional), `type` (optional: 'fact' \| 'insight', defaults to both) |
| `approve_reject` | Act on items in `pending_review` status — approve, reject, or edit | `id` (required), `action` ('approve' \| 'reject' \| 'edit'), `content` (required if action='edit'). Looks up by UUID across facts and insights tables (UUIDs are globally unique). Only operates on items with `review_status = 'pending_review'`. Use `update_fact` to edit already-approved facts. |
| `run_consolidation` | Manually trigger the consolidation pipeline | none |
| `update_tags` | Replace tags on any tier item (capture, fact, insight) | `id` (required, full UUID), `tier` ('capture' \| 'fact' \| 'insight'), `tags` (required array, replaces existing) |

### Archive Behavior

Archiving works on any tier (captures, facts, or insights) via the `type` parameter. Uses **soft isolation**: the item is excluded from future consolidation and search results, but existing facts/insights built from it remain unchanged. No cascade recalculation. Unarchiving makes the item visible again and eligible for the next consolidation run.

### Rejection Behavior

When a user rejects a fact or insight via `approve_reject`:
- `review_status` set to `user_rejected`
- Rejected items are excluded from `get_user_profile` and `search_thoughts` results
- Rejected facts are excluded from future insight generation (treated as if they don't exist)
- Rejected items are NOT deleted — they remain in the database for audit
- A rejected item can be un-rejected by calling `approve_reject` with `action = 'approve'`

### User Edit Behavior

When a user edits a fact via `update_fact`:
- Source capture links are **preserved** (provenance, not live dependency)
- `origin` set to `user_edited`
- `confidence` set to 1.0
- `edited_at` set to current timestamp
- Previous content stored in `previous_versions`
- Consolidation will **never auto-overwrite** this fact. New contradicting evidence is flagged for user review.

## Reminders & Todos

DevTrail is more than a profiler — it's a **bonding layer between human and AI**. Reminders are a core feature, not an add-on. They give the user a reason to interact with DevTrail daily, and the reminders themselves are profile signal (what someone reminds themselves about reveals interests, priorities, and active projects).

### Reminder Hierarchy

Reminders support a **Project → Section → Task** hierarchy with subtask nesting:

```
Project (e.g., "Deep Research Engine", "Personal", "QA Automation")
  └── Section (e.g., "Backend", "Deployment", "Design")
        └── Task (with status, priority, due date)
              ├── Comment (timestamped progress log entry)
              └── Subtask (recursive child task, up to 4 levels)
```

- Projects and sections are lightweight string identifiers — creating a project is implicit when a new project name is used. No separate project/section tables.
- A subtask is a reminder with a `parent_id` pointing to its parent. Subtasks can nest up to 4 levels (parent → child → grandchild → great-grandchild), though 2 levels is the common case.
- Comments are chronological progress log entries per task — "what happened." They're distinct from subtasks ("what needs to be done").

### Table: reminders

```sql
-- Follows core table shape (see Extensibility Conventions)
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
content         text NOT NULL           -- the reminder/task text
embedding       vector(3072)            -- enables cross-type semantic search
metadata        jsonb                   -- type-specific attrs (future: recurrence)
category        varchar                 -- auto-determined from semantic context
                                        -- e.g., 'work' | 'personal' | 'health'
                                        -- | 'learning' | 'finance' | 'social'
project         varchar                 -- project grouping (e.g., 'deep-research-engine')
section         varchar                 -- section within project (e.g., 'backend')
parent_id       uuid                    -- null for top-level, references reminders.id for subtasks
depth           int NOT NULL DEFAULT 0  -- 0 = top-level, 1-3 = subtask depth (max 4 levels)
status          varchar DEFAULT 'not_started'
                                        -- 'not_started' | 'in_progress' | 'researching'
                                        -- | 'paused' | 'done' | 'blocked' | 'cancelled'
priority        varchar                 -- 'P1' | 'P2' | 'P3' | null (no priority)
source_context  text                    -- what conversation/capture triggered it
source          varchar                 -- 'telegram' | 'mcp' | 'api'
archived        boolean DEFAULT false
due_date        timestamptz             -- nullable
created_at      timestamptz DEFAULT now()
updated_at      timestamptz DEFAULT now()

-- Indexes
HNSW ON embedding (cosine distance)
B-tree ON status
B-tree ON category
B-tree ON project
B-tree ON section
B-tree ON parent_id
B-tree ON priority
B-tree ON archived
B-tree ON due_date (where not null)
B-tree ON depth
```

### Table: reminder_comments

Chronological progress log per task. Follows the core table shape.

```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
content         text NOT NULL           -- the comment text
embedding       vector(3072)            -- enables cross-type semantic search
reminder_id     uuid NOT NULL           -- which reminder this comment belongs to
source          varchar                 -- 'telegram' | 'mcp' | 'api'
created_at      timestamptz DEFAULT now()

-- Indexes
HNSW ON embedding (cosine distance)
B-tree ON reminder_id
B-tree ON created_at DESC
```

Comments get embeddings for cross-type semantic search — "What progress have I made on the research engine?" should pull from comments, not just task titles.

### MCP Tools (10 reminder tools)

| Tool | Purpose | Parameters |
|------|---------|-----------|
| `create_reminder` | Create a task or subtask | `content` (required), `project` (optional), `section` (optional), `parent_id` (optional — for subtasks), `category` (optional, auto-determined if omitted), `priority` (optional — P1/P2/P3), `due_date` (optional), `source_context` (optional) |
| `list_reminders` | List reminders with flexible filtering | `project` (optional), `section` (optional), `status` (optional), `priority` (optional), `category` (optional), `due_before` (optional), `due_after` (optional), `include_done` (optional, default false), `top_level_only` (optional, default true), `limit` (optional, default 20) |
| `get_reminder_detail` | Get a single task with ALL comments and full subtask tree | `id` (required) |
| `update_reminder` | Change status, priority, content, due date, move to different section | `id` (required), `status` (optional), `priority` (optional), `content` (optional), `due_date` (optional), `project` (optional), `section` (optional) |
| `complete_reminder` | Shortcut for marking done — cascades to subtasks | `id` (required) |
| `delete_reminder` | Delete a task and cascade-delete subtasks + comments | `id` (required) |
| `add_reminder_comment` | Add a progress comment to a task | `id` (required), `content` (required) |
| `list_projects` | List all projects with summary stats (task counts by status) | none |
| `edit_comment` | Edit the text of an existing comment (re-embeds content) | `id` (required — comment UUID), `content` (required — new text) |
| `delete_comment` | Delete a comment by ID; returns the deleted comment content | `id` (required — comment UUID) |

### Telegram Support

**Slash commands:**
- `/remind <text>` — creates a reminder (parsed via LLM for project/priority/due date)
- `/todos` — lists active reminders with inline keyboard (done/cycle/action buttons)
- `/done <id>` — marks a reminder complete (cascade-completes subtasks, supports short IDs)
- `/delete <id>` — deletes a reminder and all subtasks/comments
- `/edit <id> <new text>` — edits a reminder's content
- `/move <id> <parent-id|root>` — moves a task under another task or to root level
- `/comment <id> <text>` — adds a progress comment to a task
- `/subtask` — select a reminder and add a subtask (inline keyboard flow)

**Natural language interface:** All plain text messages are routed through an LLM-powered intent classifier that can create, list, complete, update, comment, move, or undo tasks without slash commands. Each interpreted action shows a confirmation with undo hint.

**Action menu:** Per-task inline keyboard (gear button) with edit, comments (view + edit + delete), move, delete, and subtask actions. The Comments view shows each comment with edit and delete buttons per entry. Editing a comment sets `pendingAction` to `comment-edit`; the next message replaces the comment content.

### Subtask Behavior

- **Creating:** `create_reminder` with `parent_id` creates a subtask. Validates parent exists and depth < 4.
- **Completing (cascade done):** Completing a parent auto-completes all descendant subtasks recursively. `completeReminder()` walks the subtask tree and marks every non-done, non-cancelled child as done. Returns `{ completed: string[] }` with all affected IDs.
- **Deleting (cascade delete):** `delete_reminder` cascade-deletes all descendant subtasks and their comments.
- **Moving (reparent):** `reparentReminder()` moves a task under a new parent (or to root with `null`). Updates depth, project, and section to match the new parent, and recursively updates all children. `resolveReminderId()` accepts short ID prefixes (e.g., "4e0bd1b2") for ergonomic Telegram/CLI usage.
- **Listing:** `list_reminders` with `top_level_only=true` (default) shows only depth-0 tasks. Set `top_level_only=false` to see subtasks. `get_reminder_detail` always returns the full subtask tree.

### Integration with the Profiler

Reminders feed back into the consolidation pipeline:
- **Completed reminders** are treated as profile signal during consolidation. "User completed a Rust CLI research task" informs skills/interests facts. The consolidation job reads recently completed reminders alongside pending captures.
- **Comments** are also profile signal — progress notes reveal work patterns, blockers, and decisions.
- **Cancelled reminders** are weaker signal but still informative — patterns of cancellation can indicate shifting priorities.
- **Active reminder projects/categories** inform `get_user_profile` — the profile summary includes a brief note about what the user is currently focused on based on active reminders and their project groupings.
- **Blocked reminders** are strong signal — what blocks someone reveals dependencies and constraints in their life.

### v3 Expansion

- ~~Due date notifications (Telegram push at specified time)~~ -- **Implemented in v2:** per-reminder alerts when due + daily report at configured time (`DAILY_REPORT_TIME` in `TIMEZONE`)
- Recurring reminders
- Webapp/mobile app reminder management UI
- Calendar integration (reminders with dates show as calendar events)

## Notification & Review System

### Review Modes (configurable, independent of digest)

| Mode | Behavior |
|------|----------|
| **Autonomous** | Everything auto-approved. No review queue. |
| **Hybrid** (default) | Low-impact auto-approved. High-impact flagged for review. |
| **Ask** | Everything flagged for review. Nothing committed without approval. |

### Daily Digest (independent toggle)

Separate from review mode — can be enabled in any mode. Sent via Telegram:

```
🧠 DevTrail Daily Digest
Processed: 8 captures
Facts created: 2 | Updated: 3
Insights created: 1
⚡ 3 items need your review

📋 Reminders: 5 active | 2 completed today
Tap /review to see pending items
Tap /todos to see your reminders
```

### Auto-Approved vs Flagged (Hybrid Mode)

**Auto-approved (silent):**
- New facts with category: preference, habit, skill, history
- Fact refinements where confidence moves < 0.15 points
- Captures marked as "no fact"
- Consolidation runs with no new insights

**Flagged for review:**
- All new insights (always — identity-level conclusions)
- New facts with category: personality, opinion, relationship
- Fact refinements where confidence shifts > 0.15 points
- Facts that contradict a `user_edited` fact
- Insight regeneration with material content change

### Review Paths

1. **Telegram:** `/review` command shows pending items with Approve / Edit / Reject buttons
2. **MCP:** any AI client can call `review_pending` → `approve_reject` tools

## Capture Entry Points

### v2.0

1. **Telegram Bot** — text, photos, voice memos, documents (up to 2GB). Thin wrapper over `POST /api/v1/capture`.
2. **MCP `capture_thought` tool** — text + file references from any MCP client (Claude, ChatGPT, etc.)

### Future (v3+)

- Dedicated mobile/web app
- iOS Shortcuts
- Email forwarding
- Calendar/Notes/Reminders integration
- All entry points POST to the same universal REST API

## Provider Abstraction Layer

Two interfaces, independently swappable:

```typescript
interface EmbeddingProvider {
  embed(content: string, files?: Buffer[]): Promise<number[]>
  dimensions: number  // 3072 for Gemini Embedding 2
}

interface LLMProvider {
  complete(messages: LLMMessage[], options?: {
    model?: string
    systemPrompt?: string
    responseFormat?: 'json' | 'text'
    maxTokens?: number
  }): Promise<string>
}

type LLMMessage = {
  role: 'user' | 'assistant'
  content: string
}
```

Current implementations:
- `GeminiEmbeddingProvider` — Gemini Embedding 2
- `GeminiLLMProvider` — Gemini Flash (metadata extraction, retrieval synthesis)
- `AnthropicLLMProvider` — Claude Opus 4.6 (consolidation)

Future providers can be added without modifying any business logic.

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js / TypeScript |
| API Framework | Hono |
| Database | PostgreSQL + pgvector (Azure Flexible Server) |
| File Storage | Azure Blob Storage |
| Compute (API) | Azure Container Apps |
| Compute (consolidation) | Azure Functions |
| Container Registry | Azure Container Registry (shared, existing) |
| Embeddings | Gemini Embedding 2 (Google API) |
| LLM (metadata) | Gemini Flash (Google API) |
| LLM (consolidation) | Claude Opus 4.6 (Anthropic API) |
| LLM (retrieval synthesis) | Gemini Flash (Google API) |
| Bot | Telegram Bot API |
| Protocol | MCP (Model Context Protocol) 2024-11-05 |

## REST API

The REST API (`src/app.ts`, Hono framework) provides comprehensive CRUD for all resources. It is a thin adapter over the service layer — routes parse inputs, call service functions, and return JSON. No business logic lives in routes.

### Endpoint Summary

**Captures:** `GET/POST /api/v1/captures`, `GET /api/v1/captures/:id`, `PATCH /api/v1/captures/:id/tags`, `POST /api/v1/captures/:id/archive`, `POST /api/v1/captures/:id/unarchive`

**Facts:** `GET /api/v1/facts`, `GET /api/v1/facts/:id`, `PUT /api/v1/facts/:id`, `PATCH /api/v1/facts/:id/tags`, `POST /api/v1/facts/:id/archive`, `POST /api/v1/facts/:id/unarchive`, `POST /api/v1/facts/:id/approve`, `POST /api/v1/facts/:id/reject`

**Insights:** `GET /api/v1/insights`, `GET /api/v1/insights/:id`, `PUT /api/v1/insights/:id`, `PATCH /api/v1/insights/:id/tags`, `POST /api/v1/insights/:id/archive`, `POST /api/v1/insights/:id/unarchive`, `POST /api/v1/insights/:id/approve`, `POST /api/v1/insights/:id/reject`

**Reminders:** `GET/POST /api/v1/reminders`, `GET /api/v1/reminders/:id`, `PATCH /api/v1/reminders/:id`, `POST /api/v1/reminders/:id/complete`, `DELETE /api/v1/reminders/:id`, `POST /api/v1/reminders/:id/reparent`

**Comments:** `GET/POST /api/v1/reminders/:id/comments`, `GET /api/v1/comments/:id`, `PUT /api/v1/comments/:id`, `DELETE /api/v1/comments/:id`

**Other:** `POST /api/v1/search`, `GET /api/v1/profile`, `GET /api/v1/stats`, `GET /api/v1/review/pending`, `GET /api/v1/projects`, `GET /api/v1/consolidation/logs`, `POST /api/v1/consolidation/trigger`

---

## API Authentication

All endpoints require authentication:

- **REST API (`/api/v1/*`):** Bearer token via `Authorization` header. A single `DEVTRAIL_API_KEY` environment variable. Rate limited to 100 requests/minute per key.
- **MCP Server:** `x-brain-key` header or `?key=` query parameter (same as v1, backward compatible).
- **Telegram Webhook:** verified via Telegram's secret token mechanism (set during webhook registration).

### MCP File Handling

MCP operates over JSON — binary files cannot be sent directly. The `capture_thought` tool accepts `file_urls` (array of accessible URLs). The server downloads the files from the provided URLs, processes them through the capture pipeline. This supports:
- URLs to publicly accessible files
- Pre-signed Azure Blob Storage URLs
- Telegram file URLs (if the MCP client has access)

For MCP clients that don't have file upload capability, users should capture multimodal content via Telegram instead.

### Embedding Dimensions

All embeddings use **3072 dimensions** (Gemini Embedding 2's maximum). This must be explicitly requested in the API call — the default output is 768 dimensions. The 3072 dimension is chosen for maximum semantic fidelity. If storage or performance becomes a concern at scale, Matryoshka Representation Learning allows truncating to 1536 or 768 dimensions without re-embedding, though this is not expected to be necessary for single-user volume.

## Extensibility Conventions

These conventions ensure new features feel native to DevTrail rather than bolted on. Future contributors (human or AI) should follow these patterns when adding new data types or capabilities.

### 1. Core Table Shape

Every content table in DevTrail must share this base shape:

```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
content         text NOT NULL
embedding       vector(3072)        -- Gemini Embedding 2, always 3072 dims
metadata        jsonb               -- type-specific attributes go here
source          varchar             -- which entry point created this
archived        boolean DEFAULT false
created_at      timestamptz DEFAULT now()
updated_at      timestamptz DEFAULT now()
```

Type-specific columns (e.g., `confidence` on facts, `status` on reminders, `due_date` on appointments) are added alongside the core shape, not instead of it. If an attribute is unique to one type and likely to change or expand, prefer `metadata` JSONB over a dedicated column.

### 2. Everything Gets an Embedding

Every piece of content stored in DevTrail gets a vector embedding. This ensures cross-type semantic search works out of the box. "What am I working on?" should be able to pull from facts, reminders, and future types in a single query.

### 3. The Three-Tier Pattern is Reusable

The captures → facts → insights pipeline is not limited to thoughts. Any new data type can optionally feed into the same consolidation model:
- **Raw input** → table stores the original data (like `captures`)
- **Synthesized knowledge** → consolidation promotes patterns into `facts`
- **Cross-cutting insights** → patterns across facts produce `insights`

Not every data type needs all three tiers. Reminders are single-tier today. But the path to "what do my reminders reveal about me?" is already paved — the consolidation pipeline reads completed reminders as profile signal.

### 4. JSONB Metadata is the Extension Point

When a new feature needs attributes that don't fit the core shape, use `metadata` JSONB. This avoids schema migrations for exploratory features and keeps the core tables stable. Examples:
- Appointments: `metadata: {attendees: [], location: "...", recurrence: "weekly"}`
- Emotions: `metadata: {intensity: 0.8, trigger: "...", body_sensation: "..."}`
- Spiritual reflections: `metadata: {practice: "meditation", duration_min: 20}`

Only promote a metadata field to a dedicated column when it's queried frequently enough to justify an index.

### 5. Consolidation Pipeline Reads from Multiple Sources

The consolidation job should never be hardcoded to read only from `captures`. New data types that carry profile signal should be added as consolidation sources. The pattern:
1. Add a `consolidation_status` or equivalent field to the new table
2. Add a reader in the consolidation pipeline that queries for unprocessed items
3. Feed them into Phase 1 alongside pending captures

### 6. MCP Tool Naming Conventions

Tools follow a verb-noun pattern. Profiler tools use `*_thought` or `*_fact`. New feature domains get their own noun:
- Profiler: `capture_thought`, `search_thoughts`, `update_fact`
- Reminders: `create_reminder`, `list_reminders`, `get_reminder_detail`, `update_reminder`, `complete_reminder`, `delete_reminder`, `add_reminder_comment`, `list_projects`
- Future (appointments): `create_appointment`, `list_appointments`, etc.

Cross-cutting tools (like `brain_stats`, `get_user_profile`) span all domains and should be updated when new data types are added.

### 7. Telegram Command Conventions

Each feature domain gets a small set of Telegram commands:
- Profiler: message in chat (implicit capture), `/review`
- Reminders: `/remind`, `/todos`, `/done`, `/delete`, `/edit`, `/move`, `/comment`, `/subtask`
- Future: `/schedule`, `/mood`, `/reflect`, etc.

Keep commands short and intuitive. Use inline keyboard buttons for multi-step interactions (approve/reject, status changes).

## Non-Goals (v2.0)

- Multi-tenant / multi-user support
- Web dashboard or dedicated app UI
- Calendar or notes integration (reminders ARE in scope for v2)
- Historical profile evolution views
- Real-time streaming MCP (SSE/WebSocket)

These are deferred to v3+ but the architecture is designed to accommodate them without structural rewrites.

### v3 Capabilities Already Supported by v2 Architecture

- **Source file retrieval:** facts track `source_capture_ids[]` → captures store `file_urls[]`. Retrieval responses can include original files (images, audio, PDFs) that informed a fact. No schema changes needed.
- **Cross-modal search:** Gemini Embedding 2 places all modalities in the same vector space. A text query can retrieve image-derived facts; an image query can match text-derived facts. The embedding layer already enables this — only the retrieval API response format needs extending.
- **Historical profile evolution:** `previous_versions` on facts passively tracks changes. A "how have I changed?" feature is a read-only query over existing data.
