// All personal (project-less) todos in a drawer. The Home widget
// shows the top 6; this is the "see everything" escape valve. Reuses:
//   - <Drawer/> primitive (mobile fullscreen, expand-to-center toggle,
//     role="dialog", slide-in animation)
//   - <SortableTodoList/> for rendering + drag-to-reorder, so the
//     drawer and the Home column stay in lockstep
//   - useTodoExpansion so collapse state is shared with the column
//
// Detail view: clicking a row swaps the drawer body to TodoDetailDrawer
// inline (with onBack=return-to-list). The list state (search, sort,
// scroll, infinite cursor) survives because we don't unmount it. This
// mirrors NoteListDrawer / DocListDrawer.
//
// Unlike the column, the drawer renders the FULL hierarchy — no
// maxDepth — so grandchildren stay visible when their parent is open.
//
// Pagination: server returns at most PAGE_SIZE rows ordered by
// created_at DESC. The next-page cursor is the oldest visible row's
// `created_at`; an IntersectionObserver sentinel at the bottom of the
// scroll area triggers fetchNextPage. We keep all loaded pages joined
// before passing to sortPersonalTodos so the bias-based reorder (smart
// mode) treats them as a single corpus.

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Drawer } from '../primitives';
import { SortableTodoList } from '../SortableTodoList';
import { SearchBox } from '../SearchBox';
import { TodoDetailDrawer } from './TodoDetailDrawer';
import { listTodos, updateTodo } from '../../lib/api';
import { toUiTodo } from '../../lib/view';
import { sortPersonalTodos, type TodoSortMode } from '../../lib/todoSort';
import { useTodoExpansion } from '../../lib/useTodoExpansion';
import { useTodoSortMode } from '../../lib/useTodoSortMode';
import { useInView } from '../../lib/useInView';
import { TodoSortDropdown } from '../SortDropdown';
import { matchesTagFilter, type TagFilter } from '../../lib/tagFilter';
import type { ActionDispatch, Todo } from '../../types';

interface Props {
  onClose: () => void;
  onAction: ActionDispatch;
  /** Force-set the sort mode on open (e.g. clicking the "overdue"
   *  pill on Home routes here with `initialSort='due'`). Once set,
   *  the user can still override via the dropdown. */
  initialSort?: TodoSortMode;
  /** When set, only todos matching this tag filter are shown. The drawer
   *  has no in-UI toggle — clearing means closing + reopening from a
   *  filter-cleared Home (drawer state is ephemeral by design). */
  initialTagFilter?: TagFilter;
}

const PAGE_SIZE = 20;

export function TodoListDrawer({ onClose, onAction, initialSort, initialTagFilter }: Props) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const { isExpanded, toggle: toggleExpand } = useTodoExpansion();
  const { mode: sortMode, setMode: setSortMode } = useTodoSortMode('inbox');
  const [selected, setSelected] = useState<Todo | null>(null);

  // Apply the caller-requested initial sort once on mount. We persist
  // it through useTodoSortMode's setter so the choice sticks if the
  // user reopens the drawer later — matches their intent of "clicking
  // overdue means I want a due-date view." Empty dependency array so
  // re-renders don't keep re-applying the same value.
  useEffect(() => {
    if (initialSort && initialSort !== sortMode) {
      setSortMode(initialSort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pages = useInfiniteQuery({
    queryKey: ['todos', 'inbox', 'infinite', q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listTodos({
        project_id: 'null',
        limit: PAGE_SIZE,
        ...(pageParam ? { before: pageParam } : {}),
        ...(q ? { q } : {}),
      }),
    getNextPageParam: (lastPage) => {
      if (lastPage.length < PAGE_SIZE) return undefined; // exhausted
      return lastPage[lastPage.length - 1].created_at;
    },
  });

  const todosFlat = useMemo(
    () => (pages.data?.pages ?? []).flat().map(toUiTodo),
    [pages.data],
  );
  const todosFiltered = useMemo(
    () =>
      initialTagFilter && initialTagFilter.tags.length > 0
        ? todosFlat.filter((t) => matchesTagFilter(t, initialTagFilter))
        : todosFlat,
    [todosFlat, initialTagFilter],
  );
  const todos = sortPersonalTodos(todosFiltered, { mode: sortMode, isExpanded });

  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) =>
      updateTodo(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  // Sentinel — when this comes into view AND there's another page,
  // request it. Guards on `isFetchingNextPage` so we don't fire
  // overlapping fetches if the user scrolls fast.
  const { ref: sentinelRef, inView } = useInView<HTMLDivElement>();
  useEffect(() => {
    if (inView && pages.hasNextPage && !pages.isFetchingNextPage) {
      pages.fetchNextPage();
    }
  }, [inView, pages.hasNextPage, pages.isFetchingNextPage, pages.fetchNextPage]);

  const totalLoaded = todos.length;

  // Detail view: re-use the existing TodoDetailDrawer but supply onBack so
  // it renders a back affordance. The list stays mounted underneath only
  // logically — visually it's swapped out — so when the user clicks back
  // the search / sort / scroll position survives unchanged.
  if (selected) {
    return (
      <TodoDetailDrawer
        key={selected.id}
        todo={selected}
        onClose={onClose}
        onBack={() => setSelected(null)}
        onAction={onAction}
      />
    );
  }

  return (
    <Drawer title={`Personal todos · ${totalLoaded}${pages.hasNextPage ? '+' : ''}`} onClose={onClose}>
      <div className="todo-list-drawer-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search todos…" />
        <TodoSortDropdown id="inbox-sort" mode={sortMode} onChange={setSortMode} />
      </div>
      {pages.error ? (
        <div className="page-subtle search-drawer-error">
          Failed to load: {pages.error instanceof Error ? pages.error.message : String(pages.error)}
        </div>
      ) : pages.isLoading ? (
        <div className="page-subtle">Loading…</div>
      ) : todos.length === 0 && !pages.hasNextPage ? (
        <div className="page-subtle">
          {q
            ? 'No todos match.'
            : initialTagFilter && initialTagFilter.tags.length > 0
              ? `No personal todos with ${initialTagFilter.tags.length === 1 ? 'tag' : 'tags'} ${initialTagFilter.tags.map((t) => `#${t}`).join(initialTagFilter.mode === 'and' ? ' AND ' : ' or ')}.`
              : 'No personal todos yet.'}
        </div>
      ) : (
        <div className="todo-list-drawer-rows">
          {todos.length === 0 && initialTagFilter && initialTagFilter.tags.length > 0 ? (
            <div className="page-subtle">
              Searching older entries for matches…
            </div>
          ) : (
            <SortableTodoList
              rows={todos}
              allRows={todos}
              isExpanded={isExpanded}
              onToggleExpand={toggleExpand}
              onClickRow={(t) => setSelected(t)}
              onToggleDone={(t) =>
                toggle.mutate({
                  id: t.id,
                  status: t.status === 'done' ? 'not_started' : 'done',
                })
              }
            />
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
