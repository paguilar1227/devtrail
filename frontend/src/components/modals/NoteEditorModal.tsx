import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../Icons';
import { Modal, Status, Tag } from '../primitives';
import { MarkdownEditor } from '../MarkdownEditor';
import { TypeaheadPopover, type TypeaheadItem } from '../TypeaheadPopover';
import { createNote, editContentBody, listTags, updateContent } from '../../lib/api';
import { useDirtyCloseGuard } from '../../lib/useDirtyCloseGuard';
import { fmtRel } from '../../lib/util';
import type { Note } from '../../types';

const NEW_NOTE_BODY_PLACEHOLDER = '# New note\n\nStart writing…';
const NEW_NOTE_TITLE_PLACEHOLDER = 'Untitled note';

interface Props {
  note: Note | null;
  projectId?: string;
  onClose: () => void;
}

// Resolve the tag-suggestion scope for the note being edited. Single
// project membership → scope to that project. Empty membership →
// personal. Multi-project → fall back to global (no filter) since
// neither single-project nor personal applies.
function tagsScopeFor(note: Note | null, defaultProjectId?: string): { project_id: string } | { scope: 'personal' | 'all' } {
  const ids = note?.project_ids ?? (defaultProjectId ? [defaultProjectId] : []);
  if (ids.length === 1) return { project_id: ids[0] };
  if (ids.length === 0) return { scope: 'personal' };
  return { scope: 'all' };
}

export function NoteEditorModal({ note, projectId, onClose }: Props) {
  const isNew = !note;
  const [body, setBody] = useState(note?.body ?? NEW_NOTE_BODY_PLACEHOLDER);
  const [title, setTitle] = useState(note?.title ?? NEW_NOTE_TITLE_PLACEHOLDER);
  const [tags, setTags] = useState<string[]>(note?.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [editingTag, setEditingTag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  // Scope-aware tag suggestions for the typeahead. Same source-of-
  // truth listTags endpoint the home page uses, scoped to wherever
  // the note lives so the user sees relevant tags first.
  const tagsScope = useMemo(() => tagsScopeFor(note, projectId), [note, projectId]);
  const tagsQ = useQuery({
    queryKey: ['tags', 'note-editor', JSON.stringify(tagsScope)],
    queryFn: () => listTags(tagsScope),
    staleTime: 60_000,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['content'] });
    qc.invalidateQueries({ queryKey: ['project-counts'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
    qc.invalidateQueries({ queryKey: ['tags'] });
  };

  // Both mutations take the final tag list as an arg (not from closure)
  // so a draft committed in save() is reflected even though setTags is
  // async and the mutationFn captures the previous render's state.
  const createMut = useMutation({
    mutationFn: (finalTags: string[]) =>
      createNote({
        type: 'note',
        title: title.trim() || 'Untitled note',
        content: body,
        project_ids: projectId ? [projectId] : [],
        tags: finalTags,
      }),
    onSuccess: () => { invalidateAll(); onClose(); },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Edit splits into two backend calls: metadata (PUT) for title/tags
  // and edit-body (async, 202 ack) when the body actually changed. We
  // gate each call on a real diff so we don't pay the re-chunk cost on
  // a tag-only tweak.
  const editMut = useMutation({
    mutationFn: async (finalTags: string[]) => {
      if (!note) return;
      const cleanTitle = title.trim() || 'Untitled note';
      const titleChanged = cleanTitle !== note.title;
      const tagsChanged = JSON.stringify(finalTags) !== JSON.stringify(note.tags ?? []);
      const bodyChanged = body !== note.body;

      if (titleChanged || tagsChanged) {
        await updateContent(note.id, {
          ...(titleChanged ? { title: cleanTitle } : {}),
          ...(tagsChanged ? { tags: finalTags } : {}),
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

  // Dirty = user has actually edited something compared to the initial
  // state. For a new note that means stepping away from the placeholder
  // defaults; for an existing note it means any field differs from the
  // server's copy. Pending tag draft also counts as dirty so Cancel
  // doesn't quietly lose it.
  const cleanTitle = title.trim() || NEW_NOTE_TITLE_PLACEHOLDER;
  const draftIsNovel = tagDraft.trim().length > 0 && !tags.includes(tagDraft.trim().toLowerCase());
  const isDirty = isNew
    ? (
        body !== NEW_NOTE_BODY_PLACEHOLDER ||
        cleanTitle !== NEW_NOTE_TITLE_PLACEHOLDER ||
        tags.length > 0 ||
        draftIsNovel
      )
    : (
        body !== note!.body ||
        cleanTitle !== note!.title ||
        JSON.stringify(tags) !== JSON.stringify(note!.tags ?? []) ||
        draftIsNovel
      );

  const tryClose = useDirtyCloseGuard(isDirty, onClose, pending);

  // Compute the final tag list including any uncommitted draft. Used
  // by both save() and the typeahead's selection logic. Centralized
  // so the "you can click Save without pressing Enter and it still
  // saves your typed tag" promise is consistent.
  const commitDraftInto = (current: string[]): string[] => {
    const t = tagDraft.trim().toLowerCase();
    if (!t || current.includes(t)) return current;
    return [...current, t];
  };

  const addTag = (tagName: string) => {
    const t = tagName.trim().toLowerCase();
    if (!t || tags.includes(t)) return;
    setTags([...tags, t]);
    setTagDraft('');
    setActiveIndex(0);
    // Leave editingTag=true so the user can chain-add another tag
    // without re-clicking Add. Escape / blur (with empty draft) closes.
  };

  // Typeahead state — popover open while the user is editing a tag
  // and there's something to suggest. Caller selects with ↓↑ + Enter
  // (parent-owned cursor pattern, same as SearchInput).
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Filtered suggestion items: scope-tagged tags that aren't already
  // applied, matching the current draft as a prefix or substring.
  // Top 8 by usage count.
  const tagItems = useMemo<TypeaheadItem[]>(() => {
    const prefix = tagDraft.trim().toLowerCase();
    const applied = new Set(tags.map((t) => t.toLowerCase()));
    return (tagsQ.data ?? [])
      .filter((t) => !applied.has(t.name.toLowerCase()))
      .filter((t) => !prefix || t.name.toLowerCase().includes(prefix))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
      .map((t) => ({ key: t.name, value: t.name, label: t.name, sublabel: String(t.total) }));
  }, [tagDraft, tags, tagsQ.data]);

  const popoverOpen = editingTag && tagItems.length > 0;

  const onTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (popoverOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(tagItems.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        addTag(tagItems[activeIndex].value);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (popoverOpen && tagItems[activeIndex]) {
        addTag(tagItems[activeIndex].value);
      } else if (tagDraft.trim()) {
        addTag(tagDraft);
      } else {
        setEditingTag(false);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setTagDraft('');
      setEditingTag(false);
    }
  };

  const save = () => {
    setError(null);
    if (!body.trim()) {
      setError('Body is required.');
      return;
    }
    // Commit any pending draft into the tag list before mutating —
    // saves users from "I typed it but forgot to press Enter" data loss.
    const finalTags = commitDraftInto(tags);
    if (finalTags !== tags) setTags(finalTags);
    setTagDraft('');
    if (isNew) createMut.mutate(finalTags);
    else editMut.mutate(finalTags);
  };

  return (
    <Modal
      title={isNew ? 'New note' : 'Edit note'}
      size="lg"
      onClose={tryClose}
      footer={
        <>
          <span className="subtle modal-foot-meta">
            {isNew ? 'draft' : `last edit ${fmtRel(note!.updated_at)}`} · {body.split(/\s+/).length} words
          </span>
          <button className="btn" onClick={tryClose} disabled={pending}>Cancel</button>
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
          <span className="input-tag-wrap" style={{ position: 'relative' }}>
            <span className="hash">#</span>
            <input
              ref={inputRef}
              autoFocus
              className="input-tag"
              placeholder="add tag"
              value={tagDraft}
              onChange={(e) => {
                setTagDraft(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onTagKeyDown}
              onBlur={() => { if (!tagDraft.trim()) setEditingTag(false); }}
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={popoverOpen}
              aria-autocomplete="list"
            />
            {popoverOpen ? (
              <TypeaheadPopover
                items={tagItems}
                activeIndex={activeIndex}
                onSelect={(item) => addTag(item.value)}
                onHover={setActiveIndex}
                onDismiss={() => setEditingTag(false)}
                ariaLabel="Tag suggestions"
              />
            ) : null}
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
