import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { BulkCheckbox, Checkbox, FilterChip, Priority, Tag } from '../components/primitives';
import { archiveTodo, createTodo, listTodos, updateTodo } from '../lib/api';
import { toUiTodo } from '../lib/view';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { ActionDispatch, Todo } from '../types';

interface Props {
  onAction: ActionDispatch;
}

export function InboxPage({ onAction }: Props) {
  const qc = useQueryClient();
  // The backend lookup uses the literal "null" string to mean "personal/inbox"
  // (project_id IS NULL). See TodoListQuerySchema and the seed comment.
  const { data, isLoading, error } = useQuery({
    queryKey: ['todos', 'inbox'],
    queryFn: () => listTodos({ project_id: 'null' }),
  });
  const todos = useMemo(() => (data ?? []).map(toUiTodo), [data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const toggle = (id: string) =>
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['todos'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };
  const createMut = useMutation({
    mutationFn: (content: string) => createTodo({ content }),
    onSuccess: invalidate,
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) => updateTodo(id, { status }),
    onSuccess: invalidate,
  });
  const archiveMut = useMutation({
    mutationFn: (id: string) => archiveTodo(id),
    onSuccess: invalidate,
  });

  const overdueCount = todos.filter(t => t.status !== 'done' && t.due_at && isOverdue(t.due_at)).length;

  if (error) {
    return (
      <div className="page">
        <div className="page-subtle" style={{ color: 'var(--danger)' }}>
          Failed to load inbox: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="proj-hero">
        <div>
          <h1>Inbox</h1>
          <p className="page-subtle">
            Todos with no project. Capture quick thoughts here, then assign them later. Use ⌘K → "move to project" to file in bulk.
          </p>
        </div>
      </div>

      <div className="todo-input-row">
        <div className="field">
          <Icons.Plus />
          <input
            placeholder="Quick capture — press Enter to save"
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
          <span className="kbd">⏎</span>
        </div>
        <button className="btn">Add details</button>
      </div>
      {createMut.error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)', marginTop: 4 }}>
          Failed to create todo: {createMut.error instanceof Error ? createMut.error.message : String(createMut.error)}
        </div>
      ) : null}

      <div className="filter-bar">
        <FilterChip active>
          All <span style={{ marginLeft: 4 }}>{todos.length}</span>
        </FilterChip>
        <FilterChip>Open</FilterChip>
        <FilterChip>
          Overdue <span style={{ marginLeft: 4 }}>{overdueCount}</span>
        </FilterChip>
        <FilterChip>Today</FilterChip>
        <FilterChip>This week</FilterChip>
      </div>

      {isLoading ? (
        <div className="page-subtle">Loading inbox…</div>
      ) : todos.length === 0 ? (
        <div className="page-subtle">Inbox is empty — capture above to get started.</div>
      ) : (
        <div>
          {todos.map(t => (
            <div
              key={t.id}
              className={cls('todo', selected.has(t.id) && 'selected')}
              style={{ gridTemplateColumns: '18px 22px 1fr auto auto auto' }}
            >
              <BulkCheckbox checked={selected.has(t.id)} onClick={() => toggle(t.id)} />
              <Checkbox
                checked={t.status === 'done'}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  toggleMut.mutate({ id: t.id, status: t.status === 'done' ? 'not_started' : 'done' });
                }}
              />
              <div>
                <div className="nm">{t.title}</div>
                <div className="nm-meta">
                  {t.due_at ? (
                    <span className={isOverdue(t.due_at) ? 'due-overdue' : ''}>due {fmtRel(t.due_at)}</span>
                  ) : null}
                  {t.tags.map(tg => (
                    <Tag key={tg}>{tg}</Tag>
                  ))}
                  <span>created {fmtRel(t.created_at)}</span>
                </div>
              </div>
              <Priority p={t.priority} />
              <span className="todo-status-pill">{t.status.replace('_', ' ')}</span>
              <button className="btn btn-ghost btn-icon" onClick={() => onAction({ kind: 'todo-detail', payload: t })}>
                <Icons.More />
              </button>
            </div>
          ))}
        </div>
      )}

      {selected.size > 0 ? (
        <div className="bulk-bar">
          <span className="ct">{selected.size} selected</span>
          <span className="sep" />
          <button className="btn btn-sm">Move to project</button>
          <button className="btn btn-sm">Tag</button>
          <button className="btn btn-sm">Set priority</button>
          <button
            className="btn btn-sm"
            disabled={toggleMut.isPending}
            onClick={() => {
              const ids = Array.from(selected);
              setSelected(new Set());
              ids.forEach((id) => toggleMut.mutate({ id, status: 'done' }));
            }}
          >
            Mark done
          </button>
          <span className="sep" />
          <button
            className="btn btn-sm btn-danger"
            disabled={archiveMut.isPending}
            onClick={() => {
              const ids = Array.from(selected);
              setSelected(new Set());
              ids.forEach((id) => archiveMut.mutate(id));
            }}
          >
            Archive
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}
