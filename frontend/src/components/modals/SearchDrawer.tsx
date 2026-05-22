// Search surface for Open Brain. Lives inside the shared <Drawer/>
// primitive — that gives us mobile fullscreen + the desktop expand
// toggle + role="dialog" + the slide-in animation, all without
// re-implementing them. The drawer holds query state local to the
// open instance so it doesn't pollute global state when dismissed.
//
// Scope semantics (matches what the /search page does on the wire):
//   'all'      → no project filter (global)
//   'personal' → project_id='null' on the wire — backend interprets
//                that as the no-project predicate
//   <uuid>     → single project filter
//
// Universal search DSL (parsed via searchSyntax.ts):
//   #<tag>        → adds to tags[] filter
//   in:<type>     → adds to entity_types[] filter
//                   aliases: todo|todos|note|notes|doc|docs|document|documents
//   anything else → free-text semantic query
// Predicates render as removable chips above results; the underlying
// SearchRequest already supports tags + entity_types directly.
//
// We deliberately keep this read-only and single-turn — multi-turn
// conversation lives in MCP today; this is the in-product UI for
// "find what I saved" with single-shot Q&A as a future evolution.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Drawer, FilterChip } from '../primitives';
import { Icons } from '../Icons';
import { SearchResultsList } from '../SearchResultsList';
import { listProjects, search } from '../../lib/api';
import { toUiSearchHit } from '../../lib/view';
import {
  parseSearchSyntax,
  removeTagFromQuery,
  removeTypeFromQuery,
} from '../../lib/searchSyntax';

type Scope = 'all' | 'personal' | string;

interface Props {
  initialQuery?: string;
  initialScope?: Scope;
  onClose: () => void;
}

export function SearchDrawer({ initialQuery = '', initialScope = 'all', onClose }: Props) {
  const [draft, setDraft] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);
  const [scope, setScope] = useState<Scope>(initialScope);

  // Re-sync if the consumer reopens the drawer with a different query
  // (e.g. user types in the Home search row, dismisses, types again).
  useEffect(() => {
    setDraft(initialQuery);
    setSubmitted(initialQuery);
    setScope(initialScope);
  }, [initialQuery, initialScope]);

  // Parse the SUBMITTED input (not draft) so the displayed scope chips
  // match what the API was actually queried with. The draft can be
  // mid-edit; chips only update on Enter.
  const parsed = useMemo(() => parseSearchSyntax(submitted), [submitted]);

  const { data: projects } = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const projectsById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p])),
    [projects],
  );

  const { data: hitsApi, isFetching, error } = useQuery({
    queryKey: ['search', submitted, scope, parsed.tags.join(','), parsed.types.join(',')],
    queryFn: () =>
      search({
        query: parsed.text || submitted, // fallback for pure-predicate queries
        project_id: scope === 'all' ? undefined : scope === 'personal' ? 'null' : scope,
        tags: parsed.tags.length > 0 ? parsed.tags : undefined,
        entity_types: parsed.types.length > 0 ? parsed.types : undefined,
        limit: 20,
      }),
    // Submit if there's any signal: free text OR a predicate. Predicate-
    // only queries (e.g. just "#home in:todo") are valid and useful.
    enabled: parsed.text.trim().length > 0 || parsed.tags.length > 0 || parsed.types.length > 0,
  });
  const hits = useMemo(
    () => (hitsApi ?? []).map((h) => toUiSearchHit(h, projectsById)),
    [hitsApi, projectsById],
  );

  const submit = () => setSubmitted(draft);

  const removeTagChip = (tag: string) => {
    const next = removeTagFromQuery(submitted, tag);
    setDraft(next);
    setSubmitted(next);
  };

  const removeTypeChip = (type: 'todo' | 'note' | 'document') => {
    const next = removeTypeFromQuery(submitted, type);
    setDraft(next);
    setSubmitted(next);
  };

  const hasPredicates = parsed.tags.length > 0 || parsed.types.length > 0;
  const hasAnySignal = parsed.text.trim().length > 0 || hasPredicates;

  return (
    <Drawer title="Search" onClose={onClose}>
      <div className="search-drawer-body">
        <div className="search-drawer-input">
          <Icons.Search />
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="Search… use #tag to filter by tag, in:todo|note|doc to filter by type"
          />
        </div>
        {hasPredicates ? (
          <div className="search-drawer-predicates" aria-label="Active scope">
            {parsed.tags.map((tag) => (
              <button
                key={`tag-${tag}`}
                type="button"
                className="search-predicate-chip"
                onClick={() => removeTagChip(tag)}
                aria-label={`Remove tag filter ${tag}`}
              >
                #{tag} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.types.map((type) => (
              <button
                key={`type-${type}`}
                type="button"
                className="search-predicate-chip"
                onClick={() => removeTypeChip(type)}
                aria-label={`Remove type filter ${type}`}
              >
                in:{type} <Icons.X size={10} aria-hidden />
              </button>
            ))}
          </div>
        ) : null}
        <div className="search-drawer-scope">
          <FilterChip active={scope === 'all'} onClick={() => setScope('all')}>
            All projects
          </FilterChip>
          <FilterChip active={scope === 'personal'} onClick={() => setScope('personal')}>
            Personal
          </FilterChip>
          {(projects ?? []).filter((p) => p.status === 'active').map((p) => (
            <FilterChip key={p.id} active={scope === p.id} onClick={() => setScope(p.id)}>
              {p.name}
            </FilterChip>
          ))}
        </div>
        <div className="search-drawer-results">
          {error ? (
            <div className="page-subtle search-drawer-error">
              Search failed: {error instanceof Error ? error.message : String(error)}
            </div>
          ) : !hasAnySignal ? (
            <div className="page-subtle">Type a query and press Enter. Try `#tag` or `in:todo`.</div>
          ) : isFetching ? (
            <div className="page-subtle">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="page-subtle">No results.</div>
          ) : (
            <>
              <div className="subtle results-count">{hits.length} results</div>
              <SearchResultsList hits={hits} />
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}
