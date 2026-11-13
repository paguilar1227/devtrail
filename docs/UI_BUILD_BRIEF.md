# DevTrail — UI Build Brief

You are picking up the **web client** for DevTrail. The backend API is finished, deployed, and verified end-to-end. Your job is to evolve the existing minimal web UI (`frontend/`) into a complete client that exercises the full API surface.

This is a **single-user** personal knowledge base + productivity tool (NotebookLM crossed with a task manager, owned by Alex). No multi-tenancy, no signup flow — just one API key in `localStorage`. Design for that scale: **clarity, speed, keyboard-friendly** beats heavy onboarding or "social" patterns.

---

## What's already there (don't rewrite, evolve)

`frontend/` is a Vite + React 18 + Tailwind app, served statically by the Hono API in production at `/`.

```
frontend/src/
├── App.tsx                    # API key gate + hash router (#/project/:id)
├── lib/api.ts                 # 273 LOC — partial coverage of v2 API. NEEDS EXTENSION.
├── pages/
│   ├── Home.tsx               # Project list + create
│   └── ProjectDetail.tsx      # Tabbed view per project
└── components/
    ├── ChatTab.tsx            # RAG Q&A
    ├── DocumentsTab.tsx       # File-backed content (PDF/audio/video)
    ├── NotesTab.tsx           # Self-authored markdown
    ├── TodosTab.tsx
    ├── SearchBar.tsx
    └── UrlSaveModal.tsx
```

**Stack constraints — do not change without asking:**
- React 18, TypeScript, Tailwind CSS, Vite
- Hash-based routing (no react-router yet — keep it light unless complexity demands it)
- API key in `localStorage` (key: `ob_api_key`)
- No state library — `useState` / `useEffect` is fine; lift to context only if needed
- One source of truth for API calls: extend `lib/api.ts`. Do not call `fetch` from components.

**Build & dev:**
```bash
npm run install:all && npm run dev    # localhost:5173 → proxies to API
npm run build                            # builds into frontend/dist/, served by Hono
```

---

## Reality check before you start

Read these in the repo:
- `CLAUDE.md` — entity model, REST routes, async ingest contract, gotchas
- `backend/src/app.ts` — every REST route handler (authoritative source for shapes)
- `scripts/live-e2e.sh` — 59 live assertions exercising the API; the request/response shapes you'll work with are all here

If a doc says one thing and the code says another, **the code wins**. Update the doc.

---

## Entity model (asymmetric — easy to get wrong)

| Entity | Membership field | Editable body? |
|---|---|---|
| **Project** | — | name + description editable always |
| **Document** (content `type='document'`) | `project_ids[]` (array) | only if `blob_url IS NULL` (URL-ingested HTML / pasted markdown). Binary docs (PDF/audio/video) are body-immutable; use **replace** to make a v2. |
| **Note** (content `type='note'`) | `project_ids[]` (array) | always |
| **Todo** | `project_id` (single, nullable=Inbox) | `content` field |
| **Comment** | belongs to one Todo | `content` field |

Project membership is asymmetric — content uses an **array**, todos a **single** field. UI must reflect that:
- Content can show "Add to project…" multi-select chips
- Todos use a single project picker (or "Inbox" = null)

---

## The async ingest contract (don't miss this)

`POST /content`, `POST /content/from-url`, `POST /content/:id/edit-body`, `POST /content/:id/reprocess`, `POST /content/:id/retry` all return:

```
202 Accepted
{ "id": "<uuid>", "status": "pending" }
```

The row exists immediately with a placeholder title and `processing_status='pending'`. The UI must:

1. Insert an optimistic row in the list with a "processing…" badge
2. Poll `GET /content/:id/status` every 1.5–2s until status is `ready` or `failed`
3. On `ready`: refetch the full row, replace the optimistic one
4. On `failed`: show the `processing_error` and offer a **Retry** button (calls `POST /content/:id/retry`)

`GET /content/:id/status` returns slim:
```
{ "id", "processing_status": "pending|ready|failed", "processing_error": null|string, "ingest_completed_at": null|iso }
```

Don't poll the full `GET /content/:id` — it returns the full body + metadata + embeddings on every tick.

---

## Complete view inventory (28 surfaces)

Build all of these. The numbering is for reference only — pick a build order that makes sense.

### Pages (full screens)

| # | Page | Backend coverage |
|---|---|---|
| 1 | API Key Gate | `Authorization: Bearer` flow; 401 → bounce |
| 2 | Home / Dashboard | `GET /stats`, `GET /projects?pinned=true`, `GET /activity?limit=20`, Inbox preview, global search entry |
| 3 | All Projects | `GET /projects?status=&pinned=`; create; pin/unpin; archive/restore; hard-delete |
| 4 | Project Detail (shell) | header (rename inline, pin, archive, hard-delete, edit description) + 4 tabs |
| 5 | Inbox | `GET /todos?project_id=null` — personal todos with no project; same filters/bulk as project todos tab |
| 6 | Tags Management | `GET /tags`, `PUT /tags/:name`, `DELETE /tags/:name`; click a tag → filtered view |
| 7 | Activity Feed | `GET /activity` with `?since=&until=&kinds=&project_id=`; click event → jump to source |
| 8 | Search Results | `POST /search` with all filters; `retrieval_path` icon per hit; jump to source |
| 9 | Find Mentions | `POST /find-mentions {entity, type?, project_id?}` — entity-driven view |
| 10 | Trash / Archived | `?include_archived=true` for content, todos, projects; restore + hard-delete |

### Tabs inside Project Detail

| # | Tab | Backend coverage |
|---|---|---|
| 11 | Documents | `GET /content?type=document&project_id=` + filters; upload; URL save; per-row pin/archive/delete/reprocess/retry/**replace**; bulk-select |
| 12 | Notes | `GET /content?type=note&project_id=` + filters; new note; **edit-body** (only when `blob_url IS NULL`); per-row + bulk |
| 13 | Todos | `GET /todos?project_id=` with hierarchy (parent_id), filters (status, priority, tags, due_before/after, pinned); inline edit; subtasks; bulk |
| 14 | Chat (RAG) | `POST /rag` with depth toggle (auto/fast/thorough); clickable citations; timing footer; client-side history |

### Modals / sheets / panels

> **Mobile reminder:** these are full-screen on mobile, centered modals or right-rail drawers on desktop.

| # | Surface | Backend coverage |
|---|---|---|
| 15 | File Upload | multipart `POST /content`; progress; MIME inference; project_ids prefilled |
| 16 | URL Save | `POST /content/from-url`; dedup feedback ("already saved on …") |
| 17 | Note Editor | new note + `edit-body`; markdown preview; status polling on save |
| 18 | Document Reader | `GET /content/:id`; body or signed blob link; metadata (source_url, published_at, mime, file_hash); per-row actions |
| 19 | Replace | `POST /content/:id/replace`; file picker for blob-backed, text editor for blob-null; renders v1 → v2 cross-link |
| 20 | Todo Detail | full content edit, status/priority/due/parent/project, tags, **comments thread** |
| 21 | Bulk Action confirm | `POST /content/bulk` and `POST /todos/bulk`; shows count + missing_ids on response |
| 22 | Confirmation dialog | reusable for hard-delete, tag rename/delete, archive cascades. Mobile: typed-name confirmation for hard-delete. |

### Reusable components

| # | Component | Backend coverage |
|---|---|---|
| 23 | App shell + nav | bottom tab bar (mobile) / left sidebar (desktop); contextual top bar |
| 24 | Status badge | `processing_status` → pending / ready / failed (with retry button calling `POST /content/:id/retry`) |
| 25 | Bulk select toolbar | varies by entity; toggled into bulk mode by a Select button on mobile |
| 26 | Tag chip | inline rename, click to filter, remove on hover/tap (calls `bulk remove_tags`) |
| 27 | Citation pill | in chat, expands chunk preview, links to source content item |
| 28 | Pin / archive / delete action group | reused on all entity rows |

### What's intentionally out of scope

- Multi-tenancy / sharing UI
- Real-time collab
- In-app PDF/audio/video preview rendering — link to signed `blob_url`, browser handles it
- Native iOS/Android app (PWA-friendly is the bar, not a native shell)
- Diagnostics endpoints (`/diagnostics/*`)

---

## Required views / features

### P0 — must work

#### Auth gate
- Existing `App.tsx` paste-in-API-key flow is fine. Just polish.

#### Home / dashboard
- Replace current home. Show:
  - **Stats summary** from `GET /api/v1/stats` (counts, freshness, top tags)
  - **Pinned projects** (`GET /api/v1/projects?pinned=true`) as cards
  - **Active projects** below
  - **Inbox** card showing recent todos with `project_id=null`
  - **Recent activity** from `GET /api/v1/activity?limit=20` (compact list)
- Top-level **search bar** that searches across everything (`POST /api/v1/search` with no project filter)

#### Project list / create / archive / pin
- `GET /api/v1/projects` (and `?status=` and `?pinned=`)
- `POST /api/v1/projects {name, description?}`
- `PUT /api/v1/projects/:id {name?, description?, status?}` — inline rename
- `POST /api/v1/projects/:id/pin` and `/unpin`
- `DELETE /api/v1/projects/:id` (soft, default) and `?hard=true` (with confirm)

#### Project detail page
The hub for everything. Tabs roughly match the existing structure but each gets richer:

**Documents tab**
- File upload (drag-drop + button). Multipart `POST /api/v1/content` with `type=document`, file in `file` field
- URL save (existing `UrlSaveModal` works — wires to `POST /api/v1/content/from-url`)
- List with: title, type icon, source link (if `source_url`), tag chips, processing badge
- Filters: `?tags=`, `?processing_status=`, `?pinned=`, `?include_archived=`
- Per-row actions: **pin/unpin**, **archive/restore**, **delete (hard)** with confirm, **reprocess**, **retry** (only if failed), **replace** (the v2-from-file flow)
- **Bulk select** (checkboxes + toolbar): archive / restore / delete / add tags / remove tags / set project (`POST /api/v1/content/bulk`, capped at 100/request)

**Notes tab**
- "New note" button → markdown editor view
- Each note has the same actions as documents PLUS **edit body** for `blob_url IS NULL` rows. Edit calls `POST /api/v1/content/:id/edit-body {content}` (returns 202; same polling pattern as ingest).
- **Body-edit guard:** PUT `/content/:id` rejects a `content` field with 400 — never send it; route body changes through `/edit-body`.

**Todos tab**
- List with hierarchy: parent → child indent
- Filters: status (`not_started|in_progress|paused|done`), priority (P1/P2/P3), `parent_id`, `tags`, `due_before`, `due_after`, `pinned=true`
- Inline edit on click: title, status (cycle), priority, due date
- Subtask creation: hover row → "+ subtask" → POST with `parent_id` set
- Per-row actions: pin/unpin, archive/restore, delete, set project (drag to another project? maybe)
- **Bulk select** (`POST /api/v1/todos/bulk`): archive / restore / delete / set_status / set_priority / set_due_date / set_project_id / add/remove_tags
- **Comments panel** per todo (slide-out or inline expand): `GET/POST/PUT/DELETE /api/v1/todos/:id/comments[/:cid]`. POST returns `{comment: {...}}`.

**Chat tab (RAG)**
- Existing `ChatTab` is the seed. Extend to:
  - Show citations with **clickable** previews → opens the source content item
  - **Depth toggle** (auto / fast / thorough). Pass `depth` to `POST /api/v1/rag`. Default `auto`.
  - Show timing metadata (`meta.timings_ms`) in a tiny footer when present
  - Maintain chat history client-side (no server endpoint for this)

#### Tag management page
- `GET /api/v1/tags` (optionally `?project_id=`) — inventory with totals + breakdown (doc/note/todo counts)
- `PUT /api/v1/tags/:name {to}` — rename across content + todos
- `DELETE /api/v1/tags/:name` — corpus-wide delete
- Rename-to-existing collapses; show count of affected rows in confirmation

---

### P1 — adds polish, build after P0 lands

- **Replace flow** for documents (`POST /api/v1/content/:id/replace`)
  - "Replace this document" button → file picker (or pasted text for blob-null content)
  - Old row gets archived + stamped with `metadata.replaced_by`. New row has `metadata.replaces`. Show a "v2 of …" badge linking back.
- **Activity feed page** (`GET /api/v1/activity` with `?since=`, `?until=`, `?kinds=ingest,edit,comment`, `?project_id=`, `?limit=`). Kinds: `ingest`, `edit`, `comment`.
- **Search results page** with filters (project, type, tags) and `retrieval_path` shown per hit
- **Find mentions** for an entity name (`POST /api/v1/find-mentions {entity, type?, project_id?}`) — useful for "show me everything tagged with this person"
- **Trash view** — `?include_archived=true` filter on each list, with restore & hard-delete

---

### P2 — nice to have

- Keyboard shortcuts (cmd-k for search, n for new note, t for new todo, etc.)
- Local cache of recent projects so home renders fast on repeat visits
- Dark mode (Tailwind already supports it; add toggle)
- Export project as zip / markdown
- Drag-drop content between projects (calls `PUT /content/:id` to swap project_ids)

---

## Auth

Every API request:

```
Authorization: Bearer <api-key>
```

(or `?key=<api-key>` query param). Same key for `/api/*` and `/mcp`.

If a request returns **401**, clear the stored key and bounce back to the API key gate.

---

## Response shapes — the bits that bite

The API has some shape inconsistencies (kept for stability). Don't fight them — codify them in `lib/api.ts` and move on.

| Endpoint | Shape |
|---|---|
| `GET /projects` | `{projects: Project[]}` |
| `POST /projects` | `{project: Project}` (201) |
| `GET /content` | `{items: ContentItem[]}` |
| `POST /content` (text) | `{id, status: 'pending'}` (202) |
| `POST /content` (multipart) | same as text |
| `POST /content/from-url` | `{id, status: 'pending'}` (202) |
| `POST /content/:id/edit-body` | `{id, status: 'pending'}` (202) |
| `POST /content/:id/replace` | `{old_id, new_id, status: 'pending'}` (202) |
| `POST /content/:id/reprocess` | `{id, status: 'pending'}` (202) |
| `POST /content/:id/retry` | `{id, status: 'pending'}` (202) |
| `GET /content/:id` | `{item: ContentItem}` |
| `GET /content/:id/status` | `{id, processing_status, processing_error, ingest_completed_at}` |
| `GET /todos` | `{todos: Todo[]}` |
| `POST /todos` | `{todo: Todo}` (201) — full row including all defaults |
| `GET /todos/:id` | `{todo: Todo}` |
| `POST /todos/:id/comments` | `{comment: TodoComment}` (201) |
| `GET /todos/:id/comments` | `{comments: TodoComment[]}` |
| `GET /tags` | `{tags: TagInventory[]}` |
| `GET /activity` | `{events: ActivityEvent[]}` |
| `GET /stats` | `{counts, freshness, processing, top_tags}` |
| Bulk endpoints | `{requested, affected, missing_ids[]}` |
| Pin / unpin | `{ok: true, pinned: true|false}` |
| Archive (DELETE) | `{ok: true, mode: 'archived'|'hard'}` |

**Soft delete is default.** `DELETE /…/:id` archives. `DELETE /…/:id?hard=true` permanently removes. Always confirm before hard delete.

---

## Responsive design — both phone and desktop are P0

Alex uses this **a lot on mobile**. Mobile is not an afterthought — every view, every interaction, must be designed for a 360px-wide phone first, then enhanced for desktop. Use Tailwind's mobile-first breakpoints (`sm:` 640+, `md:` 768+, `lg:` 1024+, `xl:` 1280+).

### Navigation pattern

| Form factor | Pattern |
|---|---|
| **Mobile** (<768px) | Bottom tab bar with 5 destinations: Home / Projects / Inbox / Search / More. Top app bar shows current screen title + contextual actions. Modals + side panels are **full-screen overlays**. |
| **Desktop** (≥1024px) | Persistent left sidebar with the same destinations + nested sub-items (e.g. pinned projects expanded). Modals are centered cards. Side panels are right-rail drawers. |
| **Tablet** (768–1023px) | Sidebar collapses to icon strip; modals stay centered. |

### Interaction patterns that change between mobile and desktop

| Interaction | Mobile | Desktop |
|---|---|---|
| **Bulk select** | Explicit "Select" button in toolbar toggles bulk mode → checkboxes appear, action bar slides up from bottom | Hover row → checkbox visible, click into bulk mode |
| **Search** | Search icon in top bar → opens full-screen search overlay | Cmd-K opens centered search modal; persistent search bar in sidebar |
| **Drag-drop file upload** | Skip drag — tap "Upload" button → native file picker | Both drag-drop zone and Upload button |
| **Drag-to-reorder** | Skip on mobile (use up/down buttons or move-to menu) | Optional, not P0 |
| **Hover actions** (pin, archive icons) | Always visible OR revealed by tap-on-row toggling action mode | Visible on hover |
| **Side panel** (todo detail, document reader) | Full-screen view with back button | Right-rail drawer (40–50% viewport) |
| **Cmd-K shortcut** | n/a | Yes, opens global search |
| **Tabs in Project Detail** | Horizontal scroll (Documents/Notes/Todos/Chat). Sticky under app bar. | Tab strip across the top, no scroll needed |
| **Confirmation dialogs** | Full-width bottom sheet | Centered modal |
| **Pull-to-refresh** | Yes, on every list view | n/a (use refresh button) |

### Touch + mobile hygiene

- **Touch targets:** minimum 44×44 px. Tag chips, icon buttons, list rows — all must clear this.
- **Native form controls** for date pickers (`<input type="date">`), file pickers — don't roll custom on mobile.
- **Sticky composer** on Chat tab — message input stays anchored above the on-screen keyboard.
- **Safe-area insets** (`env(safe-area-inset-bottom)`) for bottom tab bar on iOS notch devices.
- **No hover-only affordances.** If something is only visible on `:hover`, mobile users can't reach it. Replace with a tap-target or always-visible icon.
- **Status polling pauses** when `document.hidden === true` (Page Visibility API) so background tabs don't drain battery.
- **Hard-delete on mobile** requires typed-name confirmation (e.g. type the project name) — touch is too easy to misfire.

### Layout rules of thumb

- **Cards over tables** on mobile. Convert any table to a stacked card list at `<md`. On desktop, tables are fine.
- **Single column at <md, two columns at md, three at xl.** Don't try a 4-column dashboard.
- **Filters collapse to a "Filter" button** that opens a sheet on mobile. On desktop, filters are inline above the list.
- **Long content respects the viewport.** No horizontal scroll on the main page (only intentionally — e.g. tab strip, code blocks).

### Acceptance test for responsive

Open every view at:
- 360 × 800 (small Android phone)
- 390 × 844 (iPhone 14)
- 768 × 1024 (iPad portrait)
- 1440 × 900 (laptop)
- 1920 × 1080 (desktop)

No view should require horizontal scrolling. No primary action should be unreachable. The bottom tab bar must not overlap content (use `pb-` padding).

---

## Workflow gotchas

### Body editability
`type='note'` is always editable. `type='document'` is editable **only if `blob_url IS NULL`** (URL-ingested HTML, pasted markdown). For binary documents, edit-body returns 409 BODY_IMMUTABLE. Surface this in the UI: hide the edit button when `blob_url !== null`, show "Replace document" instead.

### Dedup feedback on URL save
`POST /content/from-url` may return `{deduped: true, id, ...}` if you've already saved that URL. Don't show an error — show "Already saved on <date>" and link to the existing item.

### Pending = optimistic UI
On every async-ingest action, **insert a placeholder row immediately** with the new `id` and a "processing" badge. Poll status. Avoid full-list refetches per tick.

### File upload size + MIME
Multipart `POST /content` accepts PDFs, audio, video, images. The server infers MIME from the upload Content-Type with a filename fallback. Show progress (XHR upload listener — `fetch` doesn't expose progress).

### `published_at` field
URL-ingested articles get `published_at` from metadata extraction. Surface it on document cards ("published 3 days ago") when present.

### Search hits have `retrieval_path`
Each search hit includes `retrieval_path: ('vector' | 'graph')[]` showing how it was found. Use this for a subtle indicator (e.g., a graph icon when the hit came from entity expansion).

### Error envelopes
4xx/5xx always: `{error: string}` and sometimes `{error, code: 'NOT_FOUND'|'IN_FLIGHT'|'BODY_IMMUTABLE'|'BAD_INPUT'|'ALREADY_READY'}`. Surface `code` when present — they map directly to user-friendly messages.

---

## Quality bar

- **No dead code.** If you stop using an endpoint, remove it from `lib/api.ts`.
- **Type-safe end to end.** Every API call returns a typed promise.
- **Loading + error states everywhere.** No silent loading spinners or unhandled rejections.
- **Optimistic where safe** (pin, archive, edit). Refetch on confirm.
- **Hash routing, not query params**, to match existing `App.tsx`.
- **No new heavy deps.** Date formatting? Use `Intl`. Markdown? Already have `react-markdown`. Icons? Inline SVG or a small icon set is fine — don't add a UI kit.
- **Mobile-first AND desktop. Both are P0.** Alex uses this on the phone *and* on the laptop. Every view must work fluidly at 360px wide and at 1440px wide. See the "Responsive design" section below — don't skip it.

---

## Acceptance criteria — when are you done?

A user can do all of the following without touching curl, **on both a phone and a laptop**:

1. Create a project, pin it, see it pinned on home
2. Drop a PDF into a project (mobile: tap-to-pick), see it processing, see it ready, click into it and read the content
3. Save a YouTube URL, watch the dedup case (save again → "already saved")
4. Write a note in markdown, edit it, see the chunks update (verified by a follow-up search hit)
5. Replace a PDF (upload v2), see v1 archived with a "→ v2" link
6. Bulk-tag five todos in one click (toggle into bulk mode with the Select button on mobile, hover-checkbox on desktop)
7. Filter todos by `parent_id`, by tag, by `due_before`, all working
8. Add a comment to a todo, see it persist
9. Rename a tag corpus-wide, see counts on every affected item update
10. Ask the chat a question, get back an answer with clickable citations (sticky composer above keyboard on mobile)
11. View the activity feed, filter by `kinds=ingest`
12. Hard-delete a project (with typed-name confirm on mobile) and watch all its content + todos cascade

**Plus the responsive bar:** every view above renders without horizontal scroll and without unreachable actions at:
- 360 × 800 (small Android)
- 390 × 844 (iPhone 14)
- 768 × 1024 (iPad portrait)
- 1440 × 900 (laptop)

When all 12 flows work end-to-end against the live API at all 4 breakpoints, you're done.

---

## Out of scope

- Multi-user / sharing / permissions
- Real-time collaboration
- File preview rendering for PDFs / audio / video — link to `blob_url` (or the SAS-signed `signed_url` field on the GET response) and let the browser handle it
- Custom domain / branding
- Native iOS/Android wrapper — PWA-friendly is the bar, no Capacitor/React Native shell

---

## Pointers when stuck

- **Authoritative API contract:** `backend/src/app.ts` route handlers
- **Live verification of any flow:** `scripts/live-e2e.sh` (run with `API_KEY=… ./scripts/live-e2e.sh`)
- **Architecture context:** `CLAUDE.md`
- **Whether the deployed code matches a fix:** `gh run list --limit 5` (CI + Deploy must both be green for the SHA you're testing)
