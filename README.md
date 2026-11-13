# DevTrail

**A shared workspace where people and AI agents track work, and anyone can see where a project stands.**

[![CI](https://github.com/paguilar1227/devtrail/actions/workflows/ci.yml/badge.svg)](https://github.com/paguilar1227/devtrail/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DevTrail keeps projects, todos, notes, documents and agent sessions in one place. Agents work through an MCP server with 32 tools; people use the web and iOS app; both read and write the same records. The database records every change on a timeline, and everything you save is searchable with hybrid vector, keyword and entity-graph retrieval, with cited answers.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overview-dark.svg">
  <img alt="DevTrail architecture: people, AI agents and scripts reach one server through the web app, the MCP server and the REST API. All three call the same services, which store work in Postgres with pgvector and Blob storage, record every change on a timeline, and call AI models for embeddings, extraction and answers." src="docs/images/overview-light.svg">
</picture>

## Why

Agents are good at doing work and bad at leaving a trail. Sessions end, context is lost, and the person who owns the project can't tell what happened or what comes next. DevTrail gives both sides one durable record:

- **Agent-first.** 32 MCP tools mirror the REST API: create and update work, search, ask, open sessions, save handoffs, read timelines.
- **Readable by people.** Sessions end with a handoff (summary, decisions, next steps) that shows up in the web and iOS app next to the work it produced.
- **History you can't skip.** Postgres triggers write the project and session timelines in the same transaction as each change, whichever client made it.
- **Search that explains itself.** Vector, keyword and entity-graph results are fused with reciprocal rank fusion; every hit carries its retrieval path, and answers cite their sources.
- **Anything in, asynchronously.** Notes, PDFs, images, audio and video, plus YouTube, web pages and X threads by URL. Ingest returns `202` at once and finishes in the background.
- **Built to run.** OpenAPI 3.1 spec, Docker image, Azure Bicep templates, a CI gate with typecheck, tests and security scans, and a stub mode that runs everything with zero model spend.

![A DevTrail project: its live timeline, with tabs for sessions, chat, documents, notes and todos](docs/images/screenshot-project-timeline.png)

## How it works

**An agent's handoff reaches a person.** The agent calls `save_session`; the session and a searchable note are written; a trigger records the change; the person opens the session timeline.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/handoff-flow-dark.svg">
  <img alt="Sequence: an AI agent calls save_session on the MCP server, which saves the handoff through the workspace services into Postgres; a trigger records the change on the timeline; later the web app requests the session timeline from the REST API and receives the handoff and full history." src="docs/images/handoff-flow-light.svg">
</picture>

**Answering from everything saved.** The question is embedded, retrieved three ways, fused, and answered from the top chunks with citations.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/ask-flow-dark.svg">
  <img alt="Sequence: an agent calls ask on the MCP server; search embeds the question with Gemini, retrieves vector and keyword seeds and expands the entity graph in Postgres, fuses the results with RRF, asks Azure OpenAI to answer from the top chunks, and returns the answer with citations and retrieval paths." src="docs/images/ask-flow-light.svg">
</picture>

<details>
<summary>Take the animated tour</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/walkthrough-dark.svg">
  <img alt="Animated six-step tour of DevTrail: agents work through MCP, people and agents share one record, every change lands on a timeline, handoffs reach people, search fuses three retrieval arms, answers come back with citations." src="docs/images/walkthrough-light.svg">
</picture>

</details>

## Quick start

You need Docker and Node 20+.

```bash
git clone https://github.com/paguilar1227/devtrail.git
cd devtrail
npm run dev:up
```

This starts Postgres (with pgvector) and Azurite in Docker, installs dependencies, seeds demo data and runs the backend and web app with hot reload, all in **stub mode**: every model call is faked deterministically, so you need no API keys.

- Web app: <http://localhost:5173>
- API docs: <http://localhost:3001/api/v1/docs> (click **Authorize** and use `local-dev-key-not-secret`)
- MCP: `http://localhost:3001/mcp`

Stop with Ctrl-C; `npm run dev:down` stops the containers and keeps the data. To use real models, set `LLM_PROVIDER=real` and the provider keys in `backend/.env`.

## Connect an agent

Any MCP client that speaks Streamable HTTP works. Send the API key as a Bearer token.

**Claude Code** (`.mcp.json` in your project):

```json
{
  "mcpServers": {
    "devtrail": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer local-dev-key-not-secret" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`, with `DEVTRAIL_API_KEY` exported in your shell):

```toml
[mcp_servers.devtrail]
url = "http://localhost:3001/mcp"
bearer_token_env_var = "DEVTRAIL_API_KEY"
```

For clients that can only be given a URL, start the server with `MCP_ALLOW_URL_KEY=true` and use `/mcp?key=<key>`. URLs end up in logs, so prefer the header.

## API

| Path | For | Auth |
|---|---|---|
| `/api/v1/*` | REST clients and the web app | `Authorization: Bearer <DEVTRAIL_API_KEY>` |
| `/api/v1/openapi.json`, `/api/v1/docs` | anyone | public |
| `/mcp` | MCP clients | Bearer (`?key=` only with `MCP_ALLOW_URL_KEY=true`) |
| `/api/auth/token` | browsers behind Azure Easy Auth | only with `AUTH_MODE=easyauth` |
| `/health` | probes | public |

All 57 REST operations are generated from Zod schemas into the OpenAPI spec, so the docs can't drift from the handlers. Lists filter with `?project_id=`, `?tags=a,b` and `?pinned=`; deletes are soft unless `?hard=true`; errors are `{ "error": "..." }`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DEVTRAIL_API_KEY` | required | Bearer key for REST, MCP and web sign-in |
| `DATABASE_URL` | required | Postgres with the `vector` extension |
| `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER` | required | Blob storage for original files (Azurite works locally) |
| `LLM_PROVIDER` | `real` | `stub` fakes every model call |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY` | required in `real` mode | Embeddings and media, extraction, answers |
| `SUPADATA_API_KEY`, `FIRECRAWL_API_KEY`, `XAI_API_KEY` | required in `real` mode | YouTube, web page and X thread ingest |
| `AUTH_MODE` | `api-key` | `easyauth` only behind Azure Container Apps authentication |
| `MCP_ALLOW_URL_KEY` | `false` | Accept `?key=` on `/mcp` |

The full list is in [docs/architecture.md](docs/architecture.md#18-environment-variables).

## Deploy

The Docker image (`docker build -t devtrail .`) runs anywhere with Postgres + pgvector and Blob storage. The reference deployment is Azure Container Apps with PostgreSQL Flexible Server, Blob Storage and Key Vault, defined in `infra/` and deployable from GitHub Actions. See [docs/deploy-azure.md](docs/deploy-azure.md).

## Development

```bash
make ci           # typecheck + backend and frontend unit tests + build
make e2e          # Playwright workflow suite against a local stack
dagger call ci    # the CI gate: also runs gitleaks, trivy and npm audit
```

449 unit and integration tests run in stub mode with no network calls; the Playwright suite covers desktop and mobile workflows. Agents working on this repo should start with [AGENTS.md](AGENTS.md).

## Limits

- One owner per deployment; there are no user accounts or sharing.
- Models are Gemini, Anthropic and Azure OpenAI, plus xAI Grok for X threads; files go to Azure Blob Storage (or Azurite).
- Vector search is a sequential scan over 3072-dimensional embeddings: fast at personal scale, not built for millions of chunks.

## Documentation

- [Architecture](docs/architecture.md): data model, ingest, search, RAG, entity graph, sessions and timelines
- [Deploying to Azure](docs/deploy-azure.md)
- [CI](docs/ci.md) and the [live test plan](docs/testing/live-e2e-plan.md)
- [iOS shell](docs/ios-shell.md)
- [AGENTS.md](AGENTS.md): conventions for agents and contributors

## License

[MIT](LICENSE)
