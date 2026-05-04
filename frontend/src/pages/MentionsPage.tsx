import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { FilterChip } from '../components/primitives';
import { SearchResultsList } from '../components/SearchResultsList';
import { listProjects, search } from '../lib/api';
import { toUiSearchHit } from '../lib/view';
import type { ActivityEntityKind } from '../types';

type Filter = 'all' | ActivityEntityKind;

export function MentionsPage() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const queries = useQueries({
    queries: [
      { queryKey: ['projects', 'all'], queryFn: () => listProjects() },
      {
        queryKey: ['search', 'mentions', submitted, filter],
        queryFn: () =>
          search({
            query: submitted,
            entity_types: filter === 'all' ? undefined : [filter],
            limit: 50,
          }),
        enabled: submitted.trim().length > 0,
      },
    ],
  });
  const [projectsQ, hitsQ] = queries;
  const projectsById = useMemo(
    () => new Map((projectsQ.data ?? []).map((p) => [p.id, p])),
    [projectsQ.data],
  );
  const hits = useMemo(
    () => (hitsQ.data ?? []).map((h) => toUiSearchHit(h, projectsById)),
    [hitsQ.data, projectsById],
  );

  return (
    <div className="page page-narrow">
      <div className="proj-hero">
        <div>
          <h1>Find Mentions</h1>
          <p className="page-subtle">
            Backlink-style search. Pick any entity from your brain and Open Brain finds every other entity that mentions or links to it.
          </p>
        </div>
      </div>
      <div className="todo-input-row">
        <div className="field">
          <Icons.Search />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && setSubmitted(q)}
            placeholder="Search for an entity to find mentions of…"
          />
        </div>
        <button className="btn" onClick={() => setSubmitted(q)}>Find</button>
      </div>
      <div className="filter-bar">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All mentions <span style={{ marginLeft: 4 }}>{hits.length}</span>
        </FilterChip>
        <FilterChip active={filter === 'note'} onClick={() => setFilter('note')}>
          In notes
        </FilterChip>
        <FilterChip active={filter === 'document'} onClick={() => setFilter('document')}>
          In documents
        </FilterChip>
        <FilterChip active={filter === 'todo'} onClick={() => setFilter('todo')}>
          In todos
        </FilterChip>
      </div>
      {hitsQ.error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Search failed: {hitsQ.error instanceof Error ? hitsQ.error.message : String(hitsQ.error)}
        </div>
      ) : !submitted.trim() ? (
        <div className="page-subtle">Enter an entity to find its mentions.</div>
      ) : hitsQ.isFetching ? (
        <div className="page-subtle">Searching…</div>
      ) : hits.length === 0 ? (
        <div className="page-subtle">No mentions of "{submitted}".</div>
      ) : (
        <SearchResultsList hits={hits} />
      )}
    </div>
  );
}
