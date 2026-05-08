import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { Modal, Status, Tag } from '../primitives';
import { MarkdownEditor } from '../MarkdownEditor';
import { createNote, editContentBody, updateContent } from '../../lib/api';
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
  const [editingTag, setEditingTag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['content'] });
    qc.invalidateQueries({ queryKey: ['project-counts'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      createNote({
        type: 'note',
        title: title.trim() || 'Untitled note',
        content: body,
        project_ids: projectId ? [projectId] : [],
        tags,
      }),
    onSuccess: () => { invalidateAll(); onClose(); },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Edit splits into two backend calls: metadata (PUT) for title/tags
  // and edit-body (async, 202 ack) when the body actually changed. We
  // gate each call on a real diff so we don't pay the re-chunk cost on
  // a tag-only tweak. Both are awaited before the modal closes so the
  // user sees the metadata update reflected on first refetch.
  const editMut = useMutation({
    mutationFn: async () => {
      if (!note) return;
      const cleanTitle = title.trim() || 'Untitled note';
      const titleChanged = cleanTitle !== note.title;
      const tagsChanged = JSON.stringify(tags) !== JSON.stringify(note.tags ?? []);
      const bodyChanged = body !== note.body;

      if (titleChanged || tagsChanged) {
        await updateContent(note.id, {
          ...(titleChanged ? { title: cleanTitle } : {}),
          ...(tagsChanged ? { tags } : {}),
        });
      }
      if (bodyChanged) {
        await editContentBody(note.id, body);
      }
    },
    onSuccess: () => { invalidateAll(); onClose(); },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const pending = createMut.isPending || editMut.isPending;

  const save = () => {
    setError(null);
    if (!body.trim()) {
      setError('Body is required.');
      return;
    }
    if (isNew) createMut.mutate();
    else editMut.mutate();
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
          <span className="subtle modal-foot-meta">
            {isNew ? 'draft' : `last edit ${fmtRel(note!.updated_at)}`} · {body.split(/\s+/).length} words
          </span>
          <button className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <input
        className="input note-title-input"
        value={title}
        onChange={e => setTitle(e.target.value)}
      />
      <div className="row-flex gap-1" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {tags.map((t, i) => (
          <Tag key={i} removable onRemove={() => setTags(tags.filter((_, j) => j !== i))}>
            {t}
          </Tag>
        ))}
        {editingTag ? (
          <span className="input-tag-wrap">
            <span className="hash">#</span>
            <input
              autoFocus
              className="input-tag"
              placeholder="add tag"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!tagDraft.trim()) { setEditingTag(false); return; }
                  addTag();
                } else if (e.key === 'Escape') {
                  setTagDraft('');
                  setEditingTag(false);
                }
              }}
              onBlur={() => { if (!tagDraft.trim()) setEditingTag(false); }}
            />
          </span>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setEditingTag(true)}>
            <Icons.Plus size={11} /> Add
          </button>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <Status status={note?.processing_status || 'ready'} />
        </span>
      </div>
      <div
        className="note-editor-pane"
        style={{
          minHeight: 360,
          padding: '6px 4px',
          background: 'var(--glass-bg-soft)',
          border: '0.5px solid var(--hairline)',
          borderRadius: 9,
          overflow: 'hidden',
        }}
      >
        <MarkdownEditor value={body} onChange={setBody} autoFocus />
      </div>
      {error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
