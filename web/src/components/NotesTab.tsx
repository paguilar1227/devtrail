import { useEffect, useState } from 'react';
import { listContent, createContent, type ContentItem } from '../lib/api';

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

  const load = async () => {
    setLoading(true);
    try {
      const res = await listContent({ type: 'note', project_id: projectId, limit: 50 });
      setNotes(res.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

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

  return (
    <div className="space-y-4">
      {!creating && (
        <button className="btn" onClick={() => setCreating(true)}>+ New Note</button>
      )}

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
        <div className="card text-muted text-sm">No notes yet.</div>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <div key={n.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="font-medium">{n.title}</div>
                <div className="text-xs text-muted flex-shrink-0">
                  {new Date(n.created_at).toLocaleDateString()}
                </div>
              </div>
              {n.content && (
                <div className="mt-2 text-sm whitespace-pre-wrap text-muted line-clamp-4">{n.content}</div>
              )}
              {n.tags.length > 0 && (
                <div className="mt-2 text-xs text-muted">
                  {n.tags.map((t) => `#${t}`).join(' ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
