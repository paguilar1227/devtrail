import { useEffect, useState } from 'react';
import {
  listTodos, createTodo, updateTodo,
  archiveTodo, restoreTodo, deleteTodoHard,
  type Todo,
} from '../lib/api';

interface Props {
  projectId: string;
}

export function TodosTab({ projectId }: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTodo, setNewTodo] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await listTodos({ project_id: projectId, include_archived: showArchived });
      setTodos(res.todos);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId, showArchived]);

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

  const handleArchive = async (t: Todo) => {
    if (!confirm(`Archive "${t.content.slice(0, 60)}"?`)) return;
    await archiveTodo(t.id);
    load();
  };

  const handleRestore = async (t: Todo) => {
    await restoreTodo(t.id);
    load();
  };

  const handleHardDelete = async (t: Todo) => {
    if (!confirm(`Permanently delete "${t.content.slice(0, 60)}"? This cannot be undone.`)) return;
    await deleteTodoHard(t.id);
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

      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          className="accent-accent"
        />
        Show archived
      </label>

      {loading ? (
        <div className="text-muted">Loading...</div>
      ) : todos.length === 0 ? (
        <div className="card text-muted text-sm">No todos{showArchived ? '' : ' (try toggling "Show archived")'}.</div>
      ) : (
        <div className="space-y-2">
          {todos.map((t) => (
            <div key={t.id} className={`card flex items-center gap-3 ${t.archived ? 'opacity-60' : ''}`}>
              <input
                type="checkbox"
                checked={t.status === 'done'}
                onChange={() => toggleDone(t)}
                className="w-4 h-4 accent-accent"
                disabled={t.archived}
              />
              <div className="flex-1 min-w-0">
                <div className={t.status === 'done' ? 'line-through text-muted' : ''}>{t.content}</div>
                <div className="text-xs text-muted mt-0.5">
                  {t.status}
                  {t.priority && <> • {t.priority}</>}
                  {t.due_date && <> • due {new Date(t.due_date).toLocaleDateString()}</>}
                  {t.archived && <> • archived</>}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {t.archived ? (
                  <>
                    <button className="btn-ghost text-xs" onClick={() => handleRestore(t)} title="Restore">↺</button>
                    <button className="btn-ghost text-xs text-red-400" onClick={() => handleHardDelete(t)} title="Delete permanently">✕</button>
                  </>
                ) : (
                  <button className="btn-ghost text-xs" onClick={() => handleArchive(t)} title="Archive">🗑</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
