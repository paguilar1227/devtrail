import { Icons } from '../Icons';
import { Modal, Tag } from '../primitives';
import type { Project } from '../../types';

interface QueuedFile {
  name: string;
  size: string;
  status: 'uploading' | 'queued';
  pct?: number;
}

const FILES: QueuedFile[] = [
  { name: 'anthropic-cookbook-tools.pdf', size: '3.1 MB', status: 'uploading', pct: 64 },
  { name: 'research-meeting-2026-04-30.md', size: '12 KB', status: 'queued' },
];

export function UploadModal({ project, onClose }: { project: Project | null; onClose: () => void }) {
  return (
    <Modal
      title={`Add to ${project?.name || 'Inbox'}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary">Process all</button>
        </>
      }
    >
      <div className="dropzone">
        <div className="ic-big">
          <Icons.Upload />
        </div>
        <div className="t">Drop files here, or click to browse</div>
        <div className="d">PDF · MD · TXT · DOCX · audio · images · max 25 MB</div>
      </div>
      <div className="divider" />
      <label className="field-label">Or save a URL</label>
      <div className="row-flex gap-2">
        <input className="input" placeholder="https://example.com/article" />
        <button className="btn">Fetch</button>
      </div>
      <div className="divider" />
      <label className="field-label">Default tags</label>
      <div className="row-flex gap-1" style={{ flexWrap: 'wrap' }}>
        <Tag removable>research</Tag>
        <Tag removable>auth</Tag>
        <button className="btn btn-ghost btn-sm">+ Add</button>
      </div>
      <div className="divider" />
      <label className="field-label">Currently uploading</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {FILES.map((f, i) => (
          <div key={i} className="doc-row" style={{ gridTemplateColumns: '32px 1fr auto' }}>
            <div className="ic-box">
              <Icons.Doc />
            </div>
            <div>
              <div className="nm">{f.name}</div>
              <div className="sub">
                <span>{f.size}</span>
                {f.status === 'uploading' ? (
                  <span className="row-flex gap-2" style={{ flex: 1, maxWidth: 200 }}>
                    <span
                      style={{
                        background: 'var(--glass-bg-soft)',
                        height: 4,
                        borderRadius: 4,
                        flex: 1,
                        position: 'relative',
                        overflow: 'hidden',
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          inset: 0,
                          width: `${f.pct ?? 0}%`,
                          background: 'var(--accent-grad)',
                        }}
                      />
                    </span>
                    <span>{f.pct}%</span>
                  </span>
                ) : (
                  <span>queued</span>
                )}
              </div>
            </div>
            <button className="btn btn-ghost btn-icon">
              <Icons.X />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
