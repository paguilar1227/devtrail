import { useEffect, useState } from 'react';
import {
  listContent, createContent,
  archiveContent, restoreContent, deleteContentHard,
  type ContentItem,
} from '../lib/api';

interface Props {
  projectId: string;
}

export function NotesTab({ projectId }: Props) {
  const [notes, setNotes] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await listContent({
        type: 'note',
        project_id: projectId,
        limit: 50,
        include_archived: showArchived,
      });
      setNotes(res.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId, showArchived]);

  const handleCreate = async () => {
    if (!content.trim()) return;
    await createContent({
      type: 'note',
      content,
      title: title.trim() || undefined,
      project_ids: [projectId],
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    setTitle('');
    setContent('');
    setTags('');
    setCreating(false);
    load();
  };

  const handleArchive = async (n: ContentItem) => {
    if (!confirm(`Archive "${n.title}"?`)) return;
    await archiveContent(n.id);
    load();
  };

  const handleRestore = async (n: ContentItem) => {
    await restoreContent(n.id);
    load();
  };

  const handleHardDelete = async (n: ContentItem) => {
    if (!confirm(`Permanently delete "${n.title}"? This removes its chunks from search. Cannot be undone.`)) return;
    await deleteContentHard(n.id);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {!creating && (
          <button className="btn" onClick={() => setCreating(true)}>+ New Note</button>
        )}
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-accent"
          />
          Show archived
        </label>
      </div>

      {creating && (
        <div className="card space-y-2">
          <input
            className="input"
            placeholder="Title (optional — will auto-generate if empty)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="input font-mono"
            placeholder="Write your note..."
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            autoFocus
          />
          <input
            className="input"
            placeholder="Tags (comma-separated)"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={() => { setCreating(false); setContent(''); setTitle(''); }}>Cancel</button>
            <button className="btn" onClick={handleCreate} disabled={!content.trim()}>Save</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-muted">Loading...</div>
      ) : notes.length === 0 ? (
        <div className="card text-muted text-sm">No notes.</div>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <div key={n.id} className={`card ${n.archived ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{n.title}</div>
                  <div className="text-xs text-muted mt-1">
                    {new Date(n.created_at).toLocaleDateString()}
                    {n.archived && <> • archived</>}
                    {n.tags.length > 0 && <> • {n.tags.map((t) => `#${t}`).join(' ')}</>}
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {n.archived ? (
                    <>
                      <button className="btn-ghost text-xs" onClick={() => handleRestore(n)} title="Restore">↺</button>
                      <button className="btn-ghost text-xs text-red-400" onClick={() => handleHardDelete(n)} title="Delete permanently">✕</button>
                    </>
                  ) : (
                    <button className="btn-ghost text-xs" onClick={() => handleArchive(n)} title="Archive">🗑</button>
                  )}
                </div>
              </div>
              {n.source_url && (
                <div className="mt-1 text-xs text-muted truncate">
                  🔗 <a href={n.source_url} target="_blank" rel="noopener" className="underline hover:text-accent">
                    {domainOf(n.source_url)}
                  </a>
                </div>
              )}
              {n.content && (
                <div className="mt-2 text-sm whitespace-pre-wrap text-muted line-clamp-4">{n.content}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
