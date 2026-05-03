import { useEffect, useState } from 'react';
import { listProjects, createProject, listContent, listTodos, type Project, type ContentItem, type Todo } from '../lib/api';
import { SearchBar } from '../components/SearchBar';
import { UrlSaveModal } from '../components/UrlSaveModal';

interface Props {
  onOpenProject: (id: string) => void;
}

export function Home({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [recentContent, setRecentContent] = useState<ContentItem[]>([]);
  const [inboxTodos, setInboxTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [urlModalOpen, setUrlModalOpen] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, c, t] = await Promise.all([
        listProjects('active'),
        listContent({ limit: 10 }),
        listTodos({ project_id: null }),
      ]);
      setProjects(p.projects);
      setRecentContent(c.items);
      setInboxTodos(t.todos);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await createProject(newName, newDesc || undefined);
      setNewName('');
      setNewDesc('');
      setCreating(false);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div className="space-y-8">
      <SearchBar />

      {error && <div className="card text-red-400">Error: {error}</div>}

      {/* Projects */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Projects</h2>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setUrlModalOpen(true)}>🔗 Save from URL</button>
            <button className="btn" onClick={() => setCreating(true)}>+ New Project</button>
          </div>
        </div>

        <UrlSaveModal
          open={urlModalOpen}
          onClose={() => setUrlModalOpen(false)}
          onSaved={() => loadAll()}
        />

        {creating && (
          <div className="card mb-4 space-y-2">
            <input
              className="input"
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <textarea
              className="input"
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={2}
            />
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn" onClick={handleCreate} disabled={!newName.trim()}>Create</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-muted">Loading...</div>
        ) : projects.length === 0 ? (
          <div className="card text-muted text-sm">No projects yet. Create one to get started.</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.map((p) => (
              <button
                key={p.id}
                className="card text-left hover:border-accent transition-colors"
                onClick={() => onOpenProject(p.id)}
              >
                <div className="font-semibold mb-1">{p.name}</div>
                {p.description && <div className="text-muted text-sm line-clamp-2">{p.description}</div>}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Recent content */}
      {recentContent.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold mb-3">Recent</h2>
          <div className="space-y-2">
            {recentContent.slice(0, 5).map((item) => (
              <div key={item.id} className="card flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs px-2 py-0.5 rounded bg-border">
                    {item.type === 'document' ? '📄' : '📝'} {item.type}
                  </span>
                  <span className="truncate">{item.title}</span>
                </div>
                <div className="text-xs text-muted flex-shrink-0 ml-2">
                  {new Date(item.created_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Inbox todos */}
      {inboxTodos.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold mb-3">Inbox Todos</h2>
          <div className="space-y-2">
            {inboxTodos.slice(0, 5).map((t) => (
              <div key={t.id} className="card flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-xs px-2 py-0.5 rounded ${t.status === 'done' ? 'bg-green-900/50 text-green-300' : 'bg-border'}`}>
                    {t.status}
                  </span>
                  <span className={`truncate ${t.status === 'done' ? 'line-through text-muted' : ''}`}>{t.content}</span>
                </div>
                {t.priority && <span className="text-xs text-muted flex-shrink-0 ml-2">{t.priority}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
