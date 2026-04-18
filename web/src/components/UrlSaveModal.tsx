import { useState } from 'react';
import { saveFromUrl, type SaveFromUrlResult } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (result: SaveFromUrlResult) => void;
  /** If set, the saved item will be scoped to this project. Omit for personal. */
  defaultProjectId?: string;
}

export function UrlSaveModal({ open, onClose, onSaved, defaultProjectId }: Props) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveFromUrlResult | null>(null);

  if (!open) return null;

  const handleSave = async () => {
    if (!url.trim()) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await saveFromUrl({
        url: url.trim(),
        title: title.trim() || undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        project_ids: defaultProjectId ? [defaultProjectId] : undefined,
      });
      setResult(res);
      onSaved?.(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setUrl('');
    setTitle('');
    setTags('');
    setError(null);
    setResult(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      onClick={close}
    >
      <div
        className="card max-w-lg w-full space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold">Save from URL</h2>
          <button className="btn-ghost text-xs" onClick={close}>✕</button>
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="text-sm">
              {result.deduped ? (
                <span>📎 Already saved — <span className="text-muted">{result.title}</span></span>
              ) : (
                <span>✅ Saved — <span className="text-muted">{result.title}</span> ({result.url_type}{result.chunkCount ? `, ${result.chunkCount} chunks` : ''})</span>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button className="btn-secondary" onClick={reset}>Save another</button>
              <button className="btn" onClick={close}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs text-muted block mb-1">URL</label>
              <input
                className="input"
                placeholder="https://youtube.com/watch?v=… or https://x.com/… or any article URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoFocus
                disabled={saving}
              />
              <p className="text-xs text-muted mt-1">
                Supports YouTube (transcript), X/Twitter threads, PDFs, articles, Reddit, images, audio.
              </p>
            </div>

            <div>
              <label className="text-xs text-muted block mb-1">Title (optional — auto-generated if empty)</label>
              <input
                className="input"
                placeholder="Leave empty to use the page/video title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving}
              />
            </div>

            <div>
              <label className="text-xs text-muted block mb-1">Tags (comma-separated, optional)</label>
              <input
                className="input"
                placeholder="e.g., reading, reference, research"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                disabled={saving}
              />
            </div>

            {defaultProjectId ? (
              <p className="text-xs text-muted">Saving to current project.</p>
            ) : (
              <p className="text-xs text-muted">Saving as personal (no project).</p>
            )}

            {error && <div className="text-red-400 text-sm">Error: {error}</div>}

            <div className="flex gap-2 justify-end">
              <button className="btn-ghost" onClick={close} disabled={saving}>Cancel</button>
              <button className="btn" onClick={handleSave} disabled={saving || !url.trim()}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
