# Open Brain v2

Open Brain is a bonding layer between human and AI — a personal knowledge system that maintains a living profile of the user and supports their daily workflow. Its primary purpose is to help AI tools quickly understand who the user is right now: preferences, identity, habits, skills, relationships, opinions. Its secondary purpose is to serve as a personal productivity layer (reminders, todos) that feeds back into the profile. It is not a journal or historical record, though it passively preserves change history for future use.

Open Brain 2.0 transforms the original thought-capture tool into a personal search engine powered by three layered improvements: write-time consolidation, retrieval-time synthesis, and multimodal embeddings. Raw captures are synthesized into facts (a living profile), which are further distilled into insights (cross-cutting patterns). Every tier is independently searchable via pgvector.

## Features

### Profiler

- **Three-tier knowledge architecture:** raw captures -> synthesized facts -> cross-cutting insights
- **Multimodal capture:** text, photos, voice memos, documents (PDF, CSV, HTML, JSON, etc.)
- **Tag system:** 14 curated semantic tags (preference, decision, skill, goal, etc.) for filtered retrieval — auto-classified by LLM, or provided by MCP callers
- **Tag-filtered search:** `search_thoughts("coding style", { tags: ["preference"] })` returns only preference-type results
- **Semantic dedup:** cosine similarity check prevents duplicate captures
- **Consolidation pipeline:** DBSCAN clustering + Claude Opus reasoning promotes captures to facts and insights
- **Review system:** autonomous, hybrid (default), or ask modes for fact/insight approval

### Reminders & Todos

- **Hierarchical tasks:** Project > Section > Task with subtask nesting (up to 4 levels)
- **Rich metadata:** status, priority (P1/P2/P3), due dates, categories, comments
- **Comment management:** view, edit, and delete comments via Telegram action menu or MCP tools
- **Cascade behaviors:** completing a parent auto-completes children; deleting cascades to subtasks + comments
- **Reparenting/move:** move tasks between parents or to root level, children follow
- **Short IDs:** use first 8 characters of UUID for commands (e.g., `/done 4e0bd1b2`)
- **Due date notifications:** per-reminder alerts when due + daily report with brain activity stats at configured time
- **Profile feedback loop:** completed reminders feed into consolidation as profile signal

### Telegram Bot

- **Natural language interface:** LLM-powered intent classifier routes messages to create, list, complete, update, comment, move, or undo — no commands needed
- **Slash commands:** `/remind`, `/todos`, `/done`, `/delete`, `/edit`, `/move`, `/comment`, `/subtask`, `/review`
- **Inline keyboard:** numbered task buttons with done (checkmark), status cycle (not_started -> in_progress -> paused -> blocked -> not_started), and action menu (gear icon)
- **Action menu:** per-task actions via inline buttons — edit, comment, move, delete, subtask
- **Undo:** say "undo" to reverse the last action (create, complete, update, comment)
- **Pending state machines:** subtask creation and action menu flows maintain conversational state
- **Media capture:** photos, voice memos, and documents are captured with AI summarization
- **MIME detection:** 25 file extension mappings when Telegram sends `application/octet-stream`

### MCP Tools (24 total)

**Profiler (14 tools):** brain_help, get_user_prompt, get_user_profile, search_thoughts, capture_thought, brain_stats, archive_thought, unarchive_thought, update_fact, review_pending, approve_reject, run_consolidation, update_tags, daily_checkin

**Reminders (10 tools):** create_reminder, list_reminders, get_reminder_detail, update_reminder, complete_reminder, delete_reminder, add_reminder_comment, list_projects, edit_comment, delete_comment

MCP-compatible clients (Claude, etc.) receive behavioral instructions automatically on connection — including tag system guidance and search patterns. For other AI clients, call `get_user_prompt` once to get a system prompt you can paste into custom instructions.

## Architecture

| Layer | Service |
|-------|---------|
| API / MCP / Telegram webhook | Azure Container App (minReplicas: 1, always-on) |
| Consolidation pipeline | Azure Function (timer trigger, every 30 min) |
| Database | Azure Database for PostgreSQL Flexible Server + pgvector |
| File storage | Azure Blob Storage |
| Container registry | Azure Container Registry (shared, existing) |

The Container App hosts three surfaces on a single process: a REST API (`/api/v1/*`), an MCP server (`/mcp`), and the Telegram webhook handler. All three surfaces are thin adapters over a shared **service layer** (`src/services/`) that owns all business logic — hexagonal architecture / ports and adapters pattern. The Azure Function runs the consolidation pipeline on a timer: capture -> fact promotion -> insight generation, using Claude Opus 4.6 for reasoning.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 / TypeScript |
| API framework | Hono |
| Database | PostgreSQL + pgvector |
| Embeddings | Gemini Embedding 2 (3072 dims) |
| LLM (metadata + retrieval + intent) | Gemini 2.5 Flash |
| LLM (consolidation) | Claude Opus 4.6 |
| Bot | Telegram (grammY) |
| MCP | Model Context Protocol 2024-11-05 |
| Infrastructure | Azure Bicep |
| CI/CD | GitHub Actions (OIDC) |

## Local Development

```bash
# 1. Start PostgreSQL with pgvector (port 5434 on host)
docker compose up -d

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys
# Note: docker compose maps to port 5434, so use:
# DATABASE_URL=postgresql://openbrain:openbrain@localhost:5434/openbrain

# 4. Start the dev server (hot reload, runs migrations on startup)
npm run dev
```

The server auto-runs migrations on startup. No manual `psql` needed.

## Testing

453 tests across 47 files: unit, integration (mocked bot + real handlers), LLM integration (real Gemini calls), and E2E (real PostgreSQL).

```bash
# Unit + integration tests (uses vitest forks pool to avoid OOM)
npm test

# E2E tests (requires docker compose PostgreSQL on port 5434)
npm run test:e2e

# LLM integration tests (requires GEMINI_API_KEY)
npm run test:integration
```

The test suite uses `pool: 'forks'` with `--max-old-space-size=4096` to avoid OOM when running integration tests that create many full app instances.

## Deployment

See [SETUP.md](./SETUP.md) for the complete first-time Azure deployment guide, including all gotchas discovered during the initial deploy.

Subsequent deploys after setup are handled by GitHub Actions on push to `main`, or manually via:

```bash
RESOURCE_GROUP=<rg> ACR_NAME=<acr> ./scripts/deploy.sh
```
