# CLAUDE.md — Open Brain v2

Project-specific instructions for AI sessions working on this codebase.

## Development Approach

### Test Locally First

Never push untested code to production. The cycle is:

1. Write/modify code
2. Run `npx tsc --noEmit` — catch type errors before anything else
3. Run `npx vitest run` — unit + integration tests (303 tests)
4. Run `npm run test:e2e` — end-to-end against real PostgreSQL (requires `docker compose up -d`)
5. Only then commit and push

If you need to verify LLM behavior (prompts, parsing), write a quick test script and run it locally with `GEMINI_API_KEY=... npx tsx test-script.ts`. Don't deploy to production to test prompts.

### Plan Before You Act

Before implementing a feature:
- Understand what exists — read the relevant source files
- Identify what changes — list the files that need modification
- Consider testing — what tests need to be added or updated
- Think about callers — if you change a function signature, who calls it

Don't start coding until you have a clear picture.

### Commit Style

One commit per logical unit of work. Group source + tests in the same commit. Not so small they're a pain to review, not so large they're hard to backtrack.

Good: `feat: cascade done — completing parent auto-completes subtasks`
Bad: `update files` or committing each file separately

### After Pushing

After `git push origin main`, poll for CI + Deploy completion:

```bash
while true; do
  RESULT=$(gh run list --repo paguilar1227/open-brain-v2 --limit 2 --json status,conclusion,name --jq '.[] | "\(.status) \(.conclusion) \(.name)"')
  CI=$(echo "$RESULT" | grep "CI" | head -1)
  DEPLOY=$(echo "$RESULT" | grep "Deploy" | head -1)
  CI_DONE=$(echo "$CI" | grep "completed")
  DEPLOY_DONE=$(echo "$DEPLOY" | grep "completed")
  if [ -n "$CI_DONE" ] && [ -n "$DEPLOY_DONE" ]; then
    echo "CI: $(echo "$CI" | cut -d' ' -f2)"
    echo "Deploy: $(echo "$DEPLOY" | cut -d' ' -f2)"
    break
  fi
  sleep 5
done
```

Check both CI AND Deploy. CI can pass while Deploy fails (or vice versa). Report both results.

### Ask Before Destructive Actions

Always confirm before:
- Deleting files (could they be needed later?)
- Force pushing, resetting, or rewriting git history
- Modifying Azure infrastructure
- Exposing user's IP or sensitive information

## Testing Philosophy

### Test Layers

| Layer | What | Mocking | Location |
|-------|------|---------|----------|
| Unit | Individual modules, functions | Everything mocked | `tests/unit/` |
| Integration (Telegram) | Webhook → intent → action → reply pipeline | Mocked bot, real handlers | `tests/integration/telegram-*.ts` |
| Integration (LLM) | NL parsing quality with real Gemini Flash | Only LLM is real | `tests/integration/nl-reminder-parsing.test.ts` |
| E2E | REST API + MCP tools against real PostgreSQL | Only AI providers + blob mocked | `tests/e2e/api-e2e.test.ts` |
| Manual | Telegram UI, button interactions | Nothing mocked | User tests in Telegram app |

### When to Write Tests

- Every new feature gets tests at the appropriate layer
- Every bug fix gets a regression test that reproduces the failure
- If you change a function's behavior, update its tests
- If the LLM prompt changes, verify the section 19 NL tests still pass

### Telegram Pipeline Tests and OOM

The Telegram integration tests create full Hono apps with mocked grammY bots. These are memory-intensive. The test suite uses `pool: 'forks'` with 4GB per fork. If tests OOM:
- Split the test file — each file gets its own fork
- Check mocks for infinite recursion (e.g., a mock that matches too broadly and triggers recursive DB calls)
- The T6 mock bug that caused OOM: a mock returned children for ANY SQL containing 'status', which triggered infinite `completeChildren()` recursion

### Running Tests

```bash
# Unit + Integration
npx vitest run

# E2E (requires docker compose up -d)
npm run test:e2e

# Specific test file
npx vitest run tests/unit/db/reminders.test.ts

# LLM integration tests need the API key
GEMINI_API_KEY=<key> npx vitest run tests/integration/nl-reminder-parsing.test.ts
```

## Known Gotchas

### Gemini 2.5 Flash

- `maxTokens` must be >= 1024. Flash uses internal thinking tokens that count against the output budget. At 256, the model runs out after preamble text like "Here is the JSON requested:" and never outputs the actual JSON.
- `responseMimeType: 'application/json'` is unreliable. Flash often wraps JSON in markdown code blocks. The `extractJson()` function in `src/providers/gemini-llm.ts` strips the wrapping.
- `llmJsonParse()` in `src/telegram/llm-parse.ts` retries up to 3 times for non-JSON responses.
- Model IDs change. `gemini-2.0-flash` was retired. Always verify the current model ID if you get 404s.

### Gemini Embedding 2

- Model ID: `gemini-embedding-2-preview` (not `text-embedding-004` or experimental IDs)
- Must explicitly request 3072 dimensions (default is 768)
- Supported MIME types: `image/png`, `image/jpeg`, `audio/mpeg`, `audio/wav`, `video/mp4`, `video/quicktime`, `application/pdf`
- The Generative Language API must be enabled in Google Cloud Console for the project associated with the API key

### PostgreSQL / pgvector

- `db.query()` calls `ensureVector()` which registers pgvector types. This fails if the `vector` extension doesn't exist yet. Migrations must use `pool.query()` directly.
- HNSW indexes can't be created on B1ms tier (memory limit for 3072-dim vectors). Sequential scans are used instead.
- Auto-migration runs on app startup — checks if tables exist, creates them if not.

### Telegram

- Webhook must respond 200 immediately. Processing happens in background via `bot.handleUpdate()`. Never tie the HTTP response to handler completion.
- Track `update_id` to prevent duplicate processing. Telegram retries if it doesn't get a fast 200.
- `bot.init()` must be called before `bot.handleUpdate()` works.
- All media handlers need explicit try/catch for guaranteed user reply on error.
- Telegram reports `application/octet-stream` for many document types — infer from file extension via `src/telegram/mime-utils.ts`.
- `switch_inline_current_chat` requires inline mode. Action menu uses callback buttons with pending state instead.

### Azure

- ACR role assignments across resource groups can't be in Bicep — must use CLI.
- Container App revisions need unique image tags (git SHA). Pushing `latest` alone doesn't trigger a new revision.
- `minReplicas: 1` is set for always-on (no cold starts).

## Code Organization

### Key Directories

```
src/
├── telegram/        # Bot (split into 6 modules for testability)
│   ├── webhook.ts          # Entry point — wires everything
│   ├── command-handlers.ts # /remind, /todos, /done, /delete, /edit, /move, /comment, /subtask, callback handlers
│   ├── nl-router.ts        # NL intent classifier + action handlers + media handlers
│   ├── llm-parse.ts        # llmJsonParse retry helper
│   ├── state.ts            # Shared state types (lastActions, pendingSubtask, pendingAction)
│   ├── prompts.ts          # LLM prompt templates (intent classifier, reminder parser)
│   ├── mime-utils.ts       # MIME type inference + summarization routing
│   └── handlers.ts         # Per-message-type handler functions
├── capture/         # Universal ingest pipeline
│   ├── pipeline.ts         # Orchestrates dedup, embedding, metadata, DB insert
│   ├── metadata.ts         # Gemini Flash metadata + tag extraction (piggybacked on one LLM call)
│   └── tags.ts             # ALLOWED_TAGS (14 tags), TAG_DESCRIPTIONS, validateTags(), isValidTag()
├── consolidation/   # 3-phase consolidation (DBSCAN → Opus → embed)
├── retrieval/       # Profile synthesis + tiered search
├── mcp/             # MCP server + 21 tools
├── db/              # PostgreSQL query modules (6 tables)
├── providers/       # AI provider abstraction (Gemini, Anthropic)
├── storage/         # Azure Blob Storage
├── notifications/   # Formatting, review, digest, due date checker
├── config.ts        # Zod-validated environment config
├── app.ts           # Hono HTTP server + REST API
└── server.ts        # Entry point (migration, App Insights, background checkers)
```

### Tag System

`src/capture/tags.ts` is the single source of truth for the tag allowlist. It exports:
- `ALLOWED_TAGS` — 14-element const array. Used for Zod validation in MCP tools and as the prompt list in metadata extraction.
- `TAG_DESCRIPTIONS` — map from tag name to one-line description. Injected into the Gemini Flash metadata prompt so the LLM knows what each tag means.
- `validateTags(tags: string[]): string[]` — filters to valid tags, deduplicates.
- `isValidTag(tag: string): boolean` — single tag check.

**To expand the allowlist:** Add the new tag to both `ALLOWED_TAGS` and `TAG_DESCRIPTIONS` in `src/capture/tags.ts`. No migration needed — tags are stored in `text[]` columns with no DB-level constraint. The allowlist is code-only.

### State Machines in Telegram

The bot uses three per-chat state maps for multi-step interactions:

- `pendingSubtask` — set by `/subtask` button or `action-subtask`, cleared when next text message creates the subtask
- `pendingAction` — set by `action-edit/comment/move` buttons, cleared when next text message executes the action
- `lastActions` — tracks the most recent action per chat for undo support

Check order in `message:text` handler: pendingSubtask → pendingAction → undo fast-path → LLM intent classifier → capture thought (default)

### Adding a New Telegram Command

1. Add the handler in `src/telegram/command-handlers.ts`
2. Register it with `bot.command('name', handler)`
3. Add undo support if the action is reversible (`lastActions.set(...)`)
4. Add short ID resolution if it takes a reminder ID (`resolveReminderId`)
5. Add tests in `tests/integration/telegram-pipeline.test.ts` or a new split file
6. Update `ARCHITECTURE.md` and the design spec

### Adding a New MCP Tool

1. Add the tool registration in `src/mcp/profiler-tools.ts` or `src/mcp/reminder-tools.ts`
2. Use Zod for parameter validation
3. Add an E2E test in `tests/e2e/api-e2e.test.ts`
4. Update `ARCHITECTURE.md`, `README.md`, and the design spec tool count + table

### MCP Server Instructions

The `McpServer` in `src/mcp/server.ts` is created with an `instructions` field. MCP clients that support it (Claude, etc.) receive this string on connection and apply it automatically — no user setup needed. The instructions tell the AI to call `brain_help`, proactively capture, and suggest reminders.

For AI clients that don't support MCP server instructions (ChatGPT, raw API), the `get_user_prompt` tool returns the same behavioral instructions as a portable system prompt users can paste into their client's custom instructions field once.

## Production Environment

- **App URL:** `https://your-app.your-env.region.azurecontainerapps.io`
- **MCP URL:** `https://your-app.your-env.region.azurecontainerapps.io/mcp?key=<api-key>`
- **API Key:** stored in Azure Key Vault (`your-keyvault/open-brain-api-key`)
- **Telegram Bot:** `@OpenBrainToolkitBot`
- **PostgreSQL:** `your-pg-server.postgres.database.azure.com`
- **Consolidation:** Azure Function, every 30 minutes (configurable via `CONSOLIDATION_SCHEDULE`)
- **Docker compose (local dev):** port 5434 (not 5432, which is used by other projects)

## Failure Scenarios to Watch For

These have all happened in production. Tests exist for most, but be vigilant:

1. LLM returns non-JSON even with `responseFormat: 'json'` — always use `llmJsonParse` with retry
2. Telegram webhook retry loops — always respond 200 immediately, process in background
3. Silent failures in catch blocks — always log errors, always reply to user
4. MIME type misdetection — always infer from extension when Telegram says `application/octet-stream`
5. File dedup bypass — LLM generates different summaries for same file; file hash is the real dedup gate
6. Relative dates without context — always inject `TODAY'S DATE` and `CURRENT TIME (UTC)` into LLM prompts
7. Mock infinite recursion in tests — be specific with SQL pattern matching in mocks, don't use broad `includes('status')` matchers
