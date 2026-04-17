import { useEffect, useState } from 'react';
import { getProject, type Project } from '../lib/api';
import { SearchBar } from '../components/SearchBar';
import { DocumentsTab } from '../components/DocumentsTab';
import { NotesTab } from '../components/NotesTab';
import { TodosTab } from '../components/TodosTab';
import { ChatTab } from '../components/ChatTab';

interface Props {
  projectId: string;
  onBack: () => void;
}

type Tab = 'chat' | 'documents' | 'notes' | 'todos';

export function ProjectDetail({ projectId, onBack }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProject(projectId)
      .then((r) => setProject(r.project))
      .catch((err) => setError(err.message));
  }, [projectId]);

  if (error) {
    return (
      <div className="card text-red-400">
        <div className="mb-2">Error: {error}</div>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
      </div>
    );
  }

  if (!project) return <div className="text-muted">Loading project...</div>;

  return (
    <div className="space-y-6">
      <div>
        <button className="btn-ghost text-sm text-muted mb-2" onClick={onBack}>← Back to projects</button>
        <h1 className="text-2xl font-bold">{project.name}</h1>
        {project.description && <p className="text-muted mt-1">{project.description}</p>}
      </div>

      <SearchBar projectId={projectId} />

      {/* Tabs */}
      <div className="border-b border-border flex gap-1">
        {(['chat', 'documents', 'notes', 'todos'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? 'border-b-2 border-accent text-text'
                : 'text-muted hover:text-text'
            }`}
          >
            {t === 'chat' ? '💬 Chat' : t === 'documents' ? '📄 Documents' : t === 'notes' ? '📝 Notes' : '✓ Todos'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'chat' && <ChatTab projectId={projectId} />}
        {tab === 'documents' && <DocumentsTab projectId={projectId} />}
        {tab === 'notes' && <NotesTab projectId={projectId} />}
        {tab === 'todos' && <TodosTab projectId={projectId} />}
      </div>
    </div>
  );
}
