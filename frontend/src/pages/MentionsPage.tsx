import { Icons } from '../components/Icons';
import { FilterChip } from '../components/primitives';
import { SearchResultsList } from '../components/SearchResultsList';
import { SEARCH_HITS } from '../lib/mock';

export function MentionsPage() {
  const hits = SEARCH_HITS.slice(0, 4);
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
          <input placeholder="Search for an entity to find mentions of…" defaultValue="subscription cookies" />
        </div>
      </div>
      <div className="filter-bar">
        <FilterChip active>
          All mentions <span style={{ marginLeft: 4 }}>{hits.length}</span>
        </FilterChip>
        <FilterChip>In notes</FilterChip>
        <FilterChip>In documents</FilterChip>
        <FilterChip>In todos</FilterChip>
        <FilterChip>In chats</FilterChip>
      </div>
      <SearchResultsList hits={hits} />
    </div>
  );
}
