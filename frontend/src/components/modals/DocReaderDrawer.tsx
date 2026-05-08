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
      <div className="row-flex gap-2 chip-row">
        <Status status={doc.processing_status} error={doc.processing_error} />
        <Tag>{doc.type}</Tag>
        <span className="subtle">{doc.size}</span>
        {doc.tags.map(t => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>
      <div className="meta-grid">
        <span className="subtle">created</span>
        <span>{fmtRel(doc.created_at)}</span>
        {doc.published_at ? (
          <>
            <span className="subtle">published</span>
            <span>{fmtRel(doc.published_at)}</span>
          </>
        ) : null}
        {doc.file_hash ? (
          <>
            <span className="subtle">sha256</span>
            <span className="meta-hash">{doc.file_hash}</span>
          </>
        ) : null}
        {doc.source_url ? (
          <>
            <span className="subtle">source</span>
            <span className="meta-url">{doc.source_url}</span>
          </>
        ) : null}
        <span className="subtle">projects</span>
        <span className="row-flex gap-1 meta-projects">
          {doc.project_ids.map(id => (
            <Tag key={id}>{id.slice(0, 8)}</Tag>
          ))}
        </span>
      </div>

      <div className="row-flex gap-2 chip-row">
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
        <span className="subtle doc-size-trail">{doc.size}</span>
      </div>
      <div className="md-preview md-preview-card">
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
    </Drawer>
  );
}
