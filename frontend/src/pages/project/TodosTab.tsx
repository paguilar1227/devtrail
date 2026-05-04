import { Fragment, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons';
import { BulkCheckbox, Checkbox, FilterChip, Priority, Tag } from '../../components/primitives';
import { TODOS } from '../../lib/mock';
import { cls, fmtRel, isOverdue } from '../../lib/util';
import type { ActionDispatch, Project, Todo } from '../../types';

interface Props {
  project: Project;
  onAction: ActionDispatch;
}

type HierMode = 'hierarchy' | 'flat';

export function TodosTab({ project, onAction }: Props) {
  const all = TODOS[project.id] || [];
  const [hierMode, setHierMode] = useState<HierMode>('hierarchy');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const open = all.filter(t => t.status !== 'done');
    const done = all.filter(t => t.status === 'done');
    return { open, done };
  }, [all]);

  const toggleSel = (id: string) =>
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleCollapse = (id: string) =>
    setCollapsed(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectMode = selected.size > 0;

  const renderTodo = (t: Todo, depth = 0, hasChildren = false) => (
    <div
      key={t.id}
      className={cls('todo', t.status === 'done' && 'done', selected.has(t.id) && 'selected', `depth-${depth}`)}
      style={depth ? { marginLeft: depth * 24 } : undefined}
    >
      <span className="todo-rail" aria-hidden="true">
        {hasChildren ? (
          <button
            className="todo-disclosure"
            onClick={() => toggleCollapse(t.id)}
            title={collapsed.has(t.id) ? 'Expand' : 'Collapse'}
          >
            <Icons.ChevronDown
              size={11}
              style={{ transform: collapsed.has(t.id) ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms' }}
            />
          </button>
        ) : null}
      </span>
      {selectMode ? (
        <BulkCheckbox checked={selected.has(t.id)} onClick={() => toggleSel(t.id)} />
      ) : (
        <span className="todo-bulk-slot" onClick={() => toggleSel(t.id)} title="Select">
          <BulkCheckbox checked={false} />
        </span>
      )}
      <Checkbox checked={t.status === 'done'} />
      <div onClick={() => onAction({ kind: 'todo-detail', payload: t })}>
        <div className="nm">{t.title}</div>
        <div className="nm-meta">
          {t.due_at ? (
            <span className={isOverdue(t.due_at) && t.status !== 'done' ? 'due-overdue' : 'due-soon'}>
              due {fmtRel(t.due_at)}
            </span>
          ) : null}
          {t.tags.map(tg => (
            <Tag key={tg}>{tg}</Tag>
          ))}
          {t.comments > 0 ? (
            <span>
              <Icons.Chat size={10} /> {t.comments}
            </span>
          ) : null}
        </div>
      </div>
      <Priority p={t.priority} />
      <span className="todo-status-pill">{t.status.replace('_', ' ')}</span>
      <button className="btn btn-ghost btn-icon" onClick={() => onAction({ kind: 'todo-detail', payload: t })}>
        <Icons.More />
      </button>
    </div>
  );

  const renderHierGroup = (todos: Todo[]) => {
    const childrenOf = (pid: string) => todos.filter(c => c.parent_id === pid);
    const walk = (t: Todo, depth: number): JSX.Element => {
      const kids = childrenOf(t.id);
      const isCollapsed = collapsed.has(t.id);
      return (
        <Fragment key={t.id}>
          {renderTodo(t, depth, kids.length > 0)}
          {!isCollapsed && depth < 3 ? kids.map(c => walk(c, depth + 1)) : null}
          {!isCollapsed && depth === 3 ? kids.map(c => renderTodo(c, 3, false)) : null}
        </Fragment>
      );
    };
    return todos.filter(t => !t.parent_id).map(top => walk(top, 0));
  };

  return (
    <div>
      <div className="todo-input-row">
        <div className="field">
          <Icons.Plus />
          <input placeholder={`Add a todo to ${project.name} — Enter to save, Tab to nest`} />
          <span className="depth-pill">
            <button className="active">Top</button>
            <button>Sub</button>
          </span>
        </div>
        <button className="btn">Add details</button>
      </div>

      <div className="filter-bar">
        <FilterChip active>
          All <span style={{ marginLeft: 4 }}>{all.length}</span>
        </FilterChip>
        <FilterChip>
          Open <span style={{ marginLeft: 4 }}>{groups.open.length}</span>
        </FilterChip>
        <FilterChip>
          Overdue <span style={{ marginLeft: 4 }}>3</span>
        </FilterChip>
        <FilterChip>Today</FilterChip>
        <FilterChip>P1</FilterChip>
        <span style={{ marginLeft: 'auto' }} className="seg-toggle">
          <button className={hierMode === 'hierarchy' ? 'active' : ''} onClick={() => setHierMode('hierarchy')}>
            Hierarchy
          </button>
          <button className={hierMode === 'flat' ? 'active' : ''} onClick={() => setHierMode('flat')}>
            Flat
          </button>
        </span>
      </div>

      <div className="todo-group">
        <div className="todo-group-h">
          <Icons.ChevronDown size={11} className="chev" />
          <span>Open</span>
          <span className="ct">{groups.open.length}</span>
        </div>
        {hierMode === 'hierarchy' ? renderHierGroup(groups.open) : groups.open.map(t => renderTodo(t, 0))}
      </div>

      <div className="todo-group">
        <div className="todo-group-h">
          <Icons.ChevronDown size={11} className="chev" />
          <span>Done</span>
          <span className="ct">{groups.done.length}</span>
        </div>
        {hierMode === 'hierarchy' ? renderHierGroup(groups.done) : groups.done.map(t => renderTodo(t, 0))}
      </div>

      {selected.size > 0 ? (
        <div className="bulk-bar">
          <span className="ct">{selected.size} selected</span>
          <span className="sep" />
          <button className="btn btn-sm">Set priority</button>
          <button className="btn btn-sm">Set due date</button>
          <button className="btn btn-sm">Tag</button>
          <button className="btn btn-sm">Move</button>
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
