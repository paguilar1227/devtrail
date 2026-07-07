import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../../components/Icons';
import { FilterChip } from '../../components/primitives';
import { TodoSortDropdown } from '../../components/SortDropdown';
import { SearchInput, type SigilKind } from '../../components/SearchInput';
import { TodoRow } from '../../components/TodoRow';
import { createTodo, listTodos, updateTodo } from '../../lib/api';
import { toUiTodo } from '../../lib/view';
import { useEntitySearch } from '../../lib/useEntitySearch';
import { useTagSuggestions } from '../../lib/useTagSuggestions';
import { compareForMode } from '../../lib/todoSort';
import { useTodoSortMode } from '../../lib/useTodoSortMode';
import { isOverdue } from '../../lib/util';
import type { ActionDispatch, Project, Todo } from '../../types';

interface Props {
  project: Project;
  onAction: ActionDispatch;
}

type HierMode = 'hierarchy' | 'flat';
type RowFilter = 'all' | 'open' | 'overdue' | 'today' | 'p1';

const isDueToday = (dueAt: string | null | undefined): boolean => {
  if (!dueAt) return false;
  const due = new Date(dueAt);
  const now = new Date();
  return (
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate()
  );
};

const matchesRowFilter = (t: Todo, f: RowFilter): boolean => {
  switch (f) {
    case 'all': return true;
    case 'open': return t.status !== 'done';
    case 'overdue': return t.status !== 'done' && !!t.due_at && isOverdue(t.due_at);
    case 'today': return t.status !== 'done' && isDueToday(t.due_at);
    case 'p1': return t.priority === 'p1';
  }
};

const TODO_SIGILS: readonly SigilKind[] = ['tag'];
const NO_MENTIONS: never[] = [];

export function TodosTab({ project, onAction }: Props) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['todos', 'project', project.id],
    queryFn: () => listTodos({ project_id: project.id }),
  });
  const all = useMemo(() => (data ?? []).map(toUiTodo), [data]);

  // Hybrid search scoped to this project's todos — typing flips the tab to a
  // flat ranked result list; clearing returns to the hierarchy/groups view.
  const { query, setQuery, searchActive, rawHits, isFetching: searchFetching, error: searchError } =
    useEntitySearch({ projectId: project.id, entityTypes: ['todo'] });
  const tagSuggestions = useTagSuggestions({ project_id: project.id, type: 'todo' });
  const todoSearchRows = useMemo(() => {
    const seen = new Set<string>();
    const out: Todo[] = [];
    for (const h of rawHits) {
      if (h.type !== 'todo' || seen.has(h.todo.id)) continue;
      seen.add(h.todo.id);
      out.push(toUiTodo(h.todo));
    }
    return out;
  }, [rawHits]);

  const [hierMode, setHierMode] = useState<HierMode>('hierarchy');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [rowFilter, setRowFilter] = useState<RowFilter>('all');
  const { mode: sortMode, setMode: setSortMode } = useTodoSortMode(`project:${project.id}`);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['todos'] });
    qc.invalidateQueries({ queryKey: ['project-counts'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };

  const createMut = useMutation({
    mutationFn: (content: string) => createTodo({ content, project_id: project.id }),
    onSuccess: invalidate,
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) => updateTodo(id, { status }),
    onSuccess: invalidate,
  });

  const groups = useMemo(() => {
    const cmp = compareForMode(sortMode);
    const visible = all.filter((t) => matchesRowFilter(t, rowFilter));
    const open = visible.filter(t => t.status !== 'done').slice().sort(cmp);
    const done = visible.filter(t => t.status === 'done').slice().sort(cmp);
    return { open, done };
  }, [all, sortMode, rowFilter]);

  const openCount = all.filter(t => t.status !== 'done').length;
  const overdueCount = all.filter(t => matchesRowFilter(t, 'overdue')).length;
  const todayCount = all.filter(t => matchesRowFilter(t, 'today')).length;
  const p1Count = all.filter(t => matchesRowFilter(t, 'p1')).length;
  // A non-'all' filter can strip a child's ancestors out of the group, so
  // the hierarchy walk would drop it entirely — render filtered views flat
  // (same mode-switch the search results use).
  const effectiveHierMode: HierMode = rowFilter === 'all' ? hierMode : 'flat';

  const toggleCollapse = (id: string) =>
    setCollapsed(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Same TodoRow the Todos view uses — keeps the project Todos visually
  // consistent (one done checkbox, no card, no multi-select). The hierarchy
  // walk passes childCount so the row renders its own expand chevron, and
  // hiddenDescendants so a depth-capped row shows the "+N deeper" hint
  // (matching SectionedTodoList on the Todos view).
  const renderTodo = (t: Todo, depth = 0, childCount = 0, hiddenDescendants = 0) => (
    <TodoRow
      key={t.id}
      todo={t}
      depth={depth}
      childCount={childCount}
      expanded={!collapsed.has(t.id)}
      hiddenDescendants={hiddenDescendants}
      onToggleExpand={childCount > 0 ? () => toggleCollapse(t.id) : undefined}
      onClick={() => onAction({ kind: 'todo-detail', payload: t })}
      onToggleDone={() =>
        toggleMut.mutate({ id: t.id, status: t.status === 'done' ? 'not_started' : 'done' })
      }
    />
  );

  const renderHierGroup = (todos: Todo[]) => {
    const childrenOf = (pid: string) => todos.filter(c => c.parent_id === pid);
    // Total descendants under an id (all levels) — used at the depth cap so the
    // "+N deeper" hint counts everything hidden below the last rendered row.
    const descendantCount = (id: string): number =>
      childrenOf(id).reduce((sum, k) => sum + 1 + descendantCount(k.id), 0);
    const walk = (t: Todo, depth: number): JSX.Element => {
      const kids = childrenOf(t.id);
      const isCollapsed = collapsed.has(t.id);
      return (
        <Fragment key={t.id}>
          {renderTodo(t, depth, kids.length)}
          {!isCollapsed && depth < 3 ? kids.map(c => walk(c, depth + 1)) : null}
          {/* Cap at depth 3: render the last level flat (no chevron), but
              surface any deeper descendants via the "+N deeper" hint. */}
          {!isCollapsed && depth === 3
            ? kids.map(c => renderTodo(c, 3, 0, descendantCount(c.id)))
            : null}
        </Fragment>
      );
    };
    return todos.filter(t => !t.parent_id).map(top => walk(top, 0));
  };

  if (error) {
    return <div className="page-subtle" style={{ color: 'var(--danger)' }}>Failed to load todos: {String((error as Error).message)}</div>;
  }
  if (isLoading) {
    return <div className="page-subtle">Loading todos…</div>;
  }

  return (
    <div>
      {searchActive ? null : (
        <>
          <div className="todo-input-row">
            <div className="field">
              <Icons.Plus />
              <input
                placeholder={`Add a todo to ${project.name} — Enter to save`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.trim() && !createMut.isPending) {
                    e.preventDefault();
                    const content = draft.trim();
                    setDraft('');
                    createMut.mutate(content);
                  }
                }}
                disabled={createMut.isPending}
              />
            </div>
            {/* Create from the draft, then pop the detail drawer so priority /
                due / tags / subtasks can be attached in one motion (same
                affordance the Home quick-add gives for free). */}
            <button
              className="btn"
              disabled={!draft.trim() || createMut.isPending}
              onClick={async () => {
                const content = draft.trim();
                if (!content) return;
                setDraft('');
                try {
                  const created = await createMut.mutateAsync(content);
                  onAction({ kind: 'todo-detail', payload: toUiTodo(created) });
                } catch {
                  // createMut.error renders below the input row; without this
                  // catch the rejection would be unhandled and the drawer
                  // could never open anyway.
                }
              }}
            >
              Add details
            </button>
          </div>
          {createMut.error ? (
            <div className="page-subtle" style={{ color: 'var(--danger)', marginTop: 4 }}>
              Failed to create todo: {createMut.error instanceof Error ? createMut.error.message : String(createMut.error)}
            </div>
          ) : null}
        </>
      )}

      <div className="filter-bar">
        {searchActive ? null : (
          <>
            <FilterChip active={rowFilter === 'all'} onClick={() => setRowFilter('all')}>
              All <span style={{ marginLeft: 4 }}>{all.length}</span>
            </FilterChip>
            <FilterChip active={rowFilter === 'open'} onClick={() => setRowFilter('open')}>
              Open <span style={{ marginLeft: 4 }}>{openCount}</span>
            </FilterChip>
            <FilterChip active={rowFilter === 'overdue'} onClick={() => setRowFilter('overdue')}>
              Overdue <span style={{ marginLeft: 4 }}>{overdueCount}</span>
            </FilterChip>
            <FilterChip active={rowFilter === 'today'} onClick={() => setRowFilter('today')}>
              Today <span style={{ marginLeft: 4 }}>{todayCount}</span>
            </FilterChip>
            <FilterChip active={rowFilter === 'p1'} onClick={() => setRowFilter('p1')}>
              P1 <span style={{ marginLeft: 4 }}>{p1Count}</span>
            </FilterChip>
          </>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <div className="search-box">
            <Icons.Search size={13} />
            <SearchInput
              value={query}
              onChange={setQuery}
              onSubmit={() => { /* live search — no submit */ }}
              tags={tagSuggestions}
              mentions={NO_MENTIONS}
              sigils={TODO_SIGILS}
              placeholder={`Search ${project.name} todos… try #tag`}
            />
          </div>
          {searchActive ? null : (
            <>
              <TodoSortDropdown id={`project-${project.id}-sort`} mode={sortMode} onChange={setSortMode} />
              <span className="seg-toggle">
                {/* Key off effectiveHierMode: a row filter forces flat, and the
                    control must reflect what's actually rendered. */}
                <button
                  className={effectiveHierMode === 'hierarchy' ? 'active' : ''}
                  disabled={rowFilter !== 'all'}
                  title={rowFilter !== 'all' ? 'Switch the filter to "All" to use hierarchy view' : undefined}
                  onClick={() => setHierMode('hierarchy')}
                >
                  Hierarchy
                </button>
                <button className={effectiveHierMode === 'flat' ? 'active' : ''} onClick={() => setHierMode('flat')}>
                  Flat
                </button>
              </span>
            </>
          )}
        </span>
      </div>

      {searchActive ? (
        searchError ? (
          <div className="page-subtle" style={{ color: 'var(--danger)' }}>
            Search failed: {searchError instanceof Error ? searchError.message : String(searchError)}
          </div>
        ) : searchFetching && todoSearchRows.length === 0 ? (
          <div className="page-subtle">Searching…</div>
        ) : todoSearchRows.length === 0 ? (
          <div className="page-subtle">No todos match.</div>
        ) : (
          <div className="todo-list-drawer-rows">
            {todoSearchRows.map((t) => (
              <TodoRow
                key={t.id}
                todo={t}
                onClick={() => onAction({ kind: 'todo-detail', payload: t })}
                onToggleDone={() =>
                  toggleMut.mutate({ id: t.id, status: t.status === 'done' ? 'not_started' : 'done' })
                }
              />
            ))}
          </div>
        )
      ) : all.length === 0 ? (
        <div className="page-subtle">No todos in this project yet.</div>
      ) : (
        <>
          <div className="todo-group">
            <div className="todo-group-h">
              <Icons.ChevronDown size={11} className="chev" />
              <span>Open</span>
              <span className="ct">{groups.open.length}</span>
            </div>
            {effectiveHierMode === 'hierarchy' ? renderHierGroup(groups.open) : groups.open.map(t => renderTodo(t, 0))}
          </div>

          <div className="todo-group">
            <div className="todo-group-h">
              <Icons.ChevronDown size={11} className="chev" />
              <span>Done</span>
              <span className="ct">{groups.done.length}</span>
            </div>
            {effectiveHierMode === 'hierarchy' ? renderHierGroup(groups.done) : groups.done.map(t => renderTodo(t, 0))}
          </div>
        </>
      )}

    </div>
  );
}
