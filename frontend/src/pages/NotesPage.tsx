// Notes browser — a Bear-style three-column view over notes organized by
// FOLDERS (hierarchical slash-tags; see lib/folders.ts). Left: the folder
// tree. Middle: notes in the selected folder (or hybrid search results when
// the SearchInput has a query) — the SAME SearchInput used on Home. Right:
// the selected note's content + an editable folder-path chip bar.
//
// Scope (personal / all / a project) mirrors the Tags view's dropdown.
// Everything is derived client-side from the notes in scope — no backend
// changes (a Folder is just a tag containing '/').

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icons } from '../components/Icons';
import { Tag } from '../components/primitives';
import { SortDropdown } from '../components/SortDropdown';
import { SearchInput, type SigilKind } from '../components/SearchInput';
import { NoteRow } from '../components/NoteRow';
import { NoteReaderBody } from '../components/modals/NoteReaderDrawer';
import { listContent, listProjects, updateContent } from '../lib/api';
import { toUiNote, toUiProjects } from '../lib/view';
import { useEntitySearch } from '../lib/useEntitySearch';
import { useTagSuggestions } from '../lib/useTagSuggestions';
import {
  buildFolderTree, noteInFolder, withFolders, splitTags, normalizeFolderPath,
  type FolderNode,
} from '../lib/folders';
import { cls } from '../lib/util';
import type { ContentItem } from '@open-brain/shared';
import type { ActionDispatch, Note, Route } from '../types';

type ScopeMode = 'personal' | 'all' | string;

interface Props {
  onAction: ActionDispatch;
  onRoute: (r: Route) => void;
  initialPath?: string;
  initialScope?: ScopeMode;
}

const NOTE_SIGILS: readonly SigilKind[] = ['tag'];
const NO_MENTIONS: never[] = [];

const scopeToProjectId = (scope: ScopeMode): 'null' | string | undefined =>
  scope === 'personal' ? 'null' : scope === 'all' ? undefined : scope;

export function NotesPage({ onAction, onRoute, initialPath, initialScope }: Props) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<ScopeMode>(initialScope ?? 'personal');
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // --- scope dropdown options (Personal / All / each active project) ---
  const projectsQ = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const projects = useMemo(
    () => toUiProjects(projectsQ.data ?? [], []).filter((p) => p.status === 'active'),
    [projectsQ.data],
  );
  const scopeModes: readonly ScopeMode[] = useMemo(
    () => ['personal', 'all', ...projects.map((p) => p.id)],
    [projects],
  );
  const scopeLabels = useMemo(() => {
    const out: Record<string, string> = { personal: 'Personal', all: 'All projects' };
    for (const p of projects) out[p.id] = p.name;
    return out;
  }, [projects]);

  const projectId = scopeToProjectId(scope);

  // --- all notes in scope (drives both the tree and the browse list) ---
  const notesQ = useQuery({
    queryKey: ['content', 'note', 'notes-view', scope],
    queryFn: () => listContent(projectId === undefined ? { type: 'note' } : { type: 'note', project_id: projectId }),
  });
  const notes: ContentItem[] = notesQ.data ?? [];

  const roots = useMemo(() => buildFolderTree(notes.map((n) => ({ tags: n.tags }))), [notes]);

  // --- middle column: hybrid search (when typing) OR folder-filtered browse ---
  const { query, setQuery, searchActive, hits } = useEntitySearch({ projectId, entityTypes: ['note'] });
  const tagSuggestions = useTagSuggestions(
    scope === 'personal' ? { scope: 'personal', type: 'note' }
      : scope === 'all' ? { type: 'note' }
        : { project_id: scope, type: 'note' },
  );

  const browseNotes = useMemo(() => {
    const list = selectedPath ? notes.filter((n) => noteInFolder(n.tags, selectedPath)) : notes;
    return [...list]
      .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
      .map(toUiNote);
  }, [notes, selectedPath]);

  const searchNotes = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof hits = [];
    for (const h of hits) {
      if (h.entity_kind !== 'note' || seen.has(h.entity_id)) continue;
      seen.add(h.entity_id);
      out.push(h);
    }
    return out;
  }, [hits]);

  // Reset the open note when the visible list changes out from under it.
  useEffect(() => { setSelectedId(null); }, [selectedPath, scope]);

  const selectedNote: Note | null = useMemo(() => {
    if (!selectedId) return null;
    const ci = notes.find((n) => n.id === selectedId);
    return ci ? toUiNote(ci) : null;
  }, [notes, selectedId]);

  // --- folder-path editing on the open note ---
  const saveFolders = useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) => updateContent(id, { tags }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['content', 'note', 'notes-view'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
    },
  });
  const setNoteFolders = (note: Note, folders: string[]) =>
    saveFolders.mutate({ id: note.id, tags: withFolders(note.tags, folders) });

  const scopeNoteCount = notes.length;

  return (
    <div className="notes-view">
      <div className="notes-view-head">
        <div>
          <h1>Notes</h1>
          <p className="page-subtle">
            {scopeNoteCount} notes · organized by Folders (nested <code>#a/b/c</code> tags).
          </p>
        </div>
        <SortDropdown<ScopeMode>
          id="notes-scope"
          mode={scope}
          modes={scopeModes}
          labels={scopeLabels}
          onChange={(s) => { setScope(s); setSelectedPath(null); }}
          label="Scope"
        />
      </div>

      <div className="notes-cols">
        {/* ---- LEFT: folder tree ---- */}
        <nav className="notes-tree" aria-label="Folders">
          <button
            className={cls('notes-tree-row', selectedPath === null && 'active')}
            onClick={() => setSelectedPath(null)}
          >
            <Icons.Layers size={13} />
            <span className="lbl">All notes</span>
            <span className="ct">{scopeNoteCount}</span>
          </button>
          {roots.length === 0 ? (
            <div className="page-subtle notes-tree-empty">
              No folders yet. Tag a note <code>#area/topic</code> to start a tree.
            </div>
          ) : (
            roots.map((n) => (
              <FolderTreeNode
                key={n.path}
                node={n}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={(p) => setExpanded((s) => { const n2 = new Set(s); n2.has(p) ? n2.delete(p) : n2.add(p); return n2; })}
                onSelect={setSelectedPath}
              />
            ))
          )}
        </nav>

        {/* ---- MIDDLE: search + notes list ---- */}
        <div className="notes-list">
          <div className="notes-list-search">
            <div className="search-box">
              <Icons.Search size={13} />
              <SearchInput
                value={query}
                onChange={setQuery}
                onSubmit={() => { /* live */ }}
                tags={tagSuggestions}
                mentions={NO_MENTIONS}
                sigils={NOTE_SIGILS}
                placeholder="Search notes… try #tag"
              />
            </div>
          </div>
          <div className="notes-list-rows">
            {notesQ.isLoading ? (
              <div className="page-subtle">Loading…</div>
            ) : searchActive ? (
              searchNotes.length === 0 ? (
                <div className="page-subtle">No notes match.</div>
              ) : (
                searchNotes.map((h) => (
                  <NoteRow
                    key={h.entity_id}
                    note={{ title: h.title }}
                    sub={h.excerpt}
                    tags={h.tags}
                    onClick={() => setSelectedId(h.entity_id)}
                  />
                ))
              )
            ) : browseNotes.length === 0 ? (
              <div className="page-subtle">
                {selectedPath ? 'No notes in this folder.' : 'No notes yet.'}
              </div>
            ) : (
              browseNotes.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  tags={n.tags}
                  onClick={() => setSelectedId(n.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* ---- RIGHT: note content + folder-path editor ---- */}
        <div className="notes-detail">
          {selectedNote ? (
            <>
              <div className="notes-detail-body">
                <NoteReaderBody
                  key={selectedNote.id}
                  note={selectedNote}
                  onClose={() => setSelectedId(null)}
                  onRoute={onRoute}
                />
              </div>
              <FolderPathEditor
                note={selectedNote}
                pending={saveFolders.isPending}
                onChange={(folders) => setNoteFolders(selectedNote, folders)}
              />
            </>
          ) : (
            <div className="notes-detail-empty page-subtle">
              {browseNotes.length || searchNotes.length ? 'Select a note to read it.' : 'Nothing here yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- recursive folder tree node ----
function FolderTreeNode({
  node, depth, selectedPath, expanded, onToggle, onSelect,
}: {
  node: FolderNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const hasKids = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  return (
    <>
      <div
        className={cls('notes-tree-row', selectedPath === node.path && 'active')}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node.path)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(node.path); } }}
      >
        {hasKids ? (
          <button
            className={cls('notes-tree-chev', isOpen && 'open')}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
          >
            <Icons.ChevronRight size={10} />
          </button>
        ) : (
          <span className="notes-tree-chev-spacer" aria-hidden="true" />
        )}
        <span className="lbl" title={node.path}>{node.name}</span>
        <span className="ct">{node.noteCount}</span>
      </div>
      {hasKids && isOpen
        ? node.children.map((c) => (
            <FolderTreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
}

// ---- editable folder-path chip bar (pinned at the bottom of the detail) ----
function FolderPathEditor({
  note, pending, onChange,
}: {
  note: Note;
  pending: boolean;
  onChange: (folders: string[]) => void;
}) {
  const { folders } = splitTags(note.tags);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  const commit = () => {
    const p = normalizeFolderPath(draft);
    setDraft('');
    setAdding(false);
    if (p && !folders.includes(p)) onChange([...folders, p]);
  };

  return (
    <div className="notes-folder-bar" aria-label="Folders for this note">
      <span className="notes-folder-ic"><Icons.Layers size={12} /></span>
      {folders.length === 0 && !adding ? (
        <span className="page-subtle notes-folder-empty">No folder</span>
      ) : null}
      {folders.map((f) => (
        <Tag key={f} kind="note" removable onRemove={() => onChange(folders.filter((x) => x !== f))}>
          {f}
        </Tag>
      ))}
      {adding ? (
        <input
          className="notes-folder-input"
          autoFocus
          placeholder="area/topic/sub"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setDraft(''); setAdding(false); }
          }}
          onBlur={commit}
        />
      ) : (
        <button className="btn btn-ghost btn-sm notes-folder-add" disabled={pending} onClick={() => setAdding(true)}>
          <Icons.Plus size={11} /> Folder
        </button>
      )}
      {pending ? <span className="page-subtle">saving…</span> : null}
    </div>
  );
}
