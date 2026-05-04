import { Icons } from '../Icons';
import { Drawer, EntityLink, Status, Tag } from '../primitives';
import { PROJECTS } from '../../lib/mock';
import { fmtRel } from '../../lib/util';
import type { DocumentItem } from '../../types';

export function DocReaderDrawer({ doc, onClose }: { doc: DocumentItem; onClose: () => void }) {
  return (
    <Drawer title={doc.title} onClose={onClose}>
      <div className="row-flex gap-2" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <Status status={doc.processing_status} />
        <Tag>{doc.type}</Tag>
        <span className="subtle mono" style={{ fontSize: 10.5 }}>
          {doc.size}
        </span>
        {doc.tags.map(t => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: 11.5, marginBottom: 18 }}>
        <span className="subtle mono">created</span>
        <span className="mono">{fmtRel(doc.created_at)}</span>
        {doc.published_at ? (
          <>
            <span className="subtle mono">published</span>
            <span className="mono">{fmtRel(doc.published_at)}</span>
          </>
        ) : null}
        {doc.file_hash ? (
          <>
            <span className="subtle mono">sha256</span>
            <span className="mono">{doc.file_hash}</span>
          </>
        ) : null}
        {doc.source_url ? (
          <>
            <span className="subtle mono">source</span>
            <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.source_url}
            </span>
          </>
        ) : null}
        <span className="subtle mono">projects</span>
        <span className="row-flex gap-1" style={{ flexWrap: 'wrap' }}>
          {doc.project_ids.map(id => (
            <Tag key={id}>{PROJECTS.find(p => p.id === id)?.name || id}</Tag>
          ))}
        </span>
      </div>

      <div className="row-flex gap-2" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <a className="btn btn-sm btn-primary" href={doc.source_url || '#'} target="_blank" rel="noreferrer">
          <Icons.ExternalLink size={12} /> Open original
        </a>
        <button className="btn btn-sm">
          <Icons.Upload size={12} /> Replace
        </button>
        <button className="btn btn-sm">
          <Icons.Tag size={12} /> Edit tags
        </button>
        <button className="btn btn-sm">
          <Icons.Pin size={12} /> {doc.pinned ? 'Unpin' : 'Pin'}
        </button>
        <span className="subtle mono" style={{ marginLeft: 'auto', fontSize: 10.5 }}>
          {doc.type === 'binary'
            ? doc.file_hash
              ? `cached locally · ${doc.size}`
              : doc.size
            : doc.type === 'url'
              ? 'fetched · cached'
              : 'note-as-doc'}
        </span>
      </div>
      <div
        className="md-preview"
        style={{
          padding: 14,
          background: 'var(--glass-bg-soft)',
          borderRadius: 10,
          border: '0.5px solid var(--hairline)',
        }}
      >
        <h2>Extracted text · first chunk</h2>
        <p>
          The Claude Code <b>headless mode</b> exposes the full session lifecycle through a stable JSON-over-stdio protocol. This makes
          it suitable for embedding inside agent runtimes, IDE plugins, or — as in ClaudePit — a long-lived web supervisor.
        </p>
        <p>
          Authentication is handled via either <code>--auth-mode=cookie</code> (subscription cookie read from the OS keychain) or{' '}
          <code>--auth-mode=key</code> (API key from environment). Cookie mode is preferred for desktop use because it inherits the
          user's existing subscription and avoids creating a separate billing path.
        </p>
        <h3>Session protocol</h3>
        <pre>{`> { "type": "input", "content": "..." }
< { "type": "delta", "content": "..." }
< { "type": "tool_use", "name": "...", "args": {...} }
< { "type": "complete", "tokens": { "in": 123, "out": 456 } }`}</pre>
        <p style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>
          Showing chunk 1 of 7 · <a href="#">show more</a>
        </p>
      </div>
      <div className="divider" />
      <label className="field-label">Backlinks</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <EntityLink kind="note">ClaudePit — High-Level Concept</EntityLink>
        <EntityLink kind="todo">Document headless mode quirks</EntityLink>
      </div>
    </Drawer>
  );
}
