// All personal (project-less) notes in a drawer. Mirrors DocListDrawer:
// clicking a row swaps the drawer body to NoteReaderBody with a "Back to
// list" affordance — the list state (search, sort, scroll, infinite
// cursor) survives the round trip because we don't unmount it, just hide
// it visually while the reader is up.
//
// Pagination: PAGE_SIZE rows per request ordered by created_at DESC.
// Next-page cursor is the oldest visible row's `created_at`. An
// IntersectionObserver sentinel at the bottom of the scroll area
// triggers fetchNextPage; guards on isFetchingNextPage so fast scrolls
// don't fire overlapping requests.
//
// Search (`q`) is part of the query key, so changing it resets the
// infinite cursor instead of appending mismatched pages. Sort is
// client-side — backend always returns created_at DESC, the caller
// re-orders the flattened rows.

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Drawer } from '../primitives';
import { NoteRow } from '../NoteRow';
import { SearchBox } from '../SearchBox';
import { NoteSortDropdown } from '../SortDropdown';
import { NoteReaderBody } from './NoteReaderDrawer';
import { listContent } from '../../lib/api';
import { toUiNote } from '../../lib/view';
import { useInView } from '../../lib/useInView';
import { useNoteSortMode, compareNotesForMode } from '../../lib/useNoteSortMode';
import type { ActionDispatch, Note, Route } from '../../types';

interface Props {
  onClose: () => void;
  onAction: ActionDispatch;
  onRoute?: (r: Route) => void;
}

const PAGE_SIZE = 20;

export function NoteListDrawer({ onClose, onAction: _onAction, onRoute }: Props) {
  const [q, setQ] = useState('');
  const { mode: sortMode, setMode: setSortMode } = useNoteSortMode('inbox');
  const [selected, setSelected] = useState<Note | null>(null);

  const pages = useInfiniteQuery({
    queryKey: ['content', 'notes', 'personal', 'infinite', q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listContent({
        type: 'note',
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

  const notes = useMemo(() => {
    const flat = (pages.data?.pages ?? []).flat();
    return [...flat].sort(compareNotesForMode(sortMode));
  }, [pages.data, sortMode]);

  const { ref: sentinelRef, inView } = useInView<HTMLDivElement>();
  useEffect(() => {
    if (inView && pages.hasNextPage && !pages.isFetchingNextPage) {
      pages.fetchNextPage();
    }
  }, [inView, pages.hasNextPage, pages.isFetchingNextPage, pages.fetchNextPage]);

  // Detail view: drawer title swaps to the note title, NoteReaderBody
  // renders with onBack = return-to-list. The list state stays mounted
  // so scroll position + search + sort survive.
  if (selected) {
    return (
      <Drawer title={selected.title} onClose={onClose}>
        <NoteReaderBody
          note={selected}
          onClose={onClose}
          onBack={() => setSelected(null)}
          onRoute={onRoute}
        />
      </Drawer>
    );
  }

  return (
    <Drawer title={`Personal notes · ${notes.length}${pages.hasNextPage ? '+' : ''}`} onClose={onClose}>
      <div className="todo-list-drawer-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search notes…" />
        <NoteSortDropdown id="inbox-notes-sort" mode={sortMode} onChange={setSortMode} />
      </div>
      {pages.error ? (
        <div className="page-subtle search-drawer-error">
          Failed to load: {pages.error instanceof Error ? pages.error.message : String(pages.error)}
        </div>
      ) : pages.isLoading ? (
        <div className="page-subtle">Loading…</div>
      ) : notes.length === 0 ? (
        <div className="page-subtle">{q ? 'No notes match.' : 'No personal notes yet.'}</div>
      ) : (
        <div className="todo-list-drawer-rows">
          {notes.map((n) => {
            const ui = toUiNote(n);
            return (
              <NoteRow
                key={ui.id}
                note={ui}
                onClick={() => setSelected(ui)}
              />
            );
          })}
          <div ref={sentinelRef} className="todo-list-drawer-sentinel" aria-hidden="true">
            {pages.isFetchingNextPage ? <span className="page-subtle">Loading more…</span> : null}
          </div>
        </div>
      )}
    </Drawer>
  );
}
