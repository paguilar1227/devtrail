# E2E Coverage Plan — Desktop ↔ Mobile Parity Audit

> Audit date: 2026-07-02 · App: Open Brain v2 web UI (Vite + React) · Runner: Playwright,
> projects `chromium-desktop` (1440×900) + `chromium-mobile` (Pixel 7), local stack
> (Postgres 5434 + Azurite + stub LLM), seeded via `scripts/seed-local.ts`.
>
> Status legend: ☐ planned · ✅ implemented & green · ⛔ excluded (justified)
>
> ⚠️ **Partially historical since the Home-tabs consolidation (2026-08).** Home's widget
> columns, the personal-* list drawers, and the widget cap were retired — Home now renders
> the shared `TodosPanel`/`NotesPanel`/`DocumentsPanel` under tabs (same components as the
> project tabs), and Enter in the Home search box asks the knowledge base (RAG). The
> standalone Todos view remains, as a shell over the same TodosPanel. Rows below that
> reference drawers / the widget cap describe surfaces that no longer exist; their flows
> were migrated onto the panel surfaces where still meaningful. The spec files under
> `tests/e2e/` are the source of truth for current coverage.

## 1. Baseline

Before this work: **110 desktop tests / 14 mobile tests** across 34 spec files.
Desktop covers Home (search DSL, tag filtering, personal todos, drawers), Notes view,
Documents previews, Todos view, Sidebar, Settings, Projects (create/pin/menu), Activity
(feed + click-through), Tags (listing only). Mobile covers only: widget cap, fullscreen
drawer, tabbar nav, More sheet (open/close/workspace/pinned), notes drill-down, todo row
reflow, settings.

**Structural gaps found in the audit** (no coverage on either device):
Trash/Archived view, Tag detail page, tag rename, Projects page filters/grid-list toggle,
the entire Project view tab set (Chat, Documents, Notes, Todos tabs), Command palette,
Activity page filter chips, theme keyboard shortcut, upload-modal on mobile, doc reader
on mobile.

**Parity gaps**: nearly everything desktop-only above; mobile lacked Home dashboard
workflows, notes/todos view workflows, activity, tags, trash, doc reader, upload.

## 2. Approach

- **Shared workflow modules** in `frontend/tests/e2e/shared/*.ts` export
  `define*Tests()` suites; thin spec files in `desktop/**` and `mobile/**` invoke them so
  one workflow definition runs under both Playwright projects (parity by construction).
- Navigation differences are absorbed by `helpers/nav.ts`:
  `gotoView()` (sidebar vs tabbar/More-sheet), `gotoProjectPage()`, `openSettings()`.
- Mobile-parity versions of *existing* desktop specs are added as mobile specs reusing the
  same shared flows; existing green desktop specs are left untouched.
- Fixtures: arranged over REST with `stamp()` (`e2e:` prefix) names; swept in `afterEach`.
  Assertions are presence/relative (never absolute counts of the shared seed).
- Flake policy: web-first assertions only, no `waitForTimeout`, unique fixtures per test,
  existing retry config unchanged. Every new spec must pass repeated runs (see §5).

## 3. Product gaps found during audit — RESOLVED in the intent-fix pass (2026-07-03)

The audit found these controls rendered but did nothing. The follow-up
intent-fix pass wired each one to do what its label promises (or removed it),
with an e2e regression per fix:

| Surface | Was | Now | Regression |
|---|---|---|---|
| Archived (Trash) view | Restore / Delete forever / Empty archive inert | Restore round-trips; Delete forever gated on typing the title (as the header copy promises); Empty archive purges after an explicit confirm | TRASH-4..6 |
| Tags page rows | ⋯ button inert | Replaced with a working **Delete** (corpus-wide strip, typed confirm) | TAGS-7 |
| Projects page list view | per-row ⋯ inert | Full action menu: Pin/Unpin · Edit · Archive/Restore · Delete (typed confirm) | PROJ-5 |
| Project Todos tab | All/Open/Overdue/Today/P1 chips display-only; Top/Sub pill + "Add details" dead | Chips filter for real (filtered views render flat so orphaned children stay visible); **Add details** creates from the draft and opens the detail drawer; the ambiguous Top/Sub pill and the false "Tab to nest" promise were removed | PTODO-4..5 |
| Project Notes tab | Pinned / Processing chips display-only | Chips filter the card grid, with per-filter empty states | PNOTE-3 |
| Chat citations | "Open source" dead | Opens the cited entity's surface (doc reader / note editor / todo drawer); the wire schema now carries the citation's entity `type` | PCHAT-4 |
| Documents tab bulk bar | "Tag" / "Move to project" dead | Inline tag input (Enter applies additively to the selection) and a project select (moves membership) | PDOC-5 |
| Documents tab rows | trailing ⋯ button dead | Removed (all real actions already have visible buttons) | — |
| Command palette | "Search…" only routed home; advertised "G then H/A/T" shortcuts didn't exist | Search… routes home AND focuses the search bar; G-H / G-A / G-T sequences implemented (suppressed while typing) | CMDK-5..6 |

**Deliberately left as-is:**

| Surface | Why |
|---|---|
| Mobile More sheet "Notifications" / "Help & shortcuts" | Placeholder rows for unbuilt views — the existing `test.fail` markers flip green the day they land |
| Doc row actions hidden on mobile | Design decision (`display:none` < 820px); mobile now has a working path via bulk-select → bulk bar (Pin / Reprocess / Archive / Tag / Move) |

## 3b. Real bugs found by the new tests (fixed)

| Bug | Found by | Fix |
|---|---|---|
| **Chat tab broken for every cited answer** — `ragQuery` emitted citations with `content_item_id`+`chunk_preview` but the wire contract (`RagCitationSchema`) requires `id`+`excerpt`; the frontend's Zod parse rejected the response, so the Chat tab rendered "Response failed validation" instead of the answer — in production too. | PCHAT-2 | `backend/src/services/rag.ts` — extracted `hitToCitation()` emitting the schema shape; pinned by `backend/tests/unit/services/rag-citation-schema.test.ts` |
| **The parked "~26 flaky specs" mystery** — `helpers/setup.ts` registered `beforeEach`/`afterEach` as a module side effect, but Playwright caches helper modules per worker, so the hooks only attached to the first spec file a worker loaded. Every later file ran its first test hook-less on `about:blank` (60s blank-page "flake"), passed on retry only because the failure forced a fresh worker. Verified with a module-eval probe; reproduced deterministically with `--retries=0`. | Blank-page triage during the shake-out run | `frontend/tests/e2e/helpers/setup.ts` now exports a `test` extended with a page fixture (setup + `e2e:` sweep in teardown); all specs import `test`/`expect` from it. Repro set went 3-deterministic-failures → 15/15 green in 29s. |

## 4. Test matrix

Device column: D = desktop only, M = mobile only, D+M = both (parity).
Every D-only or M-only entry carries a justification.

### 4.1 Archived / Trash view — `shared/trash.ts`

| ID | Case | Device | Status |
|---|---|---|---|
| TRASH-1 | Archived seed project listed; kind filter chips narrow rows; chip counts match rendered rows | D+M | ✅ |
| TRASH-2 | Soft-deleting a todo (API) surfaces it under the Todos filter with title + "Inbox" meta | D+M | ✅ |
| TRASH-3 | Archiving a note + doc (API) surfaces each under its kind filter | D+M | ✅ |

### 4.2 Tags & tag detail — `shared/tags.ts`

| ID | Case | Device | Status |
|---|---|---|---|
| TAGS-1 | Filter input narrows tag rows; no-match state renders | D+M | ✅ |
| TAGS-2 | Scope dropdown Personal→All changes the tag inventory (project tag appears) | D+M | ✅ |
| TAGS-3 | Tag row click routes to detail page; sections render; Back returns to catalog | D+M | ✅ |
| TAGS-4 | Detail scope toggle: project-only tag empty under Personal, populated under All | D+M | ✅ |
| TAGS-5 | Detail rows open the right surface: todo→drawer, note→editor modal | D+M | ✅ |
| TAGS-6 | Rename tag via modal updates the catalog row (old name gone, new present) | D+M | ✅ |

### 4.3 Projects page — `shared/projects-page.ts`

| ID | Case | Device | Status |
|---|---|---|---|
| PROJ-1 | Active/Archived/All chips: archived seed project only under Archived + All | D+M | ✅ |
| PROJ-2 | Grid ↔ List toggle swaps layout containers | D+M | ✅ |
| PROJ-3 | Card click (grid) and row click (list) both route to the project page | D+M | ✅ |
| PROJ-4 | Page "+ New project" button opens the create modal | D+M | ✅ |

### 4.4 Project view — hero + tabs — `shared/project-tabs.ts`, `shared/project-chat.ts`

| ID | Case | Device | Status |
|---|---|---|---|
| PTAB-1 | Four tabs render with counts; switching swaps the panel; stats strip matches counts | D+M | ✅ |
| PDOC-1 | Documents tab: type filter chips narrow (Files vs URLs vs Notes-as-doc) | D+M | ✅ |
| PDOC-2 | Pin from row action → Pinned filter shows it; unpin → Pinned filter empties | D (row actions hidden on mobile by design) | ✅ |
| PDOC-3 | Archive from row action removes the row and the doc appears in Archived view | D (row actions hidden on mobile by design) | ✅ |
| PDOC-4 | Bulk select shows bulk bar with count; Clear dismisses | D+M | ✅ |
| PNOTE-1 | Notes tab: create note via "New note" → card appears in grid | D+M | ✅ |
| PNOTE-2 | Notes tab: search flips grid→flat rows; clearing restores grid | D+M | ✅ |
| PTODO-1 | Todos tab: quick-add via Enter lands in Open; checkbox moves it to Done | D+M | ✅ |
| PTODO-2 | Hierarchy/Flat toggle: child indented under parent vs flattened | D+M | ✅ |
| PTODO-3 | Todos tab search filters to flat ranked rows; clearing restores groups | D+M | ✅ |
| PCHAT-1 | Chat empty state: suggestion chip fills the composer | D+M | ✅ |
| PCHAT-2 | Send question → user bubble + stub answer with expandable citations + timing foot | D+M | ✅ |
| PCHAT-3 | Depth pill flips active state and swaps the explainer copy | D+M | ✅ |
| PHERO-M-1 | Pin/Unpin round-trips from the hero (mobile parity of desktop `projects.spec`) | M | ✅ |
| PHERO-M-2 | ⋯ menu: edit → archive → restore → delete walkthrough (mobile parity of `project-menu.spec`) | M | ✅ |

### 4.5 Home — mobile parity — `mobile/home/*`

| ID | Case | Device | Status |
|---|---|---|---|
| HOME-M-1 | Structure renders: hero, search box, scope toggle, todos/notes/docs columns, activity | M | ✅ |
| HOME-M-2 | Scope toggle flips active tab | M | ✅ |
| HOME-M-3 | Pinned chip routes to the project page | M | ✅ |
| HOME-M-4 | Quick-add todo via Enter creates + shows row; checkbox marks done in backend | M | ✅ |
| HOME-M-5 | Todo detail drawer: status chip edit persists | M | ✅ |
| HOME-M-6 | Tag chip scopes results + URL updates + Clear restores dashboard | M | ✅ |
| HOME-M-7 | Activity widget row click opens the underlying entity | M | ✅ |
| HOME-M-8 | Activity widget filter updates in place (no full reload) | M | ✅ |
| HOME-M-9 | Free-text search returns hits; predicate chip (#tag) removable | M | ✅ |
| HOME-M-10 | Notes drawer: # tag typeahead + free-text hybrid search rows | M | ✅ |

### 4.6 Notes view — mobile parity additions — `mobile/notes/*`

| ID | Case | Device | Status |
|---|---|---|---|
| NOTES-M-1 | Tag filter narrows the list (parity of desktop notes-view) | M | ✅ |
| NOTES-M-2 | New note from a selected folder files it there (mobile drill-down flow) | M | ✅ |
| NOTES-M-3 | Pinned note shows the pin glyph in the list | M | ✅ |

### 4.7 Todos view — mobile parity additions — `mobile/todos/*`

| ID | Case | Device | Status |
|---|---|---|---|
| TODOS-M-1 | Sectioned list + Done group render | M | ✅ |
| TODOS-M-2 | Completing a todo moves it to Done, struck through | M | ✅ |
| TODOS-M-3 | Tag filter narrows to matching todos | M | ✅ |
| TODOS-M-4 | Add section reveals inline input; Enter creates empty section | M | ✅ |
| — | Drag-to-reorder / cross-section drag | ⛔ M | dnd-kit pointer-drag is desktop-interaction; covered on D |

### 4.8 Activity page — `shared/activity-page.ts`

| ID | Case | Device | Status |
|---|---|---|---|
| ACT-1 | Filter chips narrow the feed by kind (ingest/edit/comment) — new on desktop too | D+M | ✅ |
| ACT-2 | Feed renders; row click opens the entity (mobile parity of desktop spec) | D+M | ✅ |

### 4.9 Settings & theme — `shared/theme.ts`

| ID | Case | Device | Status |
|---|---|---|---|
| SET-1 | Theme choice persists across reload (localStorage) | D+M | ✅ |
| SET-2 | ⌘⇧L keyboard shortcut flips the theme | D | ✅ (keyboard-only surface) |

### 4.10 Command palette — `desktop/palette/*`

| ID | Case | Device | Status |
|---|---|---|---|
| CMDK-1 | Cmd/Ctrl+K opens; Esc closes; overlay click closes | D | ✅ |
| CMDK-2 | Typing a project name filters; clicking routes to the project | D | ✅ |
| CMDK-3 | Actions: toggle theme flips `data-theme`; "Create new project" opens modal | D | ✅ |
| CMDK-4 | Search ≥2 chars yields entity groups; todo hit opens TodoDetailDrawer | D | ✅ |
| — | Mobile palette | ⛔ M | no mobile entry point exists (Cmd+K only) |

### 4.11 Doc reader — mobile parity — `mobile/documents/*`

| ID | Case | Device | Status |
|---|---|---|---|
| DOC-M-1 | PDF doc: inline embed + Download (rscd) link in fullscreen drawer | M | ✅ |
| DOC-M-2 | Image doc: inline image → tap → lightbox → Esc closes | M | ✅ |
| DOC-M-3 | Project chip in reader navigates to the project view | M | ✅ |

### 4.12 Upload modal — mobile parity — `mobile/documents/upload.spec.ts`

| ID | Case | Device | Status |
|---|---|---|---|
| UP-M-1 | Project Add → modal opens; queue a URL; it stays queued | M | ✅ |
| UP-M-2 | Default-tags editor autocompletes existing project tags | M | ✅ |

### 4.13 More sheet — completeness — `mobile/more/*`

| ID | Case | Device | Status |
|---|---|---|---|
| MORE-M-1 | Todos row in the More sheet routes to the Todos view (missing from workspace-nav) | M | ✅ |

## 5. Verification protocol

1. Each new spec runs green in isolation on its device project before moving on.
2. Full suite (both projects) run after implementation; then **2 further full runs**
   (3 total) — a test that needs a retry in any run is treated as flaky and fixed or
   rewritten, not waved through.
3. Plan statuses updated as each spec lands (this file + HTML whiteboard regenerated).

## 6b. Results after the intent-fix pass (final — 2026-07-03)

- Suite: **236 tests (155 desktop / 81 mobile)** — the intent-fix regressions
  added 22 executions on top of the parity suite.
- **3 consecutive full-suite runs at `--retries=0`: 234 passed each time**
  (~8 min/run; the 2 non-passes are the justified mobile skips for the
  by-design-hidden doc row actions; the 2 `test.fail` placeholders count
  among the 234 as expected failures).

## 6. Results (parity pass — 2026-07-02)

- Suite grew from **124 tests (110 desktop / 14 mobile)** to **214 tests
  (143 desktop / 71 mobile)**: 60 planned cases, most defined once in a shared
  suite and executed under both device projects.
- **Stability: 3 consecutive full-suite runs with `--retries=0` — 212 passed,
  0 failed, 0 flaky, every time** (the other 2 are the justified mobile skips
  for the by-design-hidden doc row actions; the 2 pre-existing `test.fail`
  markers for the unimplemented Notifications/Help views count among the 212
  as expected failures). Each run: ~7.5 min.
- For scale: before the root-cause fixes a comparable run was 39 min with
  21 flaky + 13 failed. The suite is now roughly 5× faster wall-clock and
  deterministic without any retry budget.
- Two product bugs fixed along the way (§3b): RAG citation schema drift
  (Chat tab broken in prod) and the parked ~26-flaky Playwright hook-caching
  defect. One historical flake (drag-to-reorder) was made deterministic by
  gating on dnd-kit's activation signal (8/8 under `--repeat-each`).
