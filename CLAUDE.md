# CLAUDE.md — Open Brain v2

Project-wide instructions for AI sessions. Path-scoped rules live in `.claude/rules/` and auto-load when working in matching subtrees — those are the place for backend internals, schema details, LLM gotchas, and frontend patterns. Keep this file lean.

| Subtree you're working in | Loads (in addition to this file) |
|---|---|
| `backend/**` | `.claude/rules/backend.md` (service layer, MCP tools, project membership, search/RAG, backend tests) |
| `migrations/**` or `backend/src/db/**` | `.claude/rules/schema.md` (migrations list, pgvector, B1ms / HNSW constraint) |
| `backend/src/providers/**` or `backend/src/capture/**` | `.claude/rules/llm.md` (JSON parsing, token budgets, model IDs, multimodal, URL fetchers) |
| `frontend/**` | `.claude/rules/frontend.md` (drawer composition, prow rows, e2e Playwright setup) |

## Reality check first

Before trusting anything in this file, the rules, prior session notes, or your auto-memory: **verify against the current code**. Architecture changes happen between sessions. Cheap checks:

- `git log --oneline -20` — what changed recently
- `find backend/src -type f -name '*.ts' | sort` — backend files
- `find frontend/src -type f -name '*.ts*' | sort` — frontend files
- `ls migrations/` — what schema is current
- `cat backend/package.json frontend/package.json` — current deps
- A live `/health` hit on production confirms what's deployed

If a memory or doc references a file path, function, or entity name that no longer exists in the repo, treat the doc as stale and update it. **Don't chase a phantom architecture.** Past pivots have completely replaced the entity model and code layout.

## What Open Brain v2 is

A NotebookLM-style personal knowledge base + productivity tool. Single user. No multi-tenancy.

- **Projects** group everything else.
- **Content items** are documents (uploaded reference material) and notes (self-authored). Both get chunked for search.
- **Chunks** are the unit of vector search.
- **Todos** with optional project membership, recursive subtasks, comments.
- **Entities + chunk_entities** form a graph layer over the corpus — extracted at ingest, used to expand vector retrieval along entity edges.

There is **no Telegram bot**, **no consolidation/facts/insights pipeline**, **no reflection engine**. Those existed in pre-pivot versions and were deleted in the V2 rewrite (April 2026). If you find references to them anywhere, fix the docs.

## Stack

| Layer | Tech |
|------|------|
| API | Hono on Node 20, served by `@hono/node-server` |
| Web UI | Vite + React, hand-rolled CSS in `frontend/src/styles.css`, built into `frontend/dist`, served statically by Hono |
| MCP | `@modelcontextprotocol/sdk` over Streamable HTTP, mounted at `/mcp` |
| Database | PostgreSQL + pgvector (3072-dim, sequential scan — no HNSW) |
| Blob storage | Azure Blob Storage |
| Container | Docker on Azure Container Apps |
| iOS app | Capacitor 8 shell (`frontend/ios/`, SPM — no CocoaPods) wrapping the same Vite `dist/` bundle |

## Models (see `backend/src/server.ts`)

| Role | Provider | Model |
|------|----------|-------|
| Embeddings | Gemini | `gemini-embedding-2-preview` (3072d, multimodal) |
| Metadata + entity extraction | Anthropic | `claude-haiku-4-5-20251001` |
| Query depth classifier | Anthropic | `claude-haiku-4-5-20251001` |
| RAG fast path | Azure Foundry chat completions | `gpt-5-4` |
| RAG thorough path | Azure Foundry Responses API | `gpt-5-4-pro` |

## Code layout

```
backend/                  # Hono API + MCP server (Node 20)
├── src/                  # source — see .claude/rules/backend.md for the detailed tree
├── tests/                # unit + integration
└── package.json

frontend/                 # Vite + React web client
├── src/
├── tests/e2e/             # Playwright workflow suite
└── package.json

shared/                   # @open-brain/shared — Zod schemas + TS types on the wire
└── src/schemas.ts         # Single source of truth for request/response shapes

migrations/               # SQL migrations (applied at backend startup; see schema rule)
scripts/                  # deploy.sh + live-e2e.sh + diagnostics
docs/                     # design docs, plans, UI build brief
.github/workflows/        # CI (tests + frontend build) + Deploy (Docker → ACA)
.claude/rules/            # path-scoped rule files; load when matching files are touched
Dockerfile                # multi-stage: frontend build → backend build → runtime
```

Root `package.json` is a thin script delegator (`npm run dev` → `cd backend`, etc.).

## REST API

Auth: `Authorization: Bearer <api-key>` or `?key=<api-key>`. Same key for `/api/*` and `/mcp`.

Routes (see `backend/src/app.ts`):

- `GET /health`
- **Projects** — `GET|POST|PUT|DELETE /api/v1/projects[/:id]` + `/restore` + `/pin` + `/unpin`. List supports `?status=` and `?pinned=`.
- **Content** — `GET|POST|PUT|DELETE /api/v1/content[/:id]` + `/restore` + `/pin` + `/unpin` + `/retry` + `/reprocess` + `/status`. List supports `?type=`, `?project_id=`, `?tags=`, `?processing_status=`, `?pinned=`. `POST /api/v1/content` accepts JSON or `multipart/form-data` (with `file` field). `POST /api/v1/content/from-url` for URL ingest. `POST /api/v1/content/bulk` for batch ops.
- **Todos** — `GET|POST|PUT|DELETE /api/v1/todos[/:id]` + `/restore` + `/pin` + `/unpin`. List supports `?project_id=`, `?status=`, `?priority=`, `?pinned=`. `POST /api/v1/todos/bulk` for batch ops.
- **Comments** — `GET|POST|PUT|DELETE /api/v1/todos/:id/comments[/:cid]`.
- **Tags** — `GET /api/v1/tags` (inventory), `PUT /api/v1/tags/:name {to}` (rename / merge), `DELETE /api/v1/tags/:name` (corpus-wide delete).
- **Activity** — `GET /api/v1/activity` with `?since=`, `?until=`, `?kinds=ingest,edit,comment`, `?project_id=`, `?limit=`.
- **Stats** — `GET /api/v1/stats` (counts + freshness + top tags); optional `?project_id=` to scope.
- **Search / RAG** — `POST /api/v1/search`, `POST /api/v1/find-mentions`, `POST /api/v1/rag` (`depth: 'auto'|'fast'|'thorough'`).
- **MCP** — `ALL /mcp` — stateless, fresh server + transport per request.

Soft delete by default (`archived = true`); pass `?hard=true` for permanent delete. Two URL fields ship on every content item: `blob_url` (read SAS for inline preview) and `download_url` (SAS with `rscd` Content-Disposition for save-to-disk).

Async ingest contract: `POST /content` and `/from-url` return **202 + `{id, processing_status: 'pending'}`**. Poll `GET /content/:id/status` until `processing_status` is `ready` or `failed`. `POST /content/:id/retry` re-runs a failed ingest; `POST /content/:id/reprocess` regenerates chunks/embeddings/metadata.

## Development workflow

### Local cycle

```bash
make bootstrap                               # first time per clone: deps + shared build + git hooks
docker compose up -d                         # local Postgres on port 5434
npm run dev                                  # backend dev server (tsx watch)
cd frontend && npm run dev                   # frontend dev server (separate terminal)
make ci                                      # fast local gate (typecheck + unit + build) — what pre-push runs
make ci-full                                 # everything cloud CI runs, incl. Playwright e2e
npm run build:all                            # full production build
```

### CI model — local-first, cloud only at merge

The `Makefile` is the single source of truth for the pipeline: both the local
git hook and the cloud workflow call the same targets, so a green `make ci-full`
locally means a green CI run.

- **Local CI is the daily gate.** `lefthook` runs `make ci` (typecheck + unit +
  build, ~15s) on **pre-push** — you can't push a broken tree. Run `make ci-full`
  (adds the Playwright e2e) before merging. Skip in a pinch: `LEFTHOOK=0 git push`.
- **Cloud CI (`ci.yml`) runs `make ci-full` only at merge / post-merge** — `push:
  main` (the post-merge safety net) + `workflow_dispatch` (run the full suite on a
  branch before merging). **There is no per-PR-push CI trigger** — that's what the
  local gate is for, and it's what stops the free-tier minutes from burning during
  a PR. (Merge queue / `merge_group` — the textbook "run only at merge attempt" —
  needs GitHub Enterprise Cloud for private repos, so it's unavailable here.)
- **Deploy (`deploy.yml`) runs on `push: main`** (auto-deploy on merge) +
  `workflow_dispatch`. It does NOT wait on CI — the local gate is the pre-merge
  guard; post-merge CI is the safety net (red → revert/redeploy).
- Both workflows have a `concurrency` block. PR-time review is **CodeRabbit +
  react-doctor** (`react-doctor.yml`, frontend PRs) — cheap, stays on PRs.

### iOS app (Capacitor shell)

The web `frontend/` IS the iOS app — Capacitor 8 wraps the same `dist/` bundle in a
WKWebView shell. Web behavior is untouched: `apiOrigin()` (in
`frontend/src/lib/nativeConfig.ts`) returns `''` outside Capacitor, so web requests stay
same-origin. Native-only pieces: `nativeConfig.ts` (stored server origin),
`components/ConnectScreen.tsx` (first-run server URL + API key, verified against
`/api/v1/stats` before persisting), and native branches in `lib/api.ts`
(`bootAuth`/`logout`/`probeServer`/`saveNativeServerConfig`).

Build + run in the simulator:

```bash
cd frontend && npm run build && npx cap sync ios
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17e' -derivedDataPath ./DerivedData build
xcrun simctl install booted DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted com.example.openbrain
```

First launch asks for server URL + API key (local dev: `http://localhost:3001` + the
`OPEN_BRAIN_API_KEY` from `backend/.env`; Info.plist ATS allows plain-http to local hosts
only). `npx cap sync ios` re-copies `dist/` into the shell — run it after any web build
you want reflected natively. `ios/App/App/public/` and `capacitor.config.json` are
generated (gitignored); `Info.plist` and the Xcode project are source.

Shell test coverage is two layers on top of the regular suite:
- **`webkit-mobile` Playwright project** (in `make ci-full`) — reruns core mobile
  workflows on the WebKit engine, since the shell is WKWebView while the main mobile
  project is Chromium. Scope is the curated `testMatch` list in `playwright.config.ts`.
- **`make ios-smoke`** — LOCAL-ONLY simulator smoke (`scripts/ios-smoke.sh`): build →
  fresh install → connect flow → create a todo through the UI → verify via REST →
  clean up. The only layer exercising the real native context (capacitor:// origin,
  WKWebView CORS, connect screen). Run it before merging changes to the shell,
  `nativeConfig.ts`, `api.ts`, or mobile layout.

### Plan-first

Before implementing a feature: read the relevant services, list the files that change, identify call sites, write tests at the right layer. Don't start coding until the picture is clear.

### Commit style

One commit per logical unit. Group source + tests in the same commit. Conventional-style prefixes: `feat:`, `fix:`, `feat(graph):`, `fix(search):`, etc.

### Branching — work on feature branches, NOT directly on main

**Default workflow:** create a branch, commit there, open a PR when the chunk is done, merge to main when the user says ship it.

The repo is private and on the GitHub Actions free tier (2000 min/month). Every push to `main` triggers **two** workflows — `CI` (~26 min, full Playwright e2e) and `Deploy to Azure` (~5 min) = ~31 min metered per push. Pushing N WIP commits directly to main during an iteration burns N×31 min of the monthly cap for changes the user hasn't even reviewed yet. Burned through 1200+ minutes in May 2026 doing exactly that.

**Concrete rules:**
- Default to a branch named `feat/<thing>` or `fix/<thing>`. Commit + push there freely — **branch pushes spend zero Actions minutes** (CI has no PR/branch trigger; the lefthook `make ci` gate is your feedback loop, `make ci-full` before merging). PRs still get CodeRabbit + react-doctor.
- Only push to `main` when the user explicitly says to merge / ship / land. That single `push: main` is the one time cloud CI (`make ci-full`) + Deploy run.
- For trivial / docs-only changes, append `[skip ci]` to the commit message.
- If GH Actions is unavailable (quota exhausted, runner outage) and the user needs prod NOW, use the manual deploy below.

If you find yourself about to `git push origin main` mid-session without explicit permission, stop and ask.

### Manual deploy (az CLI escape hatch)

For when GitHub Actions is down, billing-suspended, or you need to deploy faster than CI can finish. Bypasses the Deploy workflow entirely.

```bash
RESOURCE_GROUP=openbrain-rg ACR_NAME=yourregistry bash scripts/deploy.sh
```

(a) builds the Docker image locally for `linux/amd64` (~5-10 min on Apple Silicon for the cross-build), (b) pushes to ACR (~1-3 min, mostly cached), (c) rolls a new Container App revision (~1-2 min). Tags with the short HEAD SHA so revisions are traceable.

Requires Docker running + `az login` already done. ACR lives in `shared-rg` (not `openbrain-rg`) — it's shared across projects.

If `docker push` to ACR times out mid-manifest (proxy / network glitch), the layers are usually already uploaded; retry just `docker push yourregistry.azurecr.io/open-brain-v2:<tag>` instead of re-running the whole script.

### After pushing — poll for CI + Deploy

Only relevant for pushes to `main`. PR-branch CI is one run, not two.

```bash
while true; do
  RESULT=$(gh run list --repo paguilar1227/open-brain-v2 --limit 2 --json status,conclusion,name --jq '.[] | "\(.status) \(.conclusion) \(.name)"')
  CI=$(echo "$RESULT" | grep "^completed.*CI$" | head -1)
  DEPLOY=$(echo "$RESULT" | grep "^completed.*Deploy" | head -1)
  if [ -n "$CI" ] && [ -n "$DEPLOY" ]; then
    echo "$CI"; echo "$DEPLOY"; break
  fi
  sleep 5
done
```

CI passing while Deploy fails (and vice versa) is possible. Report both. If both fail in seconds with empty step logs (`gh api .../runs/<id>/jobs --jq '.jobs[].steps'` returns `[]`), it's usually GitHub Actions quota — check `https://github.com/settings/billing/summary` rather than chasing a code bug.

### CI concurrency (wired)

Both workflows now have a `concurrency` block:
- `ci.yml` → `group: ci-${{ github.ref }}`, `cancel-in-progress: true` (a newer push supersedes an in-flight CI run).
- `deploy.yml` → `group: deploy-production`, `cancel-in-progress: false` (a **constant** group so every deploy — `push: main` or a manual dispatch on any ref — serializes against the single prod Container App; `false` so a rollout is never killed mid-update, the next one queues).

### Ask before destructive actions

Confirm before:
- Deleting files (could they still be needed?)
- Force-pushing, resetting, or rewriting git history
- Modifying Azure infra
- Pushing to `main` (see Branching rule above)
- Exposing secrets or the user's IP

## Test layout overview

| Layer | Path | Detail |
|-------|------|------|
| Backend unit / integration | `backend/tests/**` | See `.claude/rules/backend.md` |
| Frontend workflow e2e | `frontend/tests/e2e/**` | See `.claude/rules/frontend.md` |

Bug fixes get a regression test at the surface where the bug appeared.

## Production environment

- **App URL:** `https://your-app.your-env.region.azurecontainerapps.io`
- **MCP URL:** `<app-url>/mcp?key=<api-key>` (stateless, per-request server)
- **Health:** `<app-url>/health` returns `{"ok":true,"service":"open-brain","version":"2.0.0"}`
- **API key:** Azure Key Vault `your-keyvault/open-brain-api-key`
- **PostgreSQL:** `your-pg-server.postgres.database.azure.com` (Azure Postgres Flexible Server)
- **Azure Container App:** resource group `openbrain-rg`, name `openbrain-prod-api`
- **Container Registry:** `yourregistry.azurecr.io` in resource group `shared-rg` (shared across projects — NOT in `openbrain-rg`)
- **Image name:** `yourregistry.azurecr.io/open-brain-v2:<short-sha>` (plus a rolling `:latest` tag)
- **Local dev Postgres:** port 5434 (so it doesn't clash with other projects on 5432)

Check the currently-running revision + its image tag:
```bash
az containerapp show --name openbrain-prod-api --resource-group openbrain-rg \
  --query "{revision: properties.latestRevisionName, image: properties.template.containers[0].image}" -o json
```

## Failure modes that have happened

General / cross-cutting issues. Domain-specific ones (LLM, pgvector, URL ingestion) live in their respective rule files.

1. **Past phantom-architecture sessions** — if the doc and the code disagree, the code wins. Update the doc immediately.
2. **GitHub Actions quota burn from direct-to-main pushes** — May 2026 burned ~1200 of the 2000-min monthly free-tier cap by pushing every WIP commit straight to `main` and triggering a ~31-min CI+Deploy pair per push. Fix is in "Branching" above: branch by default, only push to main on user-approved merge. When quota is gone, `scripts/deploy.sh` is the manual escape hatch.
3. **ACR manifest push timing out mid-upload** — proxy / network glitches can leave layers uploaded but the manifest write failed (image tag never appears in `az acr repository show-tags`). Don't re-build; just `docker push <full-image:tag>` to re-attempt the manifest with cached layers.

## When you finish a task

- Run `npx tsc --noEmit` and `npm test` before committing.
- Update this file or the relevant `.claude/rules/*.md` if you changed an entity, table, MCP tool, or service-layer contract. Stale docs cost more than they save.
- If you delete or rename a service / table / file, grep the docs for it (`grep -rn 'old-name' --include='*.md'`) and fix or remove references.
