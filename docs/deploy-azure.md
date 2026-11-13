# Deploying DevTrail to Azure

The reference deployment runs the single DevTrail container on **Azure Container Apps**, with **PostgreSQL Flexible Server** (pgvector), **Blob Storage**, **Key Vault** and **Log Analytics / Application Insights**. All of it is defined in `infra/main.bicep`.

For local development you need none of this; see the README quick start.

## What you need

- An Azure subscription, the `az` CLI (logged in) and Docker.
- An existing **Azure Container Registry** (ACR). The templates reference it rather than create it, so one registry can serve several projects.
- Model access:
  - **Gemini** API key (embeddings, plus metadata for audio and video). Enable the *Generative Language API* on its Google Cloud project.
  - **Anthropic** API key (metadata for text, images and PDFs, including OCR; entity extraction).
  - **Azure OpenAI / Foundry** endpoint and key with two chat deployments, by default `gpt-5-4` (fast answers) and `gpt-5-4-pro` (opt-in thorough answers).
  - Optional URL sources: **Supadata** (YouTube), **Firecrawl** (web pages), **xAI** (X threads). Pass any placeholder for a source you do not use; saving that kind of URL will then fail with a clear error.
- A long random API key for DevTrail itself: `openssl rand -hex 32`.

## 1. Choose names

```bash
RG=devtrail-rg                 # resource group for DevTrail
LOCATION=centralus
ACR_NAME=<your-registry>
ACR_RG=<your-registry-resource-group>
APP=devtrail-prod-api          # what infra/main.bicep names the Container App (environment=prod)
```

```bash
az group create --name "$RG" --location "$LOCATION"
```

## 2. Build and push the image first

The Container App references the image at deploy time, so it has to exist before the Bicep deployment.

```bash
TAG=$(git rev-parse --short HEAD)
az acr login --name "$ACR_NAME"
docker build --platform linux/amd64 -t "$ACR_NAME.azurecr.io/devtrail:$TAG" .
docker push "$ACR_NAME.azurecr.io/devtrail:$TAG"
```

## 3. Deploy the infrastructure

Copy the example parameters and fill in the non-secret values:

```bash
cp infra/parameters.example.json infra/parameters.json   # gitignore it if you keep secrets nearby
```

Pass secrets on the command line (or from a secret store), never in the file:

```bash
az deployment group create \
  --resource-group "$RG" \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.json \
  --parameters imageTag="$TAG" \
    dbAdminPassword="<postgres-admin-password>" \
    apiKey="<devtrail-api-key>" \
    geminiApiKey="<gemini-key>" \
    anthropicApiKey="<anthropic-key>" \
    azureOpenAIKey="<azure-openai-key>" \
    xaiApiKey="<xai-key-or-placeholder>" \
    firecrawlApiKey="<firecrawl-key-or-placeholder>" \
    supadataApiKey="<supadata-key-or-placeholder>"
```

This creates Log Analytics + Application Insights, PostgreSQL Flexible Server with pgvector, a private Blob container, a Key Vault holding every secret, and the Container App with a managed identity that reads those secrets.

Migrations run automatically every time the container starts; there is no manual migration step.

The first run can fail or time out at the Container App, because its identity cannot pull from your registry yet. That is expected: do step 4, then run the same command again.

## 4. Let the Container App pull from your registry

The templates create the app's managed identity but leave your registry alone: it is shared, not owned by this deployment, and granting a role on it needs rights on the registry itself. Grant `AcrPull` once with the CLI:

```bash
PRINCIPAL_ID=$(az identity show -n devtrail-prod-identity -g "$RG" --query principalId -o tsv)
ACR_ID=$(az acr show --name "$ACR_NAME" --resource-group "$ACR_RG" --query id -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope "$ACR_ID"
```

Role assignments take a minute or two to apply. Then rerun the step 3 deployment, or, if it already succeeded, roll the app with `az containerapp update -n "$APP" -g "$RG" --image "$ACR_NAME.azurecr.io/devtrail:$TAG"`.

## 5. Sign-in

By default (`authMode=api-key`) the web app asks for the API key, and the same key works for REST and MCP. That is enough for a personal deployment behind HTTPS.

To sign in with Microsoft Entra ID instead, put Container Apps authentication (Easy Auth) in front of the web app and switch the mode. The API, MCP endpoint and health check stay on Bearer auth:

```bash
FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

az ad app create --display-name devtrail-web \
  --web-redirect-uris "https://$FQDN/.auth/login/aad/callback" \
  --enable-id-token-issuance true
CLIENT_ID=$(az ad app list --display-name devtrail-web --query "[0].appId" -o tsv)
CLIENT_SECRET=$(az ad app credential reset --id "$CLIENT_ID" --query password -o tsv)

az containerapp auth microsoft update -n "$APP" -g "$RG" \
  --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" \
  --issuer "https://login.microsoftonline.com/$TENANT_ID/v2.0" --yes
az containerapp auth update -n "$APP" -g "$RG" \
  --enabled true \
  --unauthenticated-client-action RedirectToLoginPage \
  --excluded-paths "/api/v1/*,/mcp,/health"
az containerapp update -n "$APP" -g "$RG" --set-env-vars AUTH_MODE=easyauth
```

Only use `AUTH_MODE=easyauth` behind Easy Auth: in that mode `/api/auth/token` trusts the `x-ms-client-principal-*` headers the platform injects. To keep the deployment single-owner, set **Assignment required** on the `devtrail-web` enterprise application and assign only yourself.

## 6. Connect clients

- **Web:** open `https://$FQDN`.
- **REST:** send `Authorization: Bearer <devtrail-api-key>` to `https://$FQDN/api/v1/...`. The OpenAPI spec is at `/api/v1/openapi.json` and Swagger UI at `/api/v1/docs`.
- **MCP:** point any MCP client at `https://$FQDN/mcp` with the same Bearer header (example in the README). For clients that can only take a URL, deploy with `mcpAllowUrlKey=true` and use `https://$FQDN/mcp?key=<devtrail-api-key>`; URLs end up in logs and history, so prefer the header when you can.
- **iOS:** build the Capacitor shell (see `AGENTS.md`) and enter the server URL and API key on first launch.

## 7. Continuous deployment from GitHub (optional)

`.github/workflows/deploy.yml` builds, pushes and rolls the Container App on every push to `main`, then smoke-tests auth and a project round trip. It runs only when the repository variables below are set, and authenticates with OIDC, so no Azure credentials are stored in GitHub.

```bash
az ad app create --display-name devtrail-cicd
APP_ID=$(az ad app list --display-name devtrail-cicd --query "[0].appId" -o tsv)
az ad sp create --id "$APP_ID"
SP_OBJECT_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)

az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "devtrail-github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
az role assignment create --assignee-object-id "$SP_OBJECT_ID" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG"
az role assignment create --assignee-object-id "$SP_OBJECT_ID" --assignee-principal-type ServicePrincipal \
  --role AcrPush --scope "$ACR_ID"
```

In the repository settings (**Secrets and variables → Actions**):

| Secrets | Value |
|---|---|
| `AZURE_CLIENT_ID` | `$APP_ID` |
| `AZURE_TENANT_ID` | `az account show --query tenantId -o tsv` |
| `AZURE_SUBSCRIPTION_ID` | `$SUBSCRIPTION_ID` |
| `DEVTRAIL_API_KEY` | the API key, used by the smoke tests |

| Variables | Value |
|---|---|
| `ACR_NAME` | `$ACR_NAME` |
| `AZURE_RESOURCE_GROUP` | `$RG` |
| `CONTAINER_APP_NAME` | `$APP` |
| `AUTH_MODE` | `easyauth` if you set up step 5's Easy Auth; otherwise leave unset |

For a deploy without GitHub Actions, `RESOURCE_GROUP=$RG ACR_NAME=$ACR_NAME CONTAINER_APP_NAME=$APP bash scripts/deploy.sh` builds, pushes and rolls a new revision.

## Operating notes

- **Health:** `GET /health` returns `{"ok":true,"service":"devtrail","version":"2.0.0"}` and backs the Container App probes.
- **Files:** the blob container is private. API responses carry short-lived signed read URLs (60 minutes by default), generated by `BlobStorage.getReadSasUrl()` in `backend/src/storage/blob.ts`.
- **Vector search:** embeddings are 3072-dimensional and searched with a sequential scan; there is no HNSW index, because the smallest Postgres tier cannot build one at that dimension. That is fine at personal scale. For much larger corpora, upsize the database or reduce the embedding dimension.
- **Long ingests:** Container Apps closes HTTP requests after about 240 seconds. Ingest is asynchronous (`202` + poll `/api/v1/content/{id}/status`), so long URL fetches finish in the background.
- **Telemetry:** `infra/workbook-telemetry.bicep` deploys an Application Insights workbook over the app's request and provider telemetry.
- **Live validation:** [docs/testing/live-e2e-plan.md](testing/live-e2e-plan.md) is a 64-test manual plan for exercising REST and MCP against a real deployment.
