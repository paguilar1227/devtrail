// Home — personal-scope landing page. Absorbs what used to be the Inbox
// (project-less todos), adds project-less notes alongside it, and exposes
// search at the top with a Personal/All-projects scope toggle.
//
// Layout (top to bottom):
//   1. Hero      — greeting + New project button.
//   2. Search    — input + scope toggle. Enter routes to /search?q=… so
//                  the existing Search route owns rendering of results.
//   3. Personal  — three columns: Todos | Notes | Documents. Functional
//                  stuff up top so it's reachable without scrolling past
//                  status cards. Each column has its own quick-add (todos
//                  and notes only — documents go through upload/from-url).
//   4. Top row   — Overview counts + Recent activity preview. Status
//                  surfaces, less actionable than the columns above.
//   5. Pinned    — chip strip linking to pinned projects.
//
// "Personal" means project_ids = [] (content) / project_id = null (todo).
// All three columns hit the backend with `project_id='null'`.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityRow } from '../components/ActivityRow';
import { Icons } from '../components/Icons';
import { NoteRow } from '../components/NoteRow';
import { DocRow } from '../components/DocRow';
import { SortableTodoList } from '../components/SortableTodoList';
import { sortPersonalTodos } from '../lib/todoSort';
import { useTodoSortMode } from '../lib/useTodoSortMode';
import { useNoteSortMode, compareNotesForMode } from '../lib/useNoteSortMode';
import { NoteSortDropdown, SortDropdown, TodoSortDropdown } from '../components/SortDropdown';
import { PersonalColumnHeader } from '../components/PersonalColumnHeader';
import { FilterEmpty, HomeTagFilter } from '../components/HomeTagFilter';
import {
  EMPTY_FILTER,
  matchesTagFilter,
  parseTagFilter,
  serializeTagFilter,
  type TagFilter,
} from '../lib/tagFilter';
import {
  parseSearchSyntax,
  removeTagFromQuery,
  removeTypeFromQuery,
  removeMentionFromQuery,
  removeProjectFromQuery,
  removeExcludedFromQuery,
  toggleTagInQuery,
} from '../lib/searchSyntax';
import { SearchInput, type MentionTarget, type ProjectSuggestion } from '../components/SearchInput';
import { SearchResultsList } from '../components/SearchResultsList';
import { FilterChip } from '../components/primitives';
import { search } from '../lib/api';
import { toUiSearchHit } from '../lib/view';
import { useDebounced } from '../lib/useDebounced';

// Activity widget filter — maps to the backend `kinds` query param.
// 'all' is the unfiltered passthrough; the other three match the
// ActivityKind enum from shared/schemas.
type ActivityFilter = 'all' | 'ingest' | 'edit' | 'comment';
const ACTIVITY_FILTER_MODES: readonly ActivityFilter[] = ['all', 'ingest', 'edit', 'comment'];
const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: 'All',
  ingest: 'Ingestion',
  edit: 'Updates',
  comment: 'Comments',
};
import { useTodoExpansion } from '../lib/useTodoExpansion';
import {
  createNote,
  createTodo,
  getContent,
  listActivity,
  listContent,
  listProjectCounts,
  listProjects,
  listTags,
  listTodos,
  getStats,
  updateTodo,
} from '../lib/api';
import { toUiActivity, toUiDocument, toUiNote, toUiProjects, toUiTodo } from '../lib/view';
import { openActivityTarget } from '../lib/openActivity';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { ActionDispatch, Route, Todo } from '../types';

interface Props {
  onRoute: (r: Route) => void;
  onAction: ActionDispatch;
  /** Cross-page search seed — set when arriving at home via
   *  onRoute({ route: 'home', q, scope }) from another page (ProjectPage
   *  search submit, command palette, etc). HomePage consumes it on
   *  mount as the initial query/scope; the URL itself is the
   *  persistent source of truth thereafter. */
  initialSearch?: { query?: string; scope?: 'personal' | 'all' | string };
}

// Scope chip values: 'personal' = no project (Inbox), 'all' = global,
// any other string = project UUID. Matches the SearchRequest project_id
// trinary on the wire ('null' for personal, UUID for project, omit for all).
type SearchScope = 'personal' | 'all' | string;

export function HomePage({ onRoute, onAction, initialSearch }: Props) {
  const qc = useQueryClient();
  // Filter the Activity widget by kind. 'all' is the passthrough.
  // Keyed in the query cache so React Query refetches on flip.
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');

  // Tag filter — URL-backed (?tag=foo,bar&mode=and). Synchronous init from
  // location.search so the first paint reflects the URL with no flicker.
  // Write via replaceState only — this is view state, not navigation.
  const [tagFilter, setTagFilterState] = useState<TagFilter>(() =>
    typeof window === 'undefined'
      ? EMPTY_FILTER
      : parseTagFilter(new URLSearchParams(window.location.search)),
  );
  // setTagFilter is the public mutator. Tag-array changes route THROUGH
  // the universal search query (so the search input and chip row stay
  // bidirectionally in sync); mode-only changes apply directly. The
  // useEffect below mirrors parsed query tags back into tagFilter, so
  // both directions converge on the same source of truth without loops.
  const setTagFilter = (next: TagFilter) => {
    const tagsChanged =
      next.tags.length !== tagFilter.tags.length ||
      next.tags.some((t, i) => t !== tagFilter.tags[i]);
    if (tagsChanged) {
      // Diff against current; apply add/remove via toggleTagInQuery so
      // free text + in: predicates already in the query are preserved.
      let q = query;
      const current = new Set(tagFilter.tags);
      const desired = new Set(next.tags);
      for (const t of next.tags) if (!current.has(t)) q = toggleTagInQuery(q, t);
      for (const t of tagFilter.tags) if (!desired.has(t)) q = toggleTagInQuery(q, t);
      setQuery(q);
    }
    // Mode (AND/OR) isn't part of the search DSL — apply directly so the
    // query → tagFilter effect doesn't clobber it.
    if (next.mode !== tagFilter.mode) {
      setTagFilterState((prev) => ({ ...prev, mode: next.mode }));
    }
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const out = serializeTagFilter(next);
    const tagValue = out.get('tag') ?? '';
    if (tagValue.length > 0) url.searchParams.set('tag', tagValue);
    else url.searchParams.delete('tag');
    const modeValue = out.get('mode') ?? '';
    if (modeValue.length > 0) url.searchParams.set('mode', modeValue);
    else url.searchParams.delete('mode');
    window.history.replaceState(null, '', url.toString());
  };

  const queries = useQueries({
    queries: [
      { queryKey: ['stats'], queryFn: () => getStats() },
      { queryKey: ['projects', 'all'], queryFn: () => listProjects() },
      { queryKey: ['project-counts'], queryFn: () => listProjectCounts() },
      { queryKey: ['todos', 'inbox'], queryFn: () => listTodos({ project_id: 'null' }) },
      // Backend filter: project_id='null' = rows with no project
      // membership. Server-side keeps Home fast as the corpus grows
      // instead of relying on a client-side filter over every note.
      { queryKey: ['content', 'notes', 'personal'], queryFn: () => listContent({ type: 'note', project_id: 'null' }) },
      // Personal documents — same server-side filter pattern, type=document.
      { queryKey: ['content', 'documents', 'personal'], queryFn: () => listContent({ type: 'document', project_id: 'null' }) },
      {
        queryKey: ['activity', 'recent', activityFilter],
        queryFn: () =>
          listActivity({
            limit: 4,
            ...(activityFilter === 'all' ? {} : { kinds: activityFilter }),
          }),
      },
      // Top tags drive the dashboard "what am I working on" strip.
      // Defaults to personal scope (tags on items with no project
      // membership) so the home dashboard reflects the user's private
      // workspace — the project pages have their own scoped strips.
      { queryKey: ['tags', 'home', 'personal'], queryFn: () => listTags({ scope: 'personal' }) },
    ],
  });
  const [statsQ, projectsQ, countsQ, todosQ, notesQ, docsQ, activityQ, tagsQ] = queries;

  const projectsRaw = projectsQ.data ?? [];
  const projectsById = useMemo(
    () => new Map(projectsRaw.map((p) => [p.id, p])),
    [projectsRaw],
  );
  const projects = useMemo(
    () => toUiProjects(projectsRaw, countsQ.data ?? []),
    [projectsRaw, countsQ.data],
  );
  const pinned = projects.filter((p) => p.pinned && p.status === 'active');
  // Widget caps at depth=1 — anything deeper rolls up into a "+N deeper"
  // hint on the deepest visible row. Drawer (TodoListDrawer) gets the
  // full tree. Both surfaces honor the same per-parent expansion state.
  const { isExpanded, toggle: toggleExpand } = useTodoExpansion();
  const allPersonalTodos = useMemo(
    () => (todosQ.data ?? []).map(toUiTodo),
    [todosQ.data],
  );
  const { mode: sortMode, setMode: setSortMode } = useTodoSortMode('home');
  // Tag filter is applied pre-sort so the SortedTodo tree only builds
  // among the visible items (parent/child relationships among matching
  // items only). Overview counts (open/overdue/this-week) use the
  // unfiltered allPersonalTodos by design — they're a dashboard, not
  // a filtered view.
  const filteredPersonalTodos = useMemo(
    () =>
      tagFilter.tags.length === 0
        ? allPersonalTodos
        : allPersonalTodos.filter((t) => matchesTagFilter(t, tagFilter)),
    [allPersonalTodos, tagFilter],
  );
  const personalTodos = useMemo(
    () => sortPersonalTodos(filteredPersonalTodos, { mode: sortMode, maxDepth: 1, isExpanded }),
    [filteredPersonalTodos, sortMode, isExpanded],
  );
  const { mode: noteSortMode, setMode: setNoteSortMode } = useNoteSortMode('home');
  const personalNotes = useMemo(() => {
    const arr = notesQ.data ?? [];
    return arr.slice().sort(compareNotesForMode(noteSortMode));
  }, [notesQ.data, noteSortMode]);
  // Reuses the note sort vocabulary — same modes (recent/oldest/A-Z/Z-A)
  // apply to any titled ContentItem with a created_at. Surface key is
  // doc-specific so docs and notes keep independent user preferences.
  const { mode: docSortMode, setMode: setDocSortMode } = useNoteSortMode('docs:home');
  const personalDocs = useMemo(
    () => (docsQ.data ?? []).slice().sort(compareNotesForMode(docSortMode)).map(toUiDocument),
    [docsQ.data, docSortMode],
  );

  // project: typeahead source — active projects only (no point suggesting
  // archived / completed ones for a NEW search predicate).
  const projectSuggestions = useMemo<ProjectSuggestion[]>(
    () => projectsRaw
      .filter((p) => p.status === 'active')
      .map((p) => ({ id: p.id, name: p.name })),
    [projectsRaw],
  );

  // @-mention typeahead targets — docs + notes (personal scope, matching
  // what's visible in the columns). Title-sorted so the popover surfaces
  // alphabetically; the SearchInput component handles prefix filtering.
  const mentionTargets = useMemo<MentionTarget[]>(() => {
    const docs: MentionTarget[] = personalDocs.map((d) => ({
      title: d.title,
      kind: 'document',
      id: d.id,
    }));
    const notes: MentionTarget[] = (notesQ.data ?? []).map((n) => ({
      title: n.title,
      kind: 'note',
      id: n.id,
    }));
    return [...docs, ...notes].sort((a, b) => a.title.localeCompare(b.title));
  }, [personalDocs, notesQ.data]);

  // Notes + docs: filter post-sort (no tree to rebuild). Todos already
  // filtered pre-sort above.
  const filteredNotes = useMemo(
    () =>
      tagFilter.tags.length === 0
        ? personalNotes
        : personalNotes.filter((n) => matchesTagFilter(n, tagFilter)),
    [personalNotes, tagFilter],
  );
  const filteredDocs = useMemo(
    () =>
      tagFilter.tags.length === 0
        ? personalDocs
        : personalDocs.filter((d) => matchesTagFilter(d, tagFilter)),
    [personalDocs, tagFilter],
  );
  // For todos, `personalTodos` IS already the filtered set (filter is
  // applied pre-sort). Alias for symmetry with notes/docs render code.
  const filteredTodos = personalTodos;
  const activity = useMemo(
    () => (activityQ.data ?? []).map((e) => toUiActivity(e, projectsById)),
    [activityQ.data, projectsById],
  );
  const stats = statsQ.data;

  const isLoading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error)?.error;

  // Open count is what the dashboard surfaces — "5/36 with 14% complete"
  // told you nothing actionable. Open = total - done across personal
  // scope (matches what clicking the count opens, the personal todos
  // drawer).
  const openCount = allPersonalTodos.filter((t) => t.status !== 'done').length;
  // Overdue / due-this-week counts walk the full unfiltered list so
  // grandchildren beyond the widget cap still count.
  const overdueCount = allPersonalTodos.filter(
    (t) => t.status !== 'done' && t.due_at && isOverdue(t.due_at),
  ).length;
  const dueThisWeekCount = allPersonalTodos.filter((t) => {
    if (t.status === 'done' || !t.due_at) return false;
    const due = new Date(t.due_at).getTime();
    const now = Date.now();
    return due > now && due - now < 7 * 24 * 60 * 60 * 1000;
  }).length;

  // Top 5 tags by total usage. Skipping ones with zero total (the API
  // shouldn't return those but be defensive).
  const topTags = useMemo(() => {
    const all = tagsQ.data ?? [];
    return [...all]
      .filter((t) => t.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  }, [tagsQ.data]);

  // Full personal-scope tag list (sorted by usage) for the filter chip
  // row — NOT pre-sliced. HomeTagFilter caps the visible chips via its
  // own `visibleCap` prop and exposes a "+N more" expansion. Keeping
  // the full list here means the +N more affordance can actually do
  // something when the user has more than the cap.
  const sortedTagsForChipRow = useMemo(() => {
    const all = tagsQ.data ?? [];
    return [...all]
      .filter((t) => t.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [tagsQ.data]);

  // Recently-active projects: top 3 by `updated_at` among active (not
  // archived/completed). The sidebar shows project counts; here we
  // answer "which projects are alive lately?" with timestamps.
  const recentProjects = useMemo(() => {
    return projects
      .filter((p) => p.status === 'active')
      .slice()
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 3);
  }, [projects]);

  // ── Search ───────────────────────────────────────────────
  // Universal search bar: the input text IS the source of truth for both
  // the active filter AND the page mode. Empty input → home dashboard
  // (Personal grid + overview + activity). Non-empty → unified search-
  // results list takes over the personal-grid section.
  //
  // `#tag`, `in:type`, `@name`, `project:name`, and `-prefix` negations
  // all parse live via searchSyntax.ts. tagFilter mirrors parsed tags
  // via a useEffect below so the HomeTagFilter chip row stays
  // bidirectionally in sync (a chip click writes a #tag predicate
  // back into the input).
  //
  // Initial value seeded from the URL's ?tag= so existing bookmarks /
  // browser-back states still surface the same scope visibly.
  const [query, setQuery] = useState<string>(() => {
    // Resolution order on mount:
    //   1. initialSearch.query (cross-page dispatch from ProjectPage etc)
    //   2. URL ?q= (direct nav / bookmark / back-forward)
    //   3. Legacy URL ?tag=foo,bar → seed as `#foo #bar` for back-compat
    //   4. Empty
    if (initialSearch?.query) return initialSearch.query;
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    const urlQ = params.get('q');
    if (urlQ) return urlQ;
    const urlFilter = parseTagFilter(params);
    return urlFilter.tags.map((t) => `#${t}`).join(' ');
  });
  // Scope can now be a project UUID too (matches what the SearchDrawer
  // used to support). Personal is default — most home use is private.
  // Initial resolution: initialSearch → URL ?scope= → 'personal'.
  const [scope, setScope] = useState<SearchScope>(() => {
    if (initialSearch?.scope) return initialSearch.scope;
    if (typeof window === 'undefined') return 'personal';
    const urlScope = new URLSearchParams(window.location.search).get('scope');
    return urlScope ?? 'personal';
  });

  // URL sync: any change to query or scope writes ?q= / ?scope= via
  // replaceState (no history pollution; back button still works because
  // it pre-dates the replaceState chain). Clears params when empty.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (query.trim().length > 0) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    if (scope !== 'personal') url.searchParams.set('scope', scope);
    else url.searchParams.delete('scope');
    window.history.replaceState(null, '', url.toString());
  }, [query, scope]);


  // Live debounce. 180ms matches CommandPalette's tuned value — fast
  // enough to feel instant, slow enough to skip mid-token requests.
  const debouncedQuery = useDebounced(query, 180);
  const parsedQuery = useMemo(() => parseSearchSyntax(debouncedQuery), [debouncedQuery]);

  // `searchActive` is the mode switch. Any signal in the parsed query —
  // free text OR any predicate bucket — flips the page into results
  // mode. Empty input drops back to the dashboard.
  const searchActive =
    parsedQuery.text.trim().length > 0
    || parsedQuery.tags.length > 0
    || parsedQuery.types.length > 0
    || parsedQuery.mentions.length > 0
    || parsedQuery.projects.length > 0
    || parsedQuery.excludedTags.length > 0
    || parsedQuery.excludedTypes.length > 0
    || parsedQuery.excludedMentions.length > 0
    || parsedQuery.excludedProjects.length > 0;

  // updateBoth keeps the input string canonical when the user removes a
  // predicate chip via the X — same pattern SearchDrawer used.
  const updateBoth = (next: string) => setQuery(next);

  // Resolve @-mentions and project:names to UUIDs for the wire call.
  // Same logic SearchDrawer had — global mention pool so a mention can
  // pull in an item from any project, not just the personal scope the
  // home dashboard surfaces by default.
  const { contentItemIds, excludedContentItemIds } = useMemo(() => {
    const matchByTitle = (name: string): string[] => {
      const lower = name.toLowerCase();
      return mentionTargets
        .filter((m) => m.title.toLowerCase() === lower)
        .map((m) => m.id);
    };
    return {
      contentItemIds: parsedQuery.mentions.flatMap(matchByTitle),
      excludedContentItemIds: parsedQuery.excludedMentions.flatMap(matchByTitle),
    };
  }, [parsedQuery.mentions, parsedQuery.excludedMentions, mentionTargets]);

  // First positive project: predicate wins over the scope chip toggle.
  // Mirrors SearchDrawer's resolution rule — keeps the input the
  // canonical source of truth even when the chips suggest otherwise.
  const projectIdFromPredicate = useMemo<string | null | undefined>(() => {
    if (parsedQuery.projects.length === 0) return undefined;
    const first = parsedQuery.projects[0]!.toLowerCase();
    const match = projectSuggestions.find((p) => p.name.toLowerCase() === first);
    return match?.id;
  }, [parsedQuery.projects, projectSuggestions]);

  const effectiveProjectId =
    projectIdFromPredicate !== undefined
      ? projectIdFromPredicate
      : scope === 'all'
        ? undefined
        : scope === 'personal'
          ? 'null'
          : scope;

  // Live search hits. Fires whenever the debounced query has any
  // signal (parsed predicates OR free text). Returns SearchHit[] from
  // the existing /api/v1/search endpoint with all the PR #12+#14
  // power-feature plumbing intact (mentions, projects, exclusions,
  // vector + graph + lexical fusion).
  const { data: hitsApi, isFetching: searchIsFetching, error: searchError } = useQuery({
    queryKey: [
      'search',
      debouncedQuery,
      effectiveProjectId ?? 'all',
      parsedQuery.tags.join(','),
      parsedQuery.types.join(','),
      contentItemIds.join(','),
      parsedQuery.excludedTags.join(','),
      parsedQuery.excludedTypes.join(','),
      excludedContentItemIds.join(','),
    ],
    queryFn: () =>
      search({
        // Predicate-only inputs (e.g. just `#chore`) have parsedQuery.text === ''.
        // Send empty so the backend takes the filter-only path; falling back to
        // the raw `#chore` string would embed garbage and match nothing.
        query: parsedQuery.text,
        project_id: effectiveProjectId as 'null' | string | undefined,
        tags: parsedQuery.tags.length > 0 ? parsedQuery.tags : undefined,
        entity_types: parsedQuery.types.length > 0 ? parsedQuery.types : undefined,
        content_item_ids: contentItemIds.length > 0 ? contentItemIds : undefined,
        excluded_tags: parsedQuery.excludedTags.length > 0 ? parsedQuery.excludedTags : undefined,
        excluded_entity_types: parsedQuery.excludedTypes.length > 0 ? parsedQuery.excludedTypes : undefined,
        excluded_content_item_ids: excludedContentItemIds.length > 0 ? excludedContentItemIds : undefined,
        limit: 30,
      }),
    enabled: searchActive,
  });
  const searchHits = useMemo(
    () => (hitsApi ?? []).map((h) => toUiSearchHit(h, projectsById)),
    [hitsApi, projectsById],
  );

  // query → tagFilter sync. Parses #tag predicates out of the search
  // input and mirrors them into tagFilter.tags (preserving mode). The
  // setTagFilter mutator handles the reverse direction by writing the
  // diff back through `query`. Effect+mutator converge cleanly because
  // each only updates the OTHER state when there's a real diff.
  //
  // Mid-typing guard: only promote a parsed tag to tagFilter if it
  // matches a known tag in the user's data. Typing `#t` shouldn't
  // surface an orphan `t` chip in HomeTagFilter just because the
  // partial token parsed cleanly. Orphans are still kept for tags the
  // user previously selected that have since vanished from data —
  // those preserve in tagFilter until explicitly cleared (the chip is
  // visible inside HomeTagFilter regardless of this filter).
  useEffect(() => {
    const parsedTags = parseSearchSyntax(query).tags;
    const knownNames = new Set((tagsQ.data ?? []).map((t) => t.name));
    const validTags = parsedTags.filter((t) => knownNames.has(t));
    setTagFilterState((prev) => {
      const same =
        validTags.length === prev.tags.length &&
        validTags.every((t, i) => t === prev.tags[i]);
      return same ? prev : { ...prev, tags: validTags };
    });
  }, [query, tagsQ.data]);

  // ── Quick-add ───────────────────────────────────────────
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['todos'] });
    qc.invalidateQueries({ queryKey: ['content'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };
  const todoCreate = useMutation({
    mutationFn: (content: string) => createTodo({ content }),
    onSuccess: (todo) => {
      invalidate();
      // Pop the detail drawer for the just-created todo so the user can
      // immediately attach priority / due / tags / subtasks without an
      // extra click. They can dismiss with ESC or the close button if
      // the quick-capture was all they wanted.
      onAction({ kind: 'todo-detail', payload: toUiTodo(todo) });
    },
  });
  const noteCreate = useMutation({
    // Quick capture — first line becomes the title (capped at 80 chars),
    // full text goes into the body. Mirrors the NoteEditorModal contract
    // but keystroke-light for the Home column. On success, pop the
    // editor for the just-created note so the user can flesh out the
    // body / tags / project membership without an extra click. The
    // editor needs the full ContentItem (toUiNote signature), so we
    // refetch by id — POST /content only returns { id, status }.
    mutationFn: async (body: string) => {
      const firstLine = body.split('\n')[0].trim();
      const title = (firstLine || 'Untitled note').slice(0, 80);
      const created = await createNote({ type: 'note', title, content: body, project_ids: [], tags: [] });
      const full = await getContent(created.id);
      return full;
    },
    onSuccess: (item) => {
      invalidate();
      if (item.type === 'note') {
        onAction({ kind: 'note-edit', payload: toUiNote(item) });
      }
    },
  });
  const todoToggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) =>
      updateTodo(id, { status }),
    onSuccess: invalidate,
  });

  const [todoDraft, setTodoDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  if (error) {
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load home: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  if (isLoading || !stats) {
    return (
      <div className="page">
        <div className="page-subtle">Loading…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="proj-hero">
        <div>
          <h1>Welcome back, Alex.</h1>
        </div>
        <button className="btn btn-primary" onClick={() => onRoute({ route: 'projects', action: 'new' })}>
          <Icons.Plus /> New project
        </button>
      </div>

      <div className="home-search-row">
        <div className="home-search-box">
          <Icons.Search />
          <SearchInput
            value={query}
            onChange={setQuery}
            // Search is live (debounced) so Enter doesn't need to
            // submit anything. We provide a no-op so the input still
            // swallows Enter without bubbling a form submit somewhere.
            onSubmit={() => { /* live mode — no submit */ }}
            tags={sortedTagsForChipRow.map((t) => ({ name: t.name, total: t.total }))}
            mentions={mentionTargets}
            projects={projectSuggestions}
            onMentionSelect={(target) => {
              if (target.kind === 'document') {
                const doc = personalDocs.find((d) => d.id === target.id);
                if (doc) onAction({ kind: 'doc-read', payload: doc });
              } else {
                const raw = (notesQ.data ?? []).find((n) => n.id === target.id);
                if (raw && raw.type === 'note') onAction({ kind: 'note-edit', payload: toUiNote(raw) });
              }
            }}
            placeholder="Search… try #tag, in:todo, or @docname"
          />
        </div>
        <div className="home-scope-toggle" role="tablist" aria-label="Search scope">
          <button
            type="button"
            role="tab"
            className={cls(scope === 'personal' && 'active')}
            onClick={() => setScope('personal')}
          >
            Personal
          </button>
          <button
            type="button"
            role="tab"
            className={cls(scope === 'all' && 'active')}
            onClick={() => setScope('all')}
          >
            All projects
          </button>
        </div>
      </div>

      {/* Search-mode chrome — scope chip row + parsed-predicate chips.
          Visible only while searching so the dashboard isn't cluttered
          when the user isn't searching. The scope chip row widens
          beyond the simple Personal|All toggle above to surface every
          active project (so a search can be scoped to a specific
          project from the home page without first navigating there). */}
      {searchActive ? (
        <>
          <div className="home-search-scope-row" role="radiogroup" aria-label="Search project scope">
            <FilterChip active={scope === 'all'} onClick={() => setScope('all')}>All projects</FilterChip>
            <FilterChip active={scope === 'personal'} onClick={() => setScope('personal')}>Personal</FilterChip>
            {projectSuggestions.map((p) => (
              <FilterChip key={p.id} active={scope === p.id} onClick={() => setScope(p.id)}>
                {p.name}
              </FilterChip>
            ))}
          </div>
          {(parsedQuery.tags.length
            + parsedQuery.types.length
            + parsedQuery.mentions.length
            + parsedQuery.projects.length
            + parsedQuery.excludedTags.length
            + parsedQuery.excludedTypes.length
            + parsedQuery.excludedMentions.length
            + parsedQuery.excludedProjects.length) > 0 ? (
            <div className="search-drawer-predicates home-search-predicates" aria-label="Active predicates">
              {parsedQuery.tags.map((tag) => (
                <button key={`tag-${tag}`} type="button" className="search-predicate-chip" onClick={() => updateBoth(removeTagFromQuery(query, tag))}>#{tag} <Icons.X size={10} aria-hidden /></button>
              ))}
              {parsedQuery.types.map((type) => (
                <button key={`type-${type}`} type="button" className="search-predicate-chip" onClick={() => updateBoth(removeTypeFromQuery(query, type))}>in:{type} <Icons.X size={10} aria-hidden /></button>
              ))}
              {parsedQuery.mentions.map((name) => (
                <button key={`mention-${name}`} type="button" className="search-predicate-chip" onClick={() => updateBoth(removeMentionFromQuery(query, name))}>@{name} <Icons.X size={10} aria-hidden /></button>
              ))}
              {parsedQuery.projects.map((name) => (
                <button key={`project-${name}`} type="button" className="search-predicate-chip" onClick={() => updateBoth(removeProjectFromQuery(query, name))}>project:{name} <Icons.X size={10} aria-hidden /></button>
              ))}
              {parsedQuery.excludedTags.map((tag) => (
                <button key={`ex-tag-${tag}`} type="button" className="search-predicate-chip excluded" onClick={() => updateBoth(removeExcludedFromQuery(query, 'tag', tag))}>-#{tag} <Icons.X size={10} aria-hidden /></button>
              ))}
              {parsedQuery.excludedTypes.map((type) => (
                <button key={`ex-type-${type}`} type="button" className="search-predicate-chip excluded" onClick={() => updateBoth(removeExcludedFromQuery(query, 'type', type))}>-in:{type} <Icons.X size={10} aria-hidden /></button>
              ))}
              {parsedQuery.excludedMentions.map((name) => (
                <button key={`ex-mention-${name}`} type="button" className="search-predicate-chip excluded" onClick={() => updateBoth(removeExcludedFromQuery(query, 'mention', name))}>-@{name} <Icons.X size={10} aria-hidden /></button>
              ))}
              {parsedQuery.excludedProjects.map((name) => (
                <button key={`ex-project-${name}`} type="button" className="search-predicate-chip excluded" onClick={() => updateBoth(removeExcludedFromQuery(query, 'project', name))}>-project:{name} <Icons.X size={10} aria-hidden /></button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {sortedTagsForChipRow.length > 0 || tagFilter.tags.length > 0 ? (
        <HomeTagFilter
          options={sortedTagsForChipRow}
          filter={tagFilter}
          onChange={setTagFilter}
        />
      ) : null}

      {searchActive ? (
        <div className="home-search-results">
          {searchError ? (
            <div className="page-subtle" style={{ color: 'var(--danger)' }}>
              Search failed: {searchError instanceof Error ? searchError.message : String(searchError)}
            </div>
          ) : searchIsFetching && searchHits.length === 0 ? (
            <div className="page-subtle">Searching…</div>
          ) : searchHits.length === 0 ? (
            <div className="page-subtle">No results.</div>
          ) : (
            <>
              <div className="subtle results-count">{searchHits.length} results</div>
              <SearchResultsList hits={searchHits} onOpen={(h) => openActivityTarget(h, onAction)} />
            </>
          )}
        </div>
      ) : null}

      {!searchActive ? (<>
      <div className="home-personal-h">
        <h2>Personal</h2>
        <span className="sub">project-less todos, notes, and documents</span>
      </div>

      <div className="home-personal-grid">
        <div className="pcol" data-pcol="todos">
          <PersonalColumnHeader
            title="Todos"
            count={filteredTodos.length}
            sort={<TodoSortDropdown id="home-todos-sort" mode={sortMode} onChange={setSortMode} />}
          />
          <div className="pcol-add">
            <input
              placeholder="+ New todo (no project) — press Enter to add"
              value={todoDraft}
              onChange={(e) => setTodoDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && todoDraft.trim() && !todoCreate.isPending) {
                  e.preventDefault();
                  const c = todoDraft.trim();
                  setTodoDraft('');
                  todoCreate.mutate(c);
                }
              }}
              disabled={todoCreate.isPending}
            />
          </div>
          {filteredTodos.length === 0 ? (
            tagFilter.tags.length > 0 ? (
              <FilterEmpty entity="todos" filter={tagFilter} />
            ) : (
              <div className="pcol-empty">Inbox is empty — capture above to get started.</div>
            )
          ) : (
            <>
              <SortableTodoList
                rows={filteredTodos.slice(0, 6)}
                allRows={filteredTodos}
                isExpanded={isExpanded}
                onToggleExpand={toggleExpand}
                onClickRow={(t) => onAction({ kind: 'todo-detail', payload: t })}
                onToggleDone={(t) =>
                  todoToggle.mutate({
                    id: t.id,
                    status: t.status === 'done' ? 'not_started' : 'done',
                  })
                }
              />
              {filteredTodos.length > 6 ? (
                <button
                  className="pcol-more"
                  onClick={() => onAction({ kind: 'personal-todos', tagFilter })}
                >
                  View {filteredTodos.length - 6} more
                  <Icons.ChevronRight size={11} />
                </button>
              ) : null}
            </>
          )}
        </div>

        <div className="pcol" data-pcol="notes">
          <PersonalColumnHeader
            title="Notes"
            count={filteredNotes.length}
            sort={<NoteSortDropdown id="home-notes-sort" mode={noteSortMode} onChange={setNoteSortMode} />}
          />
          <div className="pcol-add">
            <input
              placeholder="+ Quick note — press Enter to capture"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && noteDraft.trim() && !noteCreate.isPending) {
                  e.preventDefault();
                  const c = noteDraft.trim();
                  setNoteDraft('');
                  noteCreate.mutate(c);
                }
              }}
              disabled={noteCreate.isPending}
            />
          </div>
          {filteredNotes.length === 0 ? (
            tagFilter.tags.length > 0 ? (
              <FilterEmpty entity="notes" filter={tagFilter} />
            ) : (
              <div className="pcol-empty">No personal notes — capture above.</div>
            )
          ) : (
            <>
              {filteredNotes.slice(0, 6).map((n) => (
                <NoteRow
                  key={n.id}
                  note={toUiNote(n)}
                  onClick={() => onAction({ kind: 'note-edit', payload: toUiNote(n) })}
                />
              ))}
              {filteredNotes.length > 6 ? (
                <button
                  className="pcol-more"
                  onClick={() => onAction({ kind: 'personal-notes', tagFilter })}
                >
                  View {filteredNotes.length - 6} more
                  <Icons.ChevronRight size={11} />
                </button>
              ) : null}
            </>
          )}
        </div>

        <div className="pcol" data-pcol="documents">
          <PersonalColumnHeader
            title="Documents"
            count={filteredDocs.length}
            sort={<NoteSortDropdown id="home-docs-sort" mode={docSortMode} onChange={setDocSortMode} />}
          />
          {filteredDocs.length === 0 ? (
            tagFilter.tags.length > 0 ? (
              <FilterEmpty entity="documents" filter={tagFilter} />
            ) : (
              <div className="pcol-empty">No personal documents — upload or save from URL.</div>
            )
          ) : (
            <>
              {filteredDocs.slice(0, 6).map((d) => (
                <DocRow
                  key={d.id}
                  doc={d}
                  onClick={() => onAction({ kind: 'doc-read', payload: d })}
                />
              ))}
              {filteredDocs.length > 6 ? (
                <button
                  className="pcol-more"
                  onClick={() => onAction({ kind: 'personal-docs', tagFilter })}
                >
                  View {filteredDocs.length - 6} more
                  <Icons.ChevronRight size={11} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="home-top-row">
        <div className="stat-overview">
          <div className="stat-overview-section">
            <div className="lb">Overview</div>
            <div className="stat-overview-counts">
              <button
                type="button"
                className="stat-overview-count"
                onClick={() => onAction({ kind: 'personal-todos', sort: 'smart' })}
              >
                <strong>{openCount}</strong> open
              </button>
              {overdueCount > 0 ? (
                <button
                  type="button"
                  className="stat-overview-count stat-overview-count-warn"
                  onClick={() => onAction({ kind: 'personal-todos', sort: 'due' })}
                >
                  <strong>{overdueCount}</strong> overdue
                </button>
              ) : null}
              {dueThisWeekCount > 0 ? (
                <button
                  type="button"
                  className="stat-overview-count"
                  onClick={() => onAction({ kind: 'personal-todos', sort: 'due' })}
                >
                  <strong>{dueThisWeekCount}</strong> this week
                </button>
              ) : null}
            </div>
          </div>

          {topTags.length > 0 ? (
            <div className="stat-overview-section">
              <div className="stat-overview-h">
                <div className="lb">Top tags</div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => onRoute({ route: 'tags' })}
                >
                  All →
                </button>
              </div>
              <div className="stat-overview-tags">
                {topTags.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    className="stat-overview-tag"
                    onClick={() => onRoute({ route: 'tags', name: t.name })}
                  >
                    #{t.name}
                    <span className="stat-overview-tag-count">{t.total}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {recentProjects.length > 0 ? (
            <div className="stat-overview-section">
              <div className="stat-overview-h">
                <div className="lb">Active projects</div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => onRoute({ route: 'projects' })}
                >
                  All →
                </button>
              </div>
              <div className="stat-overview-projects">
                {recentProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="stat-overview-project"
                    onClick={() => onRoute({ route: 'project', project: p.id })}
                  >
                    <span className="nm">{p.name}</span>
                    <span className="sub">{fmtRel(p.updated_at)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="stat-activity">
          <div className="ah">
            <div className="lb">Recent activity</div>
            <SortDropdown<ActivityFilter>
              id="home-activity-filter"
              mode={activityFilter}
              modes={ACTIVITY_FILTER_MODES}
              labels={ACTIVITY_FILTER_LABELS}
              onChange={setActivityFilter}
              label="Filter"
            />
          </div>
          {activity.length === 0 ? (
            <div className="page-subtle stat-activity-empty">
              {activityFilter === 'all' ? 'No recent activity.' : 'No matching events.'}
            </div>
          ) : (
            <div className="activity-list activity-list-compact">
              {activity.map((a) => (
                <ActivityRow
                  key={a.id}
                  activity={a}
                  onClick={() => openActivityTarget(a, onAction)}
                />
              ))}
            </div>
          )}
          <button
            className="stat-activity-more"
            onClick={() => onRoute({ route: 'activity' })}
          >
            View full feed
            <Icons.ChevronRight size={11} />
          </button>
        </div>
      </div>

      {pinned.length > 0 ? (
        <div className="home-pinned-strip">
          <span className="label">Pinned</span>
          {pinned.map((p) => (
            <button
              key={p.id}
              className="pin-chip"
              onClick={() => onRoute({ route: 'project', project: p.id })}
            >
              <span className={cls('sb-proj-dot', p.accent)}></span>
              {p.name}
            </button>
          ))}
        </div>
      ) : null}
      </>) : null}
    </div>
  );
}
