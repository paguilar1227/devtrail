# DevTrail — Frontend UI Test Plan

Comprehensive coverage outline for the React/Vite UI in `frontend/`. Each leaf is written as `Action => Expected outcome` and is intended to map 1:1 to a Playwright test once approved. The UI currently runs against `lib/mock.ts`; assertions about specific data values reference that fixture.

Conventions:
- "Desktop" = viewport ≥ 820px wide. "Mobile" = viewport < 820px.
- "Default route" = `home`.
- All routes are managed in component state, no URL changes.
- All persistence is `localStorage` (`devtrail.theme`, `devtrail.sidebarMode`).

Breakpoints exercised: **360 × 640** (small phone), **390 × 844** (iPhone), **768 × 1024** (tablet), **1024 × 768** (laptop landscape), **1440 × 900** (desktop).

---

## 1. App shell & global behavior

### 1.1 Boot
- Load `/` with no localStorage => Home page renders, `<html>` has `data-theme="dark"`, `data-sb` is set, sidebar shows brand "DevTrail 2.5"
- Load `/` with `devtrail.theme=light` => `<html data-theme="light">` and Topbar sun button has `.active`
- Load `/` with `devtrail.theme=dark` => `<html data-theme="dark">` and Topbar moon button has `.active`
- Load `/` with `devtrail.sidebarMode=expanded` => sidebar wide, labels visible
- Load `/` with `devtrail.sidebarMode=collapsed` => sidebar narrow, only icons visible
- Load `/` with `devtrail.sidebarMode=hidden` (and desktop) => `data-sb="hidden"`, sidebar not rendered
- Load `/` with bogus `devtrail.theme=banana` => falls back to `dark`
- Load `/` with bogus `devtrail.sidebarMode=foo` => falls back to `collapsed`
- No console errors on cold load => `console.error` count is 0

### 1.2 Theme toggle
- Click Topbar moon button while in light theme => `data-theme="dark"`, `localStorage.ob.theme="dark"`, moon button has `.active`
- Click Topbar sun button while in dark theme => `data-theme="light"`, `localStorage.ob.theme="light"`, sun button has `.active`
- Press `Cmd/Ctrl+Shift+L` from any route => theme toggles between dark and light
- Press `Cmd/Ctrl+Shift+L` repeatedly => theme alternates on every press
- Reload after toggling to light => still `data-theme="light"`
- Light theme => background gradient + foreground colors visibly lighter than dark (computed style assertion: `--bg` token differs between themes)

### 1.3 Sidebar (desktop)
- Default state collapsed => `aside.sidebar` rendered, `<html data-sb="collapsed">`, only icons visible
- Click collapse-toggle (chevron) => transitions to expanded, labels visible, `data-sb="expanded"`, persisted to localStorage
- Click collapse-toggle again => back to collapsed, persisted
- Sidebar Home item active when on home => `.sb-item[data-active=true]` matches Home
- Click "Projects" => route changes, `.sb-item` for Projects gets `.active`
- Click "Inbox" => route changes, count badge "4" visible
- Click "Activity" => Activity page renders
- Click "Tags" => Tags page renders
- Click "Mentions" => Mentions page renders
- Click "Archived" => Trash page renders
- Click a pinned project (e.g. ClaudePit) => Project detail renders, sidebar item active
- Click "New project" dim row => navigates to Projects route AND new-project modal opens
- Sidebar shows all active projects under "All Projects" + pinned under "Pinned" => exact split matches PROJECTS fixture
- Archived project (`mcp-e2e-v2`) does NOT appear in sidebar lists => assert by name not present
- Footer shows avatar "P" and email `you@example.com` => exact text match

### 1.4 Topbar
- Crumbs on Home => single crumb "Home"
- Crumbs on Projects => single crumb "Projects"
- Crumbs on Project detail => two crumbs `Projects › <project name>`, first crumb has `.ctx` and is clickable
- Click first crumb on project detail => returns to Projects list
- Crumbs on Inbox/Activity/Tags/Mentions/Trash/Search => single crumb of that name
- Click search input in topbar => command palette opens
- Mobile-only `.icon-search` button hidden at desktop => `display:none` via media query
- Theme toggle pair always visible
- Active theme button has `.active` class

### 1.5 Mobile tabbar (< 820px)
- Resize to 390px => `data-mobile="true"` on app root, sidebar removed, `nav.mobile-tabbar.show` rendered
- Tabbar shows 4 items: Home / Projects / Inbox / More => exact label match
- Click Home tab while on Inbox => navigates home, Home tab has `.active`
- Click Projects tab => navigates to projects
- Click Inbox tab => navigates to inbox
- Click More tab => `.m-sheet` slides up, `.m-sheet-overlay` rendered
- More sheet contains Activity / Tags / Mentions / Archived rows => clicking each navigates and closes the sheet
- More sheet shows pinned projects with names + count => count = `docs + notes`
- More sheet shows zero-state when no pinned projects exist => `.m-sheet-empty` text "No pinned projects yet."
- More sheet user row shows "Alex" + email => exact text
- More sheet appearance row toggles theme => clicking flips `data-theme` and the icon swaps Sun↔Moon
- Click overlay => sheet closes
- Click X button in sheet header => closes
- Resize back to 1440px while More open => sheet hidden, sidebar back, no orphan overlay

### 1.6 Keyboard shortcuts
- Press `Cmd+K` => command palette opens
- Press `Cmd+K` while palette open => palette closes
- Press `Ctrl+K` (Linux/Win path) => palette opens
- Press `Esc` while modal open => modal closes (any of the 7)
- Press `Esc` while drawer open => drawer closes
- Press `Esc` while command palette open => palette closes
- Press `Esc` while no overlay => no error, app still interactive
- Type 'k' in a text input => does NOT trigger command palette (input has focus, default not prevented inappropriately)
- Press `Cmd+Shift+L` while typing in textarea => still triggers theme toggle (current behavior; document)

### 1.7 Persistence
- Toggle theme then reload => theme retained
- Toggle sidebar then reload => sidebar mode retained
- Set theme via shortcut then read `localStorage.ob.theme` => matches new value

### 1.8 Backdrop / chrome
- `.backdrop` and `.grain` divs rendered once => present in DOM once
- Backdrop blobs animate (CSS animation present) => `.backdrop .blob` has computed `animation-name` non-empty

---

## 2. Home page

### 2.1 Header
- "Welcome back, Alex." heading visible => `<h1>` text exact
- Subtitle includes "1 document processing", "4 todos", "2 active projects pinned" => substrings present (matching mock STATS)
- "New project" button visible
- Click New project => new-project modal opens

### 2.2 Stats cards
- 4 stat cards rendered => `.stat-card` count = 4
- Projects card shows value `5` and "+1 this week" => exact text
- Documents card shows `50` and "+6 this week · 1 pending" => exact text
- Notes card shows `46` and "+3 this week"
- Todos card shows `23/48` and "48% complete" => percentage rounded from mock
- Each card has a sparkline svg => `.stat-card .spark svg` present 4×

### 2.3 Pinned projects section
- Section heading "Pinned projects" visible
- Renders only projects with `pinned=true` => 2 cards (ClaudePit, Copilot CLI App)
- "All projects →" button => clicking navigates to projects route
- Click ClaudePit card => navigates to project detail with id `claudepit`
- Each card shows accent dot, status badge, doc/note/done counts, last-edit relative time

### 2.4 Inbox preview
- Heading "Inbox · todos with no project" visible
- Shows up to 4 inbox todos => row count ≤ 4 from `INBOX_TODOS`
- Overdue todos have `.due-overdue` class on due-at chip
- Future-due todos do NOT have `.due-overdue`
- Priority pill colored per `p1`/`p2`/`p3` (computed background differs)
- Click "Open inbox →" => navigates to inbox route

### 2.5 Activity preview
- Heading "Recent activity" visible
- Shows up to 6 events => row count ≤ 6 from `ACTIVITY`
- Each row icon matches kind: ingest=Upload, edit=Note, comment=Chat
- Click "Full feed →" => navigates to activity route

### 2.6 Responsive Home
- At 360px => stats stack vertically (single column)
- At 768px => stats fit in 2 columns or per CSS grid spec
- At 1440px => stats in 4 columns
- Bottom grid (Inbox/Activity) stacks at narrow widths

---

## 3. Projects page

### 3.1 Header
- Heading "Projects" visible
- Subtitle text shown
- New project button => modal opens

### 3.2 Filter bar
- Three chips: Active / Archived / All
- Active count = 5, Archived count = 1 (from mock)
- Default filter = Active => only `status=active` rendered (5 cards)
- Click Archived => only archived (1 card: MCP E2E Test v2)
- Click All => 6 cards
- Active chip has `.active` class only when selected

### 3.3 View toggle
- Default view = grid => `.proj-grid` rendered
- Click List => `.row-list` rendered, `.proj-grid` removed
- Click Grid => back to grid
- Toggle does not change filter

### 3.4 Grid view
- First two cards have `.size-lg`, others `.size-md`
- Click any card => navigates to project detail with that id
- Pinned card shows pin icon top-right

### 3.5 List view
- Each row has accent dot, name, description (truncated), counts, last-edit
- Click row body => navigates
- Click `.btn-icon` (more) => does NOT navigate (event.stopPropagation)

### 3.6 Empty state (defensive)
- If filter yields no results => list/grid is empty (no error). (Mock data prevents this; document expectation.)

---

## 4. Project detail page

### 4.1 Header
- Accent dot rendered with class matching project accent
- "Active project · created Nm ago" subtitle present
- Pinned tag visible only when `project.pinned=true`
- `<h1>` shows project name exactly
- Description visible
- Pin button label flips between "Pin" and "Unpin" based on state
- More button (icon) visible
- "Add" button (primary) => upload modal opens with that project as payload

### 4.2 Tabs
- 4 tabs: Chat / Documents / Notes / Todos
- Default active tab = Chat
- Counts: docs/notes/todos pulled from project.counts; Chat shows static "8"
- Click each tab => active class moves, content swaps
- Stats strip shows docs/notes/done counts and last-edit relative time

### 4.3 Chat tab
- Seed assistant message rendered with citations and timing footer
- Composer textarea is empty initially
- Type "test" + Enter => message appended (role=user), draft cleared
- Pending state shows three-dot loader (`.dots`)
- After ~1.2s => mocked assistant message added with citations
- Press Shift+Enter in composer => newline inserted, message NOT sent
- Press Enter alone with empty draft => no message added (guarded by `.trim()`)
- Send button disabled when draft is empty
- Send button enabled once draft has non-whitespace
- Click depth pill "Shallow" => active class flips to Shallow
- Click depth pill "Balanced"/"Deep" => same
- Click first citation => expands chunk
- Click expanded citation again => collapses
- Multiple citations expand independently
- Footer shows "scope: <project>", retrieval/chunks meta, "⌘↵ to send" hint
- Sending scrolls chat to bottom (smooth scroll; verify scrollHeight ~= scrollTop+clientHeight after send)

### 4.4 Documents tab
- Filter chips: All / Pinned / Processing / Failed
- Counts on each chip match the mock data subset
- Type chips: Any type / Files / URLs / Notes-as-doc
- Default filter = All, type = Any type => all 6 docs shown
- Click "Pinned" => only pinned doc(s) shown
- Click "Processing" => only `processing_status=pending` (1 doc)
- Click "Failed" => only failed (1 doc, shows error message)
- Click type "Files" => only `type=binary`
- Type "URLs" => only `type=url`
- Type "Notes-as-doc" => only `type=note-as-doc`
- Filters compose => "Pinned + Files" yields ⊆ both
- Bulk top checkbox toggles select-all => all visible doc rows become selected
- Bulk top checkbox while all selected => deselects all
- Click individual bulk-checkbox => selects only that row
- Status pill matches doc state: Pending dot pulses, Failed shows error tooltip on hover (title attr)
- Failed doc shows "Retry" button + processing_error string
- Click ready doc body => DocReader drawer opens with that doc
- Click pending doc body => no drawer (guarded)
- Click "Add document" => upload modal opens
- Selecting any docs => bulk bar appears with action buttons
- Click bulk Archive => bulk-confirm modal opens with `count` and `kind=documents`
- Click "Clear" in bulk bar => selection cleared, bulk bar disappears
- Multi-project doc shows "+N project" tag
- File hash shown when present, hidden when null

### 4.5 Notes tab
- Notes grid renders => `.note-card` count matches NOTES[projectId]
- Each card: title, stripped body preview, tags (max 3), status, updated_at
- Body preview strips markdown headers and asterisks
- Pinned note shows Pin icon
- Status pill matches `processing_status`
- Click note card => note-edit modal opens with that note
- Click "New note" => note-edit modal opens with `note=null`
- Filter chips: All / Pinned / Processing => visible (interaction is decorative for now; document)

### 4.6 Todos tab
- Quick capture row visible with project name in placeholder
- Filter chips: All / Open / Overdue / Today / P1
- Hierarchy/Flat segmented toggle, default Hierarchy
- Open group expanded by default with count
- Done group expanded by default with count
- Hierarchy mode => parent renders before children, children indented (margin-left = depth × 24)
- Max depth = 4 levels (depth 0..3); deeper children render flat at depth 3
- Disclosure chevron only on todos with children
- Click chevron => collapses (children hidden), chevron rotates -90deg
- Click chevron again => expands
- Flat mode => all todos rendered without indentation, parent_id ignored visually
- Done todos have `.done` class (line-through style)
- Overdue not-done todo => `.due-overdue` class
- Future-due not-done todo => `.due-soon` class (or absence of overdue)
- Done todo's due-at => not styled overdue regardless of date
- Tags visible on todo
- Comments count badge visible only when `> 0`
- Click bulk slot (when nothing selected) => selects that todo, bulk bar appears
- Click another => adds to selection, count increments
- Bulk bar action buttons present: Set priority / Set due date / Tag / Move / Mark done / Archive / Clear
- Clear button => selection emptied
- Click todo body or More => todo-detail drawer opens with that todo
- Priority pill shows P1/P2/P3 with color

---

## 5. Inbox page

### 5.1 Header
- Heading "Inbox" visible
- Subtitle text present

### 5.2 Quick capture
- Input with placeholder "Quick capture — press Enter to save"
- "Add details" button visible

### 5.3 Filter bar
- Chips: All (count), Open, Overdue (2), Today, This week
- All chip has `.active` by default (current implementation; tests don't assert real filtering since chips are decorative for now — document this)

### 5.4 Todo list
- Renders 4 inbox todos (mock)
- Each row: bulk checkbox, status checkbox, title, due chip (overdue styled when applicable), tags, "created Nd ago", priority pill, status pill, more button
- Status checkbox reflects `done` vs `not_started`/`in_progress`
- Click bulk checkbox => row selected, bulk bar appears, count increments
- Click another => count = 2
- Click again on selected => deselects
- Click selected row's body => row keeps `.selected` class
- Bulk bar actions: Move / Tag / Set priority / Mark done / Archive / Clear
- Click "Clear" => selection cleared
- Click More => todo-detail drawer for that todo

---

## 6. Activity page

### 6.1 Header
- Heading "Activity" visible, page-narrow layout

### 6.2 Filter bar
- Chips: All (count), Ingests, Edits, Comments
- All chip active by default
- Click Ingests => only `kind=ingest` rows
- Click Edits => only `kind=edit`
- Click Comments => only `kind=comment`
- Click All => all rows back

### 6.3 Grouping
- Day groups in this order: Today / Yesterday / This week / Earlier
- Activity ms < 86400 => Today
- 86400..172800 => Yesterday
- 172800..604800 => This week
- ≥604800 => Earlier
- Empty groups omitted entirely

### 6.4 Rows
- Icon by kind: ingest=Upload, edit=Note, comment=Chat
- Verb prefix by kind: "Ingested " / "Edited " / "Commented on "
- Title bolded
- Subtle line shows `entity_kind · project`
- Right-aligned timestamp shows relative time

---

## 7. Tags page

### 7.1 Header
- Heading "Tags" visible
- Subtitle includes total tag count
- "New tag" button visible

### 7.2 Search input
- Placeholder "Filter tags…"
- Type "auth" => only tag rows whose name includes "auth"
- Empty input => all 10 tags shown
- Case-insensitive match: "AUTH" returns same as "auth"

### 7.3 Tag rows
- Each row: glyph "#", name (mono), totals counts: total / docs / notes / todos
- Counts match mock TAGS values
- Click "Rename" => confirm-rename modal opens with `name` and `total` payload
- Click row More icon => no-op for now (decorative; document)

---

## 8. Mentions page

### 8.1 Header
- Heading "Find Mentions" visible (page-narrow)
- Search input pre-populated with "subscription cookies"

### 8.2 Filter bar
- Chips: All mentions / In notes / In documents / In todos / In chats
- All chip `.active` by default

### 8.3 Hits list
- Renders first 4 SEARCH_HITS from mock => 4 `.doc-row` rows
- Each row icon by entity_kind
- Title and project shown, kind tag present
- Excerpt rendered with `<em>` highlighting from html
- Retrieval-path tags rendered (vector/graph/fts)
- Score formatted to 2 decimals
- "Open" button visible (no behavior wired)

---

## 9. Search page

### 9.1 Header
- Heading "Search" + subtitle
- (Currently reachable only via direct route navigation; no nav item in shell)

### 9.2 Search field
- Pre-filled "subscription cookies"
- Typing updates the input value
- Search button visible (no behavior wired)

### 9.3 Filter bar
- Scope chips: All projects / ClaudePit
- Retrieval method chips on right: vector (active), graph (active), fts (inactive)
- Click ClaudePit => `.active` toggles to ClaudePit, removed from All projects

### 9.4 Results
- Stats line "<n> results · 184ms"
- All 5 SEARCH_HITS rendered
- Same row structure as Mentions

---

## 10. Trash page

### 10.1 Header
- Heading "Archived"
- Subtitle text
- "Empty archive" danger button visible

### 10.2 Filter bar
- Chips: All (count) / Projects (1) / Documents / Notes / Todos
- All chip `.active` by default

### 10.3 Items list
- 4 items rendered (project / document / note / todo)
- Each row: icon by kind, title, subtle line ("kind · sub · archived Xd ago")
- Restore button visible per row
- Delete forever button visible per row, danger-styled

---

## 11. Modals & drawers

### 11.1 UploadModal
- Title "Add to <project name>" or "Add to Inbox" when project=null
- Dropzone visible with copy "Drop files here, or click to browse"
- Allowed types line visible
- Save URL row with input and Fetch button
- Default tags: "research", "auth" both removable
- Click X on a removable tag => tag removed from chips
- Currently uploading list with 2 mock files
- Uploading file shows progress bar at 64%
- Queued file shows "queued" text
- Footer: Close button closes modal, Process all (no behavior wired)
- Esc closes modal
- Click on overlay outside modal box => closes
- Click inside modal box => stays open

### 11.2 NoteEditorModal — new note (note=null)
- Title "New note"
- Title input prefilled "Untitled note"
- Body prefilled "# New note\n\nStart writing…"
- Tags row empty
- Status pill = ready (default)
- Word count in footer = 4 ("draft")
- Markdown preview right column renders h1 from "# New note" line
- Type in body => preview updates live
- Click "Add tag" => no-op (no behavior wired; document)
- Cancel/Save buttons close (Save is no-op)

### 11.3 NoteEditorModal — edit note
- Title "Edit note"
- Title input matches note.title
- Body input matches note.body
- Tags chips for note.tags, each removable
- Click X on a tag chip => removed from chips local state
- Footer shows "last edit Nm ago · N words"
- Markdown preview reflects body
- Cancel closes; Save closes (no persistence)
- Esc closes

### 11.4 DocReaderDrawer
- Drawer slides in from right
- Header shows doc.title
- Status pill, type tag, size, doc.tags chips visible
- Metadata grid shows: created, sha256 (when present), source (when present), projects (resolved to names from PROJECTS)
- "Open original" anchor uses `source_url` when present, else `#`
- Action buttons: Replace / Edit tags / Pin (or Unpin if pinned)
- Pin button label flips based on `doc.pinned`
- Extracted-text section visible
- Backlinks section shows EntityLinks
- Esc closes
- X in header closes

### 11.5 TodoDetailDrawer
- Header shows todo.title
- Priority pill, status pill, tags chips at top
- Priority chips P1/P2/P3 with active matching todo.priority
- Due / created / project / parent rows display correctly
- When `parent_id=null` => parent row shows "—"
- When `due_at=null` => due row shows "—"
- Description textarea has default content
- Subtasks section: 1 done (line-through), 2 not done
- "Add subtask" button visible
- Comments section count matches `COMMENTS[todo.id]?.length` (or 0)
- Each comment: meta with "alex · time" + body
- Add-comment input + send icon visible
- Footer: Close + Save buttons
- Esc closes

### 11.6 ConfirmModal — bulk-confirm
- Title "Archive N <kind>?" with correct count and noun
- Message text mentions "moved to the Archive"
- Confirm label = "Archive" (danger style)
- Cancel button always enabled
- Confirm button always enabled (no `requireType`)
- Click Confirm => modal closes
- Click Cancel => modal closes, no action
- Esc closes

### 11.7 ConfirmModal — confirm-rename (tag)
- Title "Rename tag"
- Message includes tag name in quotes and "X entities"
- Confirm label "Rename" (primary, not danger)
- "Type <tag>" input visible, autofocused
- Confirm button disabled while input ≠ tag name
- Type wrong text => still disabled
- Type exact tag name => button enabled
- Click Cancel => closes
- Click Confirm (when enabled) => closes
- Esc closes

### 11.8 NewProjectModal
- Title "New project"
- Name input autofocused
- Description textarea (3 rows)
- 5 accent dots: violet, magenta, indigo, cyan, neutral
- Cancel and Create buttons
- Esc closes
- Currently no validation (document)

### 11.9 Modal generic behavior
- Only one modal can be open at a time (mutually exclusive state)
- Opening a modal does not affect route
- Closing a modal restores focus to trigger? (currently not enforced; document expectation as known gap)

---

## 12. Command palette (Cmd-K)

### 12.1 Open / close
- Cmd-K opens => `.cmdk-overlay` visible
- Cmd-K while open => closes
- Click search field in topbar => opens
- Click overlay (outside palette) => closes
- Click inside palette content => stays open
- Esc closes
- Press Enter while empty => no error (no row selected)

### 12.2 Initial state
- Search input autofocused
- Groups visible: Projects (5 from active), Documents (4 from claudepit), Notes (4 from claudepit), Actions (6)
- "184ms · 32 results" footer text

### 12.3 Filtering
- Type "claudepit" => only items whose title or sub matches
- Type "subscription" => Auth strategy note appears in Notes group, others filtered
- Type "go-tags" or "tags" => "Go to Tags" action appears
- Type giberish "zzzqq" => groups disappear (filt(items) = [])
- Empty input => groups restored
- Filter is case-insensitive

### 12.4 Click actions
- Click a project row => navigates to that project, palette closes
- Click "Go to Inbox" => navigates to inbox, palette closes
- Click "Go to Tags" => navigates to tags, palette closes
- Click "Toggle theme" => palette closes (no-op for theme; documented)
- Click document/note rows => palette closes (no-op; documented)

### 12.5 Highlights
- First row of first group has `.active` class on initial render
- Footer shows kbd hints "↑↓ navigate", "↵ open", "⌘↵ open in new pane"

---

## 13. Cross-cutting / responsive matrix

For each viewport (360, 390, 768, 1024, 1440):

### 13.1 Layout integrity
- Visit Home => no horizontal scrollbar at any width (ignore if explicitly designed otherwise)
- Visit Project detail Chat => composer pinned to bottom and visible (not clipped)
- Visit Project detail Documents => filter bar wraps appropriately, no row overflow
- Visit Project detail Todos at 360 => hierarchy indents survive narrow widths
- Visit any modal at 360 => modal fits within viewport (margin maintained)
- Visit Drawer (DocReader/TodoDetail) at 390 => drawer is full-width or near-full
- Visit Tags at 360 => tag rows wrap or scroll horizontally without breaking
- Visit Activity at 1440 => `.page-narrow` width capped (computed max-width applied)

### 13.2 Mobile-only chrome
- At < 820 => sidebar absent, mobile tabbar present
- At ≥ 820 => mobile tabbar absent, sidebar present (per sidebar mode)
- At 820 exactly => not mobile (use `<` 820)

### 13.3 Topbar
- At < 820 => topbar shows mobile search icon button, hides large search input field
- At ≥ 820 => mobile search icon hidden, full search input visible

---

## 14. Theming & data attributes

### 14.1 Root attributes
- After mount => `<html>` has `data-theme` and `<div.app>` has `data-sb`
- Mobile mode => `<div.app>` has `data-mobile="true"`
- Desktop mode => `<div.app>` has no `data-mobile` attribute

### 14.2 Token application
- `data-theme="dark"` => `getComputedStyle(html).getPropertyValue('--bg')` matches dark token
- `data-theme="light"` => light token
- Switching theme updates within same render tick (no flicker)

---

## 15. Mock data integrity

### 15.1 Counts
- Sidebar Projects count = 5 (active)
- Stats Projects = 5 (mock STATS — fixture-driven)
- Pinned project count = 2
- Inbox preview count = 4 (≤ 4)

### 15.2 Cross-references
- Activity row's `project` matches a name in PROJECTS (or special string)
- Search hit `project` matches a name in PROJECTS
- Document `project_ids` are resolvable to PROJECTS (DocReader Tag list)
- Todo `parent_id` resolves to a sibling todo in TODOS[projectId]
- Comments `todo_id` resolves to a todo in TODOS[claudepit]

---

## 16. Accessibility (best-effort, runtime)

### 16.1 Roles
- Modal has `role=dialog` and `aria-modal=true`
- Tabs have `role=tablist` and tab buttons have `role=tab`
- Drawer (DocReader/Todo) — currently lacks role; document as known gap
- Mobile sheet has `role=dialog` and `aria-label="More"`

### 16.2 Focus
- Open NewProject modal => Name input focused
- Open NoteEditor modal => either title or body focusable; (not auto-focused — document)
- Open command palette => search input focused
- Open ConfirmModal with requireType => Type input focused

### 16.3 Keyboard
- Tab order in modals enters and exits buttons in document order
- Esc closes all overlays consistently
- Enter on Send button submits chat
- Enter alone in chat textarea sends; Shift+Enter newlines

---

## 17. Performance smoke

### 17.1 First paint
- Cold load Home => DOM contentful within 2s on dev server
- Subsequent route change => no full page reload (route change is in-memory)
- Production bundle size ceiling => CSS ≤ 60 KB gzipped, JS ≤ 80 KB gzipped (current: 9 KB / 67 KB)

### 17.2 Animations
- Pending status dot pulse animation runs (animation iteration count ≠ 0)
- Backdrop blob animation runs

---

## 18. Known no-ops (assert no error, document only)

These actions intentionally have no behavior wired in the mock-only build. Tests assert "click does not throw" and the UI stays usable.

- DocReader: Replace / Edit tags / Pin
- TodoDetail: Save / priority chips / Add subtask / send comment
- NoteEditor: Save / Add tag / + Link
- Upload: Process all / Fetch / + Add tag
- Search button on Search page
- "Open" buttons in Mentions and Search hit rows
- More dot icons on Projects list, Tag rows, doc rows
- Empty archive button on Trash
- Restore / Delete forever buttons on Trash rows

---

## 19. Regression triggers

These cases caused real bugs during build-out and are worth keeping forever.

- Sidebar collapse toggle persists across reload => localStorage `devtrail.sidebarMode`
- Cmd-Shift-L works regardless of focus location
- Mobile sheet does not stay open after viewport resize beyond 820
- Hierarchy todos render the correct number of children (parent + descendants), no orphans
- Replacing modal state (open A then open B) does not stack overlays
- Project detail's "Add" button passes the project as the upload payload (modal title shows project name, not "Inbox")
- Filtering documents by Pinned + Files yields the correct intersection (composed filters)
- Theme attribute applies BEFORE first paint via initial state hook (no FOUC)
