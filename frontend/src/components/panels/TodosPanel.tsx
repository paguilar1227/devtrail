// The shared todos surface — THE one todo-list implementation, used by
// Home's Todos tab (scope 'personal' | 'all') and the project page's
// Todos tab (scope = project UUID). Consolidates what used to be four
// divergent renderers (Home column, Todos page, project tab, drawer).
//
// - Group: top-level todos bucket by their durable `section` field; subtasks
//   nest under their parent; completed top-levels collapse into one Done
//   group at the very bottom.
// - Arrange: drag a row to reorder it or move it to another section
//   (SectionedTodoList → todo.section + manual_order, both already in the DB).
// - Lens: sort (defaults to Manual so a dragged arrangement is what you
//   see) + priority chips + Overdue/Today due lenses + tag filter + the
//   same hybrid SearchInput as Home.
// - Capture: quick-add row (Enter = fast add, "Add details" pops the
//   detail drawer for priority/due/tags/subtasks in one motion).

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { FilterChip } from '../primitives';
import { TodoSortDropdown } from '../SortDropdown';
import { SearchInput, type SigilKind } from '../SearchInput';
import { TodoRow } from '../TodoRow';
import { SectionedTodoList } from '../SectionedTodoList';
import { HomeTagFilter } from '../HomeTagFilter';
import { createTodo, listTodos, updateTodo } from '../../lib/api';
import { toUiTodo } from '../../lib/view';
import { useEntitySearch } from '../../lib/useEntitySearch';
import { useTagSuggestions } from '../../lib/useTagSuggestions';
import { useTodoExpansion } from '../../lib/useTodoExpansion';
import { useTodoSortMode } from '../../lib/useTodoSortMode';
import { groupTodosBySection } from '../../lib/todoSections';
import { matchesTagFilter, EMPTY_FILTER, type TagFilter } from '../../lib/tagFilter';
import { cls, isOverdue } from '../../lib/util';
import type { ActionDispatch, Todo, TodoPriority } from '../../types';

// Personal = project-less rows; All = no filter; anything else = project UUID.
export type PanelScope = 'personal' | 'all' | string;

interface Props {
  scope: PanelScope;
  onAction: ActionDispatch;
  /** Human label for the scope, used in placeholders ("Add a todo to
   *  Website Redesign…"). Falls back to scope-generic wording. */
  contextLabel?: string;
}

const TODO_SIGILS: readonly SigilKind[] = ['tag'];
const NO_MENTIONS: never[] = [];
const PRIORITIES: TodoPriority[] = ['p1', 'p2', 'p3'];

type DueLens = 'overdue' | 'today' | null;

export const scopeToProjectId = (scope: PanelScope): 'null' | string | undefined =>
  scope === 'personal' ? 'null' : scope === 'all' ? undefined : scope;

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

// Mutations here touch counts on several dashboards; invalidate broadly.
const INVALIDATE_KEYS = [['todos'], ['stats'], ['project-counts'], ['activity']];

export function TodosPanel({ scope, onAction, contextLabel }: Props) {
  const qc = useQueryClient();
  const projectId = scopeToProjectId(scope);
  const isProjectScope = scope !== 'personal' && scope !== 'all';

  // Sort defaults to Manual so a dragged arrangement is what you see.
  const { mode: sortMode, setMode: setSortMode } = useTodoSortMode(`panel:${scope}`, 'manual');
  const [tagFilter, setTagFilter] = useState<TagFilter>(EMPTY_FILTER);
  const [prioSel, setPrioSel] = useState<Set<TodoPriority>>(() => new Set());
  const [dueLens, setDueLens] = useState<DueLens>(null);
  const [extraSections, setExtraSections] = useState<string[]>([]);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionDraft, setSectionDraft] = useState('');
  const [doneOpen, setDoneOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const { isExpanded, toggle: toggleExpand } = useTodoExpansion();

  // keepPreviousData: the scope prop re-keys this query mid-interaction
  // (Home's Personal/All toggle). Keeping the previous scope's rows
  // visible during the swap avoids the "Loading…" flash that reads as a
  // full page reload — same load-bearing pattern the old Home documented.
  const todosQ = useQuery({
    queryKey: ['todos', 'panel', scope],
    queryFn: () => listTodos(projectId === undefined ? {} : { project_id: projectId }),
    placeholderData: keepPreviousData,
  });
  const allTodos: Todo[] = useMemo(() => (todosQ.data ?? []).map(toUiTodo), [todosQ.data]);

  // --- search (hybrid) — flat results, bypasses sections ---
  const { query, setQuery, searchActive, rawHits } = useEntitySearch({ projectId, entityTypes: ['todo'] });
  const tagSuggestions = useTagSuggestions(
    scope === 'personal' ? { scope: 'personal', type: 'todo' }
      : scope === 'all' ? { type: 'todo' }
        : { project_id: scope, type: 'todo' },
  );
  const searchRows = useMemo(() => {
    const seen = new Set<string>();
    const out: Todo[] = [];
    for (const h of rawHits) {
      if (h.type !== 'todo' || seen.has(h.todo.id)) continue;
      seen.add(h.todo.id);
      out.push(toUiTodo(h.todo));
    }
    return out;
  }, [rawHits]);

  // View state must not leak across scopes: a tag/priority filter or a
  // half-typed section from one scope silently applied to another reads
  // as data loss. (The quick-add draft is deliberately kept — losing
  // typed text on a scope flip is worse.)
  useEffect(() => {
    setTagFilter(EMPTY_FILTER);
    setPrioSel(new Set());
    setDueLens(null);
    setExtraSections([]);
    setAddingSection(false);
    setSectionDraft('');
    setDoneOpen(false);
    setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const invalidate = () => {
    for (const key of INVALIDATE_KEYS) qc.invalidateQueries({ queryKey: key });
  };

  // Quick-add: personal/all scope captures into the Inbox (no project);
  // project scope creates in the project.
  const createMut = useMutation({
    mutationFn: (content: string) =>
      createTodo({ content, project_id: isProjectScope ? scope : null }),
    onSuccess: invalidate,
  });

  // --- filters apply to a todo's ROOT (tags/priority/due are root-only); a
  //     subtask is kept iff its top-level ancestor is kept. ---
  const byId = useMemo(() => new Map(allTodos.map((t) => [t.id, t])), [allTodos]);
  const rootOf = (t: Todo): Todo => {
    let cur = t;
    while (cur.parent_id && byId.get(cur.parent_id)) cur = byId.get(cur.parent_id)!;
    return cur;
  };
  const matchesDue = (t: Todo): boolean =>
    dueLens === null ? true
      : dueLens === 'overdue' ? t.status !== 'done' && !!t.due_at && isOverdue(t.due_at)
        : t.status !== 'done' && isDueToday(t.due_at);
  const filtered = useMemo(() => {
    if (tagFilter.tags.length === 0 && prioSel.size === 0 && dueLens === null) return allTodos;
    return allTodos.filter((t) => {
      const root = rootOf(t);
      return (
        matchesTagFilter(root, tagFilter) &&
        (prioSel.size === 0 || prioSel.has(root.priority)) &&
        matchesDue(root)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTodos, tagFilter, prioSel, dueLens]);

  const grouped = useMemo(
    () => groupTodosBySection(filtered, { mode: sortMode, isExpanded, extraSections }),
    [filtered, sortMode, isExpanded, extraSections],
  );

  // Tag options for HomeTagFilter — distinct ROOT tags in scope with usage
  // counts (filters apply to a todo's root, so subtask-only tags are excluded).
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of allTodos) if (!t.parent_id) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, total]) => ({ name, total }));
  }, [allTodos]);

  // Due-lens counts run over roots so the chip promises what the filter shows.
  const roots = useMemo(() => allTodos.filter((t) => !t.parent_id), [allTodos]);
  const overdueCount = roots.filter((t) => t.status !== 'done' && !!t.due_at && isOverdue(t.due_at)).length;
  const todayCount = roots.filter((t) => t.status !== 'done' && isDueToday(t.due_at)).length;

  const toggleDone = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) => updateTodo(id, { status }),
    onSuccess: invalidate,
  });

  const openTodo = (t: Todo) => onAction({ kind: 'todo-detail', payload: t });
  const onToggleDone = (t: Todo) =>
    toggleDone.mutate({ id: t.id, status: t.status === 'done' ? 'not_started' : 'done' });

  const commitSection = () => {
    const name = sectionDraft.trim();
    setAddingSection(false);
    setSectionDraft('');
    if (!name) return;
    setExtraSections((s) => (s.includes(name) ? s : [...s, name]));
  };

  const toggleSet = <T,>(set: Set<T>, v: T): Set<T> => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    return n;
  };

  const addPlaceholder = isProjectScope
    ? `Add a todo to ${contextLabel ?? 'this project'} — Enter to save`
    : '+ New todo (personal Inbox) — Enter to save';

  return (
    <div className="todos-panel">
      {!searchActive && (
        <>
          <div className="todo-input-row">
            <div className="field">
              <Icons.Plus />
              <input
                placeholder={addPlaceholder}
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
                due / tags / subtasks can be attached in one motion. */}
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

      <div className="todos-toolbar">
        <div className="search-box">
          <Icons.Search size={13} />
          <SearchInput
            value={query}
            onChange={setQuery}
            onSubmit={() => { /* live */ }}
            tags={tagSuggestions}
            mentions={NO_MENTIONS}
            sigils={TODO_SIGILS}
            placeholder={contextLabel ? `Search ${contextLabel} todos… try #tag` : 'Search todos… try #tag'}
          />
        </div>
        {!searchActive && (
          <>
            <TodoSortDropdown id={`panel-${scope}-sort`} mode={sortMode} onChange={setSortMode} />
            {addingSection ? (
              <input
                className="folder-field-input todos-section-input"
                autoFocus
                placeholder="Section name"
                value={sectionDraft}
                onChange={(e) => setSectionDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitSection(); }
                  if (e.key === 'Escape') { setAddingSection(false); setSectionDraft(''); }
                }}
                onBlur={commitSection}
              />
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setAddingSection(true)}>
                <Icons.Plus size={12} /> Add section
              </button>
            )}
          </>
        )}
      </div>

      {!searchActive && allTodos.length > 0 && (
        <div className="todos-filters">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              className={cls('filter-chip', prioSel.has(p) && 'active')}
              onClick={() => setPrioSel((s) => toggleSet(s, p))}
            >
              {p.toUpperCase()}
            </button>
          ))}
          <span style={{ width: 1, height: 18, background: 'var(--hairline)', margin: '0 4px' }} />
          <FilterChip active={dueLens === 'overdue'} onClick={() => setDueLens((d) => (d === 'overdue' ? null : 'overdue'))}>
            Overdue <span style={{ marginLeft: 4 }}>{overdueCount}</span>
          </FilterChip>
          <FilterChip active={dueLens === 'today'} onClick={() => setDueLens((d) => (d === 'today' ? null : 'today'))}>
            Today <span style={{ marginLeft: 4 }}>{todayCount}</span>
          </FilterChip>
          {(prioSel.size > 0 || dueLens !== null) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPrioSel(new Set()); setDueLens(null); }}>
              Clear
            </button>
          )}
        </div>
      )}

      {!searchActive && (tagOptions.length > 0 || tagFilter.tags.length > 0) && (
        <div className="view-tagbar">
          <HomeTagFilter options={tagOptions} filter={tagFilter} onChange={setTagFilter} />
        </div>
      )}

      <div className="todos-body">
        {todosQ.isLoading ? (
          <div className="page-subtle">Loading…</div>
        ) : todosQ.error ? (
          <div className="page-subtle" style={{ color: 'var(--danger)' }}>
            Failed to load todos: {todosQ.error instanceof Error ? todosQ.error.message : String(todosQ.error)}
          </div>
        ) : searchActive ? (
          searchRows.length === 0 ? (
            <div className="page-subtle">No todos match.</div>
          ) : (
            <div className="todos-search-rows">
              {searchRows.map((t) => (
                <TodoRow key={t.id} todo={t} onClick={() => openTodo(t)} onToggleDone={() => onToggleDone(t)} />
              ))}
            </div>
          )
        ) : allTodos.length === 0 ? (
          <div className="page-subtle">
            {isProjectScope ? 'No todos in this project yet — capture above.' : 'Inbox is empty — capture above to get started.'}
          </div>
        ) : (
          <>
            <SectionedTodoList
              sections={grouped.sections}
              isExpanded={isExpanded}
              onToggleExpand={toggleExpand}
              onClickRow={openTodo}
              onToggleDone={onToggleDone}
              invalidateKeys={INVALIDATE_KEYS}
            />
            {grouped.done.length > 0 && (
              <section className="todos-section todos-done">
                <button
                  className="todos-section-head todos-done-head"
                  onClick={() => setDoneOpen((v) => !v)}
                  aria-expanded={doneOpen}
                >
                  <Icons.Check size={12} />
                  <span className="todos-section-name">Done</span>
                  <span className="ct">{grouped.done.filter((r) => r.depth === 0).length}</span>
                  <Icons.ChevronRight size={12} className={cls('todos-done-chev', doneOpen && 'open')} />
                </button>
                {doneOpen && (
                  <div className="todos-section-body">
                    {grouped.done.map((r) => (
                      <TodoRow
                        key={r.todo.id}
                        todo={r.todo}
                        depth={r.depth}
                        onClick={() => openTodo(r.todo)}
                        onToggleDone={() => onToggleDone(r.todo)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
