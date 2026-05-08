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

  const { data: projects } = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const projectsById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p])),
    [projects],
  );

  const { data: hitsApi, isFetching, error } = useQuery({
    queryKey: ['search', submitted, scope],
    queryFn: () =>
      search({
        query: submitted,
        project_id: scope === 'all' ? undefined : scope === 'personal' ? 'null' : scope,
        limit: 20,
      }),
    enabled: submitted.trim().length > 0,
  });
  const hits = useMemo(
    () => (hitsApi ?? []).map((h) => toUiSearchHit(h, projectsById)),
    [hitsApi, projectsById],
  );

  const submit = () => setSubmitted(draft);

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
            placeholder="Search across notes, documents, and todos…"
          />
        </div>
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
          ) : !submitted.trim() ? (
            <div className="page-subtle">Type a query and press Enter.</div>
          ) : isFetching ? (
            <div className="page-subtle">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="page-subtle">No results for "{submitted}".</div>
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
