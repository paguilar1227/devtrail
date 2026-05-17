// Read-only note surface that mirrors DocReaderBody. Renders inside a
// drawer (either standalone via NoteReaderDrawer or embedded via
// NoteListDrawer's inline-detail mode). The "Edit" button opens the full
// NoteEditorModal — kept separate so the editor's dirty-guard and
// markdown editor stay contained in their own surface.
//
// Why a reader instead of inline editing: parity with DocReaderBody.
// Clicking a row should not unmount the surrounding list state; once the
// user actually wants to edit, the modal pops up, and on save the reader
// refetches and stays inline. Back returns to the list.
//
// Download/Open chips use a synthesized same-origin blob: URL built from
// the note body — same trick DocReaderBody uses for note-as-doc rows.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { Drawer, Status, Tag } from '../primitives';
import { MarkdownPreview } from '../MarkdownPreview';
import { NoteEditorModal } from './NoteEditorModal';
import { getContent, listProjects, pinContent, unpinContent } from '../../lib/api';
import { fmtRel } from '../../lib/util';
import { toUiNote } from '../../lib/view';
import type { Note, Route } from '../../types';

interface BodyProps {
  note: Note;
  onClose: () => void;
  onBack?: () => void;
  onRoute?: (r: Route) => void;
}

export function NoteReaderBody({ note, onClose, onBack, onRoute }: BodyProps) {
  const qc = useQueryClient();
  // Refetch full content so any edits from the modal are reflected here.
  // The list view ships a body too, but it's the snapshot from initial
  // list load; this is the authoritative copy.
  const fullQ = useQuery({
    queryKey: ['content', note.id, 'full'],
    queryFn: () => getContent(note.id),
  });
  const projectsQ = useQuery({
    queryKey: ['projects'],
    queryFn: () => listProjects(),
    staleTime: 60_000,
  });
  const pinMut = useMutation({
    mutationFn: () => (note.pinned ? unpinContent(note.id) : pinContent(note.id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['content'] });
    },
  });

  const item = fullQ.data;
  // Prefer the freshly-fetched body. Fall back to whatever the list row
  // had so the reader renders something while the fetch is in flight.
  const body = item?.content ?? note.body ?? '';
  const hasBody = body.trim().length > 0;

  // Same trick DocReaderBody uses for text-only docs: synthesize a
  // same-origin blob: URL from the markdown body. Same-origin honors the
  // HTML `download` attribute directly, so no Content-Disposition SAS
  // dance needed. Revoke on unmount to avoid the leak.
  const blobUrl = useMemo(() => {
    if (!hasBody) return null;
    return URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
  }, [hasBody, body]);
  useEffect(() => {
    if (!blobUrl) return;
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);
  const downloadFilename = `${(note.title || 'note').replace(/[/\\?%*:|"<>]/g, '_')}.md`;

  const projectById = new Map((projectsQ.data ?? []).map(p => [p.id, p]));
  const goToProject = (id: string) => {
    if (!onRoute) return;
    onClose();
    onRoute({ route: 'project', project: id });
  };

  // Editor is local state — opening it doesn't unmount the reader, so
  // the reader's scroll position survives a save. Modal close just flips
  // this back to false; React Query invalidation in NoteEditorModal
  // triggers our fullQ to refetch.
  const [editing, setEditing] = useState(false);
  // toUiNote needs a full ApiContent. fullQ has it; until it loads we
  // can't pop the editor, so the button is disabled while loading.
  const editorNote = item ? toUiNote(item) : null;

  return (
    <>
      {onBack ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm doc-reader-back"
          onClick={onBack}
        >
          <Icons.ChevronLeft size={12} /> Back to list
        </button>
      ) : null}
      <div className="row-flex gap-2 chip-row">
        <Status status={note.processing_status} />
        <Tag>note</Tag>
        {note.tags.map(t => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>
      <div className="meta-grid">
        <span className="subtle">created</span>
        <span>{fmtRel(note.created_at)}</span>
        <span className="subtle">updated</span>
        <span>{fmtRel(note.updated_at)}</span>
        {note.project_ids.length > 0 ? (
          <>
            <span className="subtle">projects</span>
            <span className="row-flex gap-1 meta-projects">
              {note.project_ids.map(id => {
                const p = projectById.get(id);
                const label = p?.name ?? (projectsQ.isLoading ? '…' : id.slice(0, 8));
                return onRoute ? (
                  <button
                    key={id}
                    type="button"
                    className="tag tag-link"
                    onClick={() => goToProject(id)}
                    title={p ? `Open ${p.name}` : 'Open project'}
                  >
                    {label}
                  </button>
                ) : (
                  <Tag key={id}>{label}</Tag>
                );
              })}
            </span>
          </>
        ) : null}
      </div>

      <div className="row-flex gap-2 chip-row">
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setEditing(true)}
          disabled={!editorNote}
        >
          <Icons.Pencil size={12} /> Edit
        </button>
        {blobUrl ? (
          <a className="btn btn-sm" href={blobUrl} download={downloadFilename}>
            <Icons.Download size={12} /> Download
          </a>
        ) : null}
        {blobUrl ? (
          <a className="btn btn-sm" href={blobUrl} target="_blank" rel="noopener noreferrer">
            <Icons.ExternalLink size={12} /> Open
          </a>
        ) : null}
        <button
          className="btn btn-sm"
          onClick={() => pinMut.mutate()}
          disabled={pinMut.isPending}
        >
          <Icons.Pin size={12} /> {note.pinned ? 'Unpin' : 'Pin'}
        </button>
      </div>

      <div className="doc-reader-content">
        <div className="md-preview md-preview-card">
          {fullQ.isLoading && !hasBody ? (
            <div className="page-subtle">Loading content…</div>
          ) : fullQ.error ? (
            <div className="page-subtle" style={{ color: 'var(--danger)' }}>
              Failed to load content: {fullQ.error instanceof Error ? fullQ.error.message : String(fullQ.error)}
            </div>
          ) : !hasBody ? (
            <div className="page-subtle">No content yet.</div>
          ) : (
            <MarkdownPreview src={body} />
          )}
        </div>
      </div>

      {editing && editorNote ? (
        <NoteEditorModal note={editorNote} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

export function NoteReaderDrawer({
  note,
  onClose,
  onRoute,
}: {
  note: Note;
  onClose: () => void;
  onRoute?: (r: Route) => void;
}) {
  return (
    <Drawer title={note.title} onClose={onClose}>
      <NoteReaderBody note={note} onClose={onClose} onRoute={onRoute} />
    </Drawer>
  );
}
