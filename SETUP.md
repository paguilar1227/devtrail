# Open Brain v2 — First-Time Azure Deployment Guide

This guide documents every step required to go from zero to a running production deployment, including the gotchas encountered during the initial deploy.

---

## 1. Prerequisites

- **Azure CLI** (`az`) — logged in with `az login`
- **Docker Desktop** — running
- **GitHub CLI** (`gh`) — logged in with `gh auth login`
- **Node.js 20+**
- **Azure Functions Core Tools** (`func`) — for publishing the Function App
- An existing **Azure Container Registry** (ACR) — this project uses a shared ACR, not a dedicated one

---

## 2. Create the Resource Group

```bash
az group create \
  --name openbrain-rg \
  --location eastus
```

Use whatever name and region you prefer. The name used here is `openbrain-rg`.

---

## 3. Push the Docker Image to ACR First

**This must happen before deploying Bicep.** The Container App Bicep module references an image in ACR at deploy time. If the image does not exist, Bicep fails with an image pull error. This is a chicken-and-egg problem: you need the Container App resource to exist to pull the image, but Bicep won't create the resource if it can't pull the image.

The solution is to push the image before running the Bicep deployment.

```bash
ACR_NAME=yourregistry   # your shared ACR name
IMAGE_TAG=$(git rev-parse --short HEAD)

# Always build for linux/amd64 — required when building on Apple Silicon (M-series Macs)
docker build --platform linux/amd64 \
  -t ${ACR_NAME}.azurecr.io/open-brain-v2:${IMAGE_TAG} .

docker tag ${ACR_NAME}.azurecr.io/open-brain-v2:${IMAGE_TAG} \
           ${ACR_NAME}.azurecr.io/open-brain-v2:latest

az acr login --name ${ACR_NAME}
docker push ${ACR_NAME}.azurecr.io/open-brain-v2:${IMAGE_TAG}
docker push ${ACR_NAME}.azurecr.io/open-brain-v2:latest
```

> **Gotcha — use git SHA tags, not just `latest`.**
> Azure Container Apps will not create a new revision if you push a new image under the same `latest` tag. The Container App only detects a change when the image reference in its configuration changes. Always push with a unique tag (git SHA) and deploy using that tag. The `latest` tag is a convenience alias only.

> **Gotcha — `--platform linux/amd64` is required on Apple Silicon.**
> Without it, Docker builds an arm64 image which fails to run on Azure's x86-64 infrastructure.

---

## 4. Assign AcrPull Role to the Container App Identity

**This must also happen before deploying Bicep** (or immediately after, before the Container App first tries to pull).

The Container App uses a managed identity to pull images from ACR. Because the ACR lives in a different resource group (`shared-rg`) than the Container App (`openbrain-rg`), this role assignment cannot be expressed in Bicep at resource group scope. It must be done via CLI.

First, get the managed identity's principal ID from the Bicep output (available after Bicep deploys). If you are doing this before Bicep runs, create the identity manually or do this step immediately after Bicep completes and before any revision is triggered.

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

## 5. Deploy Infrastructure (Bicep)

Secrets are passed directly on the CLI — they are intentionally omitted from `parameters.json` to avoid committing credentials to source control.

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
    telegramBotToken="<your-telegram-bot-token>" \
    telegramWebhookSecret="<your-telegram-webhook-secret>" \
    telegramChatId="<your-telegram-chat-id>"
```

### Where to get each secret

| Parameter | Where to get it |
|-----------|----------------|
| `dbAdminPassword` | Generate a strong password; store it somewhere safe |
| `apiKey` | Generate any random string — this is your Open Brain REST API key |
| `geminiApiKey` | Google AI Studio: https://aistudio.google.com/app/apikey |
| `anthropicApiKey` | Anthropic Console: https://console.anthropic.com/account/keys |
| `telegramBotToken` | BotFather on Telegram (see Section 10) |
| `telegramWebhookSecret` | Generate a random string — used to verify Telegram webhook calls |
| `telegramChatId` | Your personal Telegram chat ID (send a message to @userinfobot) |

The non-secret parameters (`environment`, `acrName`, `acrResourceGroup`, `consolidationSchedule`) are already set in `infra/parameters.json`.

---

## 6. Database Migration

No manual migration step is needed. The app checks on every startup whether the database tables exist. If they do not, it reads `migrations/001_initial_schema.sql` and runs it. This check uses the raw PostgreSQL pool (not the pgvector-typed client) so it works even before the `vector` extension is registered.

Migration is idempotent — it is safe to restart the app multiple times.

If you ever need to run the migration manually:

```bash
npm run migrate  # requires DATABASE_URL to be set
```

---

## 7. HNSW Vector Indexes — Deferred

The schema defines HNSW indexes on all `embedding vector(3072)` columns. These indexes significantly speed up approximate nearest-neighbor search at scale.

However, **the B1ms PostgreSQL tier (the cheapest Flexible Server SKU) does not have enough memory to build HNSW indexes for 3072-dimension vectors.** PostgreSQL requires the entire index to fit in `maintenance_work_mem` during build, and 3072-dim HNSW exceeds what B1ms can allocate.

The migration currently omits the HNSW index creation. Sequential scans (`ORDER BY embedding <=> $1`) work correctly and perform fine at single-user scale (thousands of rows, not millions). If the dataset grows or performance becomes a concern, either upgrade to a larger SKU or reduce embedding dimensions using Matryoshka truncation (Gemini Embedding 2 supports this without re-embedding).

---

## 8. Enable the Gemini Generative Language API

The `@google/generative-ai` Node.js SDK routes all requests through the **Generative Language API** endpoint (`generativelanguage.googleapis.com`), even when you supply a Vertex AI service account key. This API is not enabled by default on Google Cloud projects.

If you see errors like `API has not been used in project ... before or it is disabled`, enable it here:

https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview

Select the Google Cloud project associated with your API key, then click Enable.

> **Gotcha — correct embedding model ID.**
> The model ID for embeddings is `gemini-embedding-2-preview` (not `text-embedding-preview-...` or other experimental IDs that appear in some documentation). Using the wrong model ID causes a 404.

---

## 9. Telegram Bot Setup

1. Open Telegram and message **@BotFather**
2. Send `/newbot` and follow the prompts — you get a bot token
3. Register the webhook after the Container App is deployed:

```bash
APP_URL=https://<your-container-app-fqdn>
BOT_TOKEN=<your-telegram-bot-token>
WEBHOOK_SECRET=<your-telegram-webhook-secret>   # same value passed to Bicep

curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${APP_URL}/telegram/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}"
```

The `secret_token` causes Telegram to include an `X-Telegram-Bot-Api-Secret-Token` header on every webhook POST. The server validates this header and rejects requests without it.

To get your personal chat ID (needed for `telegramChatId`):
- Send any message to your bot
- Call `https://api.telegram.org/bot<token>/getUpdates` — the `chat.id` in the response is your ID
- Or message @userinfobot directly

---

## 10. GitHub Actions OIDC Setup

The CI/CD pipeline authenticates to Azure using OIDC (no stored credentials). The pipeline pushes the Docker image to ACR and deploys the Container App and Function App on every push to `main`.

### App Registration and Service Principal

```bash
# Create the app registration
az ad app create --display-name "open-brain-v2-cicd"

APP_ID=$(az ad app list --display-name "open-brain-v2-cicd" --query "[0].appId" -o tsv)

# Create the service principal
az ad sp create --id "${APP_ID}"

SP_OBJECT_ID=$(az ad sp show --id "${APP_ID}" --query id -o tsv)
```

### Federated Credential

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

Replace `<your-github-username>` with your actual GitHub username.

### Role Assignments

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
RG_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/openbrain-rg"
ACR_ID=$(az acr show --name yourregistry --resource-group shared-rg --query id -o tsv)

# Contributor on the Open Brain resource group (to update Container App + Function App)
az role assignment create \
  --assignee-object-id "${SP_OBJECT_ID}" \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope "${RG_ID}"

# AcrPush on the shared ACR (to push Docker images)
az role assignment create \
  --assignee-object-id "${SP_OBJECT_ID}" \
  --assignee-principal-type ServicePrincipal \
  --role AcrPush \
  --scope "${ACR_ID}"
```

### GitHub Secrets and Variables

In your GitHub repo settings, add:

**Secrets** (Settings > Secrets and variables > Actions > Secrets):

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | The `appId` of your app registration |
| `AZURE_TENANT_ID` | Your Azure tenant ID (`az account show --query tenantId -o tsv`) |
| `AZURE_SUBSCRIPTION_ID` | Your Azure subscription ID (`az account show --query id -o tsv`) |

**Variables** (Settings > Secrets and variables > Actions > Variables):

| Variable | Value |
|----------|-------|
| `ACR_NAME` | `yourregistry` |
| `AZURE_RESOURCE_GROUP` | `openbrain-rg` |
| `CONTAINER_APP_NAME` | `openbrain-prod-api` |
| `FUNCTION_APP_NAME` | `openbrain-prod-func` |

---

## 11. MCP Connector (Claude.ai)

To connect Open Brain to Claude.ai as an MCP server:

```
https://<your-container-app-fqdn>/mcp?key=<your-open-brain-api-key>
```

In Claude.ai settings, add this as a custom MCP connector URL. The `key` query parameter is equivalent to the `x-brain-key` header.

---

## 12. Verify the Deployment

```bash
APP_URL=https://<your-container-app-fqdn>
API_KEY=<your-open-brain-api-key>

# Health check
curl ${APP_URL}/health

# Test capture
curl -X POST ${APP_URL}/api/v1/capture \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"content": "First capture — deployment test", "source": "api"}'
```

A successful capture returns a 201 with the new capture's ID.

---

## Deployment Order Summary

Getting the order wrong causes failures. The correct order is:

1. Build and push Docker image to ACR with a git SHA tag
2. Deploy Bicep (`az deployment group create`)
3. Assign AcrPull role to the Container App managed identity (cross-RG, must be CLI)
4. Register Telegram webhook
5. Set up GitHub OIDC (one-time)

After the initial setup, GitHub Actions handles all subsequent deploys automatically on push to `main`.

---

## Configurable Settings

| Setting | Environment Variable | Default |
|---------|---------------------|---------|
| Consolidation schedule | `CONSOLIDATION_SCHEDULE` (Azure Function app setting) | `0 */30 * * * *` (every 30 min) |
| Review mode | `REVIEW_MODE` | `hybrid` |
| Daily digest | `DAILY_DIGEST_ENABLED` | `true` |
| Server port | `PORT` | `3000` |

The consolidation schedule uses Azure Functions CRON format (6 fields, seconds first). Common values:
- Every 30 minutes: `0 */30 * * * *`
- Every hour: `0 0 * * * *`
- Daily at 6 AM UTC: `0 0 6 * * *`
