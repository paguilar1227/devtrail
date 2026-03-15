# Open Brain v2

Open Brain is a bonding layer between human and AI — a personal knowledge system that maintains a living profile of the user and supports their daily workflow. Its primary purpose is to help AI tools quickly understand who the user is right now: preferences, identity, habits, skills, relationships, opinions. Its secondary purpose is to serve as a personal productivity layer (reminders, todos) that feeds back into the profile. It is not a journal or historical record, though it passively preserves change history for future use.

Open Brain 2.0 transforms the original thought-capture tool into a personal search engine powered by three layered improvements: write-time consolidation, retrieval-time synthesis, and multimodal embeddings. Raw captures are synthesized into facts (a living profile), which are further distilled into insights (cross-cutting patterns). Every tier is independently searchable via pgvector.

## Architecture

| Layer | Service |
|-------|---------|
| API / MCP / Telegram webhook | Azure Container App (consumption, scales to zero) |
| Consolidation pipeline | Azure Function (timer trigger, daily or configurable) |
| Database | Azure Database for PostgreSQL Flexible Server + pgvector |
| File storage | Azure Blob Storage |
| Container registry | Azure Container Registry (shared, existing) |

The Container App hosts three surfaces on a single process: a REST API (`/api/v1/*`), an MCP server (`/mcp`), and the Telegram webhook handler. The Azure Function runs the consolidation pipeline on a timer: capture → fact promotion → insight generation, using Claude Opus 4.6 for reasoning.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 / TypeScript |
| API framework | Hono |
| Database | PostgreSQL + pgvector |
| Embeddings | Gemini Embedding 2 (3072 dims) |
| LLM (metadata + retrieval) | Gemini Flash |
| LLM (consolidation) | Claude Opus 4.6 |
| Bot | Telegram (grammY) |
| MCP | Model Context Protocol 2024-11-05 |
| Infrastructure | Azure Bicep |
| CI/CD | GitHub Actions (OIDC) |

## Local Development

```bash
# 1. Start PostgreSQL with pgvector
docker compose up -d

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Start the dev server (hot reload, runs migrations on startup)
npm run dev
```

The server auto-runs migrations on startup. No manual `psql` needed.

## Testing

```bash
# Unit tests
npm test

# Integration tests (requires a running database)
npm run test:integration
```

## Deployment

See [SETUP.md](./SETUP.md) for the complete first-time Azure deployment guide, including all gotchas discovered during the initial deploy.

Subsequent deploys after setup are handled by GitHub Actions on push to `main`, or manually via:

```bash
RESOURCE_GROUP=<rg> ACR_NAME=<acr> ./scripts/deploy.sh
```
