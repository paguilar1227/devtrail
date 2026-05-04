import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { EntityLink, Modal, Status, Tag } from '../primitives';
import { MarkdownPreview } from '../MarkdownPreview';
import { createNote } from '../../lib/api';
import { fmtRel } from '../../lib/util';
import type { Note } from '../../types';

interface Props {
  note: Note | null;
  projectId?: string;
  onClose: () => void;
}

export function NoteEditorModal({ note, projectId, onClose }: Props) {
  const isNew = !note;
  const [body, setBody] = useState(note?.body ?? '# New note\n\nStart writing…');
  const [title, setTitle] = useState(note?.title ?? 'Untitled note');
  const [tags, setTags] = useState<string[]>(note?.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const createMut = useMutation({
    mutationFn: () =>
      createNote({
        type: 'note',
        title: title.trim() || 'Untitled note',
        content: body,
        project_ids: projectId ? [projectId] : [],
        tags,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['content'] });
      qc.invalidateQueries({ queryKey: ['project-counts'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const save = () => {
    setError(null);
    if (!body.trim()) {
      setError('Body is required.');
      return;
    }
    if (isNew) {
      createMut.mutate();
    } else {
      // Editing existing notes (PUT /content/:id + POST /content/:id/edit-body)
      // is a separate flow with body-immutability rules — TODO when needed.
      setError('Editing existing notes not yet wired in this UI.');
    }
  };

  const addTag = () => {
    const t = tagDraft.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  };

  return (
    <Modal
      title={isNew ? 'New note' : 'Edit note'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="subtle mono" style={{ fontSize: 10.5, marginRight: 'auto' }}>
            {isNew ? 'draft' : `last edit ${fmtRel(note!.updated_at)}`} · {body.split(/\s+/).length} words
          </span>
          <button className="btn" onClick={onClose} disabled={createMut.isPending}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={createMut.isPending}>
            {createMut.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <input
        className="input"
        value={title}
        onChange={e => setTitle(e.target.value)}
        style={{ fontSize: 18, fontWeight: 600, padding: '10px 14px', marginBottom: 12, letterSpacing: '-0.015em' }}
      />
      <div className="row-flex gap-1" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {tags.map((t, i) => (
          <Tag key={i} removable onRemove={() => setTags(tags.filter((_, j) => j !== i))}>
            {t}
          </Tag>
        ))}
        <input
          className="input"
          placeholder="add tag"
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
          style={{ width: 100, fontSize: 11 }}
        />
        <button className="btn btn-ghost btn-sm" onClick={addTag}>
          <Icons.Plus size={11} /> Add
        </button>
        <span style={{ marginLeft: 'auto' }}>
          <Status status={note?.processing_status || 'ready'} />
        </span>
      </div>
      <div className="note-editor-grid">
        <textarea
          className="input input-mono"
          value={body}
          onChange={e => setBody(e.target.value)}
          style={{ resize: 'none', height: '100%', fontSize: 12.5, lineHeight: 1.6 }}
        />
        <div
          className="md-preview"
          style={{
            padding: '10px 14px',
            background: 'var(--glass-bg-soft)',
            border: '0.5px solid var(--hairline)',
            borderRadius: 9,
            overflowY: 'auto',
          }}
        >
          <MarkdownPreview src={body} />
        </div>
      </div>
      {error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {error}
        </div>
      ) : null}
      <div className="divider" />
      <label className="field-label">Linked entities</label>
      <div className="row-flex gap-1" style={{ flexWrap: 'wrap' }}>
        <EntityLink kind="doc">Headless Mode Reference</EntityLink>
        <EntityLink kind="todo">Wire up streaming responses with SSE</EntityLink>
        <button className="btn btn-ghost btn-sm">+ Link</button>
      </div>
    </Modal>
  );
}
