# SPEC: Tags System & Source Arrays (Open Brain v2)

## 1. Goal

Add a **curated tag system** and **source arrays** to Open Brain so that:

- Every capture, fact, and insight can be semantically classified with curated tags.
- Tags enable filtered retrieval: "show me my coding preferences" = `search_thoughts("coding", { tags: ["preference"] })`.
- Source becomes an array to support multi-source facts and insights derived from captures across different channels.
- Tag assignment is unified across all input channels via LLM classification in the capture pipeline, with an optional bypass for MCP clients that provide tags upfront.

This is an evolution of the existing profiler, not a new system.

## 2. Design Decisions

### 2.1 Tags vs Categories

Facts currently have a `category` field (single string: preference, habit, skill, etc.). Tags **replace** `category` across all tiers:

- Tags are arrays (multi-valued) vs category (single-valued).
- Tags use a curated allowlist vs category which was free-form in the LLM prompt.
- Tags exist on all three tiers (captures, facts, insights) vs category only on facts/insights.
- The existing category values map into the new tag allowlist.

### 2.2 Tags vs Source

Two orthogonal dimensions:

| Dimension | What it means | Who sets it | Examples |
|-----------|---------------|-------------|---------|
| **Source** (transport) | How it got into the system | Code, hardcoded per channel | `['telegram']`, `['mcp']`, `['api']` |
| **Tags** (semantic) | What kind of knowledge it is | LLM classifier or MCP caller | `['preference']`, `['problem-solution', 'health']` |

Source describes the plumbing. Tags describe the meaning.

### 2.3 Tag Classification: Hybrid Approach

- **Telegram, REST API (no tags provided):** Pipeline auto-classifies via Gemini Flash during metadata extraction — one LLM call handles both metadata + tags.
- **MCP (tags optionally provided):** If the AI caller provides valid tags, they're used as-is (skip LLM classification). If omitted or invalid, pipeline auto-classifies.
- **Fallback:** If auto-classification produces low-quality results, the architecture supports splitting tag classification into a separate LLM call (not implemented initially).

### 2.4 Source as Array

- Captures always have a single-element source array: `['telegram']`, `['mcp']`, `['api']`.
- Facts get their source by unioning source arrays from all contributing captures.
- Insights get their source by unioning source arrays from all contributing facts.
- A fact derived from both Telegram and MCP captures has `source: ['telegram', 'mcp']`.

## 3. Tag Allowlist

14 curated tags. Each powers a distinct retrieval question that semantic search alone can't efficiently filter.

| Tag | Retrieval question | Example capture |
|-----|-------------------|-----------------|
| `preference` | "How do I like X done?" | "Pedro prefers Hono over Express for TypeScript APIs" |
| `decision` | "What did I decide and why?" | "Chose JWT sessions over server-side, prioritizing simplicity" |
| `problem-solution` | "Have I dealt with this before?" | "Fixed Telegram retry loop by responding 200 immediately" |
| `pattern` | "What are my tendencies?" | "Tends to defer tests until after first bugs appear" |
| `goal` | "What am I working toward?" | "Training for a half marathon in October" |
| `opinion` | "What do I think/believe about X?" | "Believes monorepos are the right call for tightly coupled services" |
| `skill` | "What can I do / what's my level?" | "Deep TypeScript expertise, new to React" |
| `relationship` | "What do I know about person X?" | "Sarah prefers async communication, birthday June 12" |
| `resource` | "What was that reference/tool/link?" | "pgvector HNSW needs 2x working memory — see PostgreSQL wiki" |
| `idea` | "What have I been mulling over?" | "Might convert the garage into a workshop" |
| `interest` | "What am I into?" | "Really enjoying bouldering lately" |
| `health` | "What's relevant to my body/wellness?" | "Allergic to penicillin, left knee flares when running downhill" |
| `dislike` | "What should I avoid / never suggest?" | "Hates writing YAML configuration files" |
| `milestone` | "What have I accomplished?" | "Launched Open Brain v2 on March 21, 2026" |

### 3.1 Rules

- Captures can have **multiple tags** — "Switched from running to swimming because of knee issues" → `['decision', 'health']`.
- Captures can have **zero tags** — still searchable via semantic search, just not filterable.
- Tags are validated against the allowlist — unknown tags are silently dropped.
- Duplicate tags are deduplicated.
- Tag names are lowercase, hyphen-separated.
- The allowlist is expanded deliberately when a clear retrieval need arises that existing tags can't serve.

## 4. Schema Changes

Single migration: `002_tags_and_source_array.sql`

### 4.1 Captures Table

```sql
-- Convert source from varchar to text[]
ALTER TABLE captures ALTER COLUMN source TYPE text[] USING ARRAY[source];

-- Add tags
ALTER TABLE captures ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

-- Indexes for filtered queries
CREATE INDEX idx_captures_tags ON captures USING GIN (tags);
CREATE INDEX idx_captures_source ON captures USING GIN (source);
```

### 4.2 Facts Table

```sql
-- Drop category, add tags and source
ALTER TABLE facts DROP COLUMN category;
ALTER TABLE facts ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE facts ADD COLUMN source text[] NOT NULL DEFAULT '{}';

-- Indexes
CREATE INDEX idx_facts_tags ON facts USING GIN (tags);
CREATE INDEX idx_facts_source ON facts USING GIN (source);
```

### 4.3 Insights Table

```sql
-- Drop category, add tags and source
ALTER TABLE insights DROP COLUMN category;
ALTER TABLE insights ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE insights ADD COLUMN source text[] NOT NULL DEFAULT '{}';

-- Indexes
CREATE INDEX idx_insights_tags ON insights USING GIN (tags);
CREATE INDEX idx_insights_source ON insights USING GIN (source);
```

**Note:** No data backfill needed — the system has no production data yet. Existing test/dev rows will have empty tags arrays and get properly tagged on next consolidation run or manual `update_tags`.

## 5. Code Changes

### 5.1 New File: `src/capture/tags.ts`

- `ALLOWED_TAGS` const array (14 tags)
- `TAG_DESCRIPTIONS` map (tag → one-line description, used in LLM prompts)
- `validateTags(tags: string[]): string[]` — filters against allowlist, deduplicates
- `isValidTag(tag: string): boolean` — single tag check

### 5.2 Capture Pipeline (`src/capture/pipeline.ts`)

- `PipelineInput` gains optional `tags?: string[]`
- If valid tags provided → skip tag classification in metadata extraction
- If not → `extractMetadata` returns tags alongside existing fields
- `CaptureInsert.source` becomes `string[]`
- `CaptureInsert` gains `tags: string[]`

### 5.3 Metadata Extraction (`src/capture/metadata.ts`)

- `CaptureMetadata` gains `tags: string[]`
- Extraction prompt expanded with tag classification section:
  - Lists all 14 tags with one-line descriptions
  - Instructs LLM to return applicable tags as JSON array
  - Empty array if none clearly apply
- When caller provides valid tags, the prompt omits the tag classification section (or the function skips parsing tags from response)

### 5.4 DB Modules

**`src/db/captures.ts`:**
- `CaptureInsert.source` → `string[]`
- `CaptureRow.source` → `string[]`
- Add `CaptureInsert.tags: string[]`, `CaptureRow.tags: string[]`
- Insert query updated for array types
- Add `findCapturesByTags(db, tags)` query using `@>` operator

**`src/db/facts.ts`:**
- Remove `category` from `FactInsert` and `FactRow`
- Add `tags: string[]` and `source: string[]` to both
- Insert/update queries updated
- Add `findFactsByTags(db, tags)` query

**`src/db/insights.ts`:**
- Remove `category` from `InsightInsert` and `InsightRow`
- Add `tags: string[]` and `source: string[]` to both
- Insert/update queries updated
- Add `findInsightsByTags(db, tags)` query

### 5.5 Consolidation

**Phase 1 (`src/consolidation/phase1.ts`):**
- When creating a fact:
  - `tags` = union of all source captures' tags, deduplicated — then LLM can refine (add/remove)
  - `source` = union of all source captures' source arrays, deduplicated
- Prompt updated: `create_fact` action returns `tags` array instead of `category` string:
  ```json
  {"action": "create_fact", "content": "...", "tags": ["preference", "skill"], "confidence": 0.8, "source_capture_ids": ["..."]}
  ```
- `update_fact` action also uses `tags` array instead of `category`
- `category` removed from fact creation
- `ClusterInput.existingFacts` interface updated: `category: string` → `tags: string[]`
- `shouldAutoApprove` updated: checks if **any** tag in the fact's tags array is in the auto-approve set. Auto-approve tags: `['preference', 'skill', 'interest', 'dislike', 'resource']` (low-impact knowledge types). Signature becomes `shouldAutoApprove(tags: string[], reviewMode: string): boolean`.

**Phase 2 (`src/consolidation/phase2.ts`):**
- When creating an insight:
  - `tags` = union of all source facts' tags, deduplicated — LLM can refine
  - `source` = union of all source facts' source arrays, deduplicated
- Prompt updated: references tags instead of category
- `category` removed from insight creation
- `Phase2Input.facts` and `Phase2Input.existingInsights` interfaces updated: `category: string` → `tags: string[]`

**Runner (`src/consolidation/runner.ts`):**
- `existingFacts` mapping updated: `f.category` → `f.tags`
- `existingInsights` mapping updated: `i.category` → `i.tags`

### 5.6 Retrieval

**`src/retrieval/search.ts`:**
- `searchThoughts` gains optional `tags?: string[]` parameter
- When tags provided, adds `AND tags @> $n` to queries at each tier (insights, facts, captures)
- AND semantics: `tags: ['preference', 'health']` means "must have both"
- Tiered search logic unchanged — tags are just an additional filter predicate
- `SearchResult` interface updated: `category: string | null` → `tags: string[]`

**`src/retrieval/profile.ts`:**
- `getUserProfile` reads `tags` instead of `category` from facts/insights
- Fact/insight formatting in LLM prompt changes from `[${f.category}]` to `[${f.tags.join(', ')}]`
- Synthesis prompt updated to understand tags

### 5.7 MCP Tools (`src/mcp/profiler-tools.ts`)

**`capture_thought` — updated:**
- Add optional `tags` parameter: `z.array(z.string()).optional()`
- Description explains the 14 allowed tags
- If valid tags provided → passed to pipeline, skip LLM classification
- If omitted → pipeline auto-classifies
- Source stays hardcoded `['mcp']`

**`update_tags` — new tool:**
- Parameters:
  - `id`: string (full UUID required — no short prefix resolution for captures/facts/insights)
  - `tier`: enum `'capture' | 'fact' | 'insight'`
  - `tags`: string array
- Validates all tags against allowlist
- Updates the row's tags array in the appropriate table
- Returns confirmation with old → new tags
- Error if ID not found or invalid tags

**`brain_stats` — updated:**
- Replace `factsByCategory` query with `factsByTag`:
  ```sql
  SELECT unnest(tags) AS tag, count(*) FROM facts
  WHERE archived = false AND review_status != 'user_rejected'
  GROUP BY tag ORDER BY count DESC
  ```
- Add similar `insightsByTag` and `capturesByTag` breakdowns
- Add `capturesBySource` breakdown using `unnest(source)`

**`review_pending` — updated:**
- Response shape changes: `category: string` → `tags: string[]` for both facts and insights

**`search_thoughts` — updated:**
- Add optional `tags` parameter: `z.array(z.string()).optional()`
- Description updated to list available tags
- Passes tags filter to retrieval layer

**No `search_coding_history` tool.** Tag-filtered `search_thoughts` covers all domain-specific queries.

### 5.8 MCP Server Instructions (`src/mcp/server.ts`)

Updated to teach AI clients:
- The 14-tag system and what each tag means
- When to provide tags on `capture_thought` (if confident) vs let the system classify
- Search patterns: use tags for knowledge type, query string for domain
- Example: "coding preferences" = `search_thoughts("coding", { tags: ["preference"] })`

### 5.9 User System Prompt (`src/mcp/profiler-tools.ts`)

`USER_SYSTEM_PROMPT` (returned by `get_user_prompt`) updated with:
- Tag system explanation
- When to capture with tags
- How to search with tag filters

### 5.10 Telegram (`src/telegram/`)

- All capture calls updated: `source: 'telegram'` → `source: ['telegram']`
- No tags passed — always auto-classified by pipeline
- No UI changes — tags are invisible to Telegram users

### 5.11 REST API (`src/app.ts`)

- POST `/api/v1/capture`: accepts optional `tags` in request body
- `source` is always hardcoded server-side to `['api']` — callers cannot override (prevents arbitrary source values)
- Validates tags against allowlist if provided

### 5.12 Documentation

- `ARCHITECTURE.md` — updated with tags system, source arrays, tag allowlist
- `README.md` — updated MCP tool descriptions
- `CLAUDE.md` — add tags to code organization and known patterns
- Design spec (`2026-03-13-open-brain-2-design.md`) — updated with tags feature

## 6. Capture Channels & Tag Flow

```
┌─────────────────────────────────────────────────────────────┐
│  TELEGRAM                                                    │
│  source: ['telegram']                                        │
│  tags: not provided → auto-classified by pipeline            │
├─────────────────────────────────────────────────────────────┤
│  MCP (capture_thought)                                       │
│  source: ['mcp']                                             │
│  tags: optional from caller → validated → used if valid      │
│         not provided → auto-classified by pipeline           │
├─────────────────────────────────────────────────────────────┤
│  REST API (POST /api/v1/capture)                             │
│  source: ['api']                                             │
│  tags: optional in body → validated → used if valid          │
│         not provided → auto-classified by pipeline           │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
              ┌────────────────────────────┐
              │  CAPTURE PIPELINE          │
              │                            │
              │  valid tags provided?       │
              │  YES → store as-is         │
              │  NO  → LLM classifies      │
              │        (piggyback on       │
              │         metadata prompt)   │
              └──────────────┬─────────────┘
                             ↓
              ┌────────────────────────────┐
              │  CAPTURES TABLE            │
              │  source: text[]            │
              │  tags: text[]              │
              └──────────────┬─────────────┘
                             ↓
              ┌────────────────────────────┐
              │  CONSOLIDATION             │
              │                            │
              │  fact.tags = union(capture  │
              │    tags) + LLM refinement  │
              │  fact.source = union(      │
              │    capture sources)        │
              └──────────────┬─────────────┘
                             ↓
              ┌────────────────────────────┐
              │  FACTS TABLE               │
              │  source: text[]            │
              │  tags: text[]              │
              └──────────────┬─────────────┘
                             ↓
              ┌────────────────────────────┐
              │  INSIGHTS TABLE            │
              │  source: text[]            │
              │  tags: text[]              │
              └────────────────────────────┘
```

## 7. Testing Strategy

### 7.1 Unit Tests

**Tag validation (`src/capture/tags.ts`):**
- All 14 valid tags accepted individually
- Unknown tag rejected
- Mixed valid/invalid → only valid retained
- Empty array → empty array
- Duplicate tags deduplicated
- Case sensitivity enforced (reject `Preference`, only `preference`)

**Metadata extraction with tags (`src/capture/metadata.ts`):**
- Content with clear preference signal → returns `['preference']`
- Content with multiple signals → returns multiple tags (e.g., `['decision', 'health']`)
- Ambiguous content → returns empty array
- Tags field always present in response (never undefined)
- When caller provides tags, response tags match caller's input (no LLM override)

**DB modules:**
- `CaptureInsert` with `source: ['telegram']` and `tags: ['preference']` inserts correctly
- `FactInsert` with `source: ['telegram', 'mcp']` and `tags: ['pattern', 'skill']` inserts correctly
- `InsightInsert` same pattern
- Query with `tags @>` filter returns matching rows
- Query with `tags @>` filter excludes non-matching rows
- Query with `source @>` filter works
- Query with no tag filter returns all rows (backwards compatible)

**Tag union logic (consolidation helpers):**
- Two captures with `['preference']` and `['skill']` → fact gets `['preference', 'skill']`
- Overlapping tags deduplicated: `['preference', 'skill']` + `['skill', 'goal']` → `['preference', 'skill', 'goal']`
- Source arrays unioned: `['telegram']` + `['mcp']` → `['telegram', 'mcp']`
- Empty tags on one capture → union is just the other's tags
- All empty → empty array

### 7.2 Integration Tests

**Capture flow:**
- Telegram text capture → tags auto-classified, source `['telegram']`
- MCP capture with valid tags → stored as-is, no LLM classification called
- MCP capture with partial valid tags → invalid stripped, valid stored
- MCP capture with no tags → LLM classifies
- MCP capture with empty array → LLM classifies
- REST API with tags in body → same hybrid behavior as MCP

**Search:**
- `search_thoughts` with no tags → existing behavior unchanged (regression)
- `search_thoughts` with single tag → only matching results returned
- `search_thoughts` with multiple tags → AND filter (must have all)
- `search_thoughts` with tags that match no results → empty result set
- Tag filter applies at all three tiers (insights, facts, captures)

**update_tags tool:**
- Update capture tags with valid tags → stored correctly
- Update fact tags with valid tags → stored correctly
- Update insight tags with valid tags → stored correctly
- Invalid tags in request → rejected with error message listing invalid tags
- Non-existent ID → error
- Empty tags array → clears all tags (valid operation)

**Consolidation:**
- Facts created with unioned tags from source captures
- Facts created with unioned sources from source captures
- Consolidation LLM can refine tags (add relevant tag not in union, remove irrelevant one)
- Insights inherit unioned tags from source facts
- Insights inherit unioned sources from source facts

### 7.3 E2E Tests

- Full pipeline: REST API capture with tags → verify stored with correct tags and source
- Full pipeline: REST API capture without tags → verify auto-classified tags present
- `search_thoughts` via MCP with tag filter → returns only matching results
- `update_tags` via MCP → modifies tags, subsequent search reflects change
- Source array on facts/insights after consolidation run

## 8. Non-Goals

- No new tables or separate storage for tags.
- No Telegram UI for tag management — MCP only for now.
- No tag hierarchy or tag relationships.
- No per-tag confidence scores.
- No `search_coding_history` tool — `search_thoughts` with tags covers it.
- No separate LLM call for tag classification (piggybacks on metadata extraction).

## 9. Future Considerations

- **Separate tag classification call:** If the piggybacked approach shows quality issues, split into a dedicated LLM call for tag classification.
- **Tag analytics:** Surface tag distribution in `brain_stats` tool.
- **Tag suggestions:** When consolidation creates a fact, suggest tags to the user for review.
- **Source filtering on search:** Add optional `source` filter to `search_thoughts` alongside tags.
- **New tags:** Expand the allowlist when clear retrieval needs emerge that existing tags can't serve. Requires migration-free code change (just update the const array).
