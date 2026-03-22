# Tags System & Source Arrays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add curated semantic tags (14-tag allowlist) and convert source from scalar to array across all profiler tiers, enabling tag-filtered retrieval.

**Architecture:** Tags are classified by the LLM during metadata extraction (piggybacking on the existing Gemini Flash call) or provided by MCP callers. Source becomes `text[]` on captures and propagates upward via union during consolidation. Tags replace the existing `category` field on facts and insights.

**Tech Stack:** PostgreSQL (text[], GIN indexes), TypeScript, Vitest, Zod, Gemini Flash

---

### Task 1: Tag Allowlist Module

**Files:**
- Create: `src/capture/tags.ts`
- Create: `tests/unit/capture/tags.test.ts`

- [ ] **Step 1: Write the tag validation tests**

```typescript
// tests/unit/capture/tags.test.ts
import { describe, it, expect } from 'vitest';
import { ALLOWED_TAGS, validateTags, isValidTag, TAG_DESCRIPTIONS } from '../../../src/capture/tags.js';

describe('tag allowlist', () => {
  it('has exactly 14 tags', () => {
    expect(ALLOWED_TAGS).toHaveLength(14);
  });

  it('has a description for every tag', () => {
    for (const tag of ALLOWED_TAGS) {
      expect(TAG_DESCRIPTIONS[tag]).toBeDefined();
      expect(typeof TAG_DESCRIPTIONS[tag]).toBe('string');
    }
  });
});

describe('isValidTag', () => {
  it('accepts all allowed tags', () => {
    for (const tag of ALLOWED_TAGS) {
      expect(isValidTag(tag)).toBe(true);
    }
  });

  it('rejects unknown tag', () => {
    expect(isValidTag('foobar')).toBe(false);
  });

  it('rejects wrong case', () => {
    expect(isValidTag('Preference')).toBe(false);
    expect(isValidTag('DECISION')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTag('')).toBe(false);
  });
});

describe('validateTags', () => {
  it('returns all valid tags unchanged', () => {
    expect(validateTags(['preference', 'skill'])).toEqual(['preference', 'skill']);
  });

  it('filters out invalid tags', () => {
    expect(validateTags(['preference', 'bogus', 'skill'])).toEqual(['preference', 'skill']);
  });

  it('deduplicates tags', () => {
    expect(validateTags(['preference', 'preference', 'skill'])).toEqual(['preference', 'skill']);
  });

  it('returns empty array for all invalid', () => {
    expect(validateTags(['bogus', 'invalid'])).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(validateTags([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/capture/tags.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the tags module**

```typescript
// src/capture/tags.ts
export const ALLOWED_TAGS = [
  'preference', 'decision', 'problem-solution', 'pattern',
  'goal', 'opinion', 'skill', 'relationship',
  'resource', 'idea', 'interest', 'health',
  'dislike', 'milestone',
] as const;

export type AllowedTag = typeof ALLOWED_TAGS[number];

export const TAG_DESCRIPTIONS: Record<AllowedTag, string> = {
  'preference': 'How the person likes things done',
  'decision': 'A choice made with rationale',
  'problem-solution': 'A problem encountered and how it was resolved',
  'pattern': 'A recurring behavior or habit observed over time',
  'goal': 'An aspiration, target, or planned direction',
  'opinion': 'A stance or belief with reasoning',
  'skill': 'A capability or expertise level',
  'relationship': 'Knowledge about a specific person',
  'resource': 'A tool, link, article, or reference worth recalling',
  'idea': 'An uncommitted exploration or possibility',
  'interest': 'A hobby, passion, or thing enjoyed',
  'health': 'Medical, fitness, dietary, or wellness information',
  'dislike': 'Something to avoid or never suggest',
  'milestone': 'A significant achievement or turning point',
};

const TAG_SET = new Set<string>(ALLOWED_TAGS);

export function isValidTag(tag: string): boolean {
  return TAG_SET.has(tag);
}

export function validateTags(tags: string[]): string[] {
  return [...new Set(tags.filter(isValidTag))];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/capture/tags.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add src/capture/tags.ts tests/unit/capture/tags.test.ts
git commit -m "feat: add tag allowlist module with validation"
```

---

### Task 2: Schema Migration

**Files:**
- Create: `migrations/002_tags_and_source_array.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/002_tags_and_source_array.sql
-- Convert source from varchar to text[] and add tags across all tiers

-- Captures: source varchar → text[], add tags
ALTER TABLE captures ALTER COLUMN source TYPE text[] USING ARRAY[source];
ALTER TABLE captures ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_captures_tags ON captures USING GIN (tags);
CREATE INDEX idx_captures_source ON captures USING GIN (source);

-- Facts: drop category, add tags and source
ALTER TABLE facts DROP COLUMN category;
ALTER TABLE facts ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE facts ADD COLUMN source text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_facts_tags ON facts USING GIN (tags);
CREATE INDEX idx_facts_source ON facts USING GIN (source);

-- Insights: drop category, add tags and source
ALTER TABLE insights DROP COLUMN category;
ALTER TABLE insights ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE insights ADD COLUMN source text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_insights_tags ON insights USING GIN (tags);
CREATE INDEX idx_insights_source ON insights USING GIN (source);
```

- [ ] **Step 2: Update auto-migration in `src/server.ts`**

The app auto-migrates on startup. Check `src/server.ts` for the migration runner and ensure it picks up `002_tags_and_source_array.sql`. If migrations are file-ordered, it should pick it up automatically. If there's a manual list, add the new file.

- [ ] **Step 3: Test locally with Docker**

Run: `docker compose up -d` then `npx tsx src/server.ts` and verify the migration applies.
Expected: No errors, tables have new columns.

- [ ] **Step 4: Commit**

```bash
git add migrations/002_tags_and_source_array.sql src/server.ts
git commit -m "feat: add migration for tags and source arrays"
```

---

### Task 3: Update DB Modules (Captures, Facts, Insights)

**Files:**
- Modify: `src/db/captures.ts:3-11` (CaptureInsert), `src/db/captures.ts:13-26` (CaptureRow), `src/db/captures.ts:28-47` (insertCapture)
- Modify: `src/db/facts.ts:3-11` (FactInsert), `src/db/facts.ts:13-27` (FactRow), `src/db/facts.ts:29-38` (insertFact)
- Modify: `src/db/insights.ts:3-10` (InsightInsert), `src/db/insights.ts:12-25` (InsightRow), `src/db/insights.ts:27-36` (insertInsight)
- Modify: `tests/unit/db/captures.test.ts`
- Modify: `tests/unit/db/facts.test.ts`
- Modify: `tests/unit/db/insights.test.ts`

- [ ] **Step 1: Update existing tests to use new types**

In each test file, update any references to `source: 'something'` to `source: ['something']` and add `tags: ['preference']` where applicable. Remove any `category:` references from facts/insights tests, replacing with `tags: ['preference']`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/db/captures.test.ts tests/unit/db/facts.test.ts tests/unit/db/insights.test.ts`
Expected: FAIL — type mismatches

- [ ] **Step 3: Update `src/db/captures.ts`**

Changes:
- `CaptureInsert.source: string` → `source: string[]`
- `CaptureRow.source: string` → `source: string[]`
- Add `tags: string[]` to both interfaces
- Update `insertCapture` SQL: add `tags` as `$8`, pass `capture.tags` as array
- Add `updateCaptureTags` function for `update_tags` MCP tool:
  ```typescript
  export async function updateCaptureTags(db: DbClient, id: string, tags: string[]): Promise<string[] | null> {
    const result = await db.query(
      `UPDATE captures SET tags = $1, updated_at = now() WHERE id = $2 RETURNING tags`,
      [tags, id],
    );
    return result.rows[0]?.tags ?? null;
  }
  ```

- [ ] **Step 4: Update `src/db/facts.ts`**

Changes:
- Remove `category: string` from `FactInsert`, add `tags: string[]` and `source: string[]`
- Remove `category: string` from `FactRow`, add `tags: string[]` and `source: string[]`
- Update `insertFact` SQL: replace `category` with `tags` and `source`, update param positions
- Add `updateFactTags`:
  ```typescript
  export async function updateFactTags(db: DbClient, id: string, tags: string[]): Promise<string[] | null> {
    const result = await db.query(
      `UPDATE facts SET tags = $1, updated_at = now() WHERE id = $2 RETURNING tags`,
      [tags, id],
    );
    return result.rows[0]?.tags ?? null;
  }
  ```

- [ ] **Step 5: Update `src/db/insights.ts`**

Changes:
- Remove `category: string` from `InsightInsert`, add `tags: string[]` and `source: string[]`
- Remove `category: string` from `InsightRow`, add `tags: string[]` and `source: string[]`
- Update `insertInsight` SQL: replace `category` with `tags` and `source`, update param positions
- Add `updateInsightTags`:
  ```typescript
  export async function updateInsightTags(db: DbClient, id: string, tags: string[]): Promise<string[] | null> {
    const result = await db.query(
      `UPDATE insights SET tags = $1, updated_at = now() WHERE id = $2 RETURNING tags`,
      [tags, id],
    );
    return result.rows[0]?.tags ?? null;
  }
  ```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/db/captures.test.ts tests/unit/db/facts.test.ts tests/unit/db/insights.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/captures.ts src/db/facts.ts src/db/insights.ts tests/unit/db/captures.test.ts tests/unit/db/facts.test.ts tests/unit/db/insights.test.ts
git commit -m "feat: update DB modules for tags arrays and source arrays"
```

---

### Task 4: Metadata Extraction with Tag Classification

**Files:**
- Modify: `src/capture/metadata.ts:4-10` (CaptureMetadata), `src/capture/metadata.ts:12-19` (EXTRACTION_PROMPT), `src/capture/metadata.ts:21-27` (FALLBACK_METADATA), `src/capture/metadata.ts:29-54` (extractMetadata)
- Modify: `tests/unit/capture/metadata.test.ts`

- [ ] **Step 1: Write tests for tag classification in metadata extraction**

Add to `tests/unit/capture/metadata.test.ts`:

```typescript
it('returns tags from LLM classification', async () => {
  const llm = mockLLM();
  vi.mocked(llm.complete).mockResolvedValueOnce({
    content: JSON.stringify({
      people: [], topics: ['typescript'], action_items: [], dates: [],
      type: 'preference', tags: ['preference', 'skill'],
    }),
    tokensUsed: { input: 50, output: 30, total: 80 },
  });

  const { extractMetadata } = await import('../../../src/capture/metadata.js');
  const metadata = await extractMetadata(llm, 'Pedro strongly prefers TypeScript.');

  expect(metadata.tags).toEqual(['preference', 'skill']);
});

it('returns empty tags array when LLM returns none', async () => {
  const llm = mockLLM();
  vi.mocked(llm.complete).mockResolvedValueOnce({
    content: JSON.stringify({
      people: [], topics: [], action_items: [], dates: [],
      type: 'unknown',
    }),
    tokensUsed: { input: 50, output: 30, total: 80 },
  });

  const { extractMetadata } = await import('../../../src/capture/metadata.js');
  const metadata = await extractMetadata(llm, 'test');

  expect(metadata.tags).toEqual([]);
});

it('validates tags against allowlist in metadata response', async () => {
  const llm = mockLLM();
  vi.mocked(llm.complete).mockResolvedValueOnce({
    content: JSON.stringify({
      people: [], topics: [], action_items: [], dates: [],
      type: 'preference', tags: ['preference', 'invalid_tag', 'skill'],
    }),
    tokensUsed: { input: 50, output: 30, total: 80 },
  });

  const { extractMetadata } = await import('../../../src/capture/metadata.js');
  const metadata = await extractMetadata(llm, 'Some content');

  expect(metadata.tags).toEqual(['preference', 'skill']);
  expect(metadata.tags).not.toContain('invalid_tag');
});

it('returns empty tags on LLM error', async () => {
  const llm = mockLLM();
  vi.mocked(llm.complete).mockRejectedValueOnce(new Error('LLM failed'));

  const { extractMetadata } = await import('../../../src/capture/metadata.js');
  const metadata = await extractMetadata(llm, 'Content');

  expect(metadata.tags).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/capture/metadata.test.ts`
Expected: FAIL — `tags` not in CaptureMetadata

- [ ] **Step 3: Update metadata extraction**

In `src/capture/metadata.ts`:
- Import `validateTags` from `./tags.js`
- Add `tags: string[]` to `CaptureMetadata` interface
- Add `tags: []` to `FALLBACK_METADATA`
- Expand `EXTRACTION_PROMPT` to include tag classification section with all 14 tags and descriptions
- In `extractMetadata`, parse `tags` from response and validate through `validateTags()`

The updated prompt adds:
```
- tags: array of applicable tags from this list (select all that apply, empty array if none):
  - preference: how the person likes things done
  - decision: a choice made with rationale
  ... (all 14 with descriptions)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/capture/metadata.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/metadata.ts tests/unit/capture/metadata.test.ts
git commit -m "feat: add tag classification to metadata extraction"
```

---

### Task 5: Capture Pipeline with Tags

**Files:**
- Modify: `src/capture/pipeline.ts:16-24` (PipelineInput), `src/capture/pipeline.ts:96-125` (pipeline logic)
- Modify: `tests/unit/capture/pipeline.test.ts`

- [ ] **Step 1: Update pipeline tests**

Update existing tests in `tests/unit/capture/pipeline.test.ts`:
- Change all `source: 'telegram'` to `source: ['telegram']`
- Add test: pipeline with caller-provided tags stores them without LLM classification
- Add test: pipeline without tags auto-classifies via metadata extraction
- Add test: pipeline with invalid tags filters them and uses remaining valid ones
- Add test: pipeline with empty tags array auto-classifies

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/capture/pipeline.test.ts`
Expected: FAIL

- [ ] **Step 3: Update the pipeline**

In `src/capture/pipeline.ts`:
- Add `tags?: string[]` to `PipelineInput`
- Import `validateTags` from `./tags.js`
- After dedup check, validate incoming tags: `const validTags = input.tags ? validateTags(input.tags) : null;`
- In the metadata extraction step:
  - If `validTags && validTags.length > 0`: use provided tags, still extract metadata for other fields
  - If not: use `metadata.tags` from the extraction response
- Update the `insertCapture` call: add `tags` field and change `source` to array type

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/capture/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to catch regressions**

Run: `npx vitest run`
Expected: Some failures in tests that reference old `source: string` or `category` — these are expected and fixed in later tasks.

- [ ] **Step 6: Commit**

```bash
git add src/capture/pipeline.ts tests/unit/capture/pipeline.test.ts
git commit -m "feat: capture pipeline supports tags and source arrays"
```

---

### Task 6: Update Telegram and REST API Source References

**Files:**
- Modify: `src/telegram/webhook.ts:13` — update `CaptureFn` type: `source: string` → `source: string[]`
- Modify: `src/telegram/command-handlers.ts:120,139` — change `source: 'telegram'` to `source: ['telegram']`
- Modify: `src/telegram/handlers.ts:14` — update `CaptureFn` type: `source: string` → `source: string[]`
- Modify: `src/telegram/handlers.ts:28,88,104,120` — change `source: 'telegram'` to `source: ['telegram']`
- Modify: `src/telegram/nl-router.ts:34` — update `CaptureFn` type: `source: string` → `source: string[]`
- Modify: `src/telegram/nl-router.ts:408` — change capture `source: 'telegram'` to `source: ['telegram']`
- Modify: `src/app.ts:145,167-174` — hardcode `source: ['api']`, accept optional `tags`

- [ ] **Step 1: Update CaptureFn type definitions**

There are three independent `CaptureFn` type definitions that accept `source: string` — all must change to `source: string[]`:
- `src/telegram/webhook.ts:13` — inline type in the captureFn closure
- `src/telegram/handlers.ts:14` — `type CaptureFn`
- `src/telegram/nl-router.ts:34` — `type CaptureFn`

- [ ] **Step 2: Update all Telegram capture source references**

In `command-handlers.ts` and `handlers.ts`, change all `source: 'telegram'` to `source: ['telegram']` on capture calls.

**Important:** Only change capture-related `source` references. Lines in `nl-router.ts` that pass `source: 'telegram'` to `insertComment` or `insertReminder` (lines 89, 150, 237, 255, 343) are for the **reminders** system, not the capture pipeline — leave those as scalar strings.

- [ ] **Step 3: Update REST API capture handler**

In `src/app.ts`, update the POST `/api/v1/capture` handler:
- Remove `source` from body destructuring (no longer caller-controlled)
- Add optional `tags` from body: `const { content, tags: rawTags, file_urls } = body;`
- Import `validateTags` and validate: `const tags = rawTags ? validateTags(rawTags) : undefined;`
- Pass `source: ['api']` and `tags` to `runCapturePipeline`

- [ ] **Step 4: Run related tests**

Run: `npx vitest run tests/unit/app.test.ts tests/integration/telegram-pipeline.test.ts`
Expected: Check for failures related to source type changes. Fix any mock assertions.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/webhook.ts src/telegram/command-handlers.ts src/telegram/handlers.ts src/telegram/nl-router.ts src/app.ts
git commit -m "feat: update all capture channels for source arrays"
```

---

### Task 7: Consolidation Phase 1 — Tags Replace Category

**Files:**
- Modify: `src/consolidation/phase1.ts:5-8` (ClusterInput), `src/consolidation/phase1.ts:19-51` (prompt), `src/consolidation/phase1.ts:70-104` (processCluster actions), `src/consolidation/phase1.ts:182-188` (shouldAutoApprove)
- Modify: `tests/unit/consolidation/phase1.test.ts`

- [ ] **Step 1: Update phase1 tests**

In `tests/unit/consolidation/phase1.test.ts`:
- Change `category: 'preference'` to `tags: ['preference']` in all `existingFacts` arrays
- Update the mocked LLM response: `create_fact` actions return `tags: ['preference']` instead of `category: 'preference'`
- Add test: fact created with tags from LLM response
- Add test: shouldAutoApprove accepts facts with auto-approve tags
- Add test: shouldAutoApprove rejects facts with only non-auto-approve tags

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/consolidation/phase1.test.ts`
Expected: FAIL

- [ ] **Step 3: Update phase1 code**

In `src/consolidation/phase1.ts`:
- Import `validateTags` from `../capture/tags.js`
- Update `ClusterInput.captures`: add `source: string[]` and `tags: string[]` to the array item type (becomes `{ id: string; content: string; embedding: number[]; source: string[]; tags: string[] }`)
- Update `ClusterInput.existingFacts`: `category: string` → `tags: string[]`
- Update `NOISE_CRITERIA_PROMPT`:
  - Replace category examples with tags examples
  - `create_fact` action returns `"tags": ["preference", "skill"]` instead of `"category": "preference"`
  - Include the 14-tag allowlist with descriptions in the prompt
  - Tell LLM to select applicable tags from the list
- Update `processCluster`:
  - `create_fact`: read `action.tags` (validate through `validateTags`), compute `source` by unioning all cluster captures' source arrays: `[...new Set(input.captures.flatMap(c => c.source))]`
  - `update_fact` for user_edited: use existing fact's tags instead of category
  - All SQL `INSERT INTO facts`: replace `category` column with `tags` and `source`
- Add unit test: fact `source` is union of cluster captures' sources (e.g., captures from `['telegram']` and `['mcp']` → fact gets `['telegram', 'mcp']`)
- Update `shouldAutoApprove(tags: string[], reviewMode: string)`:
  - Auto-approve tags: `['preference', 'skill', 'interest', 'dislike', 'resource']`
  - Returns true if any tag in the fact's tags is in the auto-approve set
- Update formatting of existing facts in the prompt: `(${f.category}, ...)` → `(tags: [${f.tags.join(', ')}], ...)`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/consolidation/phase1.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/consolidation/phase1.ts tests/unit/consolidation/phase1.test.ts
git commit -m "feat: phase1 consolidation uses tags instead of category"
```

---

### Task 8: Consolidation Phase 2 — Tags Replace Category

**Files:**
- Modify: `src/consolidation/phase2.ts:4-7` (Phase2Input), `src/consolidation/phase2.ts:15-35` (INSIGHT_PROMPT), `src/consolidation/phase2.ts:44-50` (formatting), `src/consolidation/phase2.ts:72-78` (insert)
- Modify: `tests/unit/consolidation/phase2.test.ts`

- [ ] **Step 1: Update phase2 tests**

In `tests/unit/consolidation/phase2.test.ts`:
- Change `category` to `tags` in `Phase2Input` test data
- Update mocked LLM response: insights return `tags: [...]` instead of `category: '...'`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/consolidation/phase2.test.ts`
Expected: FAIL

- [ ] **Step 3: Update phase2 code**

In `src/consolidation/phase2.ts`:
- Import `validateTags` from `../capture/tags.js`
- Update `Phase2Input.facts`: `category: string` → `tags: string[]`, add `source: string[]`
- Update `Phase2Input.existingInsights`: `category: string` → `tags: string[]`
- Update `INSIGHT_PROMPT`: replace `"category": "pattern|tendency|..."` with `"tags": ["pattern", "opinion"]` using the tag allowlist
- Update fact formatting: `(${f.category}, ...)` → `(tags: [${f.tags.join(', ')}], ...)`
- Update insight formatting similarly
- Update `INSERT INTO insights`: replace `category` with `tags` and `source`
  - `tags`: validate from LLM response via `validateTags(insight.tags ?? [])`
  - `source`: compute by unioning source facts' source arrays: `[...new Set(insight.source_fact_ids.flatMap(fid => input.facts.find(f => f.id === fid)?.source ?? []))]`
- Add unit test: insight `source` is union of contributing facts' sources

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/consolidation/phase2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/consolidation/phase2.ts tests/unit/consolidation/phase2.test.ts
git commit -m "feat: phase2 consolidation uses tags instead of category"
```

---

### Task 9: Consolidation Runner — Category to Tags

**Files:**
- Modify: `src/consolidation/runner.ts:90-96` (existingFacts mapping), `src/consolidation/runner.ts:142-149` (phase2 input mapping)

- [ ] **Step 1: Update runner code**

In `src/consolidation/runner.ts`:
- Line 66: Update `allInputs` mapping to include `source: c.source` and `tags: c.tags` from `CaptureRow` (and `source: ['system']` and `tags: []` for completed reminders since they don't have these fields)
- Line 92-95: Change `category: f.category` to `tags: f.tags` in existingFacts mapping
- Line 143-144: Change `category: f.category` to `tags: f.tags` and add `source: f.source` in phase2 facts mapping
- Line 146-148: Change `category: i.category` to `tags: i.tags` in existingInsights mapping

- [ ] **Step 2: Run consolidation tests**

Run: `npx vitest run tests/unit/consolidation/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/consolidation/runner.ts
git commit -m "feat: consolidation runner maps tags instead of category"
```

---

### Task 10: Retrieval — Search with Tag Filter

**Files:**
- Modify: `src/retrieval/search.ts:8-15` (SearchResult), `src/retrieval/search.ts:17-78` (searchThoughts)
- Modify: `src/db/captures.ts` (findSimilarCaptures — add tag filter)
- Modify: `src/db/facts.ts` (findSimilarFacts — add tag filter)
- Modify: `src/db/insights.ts` (findSimilarInsights — add tag filter)
- Modify: `tests/unit/retrieval/search.test.ts`

- [ ] **Step 1: Update search tests**

In `tests/unit/retrieval/search.test.ts`:
- Change all `category:` references to `tags:`
- Add test: `searchThoughts` with tags filter passes tags to DB queries
- Add test: `searchThoughts` without tags preserves existing behavior
- Add test: search results include `tags: string[]` instead of `category`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/retrieval/search.test.ts`
Expected: FAIL

- [ ] **Step 3: Update the search module**

In `src/retrieval/search.ts`:
- `SearchResult`: replace `category: string | null` with `tags: string[]`
- `searchThoughts` gains optional `tags?: string[]` parameter
- Update `findSimilarInsights`, `findSimilarFacts`, `findSimilarCaptures` calls to accept optional `tags` parameter
- Each DB function adds `AND tags @> $n` when tags provided
- Map results: `category: i.category` → `tags: i.tags ?? []`

In the DB modules (`captures.ts`, `facts.ts`, `insights.ts`):
- Add optional `tags?: string[]` parameter to `findSimilarCaptures`, `findSimilarFacts`, `findSimilarInsights`
- When provided, add `AND tags @> $n` to the WHERE clause with the tags array as parameter

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/retrieval/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/search.ts src/db/captures.ts src/db/facts.ts src/db/insights.ts tests/unit/retrieval/search.test.ts
git commit -m "feat: search_thoughts supports tag filtering"
```

---

### Task 11: Retrieval — Profile Synthesis

**Files:**
- Modify: `src/retrieval/profile.ts:14,26,38,55,59`
- Modify: `tests/unit/retrieval/profile.test.ts`

- [ ] **Step 1: Update profile tests**

In `tests/unit/retrieval/profile.test.ts`:
- Update mocked query results: replace `category` columns with `tags` arrays
- Verify formatting uses tags

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/retrieval/profile.test.ts`
Expected: FAIL

- [ ] **Step 3: Update profile synthesis**

In `src/retrieval/profile.ts`:
- Line 14: Change `SELECT id, content, category, ...` to `SELECT id, content, tags, ...`
- Line 26: Change `SELECT id, content, category, ...` to `SELECT id, content, tags, ...`
- Line 38: Reminders query uses `category` for a different purpose (reminder category, not profiler category) — check if reminders have a `category` column. If yes, leave as-is (reminders are separate).
- Line 55: Change `[${i.category}]` to `[${(i.tags ?? []).join(', ')}]`
- Line 59: Change `[${f.category}]` to `[${(f.tags ?? []).join(', ')}]`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/retrieval/profile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/profile.ts tests/unit/retrieval/profile.test.ts
git commit -m "feat: profile synthesis uses tags instead of category"
```

---

### Task 12: MCP Tools — capture_thought, search_thoughts, brain_stats, review_pending, update_tags

**Files:**
- Modify: `src/mcp/profiler-tools.ts:162-212` (capture_thought), `src/mcp/profiler-tools.ts:161-175` (search_thoughts), `src/mcp/profiler-tools.ts:214-248` (brain_stats), `src/mcp/profiler-tools.ts:306-333` (review_pending)
- Modify: `tests/unit/mcp/profiler-tools.test.ts`

- [ ] **Step 1: Update MCP tool tests**

Add/update tests in `tests/unit/mcp/profiler-tools.test.ts`:
- `capture_thought` with tags parameter — verify tags passed to pipeline
- `capture_thought` without tags — verify pipeline called without tags
- `search_thoughts` with tags — verify tags passed to search
- `brain_stats` — verify uses `unnest(tags)` query
- `review_pending` — verify returns `tags` array not `category`
- `update_tags` — valid tags accepted, invalid rejected, non-existent ID returns error

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/mcp/profiler-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `capture_thought`**

- Add optional `tags` parameter: `tags: z.array(z.string()).optional().describe('Optional semantic tags from allowlist: preference, decision, problem-solution, pattern, goal, opinion, skill, relationship, resource, idea, interest, health, dislike, milestone')`
- Import `validateTags` from `../capture/tags.js`
- Pass validated tags to pipeline: `tags: tags ? validateTags(tags) : undefined`
- Change `source: 'mcp'` to `source: ['mcp']`

- [ ] **Step 4: Update `search_thoughts`**

- Add optional `tags` parameter: `tags: z.array(z.string()).optional().describe('Filter by semantic tags (AND — results must have all specified tags). Available: preference, decision, problem-solution, pattern, goal, opinion, skill, relationship, resource, idea, interest, health, dislike, milestone')`
- Pass tags to `searchThoughts` function

- [ ] **Step 5: Update `brain_stats`**

- Replace the category query (lines 230-234) with tag breakdowns for all tiers:
  ```sql
  -- Facts by tag
  SELECT unnest(tags) AS tag, count(*) as count FROM facts
  WHERE archived = false AND review_status != 'user_rejected'
  GROUP BY tag ORDER BY count DESC
  ```
  ```sql
  -- Insights by tag
  SELECT unnest(tags) AS tag, count(*) as count FROM insights
  WHERE archived = false AND review_status != 'user_rejected'
  GROUP BY tag ORDER BY count DESC
  ```
  ```sql
  -- Captures by source
  SELECT unnest(source) AS src, count(*) as count FROM captures
  WHERE archived = false
  GROUP BY src ORDER BY count DESC
  ```
- Rename response field: `factsByCategory` → `factsByTag`
  ```sql
  -- Captures by tag
  SELECT unnest(tags) AS tag, count(*) as count FROM captures
  WHERE archived = false
  GROUP BY tag ORDER BY count DESC
  ```
- Rename response field: `factsByCategory` → `factsByTag`
- Add response fields: `insightsByTag`, `capturesByTag`, `capturesBySource`

- [ ] **Step 6: Update `review_pending`**

- Line 315: Change `category: string` to `tags: string[]` in items array type
- Line 320: Change `category: f.category` to `tags: f.tags`
- Line 327: Change `category: i.category` to `tags: i.tags`

- [ ] **Step 7: Add `update_tags` tool**

```typescript
server.tool(
  'update_tags',
  'Update the semantic tags on a capture, fact, or insight. Tags must be from the allowlist: preference, decision, problem-solution, pattern, goal, opinion, skill, relationship, resource, idea, interest, health, dislike, milestone',
  {
    id: z.string().uuid().describe('UUID of the item'),
    tier: z.enum(['capture', 'fact', 'insight']).describe('Which tier the item belongs to'),
    tags: z.array(z.string()).describe('New tags array (replaces existing tags)'),
  },
  async ({ id, tier, tags: rawTags }) => {
    const validTags = validateTags(rawTags);
    const invalidTags = rawTags.filter(t => !isValidTag(t));
    if (invalidTags.length > 0) {
      return { content: [{ type: 'text' as const, text: `Invalid tags: ${invalidTags.join(', ')}. Allowed: ${ALLOWED_TAGS.join(', ')}` }], isError: true };
    }

    let oldTags: string[] | null = null;
    if (tier === 'capture') {
      const existing = await getCaptureById(deps.db, id);
      if (!existing) return { content: [{ type: 'text' as const, text: `No capture found with id ${id}` }], isError: true };
      oldTags = existing.tags;
      await updateCaptureTags(deps.db, id, validTags);
    } else if (tier === 'fact') {
      const existing = await getFactById(deps.db, id);
      if (!existing) return { content: [{ type: 'text' as const, text: `No fact found with id ${id}` }], isError: true };
      oldTags = existing.tags;
      await updateFactTags(deps.db, id, validTags);
    } else {
      const existing = await getInsightById(deps.db, id);
      if (!existing) return { content: [{ type: 'text' as const, text: `No insight found with id ${id}` }], isError: true };
      oldTags = existing.tags;
      await updateInsightTags(deps.db, id, validTags);
    }

    return { content: [{ type: 'text' as const, text: `Tags updated: [${oldTags?.join(', ')}] → [${validTags.join(', ')}]` }] };
  },
);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/unit/mcp/profiler-tools.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mcp/profiler-tools.ts tests/unit/mcp/profiler-tools.test.ts
git commit -m "feat: MCP tools support tags — capture, search, stats, review, update_tags"
```

---

### Task 13: MCP Server Instructions & User Prompt

**Files:**
- Modify: `src/mcp/server.ts:16-25` (instructions)
- Modify: `src/mcp/profiler-tools.ts:11-51` (USER_SYSTEM_PROMPT), `src/mcp/profiler-tools.ts:53-125` (BRAIN_HELP_TEXT)

- [ ] **Step 1: Update MCP server instructions**

In `src/mcp/server.ts`, update the `instructions` field to include tag guidance:
- Explain the 14 tags and what each means
- Tell AI to provide tags when calling `capture_thought` if confident
- Explain search patterns: use `tags` parameter for knowledge type, query for domain
- Example: `search_thoughts("coding preferences", { tags: ["preference"] })`

- [ ] **Step 2: Update USER_SYSTEM_PROMPT**

In `src/mcp/profiler-tools.ts`, update `USER_SYSTEM_PROMPT`:
- Replace the `[CATEGORY]` format in capture guidance with tags list
- Add section explaining the tag system
- Show how to use `capture_thought` with tags
- Show how to search with tag filters

- [ ] **Step 3: Update BRAIN_HELP_TEXT**

In `src/mcp/profiler-tools.ts`, update `BRAIN_HELP_TEXT`:
- Replace `Categories: preference, habit, skill, ...` with the 14-tag list
- Update examples to use tags
- Add section on tag-filtered search

- [ ] **Step 4: Run MCP tests**

Run: `npx vitest run tests/unit/mcp/ tests/integration/mcp-auth.test.ts`
Expected: PASS (instruction text changes shouldn't break functional tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/profiler-tools.ts
git commit -m "feat: update MCP instructions and user prompt with tag system"
```

---

### Task 14: Fix Remaining Test Suite

**Files:**
- Modify: various test files that reference `category` or scalar `source`

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Identify all remaining failures.

- [ ] **Step 2: Fix each failing test**

Common fixes:
- `source: 'something'` → `source: ['something']`
- `category: 'something'` → `tags: ['something']`
- Mock query results: remove `category` column, add `tags` and `source` as arrays
- `SearchResult` assertions: `category` → `tags`
- Integration tests: update mock pipelines and DB responses

Files likely affected:
- `tests/unit/capture/pipeline-regression.test.ts`
- `tests/integration/api.test.ts`
- `tests/integration/telegram-pipeline.test.ts`
- `tests/integration/telegram-nl.test.ts`
- `tests/integration/telegram-cascade-move.test.ts`
- `tests/e2e/api-e2e.test.ts`

- [ ] **Step 3: Run full suite until green**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Run TypeScript compiler check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: update all tests for tags and source arrays"
```

---

### Task 15: E2E Tests for Tags

**Files:**
- Modify: `tests/e2e/api-e2e.test.ts`

- [ ] **Step 1: Add E2E tests**

Add to `tests/e2e/api-e2e.test.ts`:

```typescript
describe('Tags System', () => {
  it('captures with caller-provided tags stores them', async () => {
    // POST /api/v1/capture with tags
    // Verify the capture has the correct tags via GET /api/v1/captures
  });

  it('captures without tags get auto-classified', async () => {
    // POST /api/v1/capture without tags
    // Verify the capture has some tags (auto-classified by mocked LLM)
  });

  it('search_thoughts with tag filter returns matching results', async () => {
    // Create captures with different tags
    // Search with tag filter, verify only matching results
  });

  it('update_tags via MCP changes tags on a capture', async () => {
    // Create a capture
    // Call update_tags
    // Verify tags changed
  });

  it('source is stored as array', async () => {
    // POST /api/v1/capture
    // Verify source is ['api'] in the DB
  });
});
```

- [ ] **Step 2: Run E2E tests**

Run: `docker compose up -d && npm run test:e2e`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/api-e2e.test.ts
git commit -m "test: add E2E tests for tags system"
```

---

### Task 16: Documentation Updates

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-03-13-open-brain-2-design.md`

- [ ] **Step 1: Update ARCHITECTURE.md**

- Add section on the tag system with the 14-tag table
- Update data flow diagrams to show tags
- Update table schemas
- Update MCP tool descriptions (new `update_tags` tool, updated `capture_thought` and `search_thoughts`)
- Update tool count (now 21 tools: 13 profiler + 8 reminders)

- [ ] **Step 2: Update README.md**

- Mention tags in feature list
- Update MCP tool count

- [ ] **Step 3: Update CLAUDE.md**

- Add tags to code organization section
- Add `src/capture/tags.ts` to key files
- Note the tag allowlist and how to expand it

- [ ] **Step 4: Update design spec**

- Add tags feature to the design spec
- Update capture contract to include tags
- Update MCP tool table

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md README.md CLAUDE.md docs/superpowers/specs/2026-03-13-open-brain-2-design.md
git commit -m "docs: update all documentation for tags system"
```

---

### Task 17: Final Verification

- [ ] **Step 1: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Run E2E tests**

Run: `npm run test:e2e`
Expected: ALL PASS

- [ ] **Step 4: Local smoke test**

Run: `docker compose up -d && npx tsx src/server.ts`
- Verify migration applies
- Test capture via REST API with and without tags
- Verify tags in response

- [ ] **Step 5: Push and verify CI**

Run: `git push origin main`
Poll CI + Deploy with the standard polling script.
