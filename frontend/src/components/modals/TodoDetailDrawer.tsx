import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { Drawer, EntityLink, Priority, Tag } from '../primitives';
import { createComment, listTodoComments } from '../../lib/api';
import { cls, fmtRel } from '../../lib/util';
import type { Todo } from '../../types';

export function TodoDetailDrawer({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');

  const commentsQ = useQuery({
    queryKey: ['todo-comments', todo.id],
    queryFn: () => listTodoComments(todo.id),
  });

  const addMut = useMutation({
    mutationFn: (content: string) => createComment(todo.id, { content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todo-comments', todo.id] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      setDraft('');
    },
  });

  const submit = () => {
    const c = draft.trim();
    if (!c || addMut.isPending) return;
    addMut.mutate(c);
  };

  const comments = commentsQ.data ?? [];

  return (
    <Drawer
      title={todo.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary">Save</button>
        </>
      }
    >
      <div className="row-flex gap-2" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <Priority p={todo.priority} />
        <span className="todo-status-pill">{todo.status.replace('_', ' ')}</span>
        {todo.tags.map(t => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 14px', fontSize: 11.5, marginBottom: 18 }}>
        <span className="subtle mono">priority</span>
        <div className="row-flex gap-1">
          <button className={cls('filter-chip', todo.priority === 'p1' && 'active')}>P1</button>
          <button className={cls('filter-chip', todo.priority === 'p2' && 'active')}>P2</button>
          <button className={cls('filter-chip', todo.priority === 'p3' && 'active')}>P3</button>
        </div>
        <span className="subtle mono">due</span>
        <span className="mono">{todo.due_at ? fmtRel(todo.due_at) : '—'}</span>
        <span className="subtle mono">created</span>
        <span className="mono">{fmtRel(todo.created_at)}</span>
        <span className="subtle mono">project</span>
        <span className="mono">{todo.project_id ?? 'Inbox'}</span>
        <span className="subtle mono">parent</span>
        <span className="mono">
          {todo.parent_id ? <EntityLink kind="todo">{todo.parent_id}</EntityLink> : '—'}
        </span>
      </div>
      <div className="divider" />
      <label className="field-label">
        Comments · {commentsQ.isLoading ? '…' : comments.length}
        {addMut.error ? (
          <span style={{ color: 'var(--danger)', marginLeft: 8 }}>
            {addMut.error instanceof Error ? addMut.error.message : String(addMut.error)}
          </span>
        ) : null}
      </label>
      {commentsQ.isLoading ? (
        <div className="page-subtle">Loading comments…</div>
      ) : comments.length === 0 ? (
        <div className="page-subtle">No comments yet.</div>
      ) : (
        comments.map(c => (
          <div key={c.id} className="comment">
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
            disabled={addMut.isPending}
          />
        </div>
        <button
          className="btn btn-primary btn-icon"
          onClick={submit}
          disabled={!draft.trim() || addMut.isPending}
        >
          <Icons.Send />
        </button>
      </div>
    </Drawer>
  );
}
