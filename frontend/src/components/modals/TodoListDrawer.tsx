// All personal (project-less) todos in a drawer. The Home widget
// shows the top 6; this is the "see everything" escape valve. Reuses:
//   - <Drawer/> primitive (mobile fullscreen, expand-to-center toggle,
//     role="dialog", slide-in animation)
//   - <TodoRow/> for row markup, so the drawer and the Home column
//     stay in lockstep
//   - existing TodoDetailDrawer for row click → detail (we hand off
//     by closing this drawer and dispatching todo-detail)

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Drawer } from '../primitives';
import { TodoRow } from '../TodoRow';
import { listTodos, updateTodo } from '../../lib/api';
import { toUiTodo } from '../../lib/view';
import { sortPersonalTodos } from '../../lib/todoSort';
import type { ActionDispatch, Todo } from '../../types';

interface Props {
  onClose: () => void;
  onAction: ActionDispatch;
}

export function TodoListDrawer({ onClose, onAction }: Props) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['todos', 'inbox'],
    queryFn: () => listTodos({ project_id: 'null' }),
  });
  const todos = sortPersonalTodos((data ?? []).map(toUiTodo));

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
          {todos.map((t) => (
            <TodoRow
              key={t.id}
              todo={t}
              depth={t.parent_id ? 1 : 0}
              onClick={() => {
                onClose();
                onAction({ kind: 'todo-detail', payload: t });
              }}
              onToggleDone={() =>
                toggle.mutate({
                  id: t.id,
                  status: t.status === 'done' ? 'not_started' : 'done',
                })
              }
            />
          ))}
        </div>
      )}
    </Drawer>
  );
}
