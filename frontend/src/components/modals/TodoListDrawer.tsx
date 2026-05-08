// All personal (project-less) todos in a drawer. The Home widget
// shows the top 6; this is the "see everything" escape valve. Reuses:
//   - <Drawer/> primitive (mobile fullscreen, expand-to-center toggle,
//     role="dialog", slide-in animation)
//   - <TodoRow/> for row markup, so the drawer and the Home column
//     stay in lockstep
//   - existing TodoDetailDrawer for row click → detail (we hand off
//     by closing this drawer and dispatching todo-detail)
//   - useTodoExpansion so collapse state is shared with the column
//
// Unlike the column, the drawer renders the FULL hierarchy — no
// maxDepth — so grandchildren stay visible when their parent is open.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Drawer } from '../primitives';
import { TodoRow } from '../TodoRow';
import { listTodos, updateTodo } from '../../lib/api';
import { toUiTodo } from '../../lib/view';
import { sortPersonalTodos } from '../../lib/todoSort';
import { useTodoExpansion } from '../../lib/useTodoExpansion';
import type { ActionDispatch, Todo } from '../../types';

interface Props {
  onClose: () => void;
  onAction: ActionDispatch;
}

export function TodoListDrawer({ onClose, onAction }: Props) {
  const qc = useQueryClient();
  const { isExpanded, toggle: toggleExpand } = useTodoExpansion();
  const { data, isLoading, error } = useQuery({
    queryKey: ['todos', 'inbox'],
    queryFn: () => listTodos({ project_id: 'null' }),
  });
  const todos = sortPersonalTodos((data ?? []).map(toUiTodo), { isExpanded });

  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Todo['status'] }) =>
      updateTodo(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  return (
    <Drawer title={`Personal todos · ${todos.length}`} onClose={onClose}>
      {error ? (
        <div className="page-subtle search-drawer-error">
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : isLoading ? (
        <div className="page-subtle">Loading…</div>
      ) : todos.length === 0 ? (
        <div className="page-subtle">No personal todos yet.</div>
      ) : (
        <div className="todo-list-drawer-rows">
          {todos.map((s) => (
            <TodoRow
              key={s.todo.id}
              todo={s.todo}
              depth={s.depth}
              childCount={s.childCount}
              expanded={isExpanded(s.todo.id)}
              hiddenDescendants={s.hiddenDescendants}
              onClick={() => {
                onClose();
                onAction({ kind: 'todo-detail', payload: s.todo });
              }}
              onToggleExpand={() => toggleExpand(s.todo.id)}
              onToggleDone={() =>
                toggle.mutate({
                  id: s.todo.id,
                  status: s.todo.status === 'done' ? 'not_started' : 'done',
                })
              }
            />
          ))}
        </div>
      )}
    </Drawer>
  );
}
