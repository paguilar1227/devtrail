# Todos MCP Server — Technical Specification

> **Date:** 2026-03-14
> **Author:** Alex (with Claude)
> **Status:** Ready for implementation
> **Target repo:** `paguilar1227/todos-mcp`

---

## 1. Product Definition

### 1.1 What It Is

A personal task management system exposed as an MCP (Model Context Protocol) server. It allows any AI client — Claude.ai (web/desktop), Claude mobile, or Claude Code — to create, read, update, and manage tasks through natural language.

### 1.2 What It Does

- Organizes tasks into a **Project → Section → Task** hierarchy
- Tasks have **status**, **priority**, and **due dates**
- Tasks support **comments** (a chronological progress log — "what happened")
- Tasks support **subtasks** (recursive child tasks — "what needs to be done", up to 4 levels deep)
- Filtering and querying by project, section, status, priority, due date, and recent activity
- Proactive suggestions when the user makes commitments in conversation (but never adds without consent)

### 1.3 Why It Exists

A file-based todo system (`/home/claude/todos.md` or `/mnt/user-data/todos.md`) only works from Claude.ai web sessions with computer use enabled. It doesn't work on mobile or Claude Code. An MCP server makes the same task data accessible from every Claude client via a universal protocol.

### 1.4 Hierarchy

```
Project (e.g., "Deep Research Engine", "Vault Bridge", "Personal")
  └── Section (e.g., "Backend", "Deployment", "Design")
        └── Task (with status, priority, due date)
              ├── Comment (timestamped progress log entry)
              └── Subtask (recursive child task, up to 4 levels)
```

- One project has many sections
- One section has many tasks
- One task has many comments and many subtasks
- A subtask is itself a task (same schema, with a `parent_id` pointing to its parent)
- Subtasks can nest up to 4 levels (parent → child → grandchild → great-grandchild), though 2 levels is the common case

---

## 2. Architecture

### 2.1 Overview

```
┌──────────────────────┐
│  Claude Clients       │
│  (Web, Mobile, Code)  │
└──────────┬───────────┘
           │ MCP Protocol (SSE)
           │ Auth: ?token=xxx query param
           ▼
┌──────────────────────┐
│  Todos MCP Server     │
│  FastMCP + Uvicorn    │
│  Azure Container Apps │
│  (Consumption,        │
│   scale-to-zero)      │
└──────────┬───────────┘
           │ Azure SDK
           │ Managed Identity
           ▼
┌──────────────────────┐
│  Azure Table Storage  │
│  (Storage Account)    │
│  Table: "todos"       │
└──────────────────────┘
```

### 2.2 Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Python 3.12 + FastMCP + Uvicorn | Matches Vault Bridge pattern. FastMCP for MCP protocol, Uvicorn to own the ASGI app directly (don't use `fastmcp run`) |
| **Storage** | Azure Table Storage | $0/month at this scale. Pay-per-operation. No provisioning. No minimum throughput. Resilient (triple-replicated by default). Simple key-value model |
| **Compute** | Azure Container Apps (Consumption plan) | Scale-to-zero. ~$0/month when idle. Matches existing infra pattern |
| **Auth** | Token via `?token=` query param | Claude connector UI constraint — doesn't support custom headers |
| **Container Registry** | Shared ACR: `yourregistry.azurecr.io` (Basic tier) | Existing shared registry across all projects |
| **IaC** | ARM template | Matches existing convention |
| **CI/CD** | GitHub Actions with OIDC (Workload Identity Federation) | Matches Vault Bridge pattern. No stored secrets |

### 2.3 Azure Resources

| Resource | Name | Resource Group |
|----------|------|----------------|
| Resource Group | `todos-mcp-rg` | — |
| Storage Account | `yourstorageaccount` | `todos-mcp-rg` |
| Table | `todos` | (inside storage account) |
| Container App Environment | Shared or new (depends on what exists) | `todos-mcp-rg` |
| Container App | `todos-mcp` | `todos-mcp-rg` |
| Managed Identity | System-assigned on Container App | `todos-mcp-rg` |

The Container App's managed identity gets the `Storage Table Data Contributor` role on the storage account. No connection strings or keys stored anywhere.

### 2.4 Why Not Other Storage Options

| Option | Verdict | Why |
|--------|---------|-----|
| SQLite | Too fragile | No persistent volume support on Container Apps. Single file, no redundancy |
| Single JSON file (Blob) | Too hacky | Concurrent write issues, no querying, scales poorly |
| Cosmos DB | Overkill | Minimum ~$0.25/million RU + $0.25/GB. Free tier works but adds unnecessary complexity for a personal todo list |
| Azure SQL | Overkill | Cheapest tier ~$5/month. Cold-start latency on serverless |
| **Azure Table Storage** | **Winner** | $0/month at this scale. Triple-replicated. Pay-per-op. Simple. Resilient |

---

## 3. Data Model

### 3.1 Table Design

Single table named `todos`. All entities use composite `PartitionKey` / `RowKey` pairs.

**PartitionKey strategy:** All entities within a project share the same PartitionKey (`project:{slug}`). This means querying everything in a project is a single partition scan — fast and cheap.

**RowKey strategy:** Encodes the entity type and a sortable identifier.

### 3.2 Entity Types

#### Project

| Field | Value |
|-------|-------|
| PartitionKey | `project:{slug}` |
| RowKey | `_meta` |
| name | `str` — Display name (e.g., "Deep Research Engine") |
| description | `str` — Optional description |
| created_at | `str` — ISO 8601 timestamp |
| updated_at | `str` — ISO 8601 timestamp |
| entity_type | `"project"` |

#### Section

| Field | Value |
|-------|-------|
| PartitionKey | `project:{slug}` |
| RowKey | `section:{slug}` |
| name | `str` — Display name (e.g., "Backend") |
| order | `int` — Sort position within the project |
| created_at | `str` — ISO 8601 timestamp |
| entity_type | `"section"` |

#### Task

| Field | Value |
|-------|-------|
| PartitionKey | `project:{slug}` |
| RowKey | `task:{ulid}` |
| section | `str` — Section slug this task belongs to |
| parent_id | `str` — ULID of parent task, or empty string for top-level tasks |
| depth | `int` — 0 for top-level, 1-3 for subtasks |
| description | `str` — Task description |
| status | `str` — One of: `not_started`, `in_progress`, `paused`, `done`, `blocked` |
| priority | `str` — One of: `P1`, `P2`, `P3`, or empty string |
| due_date | `str` — `YYYY-MM-DD` format, or empty string |
| created_at | `str` — ISO 8601 timestamp |
| updated_at | `str` — ISO 8601 timestamp |
| entity_type | `"task"` |

**Why ULIDs instead of UUIDs:** ULIDs are time-sortable. Tasks created earlier sort first lexically. This means querying tasks and sorting by creation order is free — no secondary sort needed.

#### Comment

| Field | Value |
|-------|-------|
| PartitionKey | `project:{slug}` |
| RowKey | `comment:{task_ulid}:{timestamp_ms}` |
| task_id | `str` — ULID of the task this comment belongs to |
| content | `str` — The comment text |
| created_at | `str` — ISO 8601 timestamp |
| entity_type | `"comment"` |

**RowKey structure for comments:** `comment:{task_ulid}:{timestamp_ms}` — this groups comments by task and sorts them chronologically. Querying all comments for a task is a prefix scan on RowKey.

### 3.3 Slug Generation

Slugs are derived from display names: lowercased, spaces replaced with hyphens, non-alphanumeric characters removed. Examples:
- "Deep Research Engine" → `deep-research-engine`
- "Vault Bridge" → `vault-bridge`
- "Personal" → `personal`

If a slug collision occurs, append a numeric suffix (`-2`, `-3`, etc.).

### 3.4 Example Data

```
PK: project:deep-research       RK: _meta                           → Project "Deep Research Engine"
PK: project:deep-research       RK: section:backend                 → Section "Backend"
PK: project:deep-research       RK: section:deployment              → Section "Deployment"
PK: project:deep-research       RK: task:01JTEST1234500000          → Task "Build REST API" (section:backend, depth:0)
PK: project:deep-research       RK: task:01JTEST1234500001          → Subtask "Set up FastAPI scaffold" (parent: 01JTEST1234500000, depth:1)
PK: project:deep-research       RK: comment:01JTEST1234500000:1710432000000  → Comment on task
```

---

## 4. MCP Tools

The server exposes these tools via FastMCP. Each tool has a clear name, description, and typed parameters.

### 4.1 Project Tools

#### `list_projects`
- **Description:** List all projects with summary stats (task counts by status)
- **Parameters:** None
- **Returns:** List of projects with name, slug, task count breakdown

#### `create_project`
- **Description:** Create a new project
- **Parameters:** `name` (str, required), `description` (str, optional)
- **Returns:** Created project with slug

#### `delete_project`
- **Description:** Delete a project and ALL its sections, tasks, comments
- **Parameters:** `project` (str, required — slug)
- **Returns:** Confirmation with count of deleted entities

### 4.2 Section Tools

#### `list_sections`
- **Description:** List sections within a project with task counts
- **Parameters:** `project` (str, required)
- **Returns:** List of sections with name, slug, task count

#### `create_section`
- **Description:** Create a new section in a project
- **Parameters:** `project` (str, required), `name` (str, required)
- **Returns:** Created section with slug

#### `delete_section`
- **Description:** Delete a section and all its tasks/comments
- **Parameters:** `project` (str, required), `section` (str, required)
- **Returns:** Confirmation

#### `rename_section`
- **Description:** Rename a section
- **Parameters:** `project` (str, required), `section` (str, required — current slug), `new_name` (str, required)
- **Returns:** Updated section

### 4.3 Task Tools

#### `add_task`
- **Description:** Add a new task to a section, or a subtask to an existing task
- **Parameters:**
  - `project` (str, required)
  - `section` (str, required)
  - `description` (str, required)
  - `parent_id` (str, optional — ULID of parent task for subtasks)
  - `status` (str, optional — default `not_started`)
  - `priority` (str, optional — `P1`, `P2`, `P3`)
  - `due_date` (str, optional — `YYYY-MM-DD`)
- **Returns:** Created task with ID
- **Validation:** If `parent_id` is provided, verify parent exists and depth < 4

#### `update_task`
- **Description:** Update a task's status, priority, due date, or description
- **Parameters:**
  - `project` (str, required)
  - `task_id` (str, required — ULID)
  - `status` (str, optional)
  - `priority` (str, optional)
  - `due_date` (str, optional)
  - `description` (str, optional)
- **Returns:** Updated task

#### `move_task`
- **Description:** Move a task to a different section (and all its subtasks/comments)
- **Parameters:**
  - `project` (str, required)
  - `task_id` (str, required)
  - `new_section` (str, required)
- **Returns:** Confirmation

#### `delete_task`
- **Description:** Delete a task and cascade-delete all its subtasks and comments
- **Parameters:** `project` (str, required), `task_id` (str, required)
- **Returns:** Confirmation with count of deleted entities

#### `archive_done`
- **Description:** Delete all tasks with status `done` in a project (or section)
- **Parameters:** `project` (str, required), `section` (str, optional — scope to section)
- **Returns:** Count of archived tasks

### 4.4 Comment Tools

#### `add_comment`
- **Description:** Add a progress comment to a task
- **Parameters:**
  - `project` (str, required)
  - `task_id` (str, required)
  - `content` (str, required)
- **Returns:** Created comment

### 4.5 Query Tools

#### `list_tasks`
- **Description:** List tasks with flexible filtering. Returns task summaries (not full comment history)
- **Parameters:**
  - `project` (str, required)
  - `section` (str, optional — filter to section)
  - `status` (str, optional — filter by status)
  - `priority` (str, optional — filter by priority)
  - `due_before` (str, optional — `YYYY-MM-DD`)
  - `due_after` (str, optional — `YYYY-MM-DD`)
  - `include_done` (bool, optional — default false)
  - `top_level_only` (bool, optional — default true, only depth=0 tasks)
- **Returns:** List of tasks with latest comment preview and subtask count

#### `get_task_detail`
- **Description:** Get a single task with ALL comments and full subtask tree
- **Parameters:** `project` (str, required), `task_id` (str, required)
- **Returns:** Full task object with comments array and nested subtasks

---

## 5. Server Implementation

### 5.1 Project Structure

```
todos-mcp/
├── agent-workspace/
│   └── plans/
│       └── 2026-03-14-spec.md          ← This file
├── server/
│   ├── __init__.py
│   ├── app.py                           ← FastMCP app + Uvicorn entrypoint
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── projects.py                  ← Project CRUD tools
│   │   ├── sections.py                  ← Section CRUD tools
│   │   ├── tasks.py                     ← Task CRUD + query tools
│   │   └── comments.py                  ← Comment tools
│   ├── storage.py                       ← Azure Table Storage client wrapper
│   ├── models.py                        ← Pydantic models for entities
│   └── auth.py                          ← Token verification middleware
├── infra/
│   └── template.json                    ← ARM template for all Azure resources
├── Dockerfile
├── requirements.txt
├── .github/
│   └── workflows/
│       └── deploy.yml                   ← CI/CD pipeline
├── CLAUDE.md                            ← Claude Code project context
└── README.md
```

### 5.2 Key Implementation Details

#### FastMCP Setup

```python
# app.py — Skeleton structure
from fastmcp import FastMCP
import uvicorn

mcp = FastMCP(
    instructions="Todos MCP Server — personal task management with projects, sections, tasks, comments, and subtasks."
)

# Register tools from tools/ modules
from server.tools import projects, sections, tasks, comments

# Auth: token verification via query param middleware
# Pattern: extract ?token= from SSE connection URL, validate against env var

if __name__ == "__main__":
    uvicorn.run(mcp.asgi_app(), host="0.0.0.0", port=8000)
```

**Critical FastMCP 3.x notes:**
- Use `instructions` kwarg, NOT `description` (removed in 3.x)
- Use `auth` param with custom middleware, NOT `auth_token` (removed in 3.x)
- Run with `uvicorn` directly to own the ASGI app — don't use `fastmcp run`
- Pin fastmcp version in requirements.txt

#### Azure Table Storage Client

```python
# storage.py — Wrapper around azure-data-tables SDK
from azure.data.tables import TableServiceClient
from azure.identity import DefaultAzureCredential

# Use DefaultAzureCredential — picks up Managed Identity in Azure,
# environment credentials locally
credential = DefaultAzureCredential()
table_service = TableServiceClient(
    endpoint=f"https://{STORAGE_ACCOUNT_NAME}.table.core.windows.net",
    credential=credential
)
table_client = table_service.get_table_client("todos")
```

Key operations:
- `table_client.create_entity(entity)` — insert
- `table_client.update_entity(entity, mode=UpdateMode.REPLACE)` — full replace
- `table_client.delete_entity(partition_key, row_key)` — delete
- `table_client.query_entities(filter)` — OData filter queries
- `table_client.list_entities()` — scan (with optional filter)

**OData filter examples:**
```python
# All entities in a project
f"PartitionKey eq 'project:deep-research'"

# All tasks in a section
f"PartitionKey eq 'project:deep-research' and entity_type eq 'task' and section eq 'backend'"

# All comments for a task (prefix scan on RowKey)
f"PartitionKey eq 'project:deep-research' and RowKey ge 'comment:01JTEST:' and RowKey lt 'comment:01JTEST;'"

# Tasks due before a date
f"PartitionKey eq 'project:deep-research' and entity_type eq 'task' and due_date le '2026-03-20'"
```

#### ULID Generation

Use the `python-ulid` package. ULIDs are 26-char, case-insensitive, time-sortable identifiers.

```python
from ulid import ULID
task_id = str(ULID())  # e.g., "01JTEST1234500000ABCDEF"
```

#### Auth Middleware

Match the Vault Bridge pattern: extract `?token=` from the SSE connection URL and validate against a `MCP_AUTH_TOKEN` environment variable. Reject with 401 if missing or invalid.

### 5.3 Environment Variables

| Variable | Source | Description |
|----------|--------|-------------|
| `STORAGE_ACCOUNT_NAME` | ARM template → Container App env | Azure storage account name |
| `MCP_AUTH_TOKEN` | Azure Key Vault (or Container App secret) | Token for MCP auth |
| `PORT` | Default `8000` | Server port |

### 5.4 Dependencies (requirements.txt)

```
fastmcp>=3.0,<4.0
uvicorn>=0.30
azure-data-tables>=12.5
azure-identity>=1.17
python-ulid>=3.0
pydantic>=2.0
```

---

## 6. Deployment

### 6.1 Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./server/

EXPOSE 8000
CMD ["python", "-m", "server.app"]
```

**Build note:** Must use `--platform linux/amd64` when building on Apple Silicon (M-series Mac) since Azure Container Apps runs amd64.

### 6.2 ARM Template (`infra/template.json`)

The ARM template provisions:

1. **Storage Account** (`yourstorageaccount`)
   - Kind: `StorageV2`
   - SKU: `Standard_LRS` (locally redundant — cheapest, still durable)
   - Table service + table named `todos`

2. **Container App Environment** (if not reusing shared)
   - Consumption plan
   - Region: `centralus`

3. **Container App** (`todos-mcp`)
   - Image: `yourregistry.azurecr.io/todos-mcp:latest`
   - Scale: min 0, max 1 (scale-to-zero)
   - Ingress: external, port 8000, HTTPS
   - System-assigned Managed Identity
   - Environment variables: `STORAGE_ACCOUNT_NAME`, `PORT`
   - Secrets: `MCP_AUTH_TOKEN` (from Container App secrets)

4. **Role Assignment**
   - Container App's managed identity → `Storage Table Data Contributor` role on storage account

### 6.3 CI/CD — GitHub Actions

**Trigger:** Push to `main` branch.

**Workflow:** `.github/workflows/deploy.yml`

```yaml
name: Deploy Todos MCP

on:
  push:
    branches: [main]

permissions:
  id-token: write   # OIDC
  contents: read

env:
  REGISTRY: yourregistry.azurecr.io
  IMAGE_NAME: todos-mcp
  RESOURCE_GROUP: todos-mcp-rg
  CONTAINER_APP_NAME: todos-mcp

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      # 1. Checkout
      - uses: actions/checkout@v4

      # 2. Azure Login via OIDC (Workload Identity Federation)
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      # 3. ACR Login
      - uses: azure/docker-login@v2
        with:
          login-server: ${{ env.REGISTRY }}

      # 4. Build + Push
      - run: |
          docker build --platform linux/amd64 -t $REGISTRY/$IMAGE_NAME:${{ github.sha }} -t $REGISTRY/$IMAGE_NAME:latest .
          docker push $REGISTRY/$IMAGE_NAME:${{ github.sha }}
          docker push $REGISTRY/$IMAGE_NAME:latest

      # 5. Deploy ARM template (idempotent — creates or updates resources)
      - uses: azure/arm-deploy@v2
        with:
          resourceGroupName: ${{ env.RESOURCE_GROUP }}
          template: infra/template.json
          parameters: imageTag=${{ github.sha }}

      # 6. Update Container App image
      - run: |
          az containerapp update \
            --name $CONTAINER_APP_NAME \
            --resource-group $RESOURCE_GROUP \
            --image $REGISTRY/$IMAGE_NAME:${{ github.sha }}

      # 7. Verify deployment
      - run: |
          sleep 10
          REVISION=$(az containerapp revision list \
            --name $CONTAINER_APP_NAME \
            --resource-group $RESOURCE_GROUP \
            --query "[0].name" -o tsv)
          STATUS=$(az containerapp revision show \
            --name $CONTAINER_APP_NAME \
            --resource-group $RESOURCE_GROUP \
            --revision $REVISION \
            --query "properties.runningState" -o tsv)
          echo "Revision: $REVISION, Status: $STATUS"
          if [ "$STATUS" != "Running" ] && [ "$STATUS" != "Processing" ]; then
            echo "ERROR: Deployment not healthy"
            exit 1
          fi
```

**GitHub repo secrets needed (OIDC — no stored credentials):**
- `AZURE_CLIENT_ID` — App registration client ID for OIDC
- `AZURE_TENANT_ID` — `00000000-0000-0000-0000-000000000000`
- `AZURE_SUBSCRIPTION_ID` — `00000000-0000-0000-0000-000000000000`

**First-time setup requires:**
1. Create the resource group: `az group create -n todos-mcp-rg -l centralus`
2. Set up OIDC federation for GitHub Actions (same pattern as Vault Bridge)
3. Create MCP auth token and store as Container App secret
4. First push to `main` triggers full deploy

---

## 7. Claude Skill (SKILL.md)

After the MCP server is deployed and connected as a Claude connector, the todos SKILL.md becomes a set of instructions for how to use the MCP tools — no file I/O, no indentation management. The skill teaches Claude:

- When to trigger (same trigger phrases as before)
- How to map natural language to tool calls
- How to present results (formatting, icons, summary vs detail)
- When to suggest adding tasks (proactive capture rules)
- Never to add tasks without explicit consent

The skill file will reference the MCP tools by name and describe the display conventions (status icons, priority tags, comment formatting, etc.). It does NOT need to know about Azure, Table Storage, or deployment — that's all behind the MCP boundary.

The existing SKILL.md format and display conventions from our brainstorming session (the `●○◆⏸` icons, subtask summaries, comment previews, etc.) carry forward unchanged. The only difference is the operations section: instead of "read the file, str_replace, write the file," it becomes "call `add_task`, call `update_task`," etc.

---

## 8. Claude Connector Setup

After deployment, register the MCP server in Claude.ai:

| Field | Value |
|-------|-------|
| Name | `Todos` |
| URL | `https://todos-mcp.<env-hash>.centralus.azurecontainerapps.io/mcp?token=<auth-token>` |
| OAuth Client ID | (leave empty) |
| OAuth Client Secret | (leave empty) |

The token goes in the URL as a query parameter (Claude connector UI doesn't support custom headers).

---

## 9. Testing Strategy

### 9.1 Local Development

Run the server locally with Azure credentials from `az login`:

```bash
export STORAGE_ACCOUNT_NAME=yourstorageaccount
export MCP_AUTH_TOKEN=dev-token
python -m server.app
```

Test with `curl` or an MCP test client.

### 9.2 Integration Tests

Write pytest tests that run against a real (or Azurite-emulated) Table Storage instance:

- CRUD for projects, sections, tasks, comments
- Subtask depth validation (reject depth > 3)
- Cascade delete (deleting a task removes its subtasks and comments)
- Query filtering (by status, priority, due date)
- Slug collision handling
- Auth token validation (reject missing/invalid tokens)

### 9.3 Post-Deploy Verification

After every deployment (automated in CI):
- Check revision is in `Running` state
- Verify the MCP endpoint responds
- Always verify deployments are actually running before declaring success

---

## 10. Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| Azure Table Storage (< 1GB, < 10K ops/day) | ~$0.00 |
| Container App (Consumption, scale-to-zero) | ~$0.00 (idle) — ~$0.50 (light use) |
| ACR (shared Basic tier) | Already paid for |
| **Total** | **< $1/month** |

---

## 11. Future Considerations (Not in Scope Now)

- **Recurring tasks** — tasks that auto-reset on a schedule
- **Multi-user** — separate todo lists per user (would need user identity in auth)
- **Notifications** — push reminders for due dates (would need a scheduler)
- **Import/export** — bulk import from Todoist, export to markdown
- **Web UI** — lightweight dashboard for viewing todos outside of Claude

---

## 12. Implementation Order

1. **Scaffold the repo** — project structure, CLAUDE.md, requirements.txt, Dockerfile
2. **Implement storage layer** — `storage.py` with Table Storage CRUD operations
3. **Implement data models** — Pydantic models in `models.py`
4. **Implement MCP tools** — one module per entity type in `tools/`
5. **Implement auth** — token middleware in `auth.py`
6. **Wire up the app** — `app.py` with FastMCP + Uvicorn
7. **Write ARM template** — `infra/template.json`
8. **Test locally** — against Azurite or a dev storage account
9. **Set up CI/CD** — GitHub Actions workflow + OIDC federation
10. **Deploy** — push to main, verify
11. **Register connector** — add to Claude.ai
12. **Write the SKILL.md** — instructions for Claude on how to use the tools
13. **Test end-to-end** — use from Claude.ai, verify from mobile
