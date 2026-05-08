import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { Drawer, EntityLink, Priority, Tag } from '../primitives';
import { createComment, getTodo, listTodoComments, updateTodo } from '../../lib/api';
import { cls, fmtDue, fmtRel, toDatetimeLocal } from '../../lib/util';
import type { Todo } from '../../types';

type PriorityVal = 'p1' | 'p2' | 'p3';

// UI priority is lowercase p1/p2/p3; the wire schema is uppercase P1/P2/P3
// (see toUiTodo's PRIORITY_MAP). Convert here so callers stay in UI shape.
const toWirePriority = (p: PriorityVal): 'P1' | 'P2' | 'P3' =>
  p.toUpperCase() as 'P1' | 'P2' | 'P3';

export function TodoDetailDrawer({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [priority, setPriority] = useState<PriorityVal>(todo.priority);
  const [dueLocal, setDueLocal] = useState<string>(toDatetimeLocal(todo.due_at));

  const commentsQ = useQuery({
    queryKey: ['todo-comments', todo.id],
    queryFn: () => listTodoComments(todo.id),
  });

  // Parent todo title — resolved on demand. The list/detail payload only
  // carries parent_id so we have to fetch it. Cached by id so jumping
  // around sibling subtasks doesn't refetch the same parent.
  const parentQ = useQuery({
    queryKey: ['todo', todo.parent_id],
    queryFn: () => getTodo(todo.parent_id!),
    enabled: !!todo.parent_id,
  });

  const addCommentMut = useMutation({
    mutationFn: (content: string) => createComment(todo.id, { content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todo-comments', todo.id] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      setDraft('');
    },
  });

  const updateMut = useMutation({
    mutationFn: (patch: { priority?: PriorityVal; due_date?: string | null }) =>
      updateTodo(todo.id, {
        ...(patch.priority ? { priority: toWirePriority(patch.priority) } : {}),
        ...('due_date' in patch ? { due_date: patch.due_date } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const submit = () => {
    const c = draft.trim();
    if (!c || addCommentMut.isPending) return;
    addCommentMut.mutate(c);
  };

  const setPriorityNow = (p: PriorityVal) => {
    if (p === priority) return;
    setPriority(p);
    updateMut.mutate({ priority: p });
  };

  // Save closes the drawer after pending edits. Priority fires
  // optimistically on chip click; due-date fires on input blur or
  // Save click. `dirty` reflects either is unsaved.
  const dueDirty = toDatetimeLocal(todo.due_at) !== dueLocal;
  const dirty = priority !== todo.priority || dueDirty;
  const dueWirePayload = (): string | null => {
    if (!dueLocal) return null;
    const ms = new Date(dueLocal).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const onSave = () => {
    if (dirty && !updateMut.isPending) {
      const patch: { priority?: PriorityVal; due_date?: string | null } = {};
      if (priority !== todo.priority) patch.priority = priority;
      if (dueDirty) patch.due_date = dueWirePayload();
      updateMut.mutate(patch, { onSuccess: () => onClose() });
    } else {
      onClose();
    }
  };

  const comments = commentsQ.data ?? [];

  return (
    <Drawer
      title={todo.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={updateMut.isPending}>Close</button>
          <button className="btn btn-primary" onClick={onSave} disabled={updateMut.isPending}>
            {updateMut.isPending ? 'Saving…' : dirty ? 'Save' : 'Done'}
          </button>
        </>
      }
    >
      <div className="row-flex gap-2" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <Priority p={priority} />
        <span className="todo-status-pill">{todo.status.replace('_', ' ')}</span>
        {todo.tags.map(t => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>
      <div className="meta-grid">
        <span className="subtle">priority</span>
        <div className="row-flex gap-1">
          {(['p1', 'p2', 'p3'] as const).map((p) => (
            <button
              key={p}
              className={cls('filter-chip', priority === p && 'active')}
              onClick={() => setPriorityNow(p)}
              disabled={updateMut.isPending}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="subtle">due</span>
        <div className="row-flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="datetime-local"
            className="input input-sm"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            disabled={updateMut.isPending}
          />
          {dueLocal ? (
            <>
              <span className="subtle">{fmtDue(dueWirePayload() ?? new Date(dueLocal).toISOString())}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setDueLocal('')}
                disabled={updateMut.isPending}
                title="Clear due date"
              >
                clear
              </button>
            </>
          ) : null}
        </div>
        <span className="subtle">created</span>
        <span>{fmtRel(todo.created_at)}</span>
        <span className="subtle">project</span>
        <span>{todo.project_id ?? 'Inbox'}</span>
        <span className="subtle">parent</span>
        <span>
          {todo.parent_id
            ? <EntityLink kind="todo">{parentQ.data?.content ?? (parentQ.isLoading ? '…' : todo.parent_id)}</EntityLink>
            : '—'}
        </span>
      </div>
      {updateMut.error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)', marginBottom: 12 }}>
          {updateMut.error instanceof Error ? updateMut.error.message : String(updateMut.error)}
        </div>
      ) : null}
      <div className="divider" />
      <label className="field-label">
        Comments · {commentsQ.isLoading ? '…' : comments.length}
        {addCommentMut.error ? (
          <span style={{ color: 'var(--danger)', marginLeft: 8 }}>
            {addCommentMut.error instanceof Error ? addCommentMut.error.message : String(addCommentMut.error)}
          </span>
        ) : null}
      </label>
      {commentsQ.isLoading ? (
        <div className="page-subtle">Loading comments…</div>
      ) : comments.length === 0 ? (
        <div className="page-subtle">No comments yet.</div>
      ) : (
        comments.map(c => (
          <div key={c.id} className="todo-comment">
            <div className="meta">
              <b>alex</b> · {fmtRel(c.created_at)}
            </div>
            {c.content}
          </div>
        ))
      )}
      <div className="todo-input-row" style={{ marginTop: 8 }}>
        <div className="field">
          <Icons.Chat size={13} />
          <input
            placeholder="Add a comment…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            disabled={addCommentMut.isPending}
          />
        </div>
        <button
          className="btn btn-primary btn-icon"
          onClick={submit}
          disabled={!draft.trim() || addCommentMut.isPending}
        >
          <Icons.Send />
        </button>
      </div>
    </Drawer>
  );
}
