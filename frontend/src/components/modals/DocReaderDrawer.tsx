import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { Drawer, Status, Tag } from '../primitives';
import { MarkdownPreview } from '../MarkdownPreview';
import { getContent, pinContent, unpinContent } from '../../lib/api';
import { fmtRel } from '../../lib/util';
import type { DocumentItem } from '../../types';

export function DocReaderDrawer({ doc, onClose }: { doc: DocumentItem; onClose: () => void }) {
  const qc = useQueryClient();
  const fullQ = useQuery({
    queryKey: ['content', doc.id, 'full'],
    queryFn: () => getContent(doc.id),
  });
  const pinMut = useMutation({
    mutationFn: () => (doc.pinned ? unpinContent(doc.id) : pinContent(doc.id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['content'] });
    },
  });

  const item = fullQ.data;
  const body = item?.content ?? '';

  return (
    <Drawer title={doc.title} onClose={onClose}>
      <div className="row-flex gap-2" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <Status status={doc.processing_status} error={doc.processing_error} />
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
            <Tag key={id}>{id.slice(0, 8)}</Tag>
          ))}
        </span>
      </div>

      <div className="row-flex gap-2" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {doc.source_url ? (
          <a className="btn btn-sm btn-primary" href={doc.source_url} target="_blank" rel="noreferrer">
            <Icons.ExternalLink size={12} /> Open original
          </a>
        ) : null}
        <button
          className="btn btn-sm"
          onClick={() => pinMut.mutate()}
          disabled={pinMut.isPending}
        >
          <Icons.Pin size={12} /> {doc.pinned ? 'Unpin' : 'Pin'}
        </button>
        <span className="subtle mono" style={{ marginLeft: 'auto', fontSize: 10.5 }}>
          {doc.size}
        </span>
      </div>
      <div
        className="md-preview"
        style={{
          padding: 14,
          background: 'var(--glass-bg-soft)',
          borderRadius: 10,
          border: '0.5px solid var(--hairline)',
          maxHeight: 480,
          overflowY: 'auto',
        }}
      >
        {fullQ.isLoading ? (
          <div className="page-subtle">Loading content…</div>
        ) : fullQ.error ? (
          <div className="page-subtle" style={{ color: 'var(--danger)' }}>
            Failed to load content: {fullQ.error instanceof Error ? fullQ.error.message : String(fullQ.error)}
          </div>
        ) : !body ? (
          <div className="page-subtle">No extracted text available.</div>
        ) : (
          <MarkdownPreview src={body} />
        )}
      </div>
      <div className="divider" />
      <label className="field-label">Backlinks</label>
      <div className="page-subtle" style={{ fontSize: 11 }}>
        Backlink graph not yet wired.
      </div>
    </Drawer>
  );
}
