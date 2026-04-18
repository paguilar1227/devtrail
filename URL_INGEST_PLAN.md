# URL Ingestion Feature — Implementation Plan

Living doc. Update checkboxes as you go. Designed so a fresh session can pick up mid-build without re-deriving decisions.

**Overall goal:** ingest URLs (YouTube transcripts, X threads, PDFs, HTML, media) with `source_url` preserved and surfaced on retrieval. Full stack: backend + REST + MCP + web UI.

**Reference spec:** `~/.claude/projects/-home-you-src-open-brain-v2/memory/feature_url_ingestion.md`

---

## Status Dashboard

**Phase 0 — Config (Azure side DONE, code pending):**
- [x] `xai-api-key` and `firecrawl-api-key` copied to `openbrainprodkv`
- [x] `XAI_API_KEY` and `FIRECRAWL_API_KEY` env vars wired into Container App
- [ ] `src/config.ts` updated to load them
- [ ] `src/services/index.ts` ServiceDeps extended if needed

**Phase 1 — Schema migration:**
- [ ] `migrations/002_source_url.sql` created
- [ ] `src/server.ts` auto-migrate logic extended to apply migration 002

**Phase 2 — DB layer:**
- [ ] `src/db/content-items.ts`: add `source_url` to interfaces, all SELECT column lists, INSERT, UPDATE
- [ ] `src/db/content-items.ts`: add `findByUrl(url)` for dedup
- [ ] `src/db/chunks.ts`: add `parent_source_url` to `findSimilarChunks` SELECT and `ChunkSearchResult` type

**Phase 3 — Providers:**
- [ ] npm install `youtube-transcript` + `@mendable/firecrawl-js`
- [ ] `src/providers/xai.ts`: `fetchXThread(url)` using xAI Grok live-search
- [ ] `src/providers/firecrawl.ts`: `scrapeUrl(url, opts)` using Firecrawl /v1/scrape
- [ ] Unit tests for both clients (mocked HTTP)

**Phase 4 — URL ingest service:**
- [ ] `src/capture/url-detect.ts`: `detectUrlType(url)` dispatcher
- [ ] `src/services/url-ingest.ts`: `ingestFromUrl(deps, url, opts)` orchestrator
- [ ] Per-type handlers: YouTube, X, PDF, image, audio, HTML
- [ ] Dedup check via `findByUrl` before creating
- [ ] Unit + integration tests

**Phase 5 — Public surfaces:**
- [ ] REST: `POST /api/v1/content/from-url` in `src/app.ts`
- [ ] MCP: `save_from_url` tool in `src/mcp/server.ts` (7th tool)
- [ ] Update MCP INSTRUCTIONS to mention `save_from_url`
- [ ] Integration tests for REST + MCP paths

**Phase 6 — Retrieval surfacing:**
- [ ] `ChunkSearchResult.parent_source_url` flows through search API
- [ ] RAG `Citation` type includes `source_url` when present
- [ ] `src/services/rag.ts` renders citations with URL when available
- [ ] Regression test: search response includes source_url for URL-sourced items

**Phase 7 — Web UI:**
- [ ] `web/src/lib/api.ts`: add `saveFromUrl` client, update `Citation`/`SearchHit` types
- [ ] `web/src/components/UrlSaveModal.tsx`: shared modal
- [ ] `web/src/components/DocumentsTab.tsx`: "Save from URL" button opens modal, scoped to project
- [ ] `web/src/pages/Home.tsx`: "Save from URL" button opens modal, global scope
- [ ] `web/src/components/DocumentsTab.tsx` + `NotesTab.tsx`: show source_url as clickable link on cards
- [ ] `web/src/components/ChatTab.tsx`: citations render source_url as link when present
- [ ] `web/src/components/SearchBar.tsx`: hit cards show source_url

**Phase 8 — Deploy + verify:**
- [ ] All tests pass locally (target: 70+ passing)
- [ ] Commit, push, CI+Deploy green
- [ ] Production verification:
  - [ ] MCP save_from_url with a YouTube URL → document created, transcript visible
  - [ ] MCP save_from_url with an X thread URL → document created with thread text
  - [ ] Web UI Save from URL with a blog article → document created
  - [ ] Search returns source_url in results

---

## Implementation Details

### Phase 0: Config

**Already done (Azure side):**
```bash
# Secrets copied into openbrainprodkv via:
az keyvault secret set --vault-name openbrainprodkv --name xai-api-key ...
az keyvault secret set --vault-name openbrainprodkv --name firecrawl-api-key ...

# Container App env vars wired to secret refs:
XAI_API_KEY → secretref:xai-api-key
FIRECRAWL_API_KEY → secretref:firecrawl-api-key
```

**Code changes (`src/config.ts`):**
```ts
// Add to configSchema:
xaiApiKey: z.string().min(1),
firecrawlApiKey: z.string().min(1),

// Add to loadConfig returns:
xaiApiKey: process.env.XAI_API_KEY,
firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
```

No change needed to `src/services/index.ts` (ServiceDeps) — providers are created in `server.ts` and passed to services that need them. Will decide per-service whether to inject xAI/Firecrawl clients into `ServiceDeps` or keep them as internal to `url-ingest.ts`.

**Decision: keep xAI + Firecrawl inside the url-ingest service.** Only url-ingest needs them. Passing them everywhere clutters the interface.

### Phase 1: Schema migration

**New file: `migrations/002_source_url.sql`**
```sql
-- Migration 002: source_url column for URL-sourced content items
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS source_url text;
CREATE INDEX IF NOT EXISTS idx_content_items_source_url
  ON content_items(source_url) WHERE source_url IS NOT NULL;
```

Index is partial (only non-null) so it's cheap — it exists purely to speed up the dedup lookup and is small since most items won't have a URL.

**`src/server.ts` migration runner:**
After the existing migration 001 block, add:
```ts
// Migration 002: source_url
const m002Check = await deps.db.pool.query(
  `SELECT count(*) as count FROM information_schema.columns
   WHERE table_name = 'content_items' AND column_name = 'source_url'`,
);
if (parseInt(m002Check.rows[0].count) === 0) {
  console.log('Running migration 002...');
  const sql = readFileSync(join(__dirname, '..', 'migrations', '002_source_url.sql'), 'utf-8');
  await deps.db.pool.query(sql);
  console.log('Migration 002 complete.');
}
```

### Phase 2: DB layer

**`src/db/content-items.ts`:**

Add to `ContentItemInsert`:
```ts
sourceUrl: string | null;
```

Add to `ContentItemRow`:
```ts
source_url: string | null;
```

Add to ALL explicit SELECT column lists (this is critical — miss one and source_url drops silently):
- `listContentItems` (`SELECT *` already — but we should make it explicit too, or keep `*` for list)
  - Actually for `list` endpoints the app strips embedding via `stripEmbedding` helper and source_url won't be stripped — so `SELECT *` keeps working as long as the column exists.
- `getContentItemById` — uses `SELECT *`, same logic
- `findByFileHash` — uses `SELECT *`, same logic
- `findSimilarContentItems` — explicit column list, **ADD** `source_url` to the SELECT

Add to `insertContentItem`:
```sql
INSERT INTO content_items (..., source_url)
VALUES (..., $N)
```
And pass `item.sourceUrl` in params.

Add to `updateContentItem` field map:
```ts
sourceUrl: 'source_url',
```

**New function `findByUrl(db, url)` for dedup:**
```ts
export async function findByUrl(db: DbClient, url: string): Promise<ContentItemRow | null> {
  const result = await db.query(
    `SELECT * FROM content_items WHERE source_url = $1 AND archived = false LIMIT 1`,
    [url],
  );
  return result.rows[0] ?? null;
}
```

**`src/db/chunks.ts` — update `findSimilarChunks`:**

Add to SELECT:
```sql
ci.source_url AS parent_source_url,
```

Add to `ChunkSearchResult`:
```ts
parent_source_url: string | null;
```

### Phase 3: Providers

**Install packages:**
```bash
npm install youtube-transcript @mendable/firecrawl-js
```

**`src/providers/xai.ts`:**
```ts
export class XaiClient {
  constructor(private apiKey: string) {}

  async fetchXThread(url: string): Promise<{ title: string; content: string }> {
    // xAI Grok endpoint with live search enabled for X
    // POST https://api.x.ai/v1/chat/completions
    // body: {
    //   model: 'grok-4-latest' (or similar),
    //   messages: [{ role: 'user', content: `Fetch full content of this X thread: ${url}. Include all tweets with author and timestamp. Return plain text.` }],
    //   search_parameters: { mode: 'on', sources: [{ type: 'x' }] }
    // }
    //
    // Parse response.choices[0].message.content as the thread text.
    // Pull the first 80 chars as the title.
  }
}
```

Check the real xAI API shape before finalizing. Likely differs slightly. Use `fetch`, no SDK needed.

**`src/providers/firecrawl.ts`:**
```ts
import FirecrawlApp from '@mendable/firecrawl-js';

export class FirecrawlClient {
  private app: FirecrawlApp;

  constructor(apiKey: string) {
    this.app = new FirecrawlApp({ apiKey });
  }

  async scrape(url: string, opts: { stealth?: boolean } = {}): Promise<{ title: string; markdown: string }> {
    const result = await this.app.scrapeUrl(url, {
      formats: ['markdown'],
      ...(opts.stealth ? { proxy: 'stealth' } : {}),
    });
    if (!result.success) throw new Error(`Firecrawl failed: ${result.error}`);
    return {
      title: result.metadata?.title ?? 'Untitled',
      markdown: result.markdown ?? '',
    };
  }
}
```

### Phase 4: URL ingest service

**`src/capture/url-detect.ts`:**
```ts
export type UrlType = 'youtube' | 'x' | 'pdf' | 'image' | 'audio' | 'video' | 'html' | 'unknown';

export function detectUrlTypeByPattern(url: string): UrlType | null {
  if (/(?:youtube\.com\/watch|youtu\.be\/)/.test(url)) return 'youtube';
  if (/(?:x\.com|twitter\.com)\/\w+\/status\/\d+/.test(url)) return 'x';
  return null;
}

export async function detectUrlType(url: string): Promise<UrlType> {
  const pattern = detectUrlTypeByPattern(url);
  if (pattern) return pattern;

  // HEAD request for Content-Type
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/pdf')) return 'pdf';
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('audio/')) return 'audio';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.includes('text/html') || contentType.includes('text/plain')) return 'html';
  } catch {
    // HEAD failed — fall back to HTML
  }
  return 'html';
}

export function extractYouTubeVideoId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
```

**`src/services/url-ingest.ts`:**
```ts
import { YoutubeTranscript } from 'youtube-transcript';
import { XaiClient } from '../providers/xai.js';
import { FirecrawlClient } from '../providers/firecrawl.js';
import { detectUrlType, extractYouTubeVideoId } from '../capture/url-detect.js';
import { findByUrl } from '../db/content-items.js';
import { createContentItem } from './content-items.js';
import type { ServiceDeps } from './index.js';

export interface IngestFromUrlResult {
  id: string;
  title: string;
  type: 'document' | 'note';
  source_url: string;
  deduped: boolean;  // true if an existing item was returned
  chunkCount?: number;
}

export async function ingestFromUrl(
  deps: ServiceDeps,
  url: string,
  opts: { projectIds?: string[]; tags?: string[]; title?: string } = {},
): Promise<IngestFromUrlResult> {
  // Normalize URL (strip trailing slash, fragments)
  const normalized = normalizeUrl(url);

  // Dedup check
  const existing = await findByUrl(deps.db, normalized);
  if (existing) {
    return {
      id: existing.id,
      title: existing.title,
      type: existing.type,
      source_url: normalized,
      deduped: true,
    };
  }

  const type = await detectUrlType(normalized);

  switch (type) {
    case 'youtube': return await handleYoutube(deps, normalized, opts);
    case 'x':       return await handleXThread(deps, normalized, opts);
    case 'pdf':     return await handleBinary(deps, normalized, opts, 'application/pdf');
    case 'image':   return await handleBinary(deps, normalized, opts, null);  // sniff
    case 'audio':   return await handleBinary(deps, normalized, opts, null);
    case 'video':   return await handleBinary(deps, normalized, opts, null);
    case 'html':    return await handleHtml(deps, normalized, opts);
    default:        throw new Error(`Unsupported URL type: ${type}`);
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    // Strip trailing slash on pathname
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

async function handleYoutube(deps, url, opts) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID');

  let transcriptItems;
  try {
    transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
  } catch (err) {
    throw new Error(`YouTube transcript not available for this video: ${err.message}`);
  }

  const content = transcriptItems.map(t => t.text).join(' ');
  const title = opts.title ?? `YouTube: ${videoId}`;  // url-ingest handler passes through, let Gemini Flash auto-title

  const result = await createContentItem(deps, {
    type: 'document',
    content,
    title: opts.title,  // undefined means auto-title
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
  });

  return { id: result.id, title: result.title, type: 'document', source_url: url, deduped: false, chunkCount: result.chunkCount };
}

async function handleXThread(deps, url, opts) {
  const xai = new XaiClient(deps.config.xaiApiKey);
  const firecrawl = new FirecrawlClient(deps.config.firecrawlApiKey);

  let fetched;
  try {
    fetched = await xai.fetchXThread(url);
  } catch (err) {
    console.warn('[url-ingest] xAI X fetch failed, falling back to Firecrawl:', err.message);
    try {
      fetched = await firecrawl.scrape(url, { stealth: true });
      fetched = { title: fetched.title, content: fetched.markdown };
    } catch (err2) {
      throw new Error(`Both xAI and Firecrawl failed to fetch X thread: ${err2.message}`);
    }
  }

  const result = await createContentItem(deps, {
    type: 'document',
    content: fetched.content,
    title: opts.title ?? fetched.title,
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
  });

  return { id: result.id, title: result.title, type: 'document', source_url: url, deduped: false, chunkCount: result.chunkCount };
}

async function handleHtml(deps, url, opts) {
  const firecrawl = new FirecrawlClient(deps.config.firecrawlApiKey);
  const fetched = await firecrawl.scrape(url);

  const result = await createContentItem(deps, {
    type: 'document',
    content: fetched.markdown,
    title: opts.title ?? fetched.title,
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
  });

  return { id: result.id, title: result.title, type: 'document', source_url: url, deduped: false, chunkCount: result.chunkCount };
}

async function handleBinary(deps, url, opts, forcedMimeType) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = forcedMimeType ?? res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
  const filename = url.split('/').pop() ?? 'download';

  const result = await createContentItem(deps, {
    type: 'document',
    title: opts.title,
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
    file: { data: buf, mimeType, filename },
  });

  return { id: result.id, title: result.title, type: 'document', source_url: url, deduped: false, chunkCount: result.chunkCount };
}
```

**Update `src/services/content-items.ts` `createContentItem`:**
- Add `sourceUrl?: string` to `CreateContentInput`
- Pass through to `insertContentItem` as `sourceUrl: input.sourceUrl ?? null`

### Phase 5: Public surfaces

**REST — `src/app.ts`:**
```ts
app.post('/api/v1/content/from-url', async (c) => {
  const body = await c.req.json<{ url: string; project_ids?: string[]; tags?: string[]; title?: string }>();
  if (!body.url) return c.json({ error: 'url is required' }, 400);
  try {
    const result = await urlIngestSvc.ingestFromUrl(deps, body.url, {
      projectIds: body.project_ids,
      tags: body.tags,
      title: body.title,
    });
    return c.json(result, result.deduped ? 200 : 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed' }, 400);
  }
});
```

**MCP — `src/mcp/server.ts`:**
Add as 7th tool:
```ts
server.tool(
  'save_from_url',
  `Fetch and save a URL to Open Brain. Handles YouTube transcripts, X threads, PDFs, HTML articles, and direct media links. The URL is preserved as the item's source and surfaced in search results.

Use this instead of 'create' when the user wants to save something they've linked (article, video, tweet, PDF link). Tiny MCP payload (just the URL), backend does the fetch.

Dedup: if this URL is already saved, returns the existing item (deduped: true).`,
  {
    url: z.string().describe('The URL to fetch and save. YouTube video, X/Twitter thread, article, PDF, image, or audio.'),
    project_ids: z.array(z.string()).optional().describe('Multi-project membership (array of project UUIDs)'),
    tags: z.array(z.string()).optional(),
    title: z.string().optional().describe('Optional title override. If omitted, uses the page title or AI-generated from content.'),
  },
  async ({ url, project_ids, tags, title }) => {
    try {
      const result = await urlIngestSvc.ingestFromUrl(deps, url, {
        projectIds: project_ids,
        tags,
        title,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  },
);
```

**Update MCP INSTRUCTIONS:**
- Add `save_from_url` to the tool list in the instructions
- Add a concrete example for "save this URL" flow

### Phase 6: Retrieval surfacing

**`src/services/search.ts`:** `SearchHit.chunk` already includes the full `ChunkSearchResult` which now has `parent_source_url`. No code change, but verify.

**`src/services/rag.ts`:**
Update `Citation` type:
```ts
export interface Citation {
  content_item_id?: string;
  title: string;
  type: string;
  chunk_preview: string;
  similarity: number;
  source_url?: string | null;
}
```

In `ragQuery` when building citations from chunks:
```ts
citations.push({
  content_item_id: c.content_item_id,
  title: c.parent_title,
  type: c.parent_type,
  chunk_preview: (c.content ?? '').slice(0, 150),
  similarity: c.similarity,
  source_url: c.parent_source_url ?? null,
});
```

Update SYSTEM_PROMPT to tell Claude to render source URLs in answers when available:
```
When citing, include the source URL from the citation's source_url field if present, like: "(https://...)".
```

### Phase 7: Web UI

**`web/src/lib/api.ts`:**
- Add `ContentItem.source_url?: string | null` field
- Add `Citation.source_url?: string | null` field
- Add `SearchHit.chunk.parent_source_url?: string | null` field
- Add `saveFromUrl` function:
```ts
export const saveFromUrl = (payload: {
  url: string;
  project_ids?: string[];
  tags?: string[];
  title?: string;
}) => request<{
  id: string;
  title: string;
  type: string;
  source_url: string;
  deduped: boolean;
  chunkCount?: number;
}>('/api/v1/content/from-url', {
  method: 'POST',
  body: JSON.stringify(payload),
});
```

**New `web/src/components/UrlSaveModal.tsx`:**
Shared modal component. Props: `open`, `onClose`, `defaultProjectId?`. Form fields: URL, optional title, optional tags. On submit, calls `saveFromUrl`. Shows progress + result, handles dedup case ("Already saved — opening existing item").

**Home page button** (`web/src/pages/Home.tsx`):
Add a "🔗 Save from URL" button near the "+ New Project" row. Opens UrlSaveModal with no project (personal scope).

**DocumentsTab button** (`web/src/components/DocumentsTab.tsx`):
Add "🔗 Save from URL" next to "+ Upload Document". Opens UrlSaveModal with `defaultProjectId={projectId}`.

**Source URL rendering on cards:**
- DocumentsTab + NotesTab: if `item.source_url`, show a line `📎 <domain> ↗` under the title that opens `item.source_url` in a new tab.

**Chat citations (`web/src/components/ChatTab.tsx`):**
- If `citation.source_url`, render the citation as: `[N] <title> (<domain> ↗)` where the domain is a hyperlink.
- Otherwise current rendering.

**Search hits (`web/src/components/SearchBar.tsx`):**
- Show `parent_source_url` as a clickable link under the parent title.

### Phase 8: Deploy + verify

```bash
git add -A && git commit -m "feat: URL ingestion — YouTube, X, PDF, HTML, media with source_url preserved" && git push origin main
```

Wait for CI + Deploy.

**Verification checklist:**
- [ ] Save a YouTube URL via MCP (`save_from_url`): transcript appears as content, source_url set
- [ ] Save an X thread URL: thread text appears, source_url set
- [ ] Save a PDF URL: PDF downloaded, existing pipeline chunks it
- [ ] Save a blog article: Firecrawl markdown saved
- [ ] Dedup: save same URL twice, second call returns `deduped: true`
- [ ] Search returns a URL-sourced item: response includes `parent_source_url`
- [ ] RAG Q&A includes source URLs in citations
- [ ] Web UI "Save from URL" button works on Home and DocumentsTab

---

## Stopping Points (safe to compact/resume)

Each phase is a natural stopping point. Code compiles cleanly at the end of each phase (even if the feature isn't fully wired yet).

- After Phase 2: schema + DB support `source_url` but nothing uses it. Tests pass.
- After Phase 4: url-ingest service works but no external surface. Can be tested via direct service call in a test.
- After Phase 5: REST + MCP exposed. Can be tested via curl / MCP tool from this session.
- After Phase 6: retrieval surfaces source_url. Can be tested via search/RAG.
- After Phase 7: web UI fully wired.
- After Phase 8: deployed + verified.

**If compaction happens mid-phase:** the phase's checkbox list and the Implementation Details section together should let a fresh session resume without rethinking the design.

---

## Known open questions (resolve when we hit them)

1. **xAI API exact endpoint shape** — I've assumed `/v1/chat/completions` with search_parameters. Verify against their docs before implementing. If it's different, update `src/providers/xai.ts`.
2. **youtube-transcript reliability** — package scrapes YouTube's internal endpoints. May break intermittently. Clear error message to user if it fails.
3. **URL dedup strictness** — `normalizeUrl` strips fragment and trailing slash. Should we also normalize query params (e.g., UTM params)? **Decision for v1: leave query params as-is. Future: strip tracking params.**
4. **Binary download size limits** — what if someone passes a 1GB video URL? Add a `max_bytes` check (say 100MB) that aborts early with a clear error.
