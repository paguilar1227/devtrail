import { useState } from 'react';
import { Icons } from '../Icons';
import { EntityLink, Modal, Status, Tag } from '../primitives';
import { MarkdownPreview } from '../MarkdownPreview';
import { fmtRel } from '../../lib/util';
import type { Note } from '../../types';

interface Props {
  note: Note | null;
  onClose: () => void;
}

export function NoteEditorModal({ note, onClose }: Props) {
  const [body, setBody] = useState(note?.body ?? '# New note\n\nStart writing…');
  const [title, setTitle] = useState(note?.title ?? 'Untitled note');
  const [tags, setTags] = useState<string[]>(note?.tags ?? []);
  const isNew = !note;

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
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary">Save</button>
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
        <button className="btn btn-ghost btn-sm">
          <Icons.Plus size={11} /> Add tag
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
