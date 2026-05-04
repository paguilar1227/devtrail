import { useState } from 'react';
import { Icons } from '../components/Icons';
import { FilterChip } from '../components/primitives';
import { SearchResultsList } from '../components/SearchResultsList';
import { SEARCH_HITS } from '../lib/mock';

export function SearchPage({ initialQuery = 'subscription cookies' }: { initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const hits = SEARCH_HITS;
  const [scope, setScope] = useState<'all' | 'claudepit'>('all');
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
          <input value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <button className="btn">Search</button>
      </div>
      <div className="filter-bar">
        <FilterChip active={scope === 'all'} onClick={() => setScope('all')}>
          All projects
        </FilterChip>
        <FilterChip active={scope === 'claudepit'} onClick={() => setScope('claudepit')}>
          ClaudePit
        </FilterChip>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <FilterChip active>vector</FilterChip>
          <FilterChip active>graph</FilterChip>
          <FilterChip>fts</FilterChip>
        </span>
      </div>
      <div className="subtle mono" style={{ fontSize: 11, marginBottom: 10 }}>
        {hits.length} results · 184ms
      </div>
      <SearchResultsList hits={hits} />
    </div>
  );
}
