// Home — the workspace landing page. One search box, one scope toggle,
// and the shared browse panels under tabs.
//
// Layout (top to bottom):
//   1. Hero      — greeting + New project button.
//   2. Search    — THE query surface. Typing filters live (entity search
//                  with the #tag / in:type / @name / project: DSL);
//                  pressing Enter asks the knowledge base and renders a
//                  synthesized answer with citations above the results.
//                  There is deliberately no separate "chat" surface here.
//   3. Tabs      — Todos | Notes | Documents | Activity, rendering the
//                  shared scope-parameterized panels (the same components
//                  the project page tabs use).
//   4. Pinned    — chip strip linking to pinned projects.
//
// Scope ('personal' | 'all' | project UUID) governs the search AND the
// panels. "Personal" means project_ids = [] (content) / project_id = null
// (todo) — the Inbox. The visible toggle offers Personal/All; project
// scope arrives via cross-page search dispatch (ProjectPage submit) or
// the scope chip row in search mode.

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { ActivityRow } from '../components/ActivityRow';
import { Icons } from '../components/Icons';
import { FilterChip, Tabs } from '../components/primitives';
import { SortDropdown } from '../components/SortDropdown';
import { HomeTagFilter } from '../components/HomeTagFilter';
import { TodosPanel } from '../components/panels/TodosPanel';
import { NotesPanel } from '../components/panels/NotesPanel';
import { DocumentsPanel } from '../components/panels/DocumentsPanel';
import {
  EMPTY_FILTER,
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
import {
  listActivity,
  listContent,
  listProjectCounts,
  listProjects,
  listTags,
  rag,
  search,
} from '../lib/api';
import { toUiActivity, toUiDocument, toUiNote, toUiProjects, toUiSearchHit } from '../lib/view';
import { openEntity } from '../lib/openEntity';
import { useDebounced } from '../lib/useDebounced';
import { cls } from '../lib/util';
import type { ActionDispatch, ActivityEntityKind, Route } from '../types';
import type { Project as ApiProject, RagResponse } from '@devtrail/shared';

export type HomeTab = 'todos' | 'notes' | 'documents' | 'activity';
const HOME_TABS: readonly HomeTab[] = ['todos', 'notes', 'documents', 'activity'];

interface Props {
  onRoute: (r: Route) => void;
  onAction: ActionDispatch;
  /** Cross-page search seed — set when arriving at home via
   *  onRoute({ route: 'home', q, scope }) from another page (ProjectPage
   *  search submit, command palette, etc). HomePage consumes it on
   *  mount as the initial query/scope; the URL itself is the
   *  persistent source of truth thereafter. */
  initialSearch?: { query?: string; scope?: 'personal' | 'all' | string };
  /** Deep-link a tab (sidebar "Todos" routes here with tab='todos'). */
  initialTab?: HomeTab;
  /** Bumped by the command palette's "Search…" action — focus the search
   *  input so the user can type immediately (>0 only after that action). */
  searchFocusNonce?: number;
}

// Scope chip values: 'personal' = no project (Inbox), 'all' = global,
// any other string = project UUID. Matches the SearchRequest project_id
// trinary on the wire ('null' for personal, UUID for project, omit for all).
type SearchScope = 'personal' | 'all' | string;

// listTags speaks a slightly different dialect: it takes either a
// `scope: 'personal' | 'all'` flag or a `project_id` UUID — never both.
function scopeToTagsArg(scope: SearchScope): { scope: 'personal' | 'all' } | { project_id: string } {
  if (scope === 'personal' || scope === 'all') return { scope };
  return { project_id: scope };
}

export function HomePage({ onRoute, onAction, initialSearch, initialTab, searchFocusNonce = 0 }: Props) {
  // Scope (Personal / All projects / specific project UUID) governs the
  // panels AND the universal search. URL-seeded so bookmarks / deep-links
  // replay the user's chosen scope.
  const [scope, setScope] = useState<SearchScope>(() => {
    if (initialSearch?.scope) return initialSearch.scope;
    if (typeof window === 'undefined') return 'personal';
    const urlScope = new URLSearchParams(window.location.search).get('scope');
    return urlScope ?? 'personal';
  });

  const [tab, setTab] = useState<HomeTab>(() => {
    if (initialTab) return initialTab;
    if (typeof window === 'undefined') return 'todos';
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    return (HOME_TABS as string[]).includes(urlTab ?? '') ? (urlTab as HomeTab) : 'todos';
  });

  // Tag filter mirrors the #tag predicates in the search query so the
  // HomeTagFilter chip row and the input stay bidirectionally in sync (a
  // chip click writes a #tag predicate into the input, which flips the
  // page into search mode).
  const [tagFilter, setTagFilterState] = useState<TagFilter>(() =>
    typeof window === 'undefined'
      ? EMPTY_FILTER
      : parseTagFilter(new URLSearchParams(window.location.search)),
  );
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
      { queryKey: ['projects', 'all'], queryFn: () => listProjects() },
      { queryKey: ['project-counts'], queryFn: () => listProjectCounts() },
      // Top tags reflect whichever scope the page is on so counts + which
      // tags appear match the panels below.
      { queryKey: ['tags', 'home', scope], queryFn: () => listTags(scopeToTagsArg(scope)), placeholderData: keepPreviousData },
      // Global docs + notes lists feed the @-mention typeahead (a mention
      // can pull in an item from any project) and resolve mention clicks.
      { queryKey: ['content', 'documents', 'all'], queryFn: () => listContent({ type: 'document' }) },
      { queryKey: ['content', 'notes', 'all'], queryFn: () => listContent({ type: 'note' }) },
    ],
  });
  const [projectsQ, countsQ, tagsQ, docsQ, notesQ] = queries;

  const projectsRaw = (projectsQ.data ?? []) as ApiProject[];
  const projectsById = useMemo(
    () => new Map(projectsRaw.map((p) => [p.id, p])),
    [projectsRaw],
  );
  const projects = useMemo(
    () => toUiProjects(projectsRaw, countsQ.data ?? []),
    [projectsRaw, countsQ.data],
  );
  const pinned = projects.filter((p) => p.pinned && p.status === 'active');

  // Scope heading resolves a project UUID to its name (falls back to a
  // short placeholder while the projects list is still loading).
  const scopeHeading = useMemo<{ title: string; subtitle: string }>(() => {
    if (scope === 'personal') {
      return { title: 'Personal', subtitle: 'project-less todos, notes, and documents' };
    }
    if (scope === 'all') {
      return { title: 'All projects', subtitle: 'every todo, note, and document across the workspace' };
    }
    const p = projectsById.get(scope);
    return {
      title: p?.name ?? '…',
      subtitle: p ? `todos, notes, and documents in ${p.name}` : 'loading project…',
    };
  }, [scope, projectsById]);

  // project: typeahead source — active projects only (no point suggesting
  // archived / completed ones for a NEW search predicate).
  const projectSuggestions = useMemo<ProjectSuggestion[]>(
    () => projectsRaw
      .filter((p) => p.status === 'active')
      .map((p) => ({ id: p.id, name: p.name })),
    [projectsRaw],
  );

  // @-mention typeahead targets — all docs + notes, title-sorted.
  const mentionTargets = useMemo<MentionTarget[]>(() => {
    const docs: MentionTarget[] = (docsQ.data ?? []).map((d) => ({ title: d.title, kind: 'document', id: d.id }));
    const notes: MentionTarget[] = (notesQ.data ?? []).map((n) => ({ title: n.title, kind: 'note', id: n.id }));
    return [...docs, ...notes].sort((a, b) => a.title.localeCompare(b.title));
  }, [docsQ.data, notesQ.data]);

  const error = projectsQ.error || countsQ.error;

  // Palette "Search…" → land on home with the search bar focused. Re-runs
  // when the loading gate clears: on a cold projects cache the input isn't
  // mounted yet when the nonce bumps, and the focus would silently vanish.
  useEffect(() => {
    if (searchFocusNonce > 0 && !projectsQ.isLoading) {
      document.querySelector<HTMLInputElement>('.home-search-box input')?.focus();
    }
  }, [searchFocusNonce, projectsQ.isLoading]);

  // Full scoped tag list (sorted by usage) for the filter chip row — NOT
  // pre-sliced. HomeTagFilter caps the visible chips via its own
  // `visibleCap` prop and exposes a "+N more" expansion.
  const sortedTagsForChipRow = useMemo(() => {
    const all = tagsQ.data ?? [];
    return [...all]
      .filter((t) => t.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [tagsQ.data]);

  // ── Search ───────────────────────────────────────────────
  // Universal search bar: the input text IS the source of truth for both
  // the active filter AND the page mode. Empty input → tabs. Non-empty →
  // unified search-results list takes over. Enter → synthesized answer
  // (RAG over the effective scope) above the results.
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

  // URL sync: any change to query / scope / tab writes ?q= / ?scope= /
  // ?tab= via replaceState (no history pollution). Params are cleared at
  // their defaults so plain "/" stays plain.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (query.trim().length > 0) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    if (scope !== 'personal') url.searchParams.set('scope', scope);
    else url.searchParams.delete('scope');
    if (tab !== 'todos') url.searchParams.set('tab', tab);
    else url.searchParams.delete('tab');
    window.history.replaceState(null, '', url.toString());
  }, [query, scope, tab]);

  // Live debounce. 180ms matches CommandPalette's tuned value — fast
  // enough to feel instant, slow enough to skip mid-token requests.
  const debouncedQuery = useDebounced(query, 180);
  const parsedQuery = useMemo(() => parseSearchSyntax(debouncedQuery), [debouncedQuery]);

  // `searchActive` is the mode switch. Any signal in the parsed query —
  // free text OR any predicate bucket — flips the page into results
  // mode. Empty input drops back to the tabs.
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
  // predicate chip via the X.
  const updateBoth = (next: string) => setQuery(next);

  // Resolve @-mentions and project:names to UUIDs for the wire call.
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

  // Live search hits from /api/v1/search (vector + graph + lexical fusion).
  const { data: hitsApi, isFetching: searchIsFetching, error: searchError } = useQuery({
    queryKey: [
      'search',
      debouncedQuery,
      effectiveProjectId ?? 'all',
      parsedQuery.tags.join(','),
      tagFilter.mode, // AND/OR toggle — refetch when the mode flips
      parsedQuery.types.join(','),
      contentItemIds.join(','),
      parsedQuery.excludedTags.join(','),
      parsedQuery.excludedTypes.join(','),
      excludedContentItemIds.join(','),
    ],
    queryFn: () =>
      search({
        // Predicate-only inputs (e.g. just `#chore`) have parsedQuery.text === ''.
        // Send empty so the backend takes the filter-only path.
        query: parsedQuery.text,
        project_id: effectiveProjectId as 'null' | string | undefined,
        tags: parsedQuery.tags.length > 0 ? parsedQuery.tags : undefined,
        tag_match: parsedQuery.tags.length > 0 ? (tagFilter.mode === 'and' ? 'all' : 'any') : undefined,
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

  // ── Ask (RAG folded into the search box) ─────────────────
  // Enter asks the knowledge base and renders the synthesized answer +
  // citations above the live results. The request is built from a FRESH
  // parse of the input (not the debounced one), so a just-typed
  // project:/#tag/in: predicate scopes the answer exactly like the
  // result list below it.
  const askMut = useMutation({
    mutationFn: (req: {
      question: string;
      project_id: 'null' | string | undefined;
      tags?: string[];
      entity_types?: typeof parsedQuery.types;
    }): Promise<RagResponse> =>
      rag({
        question: req.question,
        project_id: req.project_id,
        tags: req.tags,
        entity_types: req.entity_types,
        depth: 'auto',
      }),
  });
  const askReset = askMut.reset;
  // Snapshot of what was asked — the raw input string plus the scope it
  // resolved to. Staleness is judged against THIS, never against the
  // debounced query: the trailing debounce lands up to 180ms after Enter,
  // and resetting on it detached the in-flight mutation and silently
  // dropped the answer (council-review finding, confirmed by 4/4 lenses).
  const [asked, setAsked] = useState<{ query: string; projectId: 'null' | string | undefined } | null>(null);
  // Resolve the ask scope from a fresh parse: first matching project:
  // predicate wins, else the page scope — the same rule the live search
  // applies via projectIdFromPredicate/effectiveProjectId.
  const resolveAskScope = (parsed: ReturnType<typeof parseSearchSyntax>): 'null' | string | undefined => {
    if (parsed.projects.length > 0) {
      const first = parsed.projects[0]!.toLowerCase();
      const match = projectSuggestions.find((p) => p.name.toLowerCase() === first);
      if (match) return match.id;
    }
    return scope === 'all' ? undefined : scope === 'personal' ? 'null' : scope;
  };
  const submitAsk = () => {
    const parsed = parseSearchSyntax(query);
    const text = parsed.text.trim();
    if (text.length === 0 || askMut.isPending) return;
    const project_id = resolveAskScope(parsed);
    setAsked({ query, projectId: project_id });
    askMut.mutate({
      question: text,
      project_id,
      tags: parsed.tags.length > 0 ? parsed.tags : undefined,
      entity_types: parsed.types.length > 0 ? parsed.types : undefined,
    });
  };
  const dismissAnswer = () => {
    askReset();
    setAsked(null);
  };
  // Clear a stale answer only when the input genuinely diverges from the
  // asked snapshot, or the scope toggle re-resolves the same input to a
  // different scope. Comparing the RAW query means Enter-then-debounce
  // can never race the mutation it just started.
  useEffect(() => {
    if (!asked) return;
    if (query !== asked.query || resolveAskScope(parseSearchSyntax(query)) !== asked.projectId) {
      dismissAnswer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, projectSuggestions, asked]);
  const openCitation = (c: RagResponse['citations'][number]) => {
    if (!c.type || !c.content_item_id) return;
    void openEntity({ entity_kind: c.type as ActivityEntityKind, entity_id: c.content_item_id }, onAction);
  };

  // query → tagFilter sync. Parses #tag predicates out of the search
  // input and mirrors them into tagFilter.tags (preserving mode). Only
  // promotes a parsed tag if it matches a known tag in the user's data,
  // so mid-typing `#t` doesn't surface an orphan chip.
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

  if (error) {
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load home: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  if (projectsQ.isLoading) {
    return (
      <div className="page">
        <div className="page-subtle">Loading…</div>
      </div>
    );
  }

  const tabItems = [
    { id: 'todos', label: 'Todos', icon: <Icons.Check /> },
    { id: 'notes', label: 'Notes', icon: <Icons.Note /> },
    { id: 'documents', label: 'Documents', icon: <Icons.Doc /> },
    { id: 'activity', label: 'Activity', icon: <Icons.Activity /> },
  ];

  return (
    <div className="page">
      <div className="proj-hero">
        <div>
          <h1>Welcome back.</h1>
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
            // Live results appear while typing; Enter escalates to a
            // synthesized answer over the same scope.
            onSubmit={submitAsk}
            tags={sortedTagsForChipRow.map((t) => ({ name: t.name, total: t.total }))}
            mentions={mentionTargets}
            projects={projectSuggestions}
            onMentionSelect={(target) => {
              if (target.kind === 'document') {
                const raw = (docsQ.data ?? []).find((d) => d.id === target.id);
                if (raw) onAction({ kind: 'doc-read', payload: toUiDocument(raw) });
              } else {
                const raw = (notesQ.data ?? []).find((n) => n.id === target.id);
                if (raw && raw.type === 'note') onAction({ kind: 'note-edit', payload: toUiNote(raw) });
              }
            }}
            // ArrowDown from the input descends focus into the first
            // search hit — type → ↓ → ↓ → Enter without touching Tab.
            onArrowDownExit={() => {
              const first = document.querySelector<HTMLButtonElement>(
                '.home-search-results .search-hit-title',
              );
              first?.focus();
            }}
            placeholder="Search or ask… try #tag, in:todo, or @docname"
          />
        </div>
        {/* Plain toggle group — NOT a tablist: the real tablist below (the
            Todos|Notes|… strip) owns that role, and duplicate tablists
            confuse assistive tech. */}
        <div className="home-scope-toggle" role="group" aria-label="Search scope">
          <button
            type="button"
            aria-pressed={scope === 'personal'}
            className={cls(scope === 'personal' && 'active')}
            onClick={() => setScope('personal')}
          >
            Personal
          </button>
          <button
            type="button"
            aria-pressed={scope === 'all'}
            className={cls(scope === 'all' && 'active')}
            onClick={() => setScope('all')}
          >
            All projects
          </button>
        </div>
      </div>

      {/* Search-mode chrome — scope chip row + parsed-predicate chips.
          Visible only while searching. The scope chip row widens beyond
          the Personal|All toggle to surface every active project (so a
          search can be scoped to a specific project from here). */}
      {searchActive ? (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm home-search-back"
            onClick={() => onRoute({ route: 'home' })}
          >
            <Icons.ChevronLeft size={12} /> Back to home
          </button>
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

      {/* Page-level tag chips render in SEARCH MODE ONLY — search has no
          type context, so a workspace-wide tag surface belongs there
          (synced with the query's #tag predicates). In browse mode each
          panel owns its type-scoped tag filter, so the funnel reads
          scope → type → tags → items with no duplicate row. */}
      {searchActive && (sortedTagsForChipRow.length > 0 || tagFilter.tags.length > 0) ? (
        <HomeTagFilter
          options={sortedTagsForChipRow}
          filter={tagFilter}
          onChange={setTagFilter}
        />
      ) : null}

      {searchActive ? (
        <div className="home-search-results">
          {/* Synthesized answer — RAG over the effective scope. */}
          {askMut.isPending ? (
            <div className="home-answer-card">
              <div className="hd"><Icons.Sparkle size={13} /> Thinking…</div>
            </div>
          ) : askMut.error ? (
            <div className="home-answer-card">
              <div className="hd"><Icons.Sparkle size={13} /> Answer</div>
              <div className="body" style={{ color: 'var(--danger)' }}>
                {askMut.error instanceof Error ? askMut.error.message : String(askMut.error)}
              </div>
            </div>
          ) : askMut.data ? (
            <div className="home-answer-card">
              <div className="hd">
                <Icons.Sparkle size={13} /> Answer
                <button
                  type="button"
                  className="btn btn-ghost btn-icon home-answer-dismiss"
                  aria-label="Dismiss answer"
                  onClick={dismissAnswer}
                >
                  <Icons.X size={11} />
                </button>
              </div>
              <div className="body">{askMut.data.answer}</div>
              {askMut.data.citations.length > 0 ? (
                <div className="cites">
                  {askMut.data.citations.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      className="home-answer-cite"
                      title={c.title}
                      onClick={() => openCitation(c)}
                    >
                      {i + 1}. {c.title}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
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
              <div className="subtle results-count">
                {searchHits.length} results
                {parsedQuery.text.trim().length > 0 && !askMut.data && !askMut.isPending
                  ? ' · press Enter to ask for an answer'
                  : ''}
              </div>
              <SearchResultsList hits={searchHits} onOpen={(h) => openEntity(h, onAction)} />
            </>
          )}
        </div>
      ) : null}

      {!searchActive ? (<>
      <div className="home-personal-h">
        <h2>{scopeHeading.title}</h2>
        <span className="sub">{scopeHeading.subtitle}</span>
      </div>

      <div className="tabs-row home-tabs-row">
        <Tabs value={tab} onChange={(id) => setTab(id as HomeTab)} items={tabItems} />
      </div>

      <div className="home-tab-body">
        {tab === 'todos' && <TodosPanel scope={scope} onAction={onAction} />}
        {tab === 'notes' && <NotesPanel scope={scope} onAction={onAction} />}
        {tab === 'documents' && (
          <DocumentsPanel
            scope={scope}
            // Project-scoped Home (via search dispatch / scope chips): give
            // the panel the project so "Add document" uploads INTO it
            // instead of silently landing in Personal.
            project={projects.find((p) => p.id === scope) ?? null}
            onAction={onAction}
          />
        )}
        {tab === 'activity' && (
          <HomeActivityTab projectsById={projectsById} onRoute={onRoute} onAction={onAction} />
        )}
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

// ── Activity tab ───────────────────────────────────────────
// The recent-activity feed as a Home tab (global — the activity API has
// no personal scope). "View full feed" links to the Activity page.

type ActivityFilter = 'all' | 'ingest' | 'edit' | 'comment';
const ACTIVITY_FILTER_MODES: readonly ActivityFilter[] = ['all', 'ingest', 'edit', 'comment'];
const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: 'All',
  ingest: 'Ingestion',
  edit: 'Updates',
  comment: 'Comments',
};

function HomeActivityTab({
  projectsById,
  onRoute,
  onAction,
}: {
  projectsById: Map<string, ApiProject>;
  onRoute: (r: Route) => void;
  onAction: ActionDispatch;
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const { data } = useQuery({
    queryKey: ['activity', 'home-tab', filter],
    queryFn: () =>
      listActivity({
        limit: 50,
        ...(filter === 'all' ? {} : { kinds: filter }),
      }),
    placeholderData: keepPreviousData,
  });
  const activity = useMemo(
    () => (data ?? []).map((e) => toUiActivity(e, projectsById)),
    [data, projectsById],
  );

  return (
    <div className="stat-activity home-activity-tab">
      <div className="ah">
        <div className="lb">Recent activity</div>
        <SortDropdown<ActivityFilter>
          id="home-activity-filter"
          mode={filter}
          modes={ACTIVITY_FILTER_MODES}
          labels={ACTIVITY_FILTER_LABELS}
          onChange={setFilter}
          label="Filter"
        />
      </div>
      {activity.length === 0 ? (
        <div className="page-subtle stat-activity-empty">
          {filter === 'all' ? 'No recent activity.' : 'No matching events.'}
        </div>
      ) : (
        <div className="activity-list activity-list-compact">
          {activity.map((a) => (
            <ActivityRow
              key={a.id}
              activity={a}
              onClick={() => openEntity(a, onAction)}
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
  );
}
