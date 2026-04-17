import { useEffect, useState } from 'react';
import { listTodos, createTodo, updateTodo, type Todo } from '../lib/api';

interface Props {
  projectId: string;
}

export function TodosTab({ projectId }: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTodo, setNewTodo] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await listTodos({ project_id: projectId });
      setTodos(res.todos);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

  const handleCreate = async () => {
    if (!newTodo.trim()) return;
    await createTodo({ content: newTodo, project_id: projectId });
    setNewTodo('');
    load();
  };

  const toggleDone = async (t: Todo) => {
    await updateTodo(t.id, { status: t.status === 'done' ? 'not_started' : 'done' });
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="Add a todo..."
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
        />
        <button className="btn" onClick={handleCreate} disabled={!newTodo.trim()}>Add</button>
      </div>

      {loading ? (
        <div className="text-muted">Loading...</div>
      ) : todos.length === 0 ? (
        <div className="card text-muted text-sm">No todos yet.</div>
      ) : (
        <div className="space-y-2">
          {todos.map((t) => (
            <div key={t.id} className="card flex items-center gap-3">
              <input
                type="checkbox"
                checked={t.status === 'done'}
                onChange={() => toggleDone(t)}
                className="w-4 h-4 accent-accent"
              />
              <div className="flex-1 min-w-0">
                <div className={t.status === 'done' ? 'line-through text-muted' : ''}>{t.content}</div>
                <div className="text-xs text-muted mt-0.5">
                  {t.status}
                  {t.priority && <> • {t.priority}</>}
                  {t.due_date && <> • due {new Date(t.due_date).toLocaleDateString()}</>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
