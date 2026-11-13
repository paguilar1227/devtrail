# SPEC: Service Layer, REST API, and Comment Management

## 1. Goal

Refactor DevTrail into a **hexagonal architecture** (ports and adapters):

1. **Service layer** — centralized business logic for all operations
2. **Comprehensive REST API** — exposes every operation over HTTP (supports future Web UI + iOS app)
3. **MCP and Telegram as thin adapters** — call the service layer directly (in-process), format results for their channel
4. **Comment management feature** — view, edit, delete comments in Telegram and MCP, built on the new architecture

```
Future Web UI / iOS App → REST API (HTTP) ─┐
MCP Tools ──────────────────────────────────┤→ Service Layer → DB Layer
Telegram Bot ───────────────────────────────┘
```

## 2. Design Decisions

### 2.1 Service Layer, Not Direct DB Calls

Currently, MCP tools and Telegram handlers call DB functions directly, mixing business logic (embedding, validation, formatting) with data access. The service layer extracts this:

- **DB layer** — pure data access (queries, inserts, updates). No business logic. Already exists.
- **Service layer** — orchestrates DB calls, embedding, validation, LLM calls. Returns typed results.
- **Adapters** (REST, MCP, Telegram) — format input/output for their channel. Call service layer.

### 2.2 In-Process Service Calls

MCP and Telegram are in the same Node.js process as the REST API. They call the service layer directly via function imports — no HTTP round-trip. The REST API is just another adapter that exposes the same service functions over HTTP.

### 2.3 Service Dependencies

The service layer receives dependencies via a `ServiceDeps` interface (same pattern as current `AppDeps`):

```typescript
export interface ServiceDeps {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;
  consolidationLLM: LLMProvider;
  retrievalLLM: LLMProvider;
  blobStorage: BlobStorage;
  config: Config;  // Same Config type from src/config.ts (includes reviewMode, timezone, etc.)
}
```

Each service module receives `ServiceDeps` at construction. This keeps services testable with mocked deps.

**Note on static content tools:** `brain_help` and `get_user_prompt` return static strings with no business logic. These remain in the MCP adapter — no service layer needed for static text.

## 3. Service Modules

### 3.1 Capture Service (`src/services/captures.ts`)

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `captureThought` | `content, files?, tags?, source` | `{ captureId, warnings? }` or `{ error, reason }` | Wraps `runCapturePipeline` |
| `searchThoughts` | `query, threshold?, limit?, tags?` | `SearchResult[]` | Tiered search: insights → facts → captures |
| `getCapture` | `id` | `CaptureRow \| null` | Returns full row |
| `listCaptures` | `limit?, status?` | `CaptureRow[]` | Returns full rows |
| `archiveCapture` | `id` | `void` | |
| `unarchiveCapture` | `id` | `void` | |

**Note:** Tag updates for captures go through the Tags Service (`tags.updateTags`), not this module.

### 3.2 Fact Service (`src/services/facts.ts`)

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `getFact` | `id` | `FactRow \| null` | |
| `listFacts` | `limit?, minConfidence?` | `FactRow[]` | |
| `updateFact` | `id, content` | `void` | Sets origin='user_edited', confidence=1.0, re-embeds |
| `archiveFact` | `id` | `void` | |
| `unarchiveFact` | `id` | `void` | |
| `reviewPendingFacts` | `limit?` | `FactRow[]` | |
| `approveRejectFact` | `id, action, content?` | `void` | action: approve/reject/edit |

### 3.3 Insight Service (`src/services/insights.ts`)

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `getInsight` | `id` | `InsightRow \| null` | |
| `listInsights` | `limit?` | `InsightRow[]` | |
| `updateInsight` | `id, content` | `void` | Sets origin='user_edited', re-embeds |
| `archiveInsight` | `id` | `void` | |
| `unarchiveInsight` | `id` | `void` | |
| `reviewPendingInsights` | `limit?` | `InsightRow[]` | |
| `approveRejectInsight` | `id, action, content?` | `void` | |

### 3.4 Reminder Service (`src/services/reminders.ts`)

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `createReminder` | `content, project?, section?, parentId?, category?, priority?, dueDate?, source?, sourceContext?` | `{ id }` | Embeds content, validates parent |
| `listReminders` | `filters` | `ReminderRow[]` | Supports: project, section, status, priority, category, dueDate range, depth, limit |
| `getReminder` | `id` | `ReminderRow \| null` | |
| `getReminderDetail` | `id` | `ReminderDetail \| null` | Includes comments + subtask tree |
| `updateReminder` | `id, fields` | `void` | Re-embeds if content changed |
| `completeReminder` | `id` | `{ completed: string[] }` | Cascades to subtasks |
| `deleteReminder` | `id` | `void` | Cascade-deletes subtasks + comments |
| `reparentReminder` | `id, newParentId?` | `void` | Updates depth, project, section |
| `resolveReminderId` | `shortId` | `string \| null` | 8-char prefix → full UUID |
| `listProjects` | | `ProjectSummary[]` | |
| `findSubtasks` | `parentId` | `ReminderRow[]` | Used by Telegram todos display and MCP list_reminders |
| `findActiveReminders` | | `ReminderRow[]` | |
| `findAllReminders` | | `ReminderRow[]` | |
| `findRemindersDueOnDate` | `date, timezone` | `ReminderRow[]` | |
| `findOverdueReminders` | | `ReminderRow[]` | |
| `findRecentlyCompletedReminders` | `since` | `ReminderRow[]` | Used internally by consolidation |

### 3.5 Comment Service (`src/services/comments.ts`) — NEW

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `addComment` | `reminderId, content, source` | `{ id }` | Embeds content, validates reminder exists |
| `listComments` | `reminderId` | `ReminderCommentRow[]` | Ascending chronological order |
| `getComment` | `id` | `ReminderCommentRow \| null` | NEW — needed for edit/delete |
| `updateComment` | `id, content` | `void` | NEW — re-embeds |
| `deleteComment` | `id` | `ReminderCommentRow` | Returns the deleted comment (needed for undo and confirmation messages) |

### 3.6 Profile Service (`src/services/profile.ts`)

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `getUserProfile` | | `string` | LLM-synthesized profile summary |
| `getBrainStats` | | `BrainStats` | Counts, tag breakdowns, source breakdowns |
| `getBrainHelp` | | `string` | Usage guide text |
| `getUserPrompt` | | `string` | Portable system prompt |

### 3.7 Consolidation Service (`src/services/consolidation.ts`)

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `runConsolidation` | `sendNotification?` | `ConsolidationResult` | Full 3-phase pipeline |
| `getConsolidationLogs` | `limit?` | `ConsolidationLogRow[]` | |

### 3.8 Tags Service (`src/services/tags.ts`)

| Operation | Parameters | Returns | Notes |
|-----------|-----------|---------|-------|
| `updateTags` | `id, tier, tags` | `{ old: string[], new: string[] }` | Validates allowlist, routes to correct DB module |
| `getAllowedTags` | | `string[]` | Returns the 14-tag allowlist |

## 4. REST API Design

### 4.1 Convention

- Base path: `/api/v1`
- Auth: `Authorization: Bearer <api-key>` (existing pattern)
- Rate limit: existing 100/min (unchanged)
- Responses: JSON
- Errors: `{ error: string }` with appropriate HTTP status code
- IDs: UUIDs in URL path

### 4.2 Endpoints

#### Captures

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `POST` | `/api/v1/captures` | `captureThought` | Body: `{ content, tags?, file_urls? }`. Source hardcoded to `['api']`. REST adapter downloads `file_urls` before passing file buffers to service. |
| `GET` | `/api/v1/captures` | `listCaptures` | Query: `?limit=&status=` |
| `GET` | `/api/v1/captures/:id` | `getCapture` | |
| `PATCH` | `/api/v1/captures/:id/tags` | `tags.updateTags` | Body: `{ tags }` |
| `POST` | `/api/v1/captures/:id/archive` | `archiveCapture` | |
| `POST` | `/api/v1/captures/:id/unarchive` | `unarchiveCapture` | |

#### Facts

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `GET` | `/api/v1/facts` | `listFacts` | Query: `?limit=&min_confidence=` |
| `GET` | `/api/v1/facts/:id` | `getFact` | |
| `PUT` | `/api/v1/facts/:id` | `updateFact` | Body: `{ content }` |
| `PATCH` | `/api/v1/facts/:id/tags` | `tags.updateTags` | Body: `{ tags }` |
| `POST` | `/api/v1/facts/:id/archive` | `archiveFact` | |
| `POST` | `/api/v1/facts/:id/unarchive` | `unarchiveFact` | |
| `POST` | `/api/v1/facts/:id/approve` | `approveRejectFact('approve')` | |
| `POST` | `/api/v1/facts/:id/reject` | `approveRejectFact('reject')` | |

#### Insights

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `GET` | `/api/v1/insights` | `listInsights` | Query: `?limit=` |
| `GET` | `/api/v1/insights/:id` | `getInsight` | |
| `PUT` | `/api/v1/insights/:id` | `updateInsight` | Body: `{ content }` |
| `PATCH` | `/api/v1/insights/:id/tags` | `tags.updateTags` | Body: `{ tags }` |
| `POST` | `/api/v1/insights/:id/archive` | `archiveInsight` | |
| `POST` | `/api/v1/insights/:id/unarchive` | `unarchiveInsight` | |
| `POST` | `/api/v1/insights/:id/approve` | `approveRejectInsight('approve')` | |
| `POST` | `/api/v1/insights/:id/reject` | `approveRejectInsight('reject')` | |

#### Reminders

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `POST` | `/api/v1/reminders` | `createReminder` | Body: `{ content, project?, section?, parent_id?, category?, priority?, due_date?, source_context? }` |
| `GET` | `/api/v1/reminders` | `listReminders` | Query: `?project=&status=&priority=&limit=&include_done=&top_level_only=` |
| `GET` | `/api/v1/reminders/:id` | `getReminderDetail` | Returns reminder + comments + subtask tree |
| `PATCH` | `/api/v1/reminders/:id` | `updateReminder` | Body: `{ status?, priority?, content?, due_date?, project?, section? }` |
| `POST` | `/api/v1/reminders/:id/complete` | `completeReminder` | |
| `DELETE` | `/api/v1/reminders/:id` | `deleteReminder` | Cascade-deletes subtasks + comments |
| `POST` | `/api/v1/reminders/:id/reparent` | `reparentReminder` | Body: `{ parent_id }` (null for root) |

#### Comments

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `GET` | `/api/v1/reminders/:id/comments` | `listComments` | Returns comments in ascending chronological order |
| `POST` | `/api/v1/reminders/:id/comments` | `addComment` | Body: `{ content }`. Source hardcoded to `['api']` |
| `GET` | `/api/v1/comments/:id` | `getComment` | |
| `PUT` | `/api/v1/comments/:id` | `updateComment` | Body: `{ content }` |
| `DELETE` | `/api/v1/comments/:id` | `deleteComment` | |

#### Search

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `POST` | `/api/v1/search` | `searchThoughts` | Body: `{ query, threshold?, limit?, tags? }` |

#### Profile

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `GET` | `/api/v1/profile` | `getUserProfile` | |
| `GET` | `/api/v1/stats` | `getBrainStats` | |

#### Consolidation

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `POST` | `/api/v1/consolidation/trigger` | `runConsolidation` | |
| `GET` | `/api/v1/consolidation/logs` | `getConsolidationLogs` | Query: `?limit=` |

#### Review

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `GET` | `/api/v1/review/pending` | `reviewPendingFacts + reviewPendingInsights` | Query: `?type=fact\|insight&limit=` |

#### Projects

| Method | Path | Service Call | Notes |
|--------|------|-------------|-------|
| `GET` | `/api/v1/projects` | `listProjects` | |

### 4.3 Backward Compatibility

The existing `POST /api/v1/capture` endpoint (singular) continues to work as an alias for `POST /api/v1/captures`. No breaking changes for existing clients.

**Response shape changes:** Existing `GET` endpoints (`/captures`, `/facts`, `/insights`, `/reminders`) currently return limited column sets via hand-written SQL. After refactoring to use the service layer, they will return full row objects. This is an additive change (more fields, no removals) and should not break existing consumers. New fields: `tags`, `source` (arrays), `embedding` (excluded from REST responses for size — service layer strips it).

## 5. MCP Adapter Changes

MCP tools become thin wrappers:

```typescript
// Before (current)
server.tool('capture_thought', ..., async ({ content, tags }) => {
  // Business logic mixed in: file downloads, validation, pipeline call
  const result = await runCapturePipeline({ db, embeddingProvider, ... });
  return { content: [{ type: 'text', text: `Captured! ID: ${result.captureId}` }] };
});

// After (service layer)
server.tool('capture_thought', ..., async ({ content, tags, file_urls }) => {
  const result = await services.captures.captureThought(content, files, tags, ['mcp']);
  if ('error' in result) return { content: [{ type: 'text', text: result.reason }], isError: true };
  return { content: [{ type: 'text', text: `Captured! ID: ${result.captureId}` }] };
});
```

File download logic (for `file_urls`) stays in the MCP adapter since it's channel-specific (MCP clients provide URLs, Telegram provides file IDs, REST accepts raw uploads).

### 5.1 New MCP Tools

| Tool | Service Call | Notes |
|------|-------------|-------|
| `edit_comment` | `comments.updateComment` | Params: `id: uuid, content: string` |
| `delete_comment` | `comments.deleteComment` | Params: `id: uuid` |

### 5.2 Updated MCP Tools

All existing tools updated to call service layer instead of DB functions directly. No parameter or response format changes — the MCP API surface stays identical.

**Fix:** The `complete_reminder` MCP tool description currently says "Does NOT auto-complete subtasks" — this is stale. The actual behavior cascades to subtasks. Update the description to match.

## 6. Telegram Comment Management Feature

### 6.1 Updated Gear Menu

The `💬 Comment` button in the action menu changes to `💬 Comments`:

```
[✏ Edit] [💬 Comments] [↕ Move]
[🗑 Delete] [➕ Subtask]
```

Callback data: `action-comments:{reminderId}` (plural, distinct from current `action-comment`)

### 6.2 Comments View

When user clicks `💬 Comments`, bot sends a new message:

```
💬 Comments on "Deploy v2" (a1b2c3d4)

1. Blocked on Azure credentials from DevOps team
   Mar 21, 2:30 PM

2. Got the creds, deploying now
   Mar 22, 9:15 AM

[✏ 1] [🗑 1]
[✏ 2] [🗑 2]
[➕ Add Comment]
```

If no comments:
```
💬 Comments on "Deploy v2" (a1b2c3d4)

No comments yet.

[➕ Add Comment]
```

### 6.3 Callback Data Patterns

| Button | Callback Data | Handler |
|--------|---------------|---------|
| `✏ N` | `cedit:{commentId}` | Set `pendingAction` with action `'comment-edit'`, reply with existing text |
| `🗑 N` | `cdel:{commentId}` | Instant delete, reply with confirmation |
| `➕ Add Comment` | `cadd:{reminderId}` | Set `pendingAction` with action `'comment'` (reuses existing flow) |

### 6.4 Edit Flow

1. User taps `✏ 1` button
2. Bot replies: `✏ Editing comment:\n"Blocked on Azure credentials from DevOps team"\n\nType the new text:`
3. User types new text
4. Bot updates comment via service layer, replies: `Comment updated.`

### 6.5 Delete Flow

1. User taps `🗑 1` button
2. Bot instantly deletes the comment via service layer
3. Bot replies: `🗑 Comment deleted: "Blocked on Azure credentials from DevOps team"`

### 6.6 State Machine Update

Add `'comment-edit'` to the `PendingActionEntry` action union:

```typescript
export type PendingActionEntry = {
  action: 'edit' | 'comment' | 'move' | 'comment-edit';
  reminderId: string;
  commentId?: string;  // Used for comment-edit action
};
```

The `message:text` handler check order remains: pendingSubtask → pendingAction → undo → LLM → capture.

### 6.7 Undo Support

- Edit comment: stores previous content in `lastActions.previousState`, undo restores it
- Delete comment: stores comment content + reminderId in `lastActions.previousState`, undo re-creates it
- Add comment: existing undo support (delete the comment)

## 7. DB Changes

### 7.1 New Function: `updateComment`

```typescript
export async function updateComment(
  db: DbClient,
  id: string,
  content: string,
  embedding: number[],
): Promise<void> {
  await db.query(
    `UPDATE reminder_comments SET content = $1, embedding = $2 WHERE id = $3`,
    [content, JSON.stringify(embedding), id],
  );
}
```

### 7.2 New Function: `getCommentById`

```typescript
export async function getCommentById(
  db: DbClient,
  id: string,
): Promise<ReminderCommentRow | null> {
  const result = await db.query(
    `SELECT * FROM reminder_comments WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
```

No schema migration needed — `reminder_comments` table already has all necessary columns.

## 8. Testing Strategy

### 8.1 Service Layer Tests

Each service module gets unit tests with mocked DB and providers:

- `tests/unit/services/captures.test.ts`
- `tests/unit/services/facts.test.ts`
- `tests/unit/services/insights.test.ts`
- `tests/unit/services/reminders.test.ts`
- `tests/unit/services/comments.test.ts`
- `tests/unit/services/profile.test.ts`
- `tests/unit/services/consolidation.test.ts`

### 8.2 REST API Tests

Integration tests via `app.request()` against the full Hono app with mocked providers:

- Update existing `tests/integration/api.test.ts` for new endpoints
- Add comment CRUD endpoints
- Add search, profile, stats endpoints

### 8.3 MCP Adapter Tests

Verify MCP tools correctly delegate to service layer:

- Update existing `tests/unit/mcp/profiler-tools.test.ts`
- Update existing `tests/unit/mcp/reminder-tools.test.ts`
- Add `edit_comment` and `delete_comment` tool tests

### 8.4 Telegram Tests

- Update existing integration tests to verify handlers call service layer
- Add comment view/edit/delete Telegram tests in integration suite

### 8.5 E2E Tests

- Existing E2E tests continue to validate full pipeline against real PostgreSQL
- Add E2E tests for comment CRUD
- Add E2E tests for new REST endpoints

### 8.6 Existing Test Preservation

All existing tests must continue to pass. When refactoring tests for the service layer:
- Preserve the core intent of each test
- Update mock targets (service layer instead of DB functions)
- Maintain the same assertion logic

## 9. Implementation Order

This spec covers four sub-projects that should be implemented in order:

1. **Service layer + new DB functions** — create service modules, add `updateComment` and `getCommentById`
2. **REST API expansion** — add all new endpoints, update existing ones to use service layer
3. **MCP adapter refactor** — update all tools to call service layer, add `edit_comment`/`delete_comment`
4. **Telegram comment feature** — add comment view/edit/delete UX, update gear menu

Each sub-project can be tested independently before moving to the next.

## 10. Non-Goals

- No OAuth implementation (future work for claude.ai/Perplexity integration)
- No WebSocket or real-time updates
- No file upload via REST (continue using URL-based file ingestion)
- No pagination (simple limit-based queries are sufficient at current scale)
- No API versioning beyond `/v1` prefix

## 11. File Structure

```
src/services/
├── captures.ts      # Capture + search operations
├── facts.ts         # Fact CRUD + review
├── insights.ts      # Insight CRUD + review
├── reminders.ts     # Reminder CRUD + hierarchy
├── comments.ts      # Comment CRUD (NEW)
├── profile.ts       # Profile synthesis + stats
├── consolidation.ts # Consolidation pipeline
├── tags.ts          # Tag management
└── index.ts         # ServiceDeps type + factory
```
