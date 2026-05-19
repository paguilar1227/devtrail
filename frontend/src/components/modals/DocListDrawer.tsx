// All personal (project-less) documents in a drawer. Mirrors NoteListDrawer
// for chrome and pagination, with one important difference: clicking a doc
// does NOT close the drawer and swap in a doc-reader drawer. Instead, the
// detail view renders INSIDE this drawer (via DocReaderBody) with a "Back
// to list" button at the top. Search, sort, and scroll position survive
// the round trip — the user picks a doc, reads it, hits back, and is right
// where they left off in the list.

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Drawer } from '../primitives';
import { DocRow } from '../DocRow';
import { SearchBox } from '../SearchBox';
import { NoteSortDropdown } from '../SortDropdown';
import { DocReaderBody } from './DocReaderDrawer';
import { listContent } from '../../lib/api';
import { toUiDocument } from '../../lib/view';
import { useInView } from '../../lib/useInView';
import { useNoteSortMode, compareNotesForMode } from '../../lib/useNoteSortMode';
import { matchesTagFilter, type TagFilter } from '../../lib/tagFilter';
import type { ActionDispatch, DocumentItem, Route } from '../../types';

interface Props {
  onClose: () => void;
  onAction: ActionDispatch;
  onRoute?: (r: Route) => void;
  /** When set, only documents matching this tag filter are shown. */
  initialTagFilter?: TagFilter;
}

const PAGE_SIZE = 20;

export function DocListDrawer({ onClose, onAction: _onAction, onRoute, initialTagFilter }: Props) {
  const [q, setQ] = useState('');
  const { mode: sortMode, setMode: setSortMode } = useNoteSortMode('docs:inbox');
  const [selected, setSelected] = useState<DocumentItem | null>(null);

  const pages = useInfiniteQuery({
    queryKey: ['content', 'documents', 'personal', 'infinite', q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listContent({
        type: 'document',
        project_id: 'null',
        limit: PAGE_SIZE,
        ...(pageParam ? { before: pageParam } : {}),
        ...(q ? { q } : {}),
      }),
    getNextPageParam: (lastPage) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      return lastPage[lastPage.length - 1].created_at;
    },
  });

  const docs = useMemo(() => {
    const flat = (pages.data?.pages ?? []).flat();
    const filtered =
      initialTagFilter && initialTagFilter.tags.length > 0
        ? flat.filter((d) => matchesTagFilter(d, initialTagFilter))
        : flat;
    return filtered.slice().sort(compareNotesForMode(sortMode)).map(toUiDocument);
  }, [pages.data, sortMode, initialTagFilter]);

  const { ref: sentinelRef, inView } = useInView<HTMLDivElement>();
  useEffect(() => {
    if (inView && pages.hasNextPage && !pages.isFetchingNextPage) {
      pages.fetchNextPage();
    }
  }, [inView, pages.hasNextPage, pages.isFetchingNextPage, pages.fetchNextPage]);

  // Detail view: drawer title swaps to the doc title, DocReaderBody renders
  // with onBack = return-to-list. We don't unmount the list state; only
  // hide it visually, so scroll position + search + sort survive.
  if (selected) {
    return (
      <Drawer title={selected.title} onClose={onClose}>
        <DocReaderBody
          doc={selected}
          onClose={onClose}
          onBack={() => setSelected(null)}
          onRoute={onRoute}
        />
      </Drawer>
    );
  }

  return (
    <Drawer title={`Personal documents · ${docs.length}${pages.hasNextPage ? '+' : ''}`} onClose={onClose}>
      <div className="todo-list-drawer-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search documents…" />
        <NoteSortDropdown id="inbox-docs-sort" mode={sortMode} onChange={setSortMode} />
      </div>
      {pages.error ? (
        <div className="page-subtle search-drawer-error">
          Failed to load: {pages.error instanceof Error ? pages.error.message : String(pages.error)}
        </div>
      ) : pages.isLoading ? (
        <div className="page-subtle">Loading…</div>
      ) : docs.length === 0 && !pages.hasNextPage ? (
        <div className="page-subtle">
          {q
            ? 'No documents match.'
            : initialTagFilter && initialTagFilter.tags.length > 0
              ? `No personal documents with ${initialTagFilter.tags.length === 1 ? 'tag' : 'tags'} ${initialTagFilter.tags.map((t) => `#${t}`).join(initialTagFilter.mode === 'and' ? ' AND ' : ' or ')}.`
              : 'No personal documents yet.'}
        </div>
      ) : (
        <div className="todo-list-drawer-rows">
          {docs.length === 0 && initialTagFilter && initialTagFilter.tags.length > 0 ? (
            <div className="page-subtle">Searching older entries for matches…</div>
          ) : (
            docs.map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                onClick={() => setSelected(d)}
              />
            ))
          )}
          {pages.hasNextPage ? (
            <div ref={sentinelRef} className="todo-list-drawer-sentinel" aria-hidden="true">
              {pages.isFetchingNextPage ? <span className="page-subtle">Loading more…</span> : null}
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
