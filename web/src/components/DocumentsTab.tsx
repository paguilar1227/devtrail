import { useEffect, useRef, useState } from 'react';
import { listContent, uploadFile, type ContentItem } from '../lib/api';

interface Props {
  projectId: string;
}

export function DocumentsTab({ projectId }: Props) {
  const [docs, setDocs] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await listContent({ type: 'document', project_id: projectId, limit: 50 });
      setDocs(res.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

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

      {loading ? (
        <div className="text-muted">Loading...</div>
      ) : docs.length === 0 ? (
        <div className="card text-muted text-sm">No documents yet.</div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{d.title}</div>
                  <div className="text-xs text-muted mt-1">
                    {d.mime_type ?? 'unknown'} • {new Date(d.created_at).toLocaleDateString()}
                    {d.tags.length > 0 && <> • {d.tags.map((t) => `#${t}`).join(' ')}</>}
                  </div>
                </div>
                {d.blob_url && (
                  <a href={d.blob_url} target="_blank" rel="noopener" className="btn-secondary text-xs">
                    Open
                  </a>
                )}
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
