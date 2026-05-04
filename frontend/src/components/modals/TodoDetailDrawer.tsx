import { Icons } from '../Icons';
import { Checkbox, Drawer, EntityLink, Priority, Tag } from '../primitives';
import { COMMENTS } from '../../lib/mock';
import { cls, fmtRel } from '../../lib/util';
import type { Todo } from '../../types';

export function TodoDetailDrawer({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const comments = COMMENTS[todo.id] || [];
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
      <label className="field-label">Description</label>
      <textarea
        className="input"
        rows={4}
        defaultValue="Implement Server-Sent Events streaming for the assistant response. Need to handle nginx proxy buffering quirks (set proxy_buffering off, proxy_cache off). Reconnect with last-event-id on dropped connections."
      />
      <div className="divider" />
      <label className="field-label">Subtasks</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="row-flex gap-2">
          <Checkbox checked />
          <span style={{ textDecoration: 'line-through', color: 'var(--fg-muted)', fontSize: 12.5 }}>
            Spec the SSE message envelope
          </span>
        </div>
        <div className="row-flex gap-2">
          <Checkbox />
          <span style={{ fontSize: 12.5 }}>Heartbeat + reconnect logic</span>
        </div>
        <div className="row-flex gap-2">
          <Checkbox />
          <span style={{ fontSize: 12.5 }}>Client-side replay buffer</span>
        </div>
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <Icons.Plus size={11} /> Add subtask
        </button>
      </div>
      <div className="divider" />
      <label className="field-label">Comments · {comments.length}</label>
      {comments.map(c => (
        <div key={c.id} className="comment">
          <div className="meta">
            <b>alex</b> · {fmtRel(c.at)}
          </div>
          {c.content}
        </div>
      ))}
      <div className="todo-input-row" style={{ marginTop: 8 }}>
        <div className="field">
          <Icons.Chat size={13} />
          <input placeholder="Add a comment…" />
        </div>
        <button className="btn btn-primary btn-icon">
          <Icons.Send />
        </button>
      </div>
    </Drawer>
  );
}
