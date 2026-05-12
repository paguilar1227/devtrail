import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { Drawer, Status, Tag } from '../primitives';
import { MarkdownPreview } from '../MarkdownPreview';
import { getContent, pinContent, unpinContent } from '../../lib/api';
import { cls, fmtRel } from '../../lib/util';
import type { DocumentItem } from '../../types';

// Pick a preview surface from the mime type. The text-only branch covers
// markdown-as-doc rows where the body IS the document — no separate source
// media — so the existing MarkdownPreview render below is the whole story.
type PreviewMode = 'pdf' | 'image' | 'audio' | 'video' | 'text' | 'other';

function previewModeFor(mime: string, hasBlob: boolean): PreviewMode {
  if (!hasBlob) return 'text';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}

function downloadName(doc: DocumentItem): string {
  // Pick a filename for the download link. The backend stores the original
  // filename in metadata but we don't expose it on the UI shape today, so
  // we fall back to the title; the user gets something readable instead of
  // a random blob name when they save.
  return doc.title || 'document';
}

function DocPreview({ doc, blobUrl }: { doc: DocumentItem; blobUrl: string | null }) {
  const mode = previewModeFor(doc.mime, !!blobUrl);
  const [imageOpen, setImageOpen] = useState(false);

  if (mode === 'text' || !blobUrl) return null;

  if (mode === 'pdf') {
    // <object> + <embed> together so browsers that refuse one fall back to
    // the other; the Download anchor inside is what shows if neither renders.
    return (
      <div className="doc-preview doc-preview-pdf">
        <object data={blobUrl} type="application/pdf" aria-label={doc.title}>
          <embed src={blobUrl} type="application/pdf" />
          <div className="doc-preview-fallback">
            <span className="subtle">Inline PDF preview is not supported in this browser.</span>
            <a className="btn btn-sm btn-primary" href={blobUrl} download={downloadName(doc)}>
              <Icons.Download size={12} /> Download PDF
            </a>
          </div>
        </object>
      </div>
    );
  }

  if (mode === 'image') {
    return (
      <>
        <button
          type="button"
          className="doc-preview doc-preview-image"
          onClick={() => setImageOpen(true)}
          aria-label="Open full-size image"
        >
          <img src={blobUrl} alt={doc.title} />
          <span className="doc-preview-zoom"><Icons.Expand size={11} /> Click to enlarge</span>
        </button>
        {imageOpen && (
          <div
            className="doc-preview-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={doc.title}
            onClick={() => setImageOpen(false)}
          >
            <img src={blobUrl} alt={doc.title} />
            <button
              type="button"
              className="btn btn-ghost btn-icon doc-preview-lightbox-close"
              onClick={() => setImageOpen(false)}
              aria-label="Close preview"
            >
              <Icons.X />
            </button>
          </div>
        )}
      </>
    );
  }

  if (mode === 'audio') {
    return (
      <div className="doc-preview doc-preview-audio">
        <audio controls preload="metadata" src={blobUrl}>
          <a href={blobUrl} download={downloadName(doc)}>Download audio</a>
        </audio>
      </div>
    );
  }

  if (mode === 'video') {
    return (
      <div className="doc-preview doc-preview-video">
        <video controls preload="metadata" src={blobUrl}>
          <a href={blobUrl} download={downloadName(doc)}>Download video</a>
        </video>
      </div>
    );
  }

  // mode === 'other'
  return (
    <div className="doc-preview doc-preview-other">
      <span className="subtle">{doc.mime || 'Unknown type'}</span>
      <a className="btn btn-sm btn-primary" href={blobUrl} download={downloadName(doc)}>
        <Icons.Download size={12} /> Download
      </a>
    </div>
  );
}

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
  // The wire shape signs blob_url with a 60-min SAS in production AND against
  // Azurite locally, so the browser can fetch directly off the storage host
  // in both environments. Falls back to doc.blob_url if the full record
  // hasn't loaded yet — that one is also signed (same serializer).
  const blobUrl = item?.blob_url ?? doc.blob_url;
  const mode = previewModeFor(doc.mime, !!blobUrl);
  const hasBody = body.trim().length > 0;

  return (
    <Drawer title={doc.title} onClose={onClose}>
      <div className="row-flex gap-2 chip-row">
        <Status status={doc.processing_status} error={doc.processing_error} />
        <Tag>{doc.type}</Tag>
        {doc.mime ? <span className="subtle doc-mime">{doc.mime}</span> : null}
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
        {blobUrl ? (
          <a className="btn btn-sm" href={blobUrl} download={downloadName(doc)}>
            <Icons.Download size={12} /> Download
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

      <DocPreview doc={doc} blobUrl={blobUrl} />

      {/* For binary docs the extracted text is supplementary — useful for
          search/RAG and as a body when the preview is awkward (mobile PDF
          embeds especially). We label it so a glance distinguishes the
          model's extraction from the document itself. For text-only docs
          this block IS the document, so no label. */}
      {hasBody || mode === 'text' ? (
        <>
          {mode !== 'text' && hasBody ? (
            <div className={cls('subtle', 'doc-extracted-label')}>Extracted text</div>
          ) : null}
          <div className="md-preview md-preview-card">
            {fullQ.isLoading ? (
              <div className="page-subtle">Loading content…</div>
            ) : fullQ.error ? (
              <div className="page-subtle" style={{ color: 'var(--danger)' }}>
                Failed to load content: {fullQ.error instanceof Error ? fullQ.error.message : String(fullQ.error)}
              </div>
            ) : !hasBody ? (
              <div className="page-subtle">No extracted text available.</div>
            ) : (
              <MarkdownPreview src={body} />
            )}
          </div>
        </>
      ) : null}
    </Drawer>
  );
}
