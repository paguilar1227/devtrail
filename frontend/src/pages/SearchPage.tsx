import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { FilterChip } from '../components/primitives';
import { SearchResultsList } from '../components/SearchResultsList';
import { listProjects, search } from '../lib/api';
import { toUiSearchHit } from '../lib/view';

// scope values:
//   'all'       → no project_id filter (global)
//   'personal'  → project_id='null' on the wire (no-project content + todos)
//   <uuid>      → single project filter
type Scope = 'all' | 'personal' | string;

interface Props {
  initialQuery?: string;
  initialScope?: Scope;
}

export function SearchPage({ initialQuery = '', initialScope = 'all' }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [scope, setScope] = useState<Scope>(initialScope);

  const { data: projects } = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const projectsById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p])),
    [projects],
  );

  const { data: hitsApi, isFetching, error } = useQuery({
    queryKey: ['search', submittedQuery, scope],
    queryFn: () =>
      search({
        query: submittedQuery,
        // 'all' = omit the filter; 'personal' goes on the wire as the
        // string 'null' which the backend translates to a no-project
        // SQL predicate; anything else is a project UUID.
        project_id: scope === 'all' ? undefined : scope === 'personal' ? 'null' : scope,
        limit: 20,
      }),
    enabled: submittedQuery.trim().length > 0,
  });
  const hits = useMemo(
    () => (hitsApi ?? []).map((h) => toUiSearchHit(h, projectsById)),
    [hitsApi, projectsById],
  );

  const onSubmit = () => setSubmittedQuery(q);

  return (
    <div className="page page-narrow">
      <div className="proj-hero">
        <div>
          <h1>Search</h1>
          <p className="page-subtle">
            Hybrid retrieval — vector similarity, graph adjacency, and FTS combined. Toggle which paths to use.
          </p>
        </div>
      </div>
      <div className="todo-input-row">
        <div className="field">
          <Icons.Search />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onSubmit()}
            placeholder="Search across notes, documents, and todos…"
          />
        </div>
        <button className="btn" onClick={onSubmit}>Search</button>
      </div>
      <div className="filter-bar">
        <FilterChip active={scope === 'all'} onClick={() => setScope('all')}>
          All projects
        </FilterChip>
        <FilterChip active={scope === 'personal'} onClick={() => setScope('personal')}>
          Personal
        </FilterChip>
        {(projects ?? []).filter(p => p.status === 'active').map(p => (
          <FilterChip key={p.id} active={scope === p.id} onClick={() => setScope(p.id)}>
            {p.name}
          </FilterChip>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <FilterChip active>vector</FilterChip>
          <FilterChip active>graph</FilterChip>
          <FilterChip>fts</FilterChip>
        </span>
      </div>
      {error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Search failed: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : !submittedQuery.trim() ? (
        <div className="page-subtle">Type a query and press Enter.</div>
      ) : isFetching ? (
        <div className="page-subtle">Searching…</div>
      ) : hits.length === 0 ? (
        <div className="page-subtle">No results for "{submittedQuery}".</div>
      ) : (
        <>
          <div className="subtle results-count">
            {hits.length} results
          </div>
          <SearchResultsList hits={hits} />
        </>
      )}
    </div>
  );
}
