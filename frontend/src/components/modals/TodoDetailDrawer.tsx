import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_TODO_DEPTH } from '@open-brain/shared';
import { DateTimePicker } from '../DateTimePicker';
import { Icons } from '../Icons';
import { Drawer, Checkbox, EntityLink, Priority, Tag } from '../primitives';
import {
  createComment, createTodo as apiCreateTodo, getTodo, listTodoComments,
  listTodos, updateTodo,
} from '../../lib/api';
import { toUiTodo } from '../../lib/view';
import { cls, fmtRel } from '../../lib/util';
import { useTodoDepth } from '../../lib/useTodoDepth';
import type { ActionDispatch, Todo } from '../../types';

type PriorityVal = 'p1' | 'p2' | 'p3';

// UI priority is lowercase p1/p2/p3; the wire schema is uppercase P1/P2/P3
// (see toUiTodo's PRIORITY_MAP). Convert here so callers stay in UI shape.
const toWirePriority = (p: PriorityVal): 'P1' | 'P2' | 'P3' =>
  p.toUpperCase() as 'P1' | 'P2' | 'P3';

interface Props {
  todo: Todo;
  onClose: () => void;
  /**
   * Required to navigate when a subtask row is clicked. The drawer
   * dispatches `todo-detail` with the subtask, then closes itself —
   * the App reopens the new drawer one frame later, giving a
   * navigation feel without nesting drawers.
   */
  onAction?: ActionDispatch;
}

export function TodoDetailDrawer({ todo, onClose, onAction }: Props) {
  const qc = useQueryClient();
  const [commentDraft, setCommentDraft] = useState('');
  const [subtaskDraft, setSubtaskDraft] = useState('');
  const [priority, setPriority] = useState<PriorityVal>(todo.priority);
  // Local mirror so the trigger reflects the user's edit immediately
  // — the drawer receives `todo` as a prop snapshot (parent doesn't
  // refetch it on update) so we can't rely on todo.due_at after a
  // mutation. Same pattern priority uses.
  const [dueIso, setDueIso] = useState<string | null>(todo.due_at);

  const commentsQ = useQuery({
    queryKey: ['todo-comments', todo.id],
    queryFn: () => listTodoComments(todo.id),
  });

  // Direct subtasks of this todo. Cached by parent id so opening the
  // drawer again is instant; invalidated whenever a subtask is added,
  // toggled, or its parent's any status changes.
  const subtasksQ = useQuery({
    queryKey: ['todos', 'children', todo.id],
    queryFn: () => listTodos({ parent_id: todo.id }),
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
      setCommentDraft('');
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

  const addSubtaskMut = useMutation({
    mutationFn: (content: string) =>
      apiCreateTodo({ content, parent_id: todo.id, project_id: todo.project_id ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
      qc.invalidateQueries({ queryKey: ['todos', 'children', todo.id] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      setSubtaskDraft('');
    },
  });

  const toggleSubtaskMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) =>
      updateTodo(id, { status }),
    onSuccess: () => {
      // Invalidate broadly: the toggle can cascade (parent → done → all
      // descendants), and we want every consumer (drawer subtasks,
      // column, activity feed, stats) to refresh.
      qc.invalidateQueries({ queryKey: ['todos'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });

  const submitComment = () => {
    const c = commentDraft.trim();
    if (!c || addCommentMut.isPending) return;
    addCommentMut.mutate(c);
  };

  const submitSubtask = () => {
    const c = subtaskDraft.trim();
    if (!c || addSubtaskMut.isPending) return;
    addSubtaskMut.mutate(c);
  };

  const setPriorityNow = (p: PriorityVal) => {
    if (p === priority) return;
    setPriority(p);
    updateMut.mutate({ priority: p });
  };

  // Save closes the drawer after pending edits. Priority + due fire
  // optimistically on chip / picker-Done click; this button is the
  // user's "I'm done here" gesture.
  const dirty = priority !== todo.priority;
  const onSave = () => {
    if (dirty && !updateMut.isPending) {
      updateMut.mutate({ priority }, { onSuccess: () => onClose() });
    } else {
      onClose();
    }
  };

  const comments = commentsQ.data ?? [];
  const subtasks = subtasksQ.data ?? [];
  const { depth: ownDepth } = useTodoDepth(todo);
  // We can only add a subtask if doing so wouldn't push the new child
  // past MAX_TODO_DEPTH. New child sits at ownDepth + 1.
  const canAddSubtask = ownDepth + 1 <= MAX_TODO_DEPTH;

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
        <DateTimePicker
          value={dueIso}
          onChange={(iso) => {
            setDueIso(iso);
            updateMut.mutate({ due_date: iso });
          }}
          disabled={updateMut.isPending}
        />
        <span className="subtle">created</span>
        <span>{fmtRel(todo.created_at)}</span>
        <span className="subtle">project</span>
        <span>{todo.project_id ?? 'Inbox'}</span>
        <span className="subtle">parent</span>
        <span>
          {todo.parent_id ? (
            <EntityLink
              kind="todo"
              // Navigate up: close this drawer, then dispatch detail
              // for the parent. App reopens the drawer one frame
              // later — same pattern as the subtask click below.
              onClick={onAction && parentQ.data ? () => {
                onClose();
                onAction({ kind: 'todo-detail', payload: toUiTodo(parentQ.data!) });
              } : undefined}
            >
              {parentQ.data?.content ?? (parentQ.isLoading ? '…' : todo.parent_id)}
            </EntityLink>
          ) : '—'}
        </span>
      </div>
      {updateMut.error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)', marginBottom: 12 }}>
          {updateMut.error instanceof Error ? updateMut.error.message : String(updateMut.error)}
        </div>
      ) : null}

      <div className="divider" />
      <label className="field-label">
        Subtasks · {subtasksQ.isLoading ? '…' : subtasks.length}
        {addSubtaskMut.error ? (
          <span style={{ color: 'var(--danger)', marginLeft: 8 }}>
            {addSubtaskMut.error instanceof Error ? addSubtaskMut.error.message : String(addSubtaskMut.error)}
          </span>
        ) : null}
      </label>
      {subtasksQ.isLoading ? (
        <div className="page-subtle">Loading subtasks…</div>
      ) : subtasks.length === 0 ? (
        <div className="page-subtle">No subtasks yet.</div>
      ) : (
        // Reuse TodoRow so subtasks render with the same conventions as
        // everywhere else (strikethrough on done, comment badges, etc.).
        // No drag handles here — this is just the subtask list, not the
        // hierarchy view.
        <div className="todo-subtask-list">
          {subtasks.map((s) => {
            const ui = toUiTodo(s);
            // Lightweight inline row: a checkbox + title (clickable to
            // navigate), no chevron / depth indent / DnD. The parent
            // drawer is the context, so we don't need TodoRow's full
            // chrome — keep it visually tight.
            const done = s.status === 'done';
            return (
              <div
                key={s.id}
                className={cls('todo-subtask-row', done && 'done')}
                role={onAction ? 'button' : undefined}
                tabIndex={onAction ? 0 : undefined}
                onClick={() => {
                  if (!onAction) return;
                  onClose();
                  onAction({ kind: 'todo-detail', payload: ui });
                }}
                onKeyDown={onAction ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClose();
                    onAction({ kind: 'todo-detail', payload: ui });
                  }
                } : undefined}
              >
                <Checkbox
                  checked={done}
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    toggleSubtaskMut.mutate({
                      id: s.id,
                      status: done ? 'not_started' : 'done',
                    });
                  }}
                />
                <span className="todo-subtask-title">{s.content}</span>
                {s.priority ? <Priority p={ui.priority} /> : null}
              </div>
            );
          })}
        </div>
      )}
      {canAddSubtask ? (
        <div className="todo-input-row" style={{ marginTop: 8 }}>
          <div className="field">
            <Icons.Plus size={13} />
            <input
              placeholder="Add a subtask…"
              value={subtaskDraft}
              onChange={(e) => setSubtaskDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitSubtask()}
              disabled={addSubtaskMut.isPending}
            />
          </div>
          <button
            className="btn btn-primary btn-icon"
            onClick={submitSubtask}
            disabled={!subtaskDraft.trim() || addSubtaskMut.isPending}
            aria-label="Add subtask"
          >
            <Icons.Plus />
          </button>
        </div>
      ) : (
        <div className="todo-subtask-cap-notice" style={{ marginTop: 8 }}>
          {`Max nesting reached (${MAX_TODO_DEPTH + 1} levels). Split this task or add a sibling instead of going deeper.`}
        </div>
      )}

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
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitComment()}
            disabled={addCommentMut.isPending}
          />
        </div>
        <button
          className="btn btn-primary btn-icon"
          onClick={submitComment}
          disabled={!commentDraft.trim() || addCommentMut.isPending}
          aria-label="Send comment"
        >
          <Icons.Send />
        </button>
      </div>
    </Drawer>
  );
}

