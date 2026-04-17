import { useEffect, useRef, useState } from 'react';
import {
  listContent, uploadFile,
  archiveContent, restoreContent, deleteContentHard,
  type ContentItem,
} from '../lib/api';

interface Props {
  projectId: string;
}

export function DocumentsTab({ projectId }: Props) {
  const [docs, setDocs] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await listContent({
        type: 'document',
        project_id: projectId,
        limit: 50,
        include_archived: showArchived,
      });
      setDocs(res.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId, showArchived]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadFile(file, 'document', { projectIds: [projectId] });
      }
      await load();
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleArchive = async (d: ContentItem) => {
    if (!confirm(`Archive "${d.title}"?`)) return;
    await archiveContent(d.id);
    load();
  };

  const handleRestore = async (d: ContentItem) => {
    await restoreContent(d.id);
    load();
  };

  const handleHardDelete = async (d: ContentItem) => {
    if (!confirm(`Permanently delete "${d.title}"? The file stays in blob storage but will be removed from search. Cannot be undone.`)) return;
    await deleteContentHard(d.id);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="card border-dashed text-center">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          multiple
          accept="application/pdf,image/*,audio/*,video/*,text/*"
          onChange={(e) => handleUpload(e.target.files)}
        />
        <button
          className="btn"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading...' : '+ Upload Document'}
        </button>
        <div className="text-xs text-muted mt-2">PDFs, images, audio, video, text files</div>
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
      ) : docs.length === 0 ? (
        <div className="card text-muted text-sm">No documents yet.</div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className={`card ${d.archived ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{d.title}</div>
                  <div className="text-xs text-muted mt-1">
                    {d.mime_type ?? 'unknown'} • {new Date(d.created_at).toLocaleDateString()}
                    {d.archived && <> • archived</>}
                    {d.tags.length > 0 && <> • {d.tags.map((t) => `#${t}`).join(' ')}</>}
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0 items-start">
                  {d.blob_url && (
                    <a href={d.blob_url} target="_blank" rel="noopener" className="btn-secondary text-xs">
                      Open
                    </a>
                  )}
                  {d.archived ? (
                    <>
                      <button className="btn-ghost text-xs" onClick={() => handleRestore(d)} title="Restore">↺</button>
                      <button className="btn-ghost text-xs text-red-400" onClick={() => handleHardDelete(d)} title="Delete permanently">✕</button>
                    </>
                  ) : (
                    <button className="btn-ghost text-xs" onClick={() => handleArchive(d)} title="Archive">🗑</button>
                  )}
                </div>
              </div>
              {d.content && (
                <div className="mt-2 text-sm text-muted line-clamp-2">{d.content}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
