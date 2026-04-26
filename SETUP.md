# Open Brain v2 — First-Time Azure Deployment Guide

This walks you from zero to a running production deployment, including the gotchas hit during the initial deploy. Subsequent deploys are handled by GitHub Actions on every push to `main` (`.github/workflows/deploy.yml`).

> **Heads-up — legacy infra still in the templates.** The Bicep templates and `scripts/deploy.sh` were authored against the pre-V2 architecture (Telegram bot + consolidation Azure Function). The app no longer reads any Telegram env vars and the function is a no-op, but the Bicep parameters and deploy step are still in place. They're flagged in §11 below; the user-flow steps in this doc reflect what the V2 app actually needs.

---

## 1. Prerequisites

- **Azure CLI** (`az`) — logged in (`az login`)
- **Docker Desktop** — running
- **GitHub CLI** (`gh`) — logged in (`gh auth login`)
- **Node.js 20+**
- An existing **Azure Container Registry** (ACR). This project shares an ACR with other projects in `shared-rg` rather than provisioning a dedicated one.

You will need API keys/values for everything below before running Bicep:

| Value | Where to get it |
|-------|-----------------|
| `dbAdminPassword` | Generate a strong password; store somewhere safe |
| `apiKey` (Open Brain) | Generate any random string — this is your bearer token for `/api/v1/*` and `?key=` for `/mcp` |
| `geminiApiKey` | Google AI Studio → https://aistudio.google.com/app/apikey |
| `anthropicApiKey` | Anthropic Console → https://console.anthropic.com/account/keys |
| `xaiApiKey` | xAI console (used for X/Twitter live search via Grok) |
| `firecrawlApiKey` | Firecrawl dashboard (used for HTML extraction fallback during URL ingest) |
| Azure OpenAI endpoint + key | An Azure Foundry / Azure OpenAI resource with `gpt-5-4` (chat completions) and `gpt-5-4-pro` (Responses API) deployments |

The Azure OpenAI resource doesn't have to live in the same resource group — point at any one you have access to. The Container App reads the endpoint + key + the two deployment names from Key Vault.

---

## 2. Create the Resource Group

```bash
az group create \
  --name openbrain-rg \
  --location eastus
```

Use whatever region you prefer. The name `openbrain-rg` matches what's referenced in the rest of this doc.

---

## 3. Push the Docker Image to ACR FIRST

**Must happen before deploying Bicep.** The Container App module references an image at deploy time. If the image doesn't exist, Bicep fails with an image pull error. You can't create the Container App resource to pull the image before pushing — chicken and egg. Push first.

```bash
ACR_NAME=yourregistry         # your shared ACR name
IMAGE_TAG=$(git rev-parse --short HEAD)

# linux/amd64 is required when building on Apple Silicon — Docker defaults to arm64
# on M-series Macs, which fails to run on Azure's x86-64 infra.
docker build --platform linux/amd64 \
  -t ${ACR_NAME}.azurecr.io/open-brain-v2:${IMAGE_TAG} .

docker tag ${ACR_NAME}.azurecr.io/open-brain-v2:${IMAGE_TAG} \
           ${ACR_NAME}.azurecr.io/open-brain-v2:latest

az acr login --name ${ACR_NAME}
docker push ${ACR_NAME}.azurecr.io/open-brain-v2:${IMAGE_TAG}
docker push ${ACR_NAME}.azurecr.io/open-brain-v2:latest
```

> **Gotcha — use git SHA tags, not just `latest`.**
> Azure Container Apps only creates a new revision when the image *reference* changes. Pushing a new image under the same `:latest` tag is invisible to Container Apps. Always push with a unique tag (the git SHA works) and deploy that tag. `latest` is a convenience alias only.

---

## 4. Deploy Infrastructure (Bicep)

Secrets are passed via CLI — they are intentionally absent from `parameters.json` to keep credentials out of source control.

```bash
az deployment group create \
  --resource-group openbrain-rg \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.json \
  --parameters \
    dbAdminPassword="<postgres-admin-password>" \
    apiKey="<your-open-brain-api-key>" \
    geminiApiKey="<your-gemini-api-key>" \
    anthropicApiKey="<your-anthropic-api-key>" \
    telegramBotToken="unused" \
    telegramWebhookSecret="unused" \
    telegramChatId="unused"
```

The non-secret values (`environment`, `acrName`, `acrResourceGroup`, `consolidationSchedule`) are already in `infra/parameters.json`.

> **About the `telegram*` parameters.** The current Bicep schema marks them required (`@secure()` with no default). The V2 app doesn't read them — the values just land in Key Vault unused. Pass any non-empty placeholder. Removing these parameters from Bicep is on the cleanup list.

> **About the Azure OpenAI / xAI / Firecrawl keys.** These are read by the V2 app but **not** in the current Bicep schema. After Bicep deploys, set them on the Container App directly (see §6).

---

## 5. Assign AcrPull to the Container App's Managed Identity (cross-RG)

The Container App pulls images from the ACR using its managed identity. Because the ACR lives in a different resource group (`shared-rg`) than the Container App (`openbrain-rg`), this role assignment can't be expressed in Bicep at resource-group scope. Do it via CLI right after Bicep deploys, before the first revision tries to pull.

```bash
PRINCIPAL_ID=$(az containerapp show \
  --name openbrain-prod-api \
  --resource-group openbrain-rg \
  --query "identity.principalId" -o tsv)

ACR_ID=$(az acr show \
  --name yourregistry \
  --resource-group shared-rg \
  --query id -o tsv)

az role assignment create \
  --assignee "${PRINCIPAL_ID}" \
  --role AcrPull \
  --scope "${ACR_ID}"
```

---

## 6. Set the V2-Only Secrets on the Container App

The Bicep template predates the V2 stack and doesn't wire the Azure OpenAI / xAI / Firecrawl keys yet. Set them as Container App secrets and surface them as env vars:

```bash
az containerapp secret set \
  --name openbrain-prod-api --resource-group openbrain-rg \
  --secrets \
    azure-openai-endpoint="https://<your-foundry-resource>.openai.azure.com" \
    azure-openai-key="<azure-openai-key>" \
    xai-api-key="<xai-key>" \
    firecrawl-api-key="<firecrawl-key>"

az containerapp update \
  --name openbrain-prod-api --resource-group openbrain-rg \
  --set-env-vars \
    AZURE_OPENAI_ENDPOINT=secretref:azure-openai-endpoint \
    AZURE_OPENAI_KEY=secretref:azure-openai-key \
    AZURE_RAG_DEPLOYMENT=gpt-5-4 \
    AZURE_DEEP_RAG_DEPLOYMENT=gpt-5-4-pro \
    XAI_API_KEY=secretref:xai-api-key \
    FIRECRAWL_API_KEY=secretref:firecrawl-api-key
```

`AZURE_RAG_DEPLOYMENT` and `AZURE_DEEP_RAG_DEPLOYMENT` default to `gpt-5-4` / `gpt-5-4-pro` in `src/config.ts`; override only if your deployment names differ.

---

## 7. Database Migrations

There is **no manual migration step**. On every container start, `runMigrations()` in `src/server.ts` checks for table existence (`projects`, `content_items.source_url`, `entities`) and applies any missing migrations idempotently. Restarting the app multiple times is safe.

Migrations on disk (`migrations/`):

- `001_schema.sql` — projects, content_items, chunks, todos, todo_comments
- `002_source_url.sql` — adds `source_url` to content_items (URL ingest)
- `003_entities_graph.sql` — entities, chunk_entities, `published_at` on content_items

Run manually if you want to (e.g., to re-init a dev DB from scratch):

```bash
psql "$DATABASE_URL" -f migrations/001_schema.sql
psql "$DATABASE_URL" -f migrations/002_source_url.sql
psql "$DATABASE_URL" -f migrations/003_entities_graph.sql
```

> **`scripts/deploy.sh` is stale here.** It references `migrations/001_initial_schema.sql`, which doesn't exist. The auto-migration on startup is the canonical path; that script step is dead code.

> **No HNSW indexes.** B1ms (the cheapest Postgres Flexible Server SKU) doesn't have enough memory to build HNSW for 3072-dim vectors — the index has to fit in `maintenance_work_mem` during build, and B1ms can't allocate it. Sequential scan on cosine distance (`ORDER BY embedding <=> $1`) is fine at single-user scale (low thousands of chunks, well under 100ms/query). To unblock larger corpora, either upsize the DB or use Matryoshka truncation on Gemini Embedding 2 (smaller dim, then HNSW fits).

---

## 8. Disable Public Blob Access + SAS-Signed URLs

The storage account is created with `Allow Blob Public Access = false` and the container with `publicAccess: 'None'`. Direct URLs from `blob_url` are not downloadable as-is.

The API generates **short-lived SAS read URLs** (default 60 min) at response time via `BlobStorage.getReadSasUrl()` (`src/storage/blob.ts`). All `/api/v1/content` endpoints that return `blob_url` rewrite it to a signed URL before responding. No further config needed once the storage account is created.

If you flip `allowBlobPublicAccess` to true for any reason, the SAS code is a no-op pass-through for already-public URLs; nothing breaks, but you lose access control.

---

## 9. Enable the Gemini Generative Language API

The `@google/generative-ai` Node SDK routes through `generativelanguage.googleapis.com`. That API is **not enabled by default** on Google Cloud projects. If you see `API has not been used in project ... or it is disabled`, enable it:

https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview

Select the GCP project tied to your Gemini API key, then click **Enable**.

> **Embedding model ID.** Use `gemini-embedding-2-preview` (3072d, multimodal). Other IDs in scattered docs (`text-embedding-preview-...`) will 404. The codebase pins this in `src/server.ts`.

---

## 10. GitHub Actions (OIDC)

CI + CD authenticate to Azure via OIDC — no stored credentials. CI runs typecheck + tests on every PR/push (`.github/workflows/ci.yml`). Deploy runs on every push to `main` (`.github/workflows/deploy.yml`): build the image with the commit SHA tag, push to ACR, update the Container App revision.

### App registration + service principal (one-time)

```bash
az ad app create --display-name "open-brain-v2-cicd"

APP_ID=$(az ad app list --display-name "open-brain-v2-cicd" --query "[0].appId" -o tsv)
az ad sp create --id "${APP_ID}"
SP_OBJECT_ID=$(az ad sp show --id "${APP_ID}" --query id -o tsv)
```

### Federated credential

```bash
az ad app federated-credential create \
  --id "${APP_ID}" \
  --parameters '{
    "name": "open-brain-github-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<your-github-username>/open-brain-v2:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### Role assignments

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
RG_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/openbrain-rg"
ACR_ID=$(az acr show --name yourregistry --resource-group shared-rg --query id -o tsv)

# Contributor on the project RG (update Container App + Function App)
az role assignment create \
  --assignee-object-id "${SP_OBJECT_ID}" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "${RG_ID}"

# AcrPush on the shared ACR
az role assignment create \
  --assignee-object-id "${SP_OBJECT_ID}" --assignee-principal-type ServicePrincipal \
  --role AcrPush --scope "${ACR_ID}"
```

### GitHub repo settings

**Secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | `appId` from the app registration |
| `AZURE_TENANT_ID` | `az account show --query tenantId -o tsv` |
| `AZURE_SUBSCRIPTION_ID` | `az account show --query id -o tsv` |
| `GEMINI_API_KEY` | Used by CI for tests that exercise embedding/LLM mocks (won't actually call Gemini) |

**Variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|----------|-------|
| `ACR_NAME` | `yourregistry` |
| `AZURE_RESOURCE_GROUP` | `openbrain-rg` |
| `CONTAINER_APP_NAME` | `openbrain-prod-api` |
| `FUNCTION_APP_NAME` | `openbrain-prod-func` (still referenced by the Functions step — see §11) |

---

## 11. Legacy Infrastructure (cleanup candidates)

The following are deployed but **not used** by the V2 app. They're slated for removal but still in the templates — leave them alone for now unless you want to do the cleanup pass.

| Item | Why it's still here |
|------|---------------------|
| `infra/modules/function-app.bicep` + `functions/consolidation-trigger/` | Pre-pivot timer trigger that ran the captures-facts-insights consolidation pipeline. The V2 app has no captures/facts/insights; the function is a no-op. |
| `telegramBotToken` / `telegramWebhookSecret` / `telegramChatId` Bicep params | Pre-pivot Telegram bot. No V2 code reads these. |
| `consolidationSchedule` parameter | Cron for the no-op function. Ignored. |
| `Azure/functions-action` step in `deploy.yml` | Publishes the no-op function. Wastes a CI minute. |
| `psql ... migrations/001_initial_schema.sql` step in `scripts/deploy.sh` | References a migration filename that doesn't exist. Auto-migration on startup is the real path. |

When you do the cleanup, also remove `Function App` references from this doc and `ARCHITECTURE.md`.

---

## 12. MCP Connector (Claude.ai / Claude Desktop / Claude Code)

```
https://<your-container-app-fqdn>/mcp?key=<your-open-brain-api-key>
```

Add this URL as a custom MCP connector. The `key` query parameter is equivalent to the `Authorization: Bearer ...` header that the REST API uses, so the same key works for both surfaces. The MCP server is stateless — a fresh `McpServer + WebStandardStreamableHTTPServerTransport` is constructed per request.

---

## 13. Verify the Deployment

```bash
APP_URL=https://<your-container-app-fqdn>
API_KEY=<your-open-brain-api-key>

# Health (no auth)
curl ${APP_URL}/health
# expected: {"ok":true,"service":"open-brain","version":"2.0.0"}

# Authenticated list
curl -s -H "Authorization: Bearer ${API_KEY}" "${APP_URL}/api/v1/projects" | jq

# Create a project
curl -s -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  "${APP_URL}/api/v1/projects" -d '{"name":"smoke-test"}' | jq
```

For a full end-to-end validation, work through `E2E_TEST_PLAN.md` — 52 reproducible tests across the REST + MCP surfaces against production.

---

## Deployment Order Summary

Order matters; getting it wrong leaves you debugging Bicep image-pull failures or Container App revisions that won't update.

1. Build + push Docker image to ACR with a git SHA tag (§3)
2. Deploy Bicep — `az deployment group create` (§4)
3. Assign AcrPull to the Container App's managed identity (cross-RG, CLI only) (§5)
4. Set the V2-only secrets on the Container App (§6)
5. Verify (§13)
6. (One-time) Set up GitHub Actions OIDC (§10) — every subsequent deploy is automatic on push to `main`

---

## Configurable Settings (V2)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `TIMEZONE` | `America/Chicago` | IANA timezone (used for date math; minimally surfaced today) |
| `AZURE_RAG_DEPLOYMENT` | `gpt-5-4` | Azure OpenAI deployment name for fast-path RAG (chat completions) |
| `AZURE_DEEP_RAG_DEPLOYMENT` | `gpt-5-4-pro` | Azure OpenAI deployment name for thorough-path RAG (Responses API) |

All other values (`DATABASE_URL`, `OPEN_BRAIN_API_KEY`, the various `*_API_KEY` and `AZURE_*` keys) are required — `loadConfig()` in `src/config.ts` throws on missing values.

---

## Provider Gotchas

### LLM JSON output

- Anthropic Haiku and Gemini both occasionally wrap JSON in markdown fences even when JSON mode is requested. Every LLM-JSON path is run through `extractJson()` in `src/providers/json-utils.ts` before `JSON.parse`. If you add a new JSON-producing call, route it through there.
- Haiku metadata calls use `maxTokens: 8192` for PDF-scale inputs (a 2048 default truncates real-world PDFs). Entity extraction caps input at 50K chars and uses `maxTokens: 4096`.
- `gpt-5-4-pro` on Azure Foundry **rejects `reasoning_effort: 'low'`** (HTTP 400 with `"param": "reasoning.effort"`). Only `medium` (default) and `high` are accepted. May change with `gpt-5.5+`; re-test on model swaps.

### PDF parsing

- `pdf-parse` v2 ships a `PDFParse` class — the v1 default-import function is gone. Use the class.
- Extracted PDF text can leak NUL/FF/VT control bytes that break strict JSON parsers (jq, `JSON.parse`). `sanitizeControlChars()` in `src/providers/pdf-extract.ts` strips them before persisting.

### Container App

- `minReplicas: 1` (always-on) — eliminates cold-start latency. Doesn't scale to zero.
- HTTP response timeout ≈ 240s. URL ingestion (especially YouTube) can exceed that when fallback fetchers chain. Server completes the work either way; the client just sees 504. There's an open task to convert URL ingest to async + 202 (job_id polling).

---

## Local Development

For local dev, see `README.md` — there's a `docker-compose.yml` that brings up a `pgvector/pgvector:pg16` container on host port **5434** (not 5432, to avoid clashing with a system Postgres) and `npm run dev` (`tsx watch src/server.ts`) for the backend. Web UI is `cd web && npm run dev`. Auto-migrations apply on first boot.
