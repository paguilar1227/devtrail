// Home — personal-scope landing page. Absorbs what used to be the Inbox
// (project-less todos), adds project-less notes alongside it, and exposes
// search at the top with a Personal/All-projects scope toggle.
//
// Layout (top to bottom):
//   1. Hero      — greeting + New project button.
//   2. Search    — input + scope toggle. Enter routes to /search?q=… so
//                  the existing Search route owns rendering of results.
//   3. Top row   — Todos progress card + Recent activity preview.
//   4. Personal  — two columns: Personal todos | Personal notes, each
//                  with a quick-add input at the top.
//   5. Pinned    — chip strip linking to pinned projects.
//
// "Personal" means project_ids = [] (content) / project_id = null (todo).
// The backend's content list filter accepts a single project_id, not the
// "no project" case, so personal notes are filtered client-side.

import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { ActivityRow } from '../components/ActivityRow';
import { Icons } from '../components/Icons';
import { NoteRow } from '../components/NoteRow';
import { SortableTodoList } from '../components/SortableTodoList';
import { sortPersonalTodos } from '../lib/todoSort';
import { useTodoSortMode } from '../lib/useTodoSortMode';
import { TodoSortDropdown } from '../components/SortDropdown';
import { useTodoExpansion } from '../lib/useTodoExpansion';
import {
  createNote,
  createTodo,
  getContent,
  listActivity,
  listContent,
  listProjectCounts,
  listProjects,
  listTodos,
  getStats,
  updateTodo,
} from '../lib/api';
import { toUiActivity, toUiNote, toUiProjects, toUiTodo } from '../lib/view';
import { openActivityTarget } from '../lib/openActivity';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { ActionDispatch, Route, Todo } from '../types';

interface Props {
  onRoute: (r: Route) => void;
  onAction: ActionDispatch;
}

type SearchScope = 'personal' | 'all';

export function HomePage({ onRoute, onAction }: Props) {
  const qc = useQueryClient();

  const queries = useQueries({
    queries: [
      { queryKey: ['stats'], queryFn: () => getStats() },
      { queryKey: ['projects', 'all'], queryFn: () => listProjects() },
      { queryKey: ['project-counts'], queryFn: () => listProjectCounts() },
      { queryKey: ['todos', 'inbox'], queryFn: () => listTodos({ project_id: 'null' }) },
      // Backend filter: project_id='null' = rows with no project
      // membership. Server-side keeps Home fast as the corpus grows
      // instead of relying on a client-side filter over every note.
      { queryKey: ['content', 'notes', 'personal'], queryFn: () => listContent({ type: 'note', project_id: 'null' }) },
      { queryKey: ['activity', 'recent'], queryFn: () => listActivity({ limit: 4 }) },
    ],
  });
  const [statsQ, projectsQ, countsQ, todosQ, notesQ, activityQ] = queries;

  const projectsRaw = projectsQ.data ?? [];
  const projectsById = useMemo(
    () => new Map(projectsRaw.map((p) => [p.id, p])),
    [projectsRaw],
  );
  const projects = useMemo(
    () => toUiProjects(projectsRaw, countsQ.data ?? []),
    [projectsRaw, countsQ.data],
  );
  const pinned = projects.filter((p) => p.pinned && p.status === 'active');
  // Widget caps at depth=1 — anything deeper rolls up into a "+N deeper"
  // hint on the deepest visible row. Drawer (TodoListDrawer) gets the
  // full tree. Both surfaces honor the same per-parent expansion state.
  const { isExpanded, toggle: toggleExpand } = useTodoExpansion();
  const allPersonalTodos = useMemo(
    () => (todosQ.data ?? []).map(toUiTodo),
    [todosQ.data],
  );
  const { mode: sortMode, setMode: setSortMode } = useTodoSortMode('home');
  const personalTodos = useMemo(
    () => sortPersonalTodos(allPersonalTodos, { mode: sortMode, maxDepth: 1, isExpanded }),
    [allPersonalTodos, sortMode, isExpanded],
  );
  const personalNotes = notesQ.data ?? [];
  const activity = useMemo(
    () => (activityQ.data ?? []).map((e) => toUiActivity(e, projectsById)),
    [activityQ.data, projectsById],
  );
  const stats = statsQ.data;

  const isLoading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error)?.error;

  const todosTotal = stats?.counts.todos.total ?? 0;
  const todosDone = stats?.counts.todos.done ?? 0;
  const donePct = todosTotal > 0 ? Math.round((todosDone / todosTotal) * 100) : 0;
  // Overdue / due-this-week counts walk the full unfiltered list so
  // grandchildren beyond the widget cap still count.
  const overdueCount = allPersonalTodos.filter(
    (t) => t.status !== 'done' && t.due_at && isOverdue(t.due_at),
  ).length;
  const dueThisWeekCount = allPersonalTodos.filter((t) => {
    if (t.status === 'done' || !t.due_at) return false;
    const due = new Date(t.due_at).getTime();
    const now = Date.now();
    return due > now && due - now < 7 * 24 * 60 * 60 * 1000;
  }).length;

  // ── Search ───────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('personal');
  const submitSearch = () => {
    if (!query.trim()) return;
    onAction({ kind: 'search', payload: { query: query.trim(), scope } });
  };

  // ── Quick-add ───────────────────────────────────────────
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['todos'] });
    qc.invalidateQueries({ queryKey: ['content'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };
  const todoCreate = useMutation({
    mutationFn: (content: string) => createTodo({ content }),
    onSuccess: (todo) => {
      invalidate();
      // Pop the detail drawer for the just-created todo so the user can
      // immediately attach priority / due / tags / subtasks without an
      // extra click. They can dismiss with ESC or the close button if
      // the quick-capture was all they wanted.
      onAction({ kind: 'todo-detail', payload: toUiTodo(todo) });
    },
  });
  const noteCreate = useMutation({
    // Quick capture — first line becomes the title (capped at 80 chars),
    // full text goes into the body. Mirrors the NoteEditorModal contract
    // but keystroke-light for the Home column. On success, pop the
    // editor for the just-created note so the user can flesh out the
    // body / tags / project membership without an extra click. The
    // editor needs the full ContentItem (toUiNote signature), so we
    // refetch by id — POST /content only returns { id, status }.
    mutationFn: async (body: string) => {
      const firstLine = body.split('\n')[0].trim();
      const title = (firstLine || 'Untitled note').slice(0, 80);
      const created = await createNote({ type: 'note', title, content: body, project_ids: [], tags: [] });
      const full = await getContent(created.id);
      return full;
    },
    onSuccess: (item) => {
      invalidate();
      if (item.type === 'note') {
        onAction({ kind: 'note-edit', payload: toUiNote(item) });
      }
    },
  });
  const todoToggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) =>
      updateTodo(id, { status }),
    onSuccess: invalidate,
  });

  const [todoDraft, setTodoDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  if (error) {
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load home: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  if (isLoading || !stats) {
    return (
      <div className="page">
        <div className="page-subtle">Loading…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="proj-hero">
        <div>
          <h1>Welcome back, Alex.</h1>
        </div>
        <button className="btn btn-primary" onClick={() => onRoute({ route: 'projects', action: 'new' })}>
          <Icons.Plus /> New project
        </button>
      </div>

      <div className="home-search-row">
        <div className="home-search-box">
          <Icons.Search />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
            placeholder="Search your stuff — todos, notes, documents…"
          />
        </div>
        <div className="home-scope-toggle" role="tablist" aria-label="Search scope">
          <button
            type="button"
            role="tab"
            className={cls(scope === 'personal' && 'active')}
            onClick={() => setScope('personal')}
          >
            Personal
          </button>
          <button
            type="button"
            role="tab"
            className={cls(scope === 'all' && 'active')}
            onClick={() => setScope('all')}
          >
            All projects
          </button>
        </div>
      </div>

      <div className="home-top-row">
        <div className="stat-todos">
          <div className="lb">Todos</div>
          <div className="vl">
            {todosDone}
            <span className="vl-sub">/{todosTotal}</span>
          </div>
          <div className="ds">
            {donePct}% complete
            {dueThisWeekCount > 0 ? ` · ${dueThisWeekCount} due this week` : ''}
            {overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}
          </div>
        </div>
        <div className="stat-activity">
          <div className="ah">
            <div className="lb">Recent activity</div>
            <button className="btn btn-ghost btn-sm" onClick={() => onRoute({ route: 'activity' })}>
              Full feed →
            </button>
          </div>
          {activity.length === 0 ? (
            <div className="page-subtle">No recent activity.</div>
          ) : (
            <div className="activity-list activity-list-compact">
              {activity.map((a) => (
                <ActivityRow
                  key={a.id}
                  activity={a}
                  onClick={() => openActivityTarget(a, onAction)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="home-personal-h">
        <h2>Personal</h2>
        <span className="sub">project-less todos and notes</span>
      </div>

      <div className="home-personal-grid">
        <div className="pcol">
          <div className="pcol-h">
            <h3>Todos</h3>
            <span className="ct">{personalTodos.length}</span>
            <TodoSortDropdown id="home-todos-sort" mode={sortMode} onChange={setSortMode} />
          </div>
          <div className="pcol-add">
            <input
              placeholder="+ New todo (no project) — press Enter to add"
              value={todoDraft}
              onChange={(e) => setTodoDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && todoDraft.trim() && !todoCreate.isPending) {
                  e.preventDefault();
                  const c = todoDraft.trim();
                  setTodoDraft('');
                  todoCreate.mutate(c);
                }
              }}
              disabled={todoCreate.isPending}
            />
          </div>
          {personalTodos.length === 0 ? (
            <div className="pcol-empty">Inbox is empty — capture above to get started.</div>
          ) : (
            <>
              <SortableTodoList
                rows={personalTodos.slice(0, 6)}
                allRows={personalTodos}
                isExpanded={isExpanded}
                onToggleExpand={toggleExpand}
                onClickRow={(t) => onAction({ kind: 'todo-detail', payload: t })}
                onToggleDone={(t) =>
                  todoToggle.mutate({
                    id: t.id,
                    status: t.status === 'done' ? 'not_started' : 'done',
                  })
                }
              />
              {personalTodos.length > 6 ? (
                <button
                  className="pcol-more"
                  onClick={() => onAction({ kind: 'personal-todos' })}
                >
                  View {personalTodos.length - 6} more
                  <Icons.ChevronRight size={11} />
                </button>
              ) : null}
            </>
          )}
        </div>

        <div className="pcol">
          <div className="pcol-h">
            <h3>Notes</h3>
            <span className="ct">{personalNotes.length}</span>
          </div>
          <div className="pcol-add">
            <input
              placeholder="+ Quick note — press Enter to capture"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && noteDraft.trim() && !noteCreate.isPending) {
                  e.preventDefault();
                  const c = noteDraft.trim();
                  setNoteDraft('');
                  noteCreate.mutate(c);
                }
              }}
              disabled={noteCreate.isPending}
            />
          </div>
          {personalNotes.length === 0 ? (
            <div className="pcol-empty">No personal notes — capture above.</div>
          ) : (
            <>
              {personalNotes.slice(0, 6).map((n) => (
                <NoteRow
                  key={n.id}
                  note={toUiNote(n)}
                  onClick={() => onAction({ kind: 'note-edit', payload: toUiNote(n) })}
                />
              ))}
              {personalNotes.length > 6 ? (
                <button
                  className="pcol-more"
                  onClick={() => onAction({ kind: 'personal-notes' })}
                >
                  View {personalNotes.length - 6} more
                  <Icons.ChevronRight size={11} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {pinned.length > 0 ? (
        <div className="home-pinned-strip">
          <span className="label">Pinned</span>
          {pinned.map((p) => (
            <button
              key={p.id}
              className="pin-chip"
              onClick={() => onRoute({ route: 'project', project: p.id })}
            >
              <span className={cls('sb-proj-dot', p.accent)}></span>
              {p.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
