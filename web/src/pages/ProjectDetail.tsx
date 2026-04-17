import { useEffect, useState } from 'react';
import {
  getProject, archiveProject, restoreProject, deleteProjectHard,
  type Project,
} from '../lib/api';
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

  const load = () => {
    getProject(projectId)
      .then((r) => setProject(r.project))
      .catch((err) => setError(err.message));
  };

  useEffect(() => { load(); }, [projectId]);

  if (error) {
    return (
      <div className="card text-red-400">
        <div className="mb-2">Error: {error}</div>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
      </div>
    );
  }

  if (!project) return <div className="text-muted">Loading project...</div>;

  const isArchived = project.status === 'archived';

  const handleArchive = async () => {
    if (!confirm(`Archive "${project.name}"? Its content stays, but the project is hidden from the active list.`)) return;
    await archiveProject(projectId);
    load();
  };

  const handleRestore = async () => {
    await restoreProject(projectId);
    load();
  };

  const handleHardDelete = async () => {
    if (!confirm(
      `Permanently delete "${project.name}"?\n\n` +
      `This removes the project and scrubs its reference from all linked documents/notes ` +
      `(they stay, but lose this project tag). Todos in this project become personal.\n\n` +
      `Cannot be undone.`
    )) return;
    await deleteProjectHard(projectId);
    onBack();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <button className="btn-ghost text-sm text-muted mb-2" onClick={onBack}>← Back to projects</button>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            {project.name}
            {isArchived && <span className="text-xs px-2 py-0.5 rounded bg-border text-muted">archived</span>}
          </h1>
          {project.description && <p className="text-muted mt-1">{project.description}</p>}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {isArchived ? (
            <>
              <button className="btn-secondary text-sm" onClick={handleRestore}>Restore</button>
              <button className="btn-ghost text-sm text-red-400" onClick={handleHardDelete}>Delete permanently</button>
            </>
          ) : (
            <button className="btn-ghost text-sm" onClick={handleArchive}>Archive project</button>
          )}
        </div>
      </div>

      <SearchBar projectId={projectId} />

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

      <div>
        {tab === 'chat' && <ChatTab projectId={projectId} />}
        {tab === 'documents' && <DocumentsTab projectId={projectId} />}
        {tab === 'notes' && <NotesTab projectId={projectId} />}
        {tab === 'todos' && <TodosTab projectId={projectId} />}
      </div>
    </div>
  );
}
