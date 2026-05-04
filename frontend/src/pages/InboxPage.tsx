import { useState } from 'react';
import { Icons } from '../components/Icons';
import { BulkCheckbox, Checkbox, FilterChip, Priority, Tag } from '../components/primitives';
import { INBOX_TODOS } from '../lib/mock';
import { cls, fmtRel, isOverdue } from '../lib/util';
import type { ActionDispatch } from '../types';

interface Props {
  onAction: ActionDispatch;
}

export function InboxPage({ onAction }: Props) {
  const todos = INBOX_TODOS;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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
          <input placeholder="Quick capture — press Enter to save" />
          <span className="kbd">⏎</span>
        </div>
        <button className="btn">Add details</button>
      </div>

      <div className="filter-bar">
        <FilterChip active>
          All <span style={{ marginLeft: 4 }}>{todos.length}</span>
        </FilterChip>
        <FilterChip>Open</FilterChip>
        <FilterChip>
          Overdue <span style={{ marginLeft: 4 }}>2</span>
        </FilterChip>
        <FilterChip>Today</FilterChip>
        <FilterChip>This week</FilterChip>
      </div>

      <div>
        {todos.map(t => (
          <div
            key={t.id}
            className={cls('todo', selected.has(t.id) && 'selected')}
            style={{ gridTemplateColumns: '18px 22px 1fr auto auto auto' }}
          >
            <BulkCheckbox checked={selected.has(t.id)} onClick={() => toggle(t.id)} />
            <Checkbox checked={t.status === 'done'} />
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

      {selected.size > 0 ? (
        <div className="bulk-bar">
          <span className="ct">{selected.size} selected</span>
          <span className="sep" />
          <button className="btn btn-sm">Move to project</button>
          <button className="btn btn-sm">Tag</button>
          <button className="btn btn-sm">Set priority</button>
          <button className="btn btn-sm">Mark done</button>
          <span className="sep" />
          <button className="btn btn-sm btn-danger">Archive</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}
